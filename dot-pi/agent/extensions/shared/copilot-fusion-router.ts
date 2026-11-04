// GitHub's Fusion Standard route selects one physical model. Keep the routing
// session token in memory only: it is a billing credential, not session state.

export interface FusionModel {
  id: string;
  provider: string;
  input: readonly string[];
}

export const UNKNOWN_FUSION_CONTEXT = 32_768;

/** The router may choose any allowed model, so advertise their smallest window. */
export function fusionContextWindow(
  scoped: readonly { model: { provider: string; contextWindow?: number } }[],
  available: readonly { provider: string; contextWindow?: number }[],
): number {
  const candidates = (scoped.length > 0 ? scoped.map(({ model }) => model) : available)
    .filter((model) => model.provider === "github-copilot");
  if (candidates.length === 0 || candidates.some(({ contextWindow }) =>
    !Number.isSafeInteger(contextWindow) || (contextWindow ?? 0) <= 0,
  )) return UNKNOWN_FUSION_CONTEXT;
  return Math.min(...candidates.map(({ contextWindow }) => contextWindow!));
}

export interface FusionAuth {
  apiKey: string;
  baseUrl: string;
}

interface UserMessage {
  role: string;
  content?: string | readonly { type: string; text?: string }[];
  timestamp?: number;
}

interface FusionDecision<T extends FusionModel> {
  model: T;
  sessionToken: string;
  expiresAt: number;
  authKey: string;
  baseOrigin: string;
  anchor: string;
  hasImage: boolean;
  maxContextTokens?: number;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
}

interface RouterDependencies<T extends FusionModel> {
  getAuth(): Promise<FusionAuth>;
  findModel(id: string): T | undefined;
  isAllowed(model: T): boolean;
  fetch: typeof fetch;
  now(): number;
}

const ROUTER_TIMEOUT_MS = 10_000;
const EXPIRY_MARGIN_SECONDS = 300;
const MAX_SESSIONS = 50;

/** Keep credentials request-scoped and replace conflicting headers case-insensitively. */
export function fusionRequestHeaders(headers: Record<string, string | null> | undefined, sessionToken: string) {
  const blocked = new Set(["authorization", "api-key", "x-api-key", "copilot-session-token", "x-github-api-version"]);
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !blocked.has(name.toLowerCase()))),
    "X-GitHub-Api-Version": "2026-08-01",
    "Copilot-Session-Token": sessionToken,
  };
}

/** A router instance is scoped to the Pi extension runtime, not persisted. */
export function createFusionRouter<T extends FusionModel>(deps: RouterDependencies<T>) {
  const sessions = new Map<string, FusionDecision<T>>();

  function clear() {
    sessions.clear();
  }

  function invalidate(sessionId: string | undefined, sessionToken: string) {
    if (sessionId && sessions.get(sessionId)?.sessionToken === sessionToken) sessions.delete(sessionId);
  }

  async function route(messages: readonly UserMessage[], sessionId?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const user = [...messages].reverse().find((message) => message.role === "user");
    if (!user) throw new Error("Fusion Standard needs a user message to route.");
    const parts = typeof user.content === "string" ? [{ type: "text", text: user.content }] : (user.content ?? []);
    const prompt = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    const hasImage = messages.some((message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
    );
    if (!prompt && !hasImage) throw new Error("Fusion Standard needs text or an image to route.");

    const auth = await deps.getAuth();
    signal?.throwIfAborted();
    const base = new URL(auth.baseUrl);
    // Never send a Copilot bearer token or a user prompt to a configured proxy.
    if (base.protocol !== "https:" || base.username || base.password ||
      !(base.hostname === "githubcopilot.com" || base.hostname.endsWith(".githubcopilot.com"))) {
      throw new Error("Fusion Standard requires a direct GitHub Copilot HTTPS endpoint.");
    }
    const anchor = JSON.stringify([user.timestamp ?? null, prompt, hasImage]);
    const previous = sessionId ? sessions.get(sessionId) : undefined;
    if (previous && previous.anchor === anchor && previous.authKey === auth.apiKey &&
      previous.baseOrigin === base.origin && previous.hasImage === hasImage && previous.expiresAt - EXPIRY_MARGIN_SECONDS > deps.now() / 1000 &&
      deps.isAllowed(previous.model)) {
      return previous;
    }

    const response = await deps.fetch(new URL("/auto", base), {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${auth.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "GitHubCopilotChat/0.74.0",
        "Editor-Version": "vscode/1.146.0",
        "Editor-Plugin-Version": "copilot-chat/0.74.0",
        "Copilot-Integration-Id": "vscode-chat",
        "X-GitHub-Api-Version": "2026-08-01",
      },
      body: JSON.stringify({
        prompt: prompt || "[Image attached]",
        has_image: hasImage,
        multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 },
        tier: "balance",
        hydra_rl_multi_turn: {},
        fusion: true,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)]) : AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Fusion Standard routing failed (HTTP ${response.status}).`);
    const result = await response.json() as {
      selected_model?: { id?: unknown; capabilities?: { limits?: {
        max_context_window_tokens?: unknown; max_prompt_tokens?: unknown; max_output_tokens?: unknown;
      } } };
      session_token?: unknown;
      expires_at?: unknown;
    };
    const id = result.selected_model?.id;
    if (typeof id !== "string" || !id || typeof result.session_token !== "string" || !result.session_token ||
      typeof result.expires_at !== "number" || !Number.isFinite(result.expires_at) ||
      result.expires_at - EXPIRY_MARGIN_SECONDS <= deps.now() / 1000) {
      throw new Error("Fusion Standard returned an invalid routing decision.");
    }
    const model = deps.findModel(id);
    if (!model || model.provider !== "github-copilot" || model.id !== id) {
      throw new Error(`Fusion selected github-copilot/${id}, which is missing from Pi's catalog. Update Pi's models.`);
    }
    if (!deps.isAllowed(model)) {
      throw new Error(`Fusion selected github-copilot/${id}, which is outside the enabled model scope. Enable it before retrying.`);
    }
    if (hasImage && !model.input.includes("image")) {
      throw new Error(`Fusion selected github-copilot/${id}, which does not support image input.`);
    }
    const limits = result.selected_model?.capabilities?.limits;
    const validLimit = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
    const decision: FusionDecision<T> = {
      model, sessionToken: result.session_token, expiresAt: result.expires_at,
      authKey: auth.apiKey, baseOrigin: base.origin, anchor, hasImage,
      maxContextTokens: validLimit(limits?.max_context_window_tokens),
      maxPromptTokens: validLimit(limits?.max_prompt_tokens),
      maxOutputTokens: validLimit(limits?.max_output_tokens),
    };
    if (sessionId) {
      if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
      sessions.set(sessionId, decision);
    }
    return decision;
  }

  return { route, clear, invalidate };
}
