export const COPILOT_PROVIDER = "github-copilot";
export const COPILOT_CONTEXT_API_VERSION = "2026-08-01";
export const COPILOT_VERSION_HEADER = "X-GitHub-Api-Version";
export const COPILOT_CHAT_ENDPOINTS = {
  "anthropic-messages": "/v1/messages",
  "openai-responses": "/responses",
  "openai-completions": "/chat/completions",
} as const;
const ENDPOINTS: ReadonlyMap<string, string> = new Map(Object.entries(COPILOT_CHAT_ENDPOINTS));

export class CopilotCatalogError extends Error {}

function directEndpoint(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
      url.pathname === "/" && !url.search && !url.hash &&
      (url.hostname === "githubcopilot.com" || url.hostname.endsWith(".githubcopilot.com"))) return url;
  } catch { /* not a URL */ }
  return undefined;
}

export function isDirectCopilotEndpoint(baseUrl: string): boolean {
  return directEndpoint(baseUrl) !== undefined;
}

export async function fetchCopilotCatalog(
  baseUrl: string,
  apiKey: string,
  fetcher = globalThis.fetch,
  options: { defaultTier?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  const base = directEndpoint(baseUrl);
  if (!base) throw new CopilotCatalogError("Long-context lookup requires a direct GitHub Copilot HTTPS endpoint.");
  const response = await fetcher(new URL("/models", base), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "GitHubCopilotChat/0.35.0",
      "Editor-Version": "vscode/1.107.0",
      "Editor-Plugin-Version": "copilot-chat/0.35.0",
      "Copilot-Integration-Id": "vscode-chat",
      ...(options.defaultTier ? {} : { [COPILOT_VERSION_HEADER]: COPILOT_CONTEXT_API_VERSION }),
    },
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) throw new CopilotCatalogError(`GitHub Copilot catalog request failed (HTTP ${response.status}).`);
  return response.json();
}

interface PiModel {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  maxTokens: number;
}

interface ModelSetup {
  defaultPrompt: number;
  contextWindow: number;
  maxTokens: number;
  // True only when the long tier is priced at or below the default tier for
  // every token rate, so enabling it cannot raise the AI credit cost.
  priceNeutral: boolean;
}

export function isCopilotChatModel(model: Pick<PiModel, "provider" | "api">): boolean {
  return model.provider === COPILOT_PROVIDER && ENDPOINTS.has(model.api);
}

export function copilotVersionHeader(key: string): boolean {
  return key.toLowerCase() === COPILOT_VERSION_HEADER.toLowerCase();
}

export function longContextHeaders(headers?: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => !copilotVersionHeader(key))),
    [COPILOT_VERSION_HEADER]: COPILOT_CONTEXT_API_VERSION,
  };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function limit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function tierLimit(value: unknown): number | undefined {
  const tier = record(value);
  return limit(tier?.max_prompt_tokens) ?? limit(tier?.context_max);
}

function tierRates(tier: unknown): (number | undefined)[] {
  const row = record(tier);
  const rate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  return [rate(row?.input_price), rate(row?.output_price), rate(row?.cache_read_price ?? row?.cache_price), rate(row?.cache_write_price)];
}

function priceNeutral(defaultTier: unknown, longTier: unknown): boolean {
  const base = tierRates(defaultTier);
  const long = tierRates(longTier);
  return base.every((value, i) => value !== undefined && long[i] !== undefined && long[i]! <= value);
}

export function copilotLongContext(raw: unknown, model: PiModel, authBaseUrl?: string): ModelSetup | undefined {
  const endpoint = ENDPOINTS.get(model.api);
  if (model.provider !== COPILOT_PROVIDER || !endpoint || !isDirectCopilotEndpoint(authBaseUrl ?? model.baseUrl)) return;
  const data = record(raw)?.data;
  if (!Array.isArray(data)) throw new CopilotCatalogError("GitHub Copilot returned an invalid model catalog.");
  for (const entry of data) {
    const row = record(entry);
    if (row?.id !== model.id || row.model_picker_enabled !== true) continue;
    const policy = record(row.policy)?.state;
    if (policy === "disabled" || policy === "unconfigured") continue;
    if (!Array.isArray(row.supported_endpoints) || !row.supported_endpoints.includes(endpoint)) continue;
    const capabilities = record(row.capabilities);
    if (record(capabilities?.supports)?.tool_calls === false) continue;
    const limits = record(capabilities?.limits);
    const tiers = record(record(row.billing)?.token_prices);
    const neutral = priceNeutral(tiers?.default, tiers?.long_context);
    const defaultPrompt = tierLimit(tiers?.default);
    const longPrompt = tierLimit(tiers?.long_context);
    const prompt = limit(limits?.max_prompt_tokens);
    const total = limit(limits?.max_context_window_tokens);
    const output = limit(limits?.max_output_tokens);
    const configuredOutput = limit(model.maxTokens);
    if (!defaultPrompt || !longPrompt || !prompt || !total || !output || !configuredOutput) continue;
    const maxTokens = Math.min(configuredOutput, output);
    // Pi compacts against contextWindow, not a separate provider prompt limit.
    // Honor both prompt caps, and reserve room for the request's maximum output.
    const contextWindow = Math.min(longPrompt, prompt, total - maxTokens);
    if (contextWindow <= defaultPrompt) continue;
    return { defaultPrompt, contextWindow, maxTokens, priceNeutral: neutral };
  }
}
