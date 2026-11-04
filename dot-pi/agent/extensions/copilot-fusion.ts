// Fusion is a virtual model: route first, then let Pi compact against the
// selected model. A private dispatch model keeps the request-scoped token out
// of model metadata and session entries; it is sent only in the actual request.
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasCopilotConfiguration } from "./shared/copilot-fusion-auth";
import { createFusionRouter, fusionContextWindow, fusionRequestHeaders, UNKNOWN_FUSION_CONTEXT } from "./shared/copilot-fusion-router";

const PROVIDER = "copilot-fusion";
const MODEL = "standard";
const DISPATCH_API = "copilot-fusion-dispatch";

export default function (pi: ExtensionAPI) {
  let registeredContextWindow = UNKNOWN_FUSION_CONTEXT;
  type Router = ReturnType<typeof createFusionRouter<Model<Api>>>;
  type Decision = Awaited<ReturnType<Router["route"]>>;
  type Registry = ExtensionContext["modelRegistry"];
  type Turn = { routed: boolean; pending: Set<string> };
  const contexts = new Map<string, ExtensionContext>();
  const routers = new Map<string, Router>();
  const turns = new Map<string, Turn>();
  const dispatches = new Map<string, { model: Model<Api>; decision: Decision; router: Router; registry: Registry; sessionId: string }>();

  function turn(sessionId: string): Turn {
    let state = turns.get(sessionId);
    if (!state) { state = { routed: false, pending: new Set() }; turns.set(sessionId, state); }
    return state;
  }

  function sessionRouter(sessionId: string, ctx: ExtensionContext): Router {
    contexts.set(sessionId, ctx);
    const existing = routers.get(sessionId);
    if (existing) return existing;
    function context() {
      const value = contexts.get(sessionId);
      if (!value) throw new Error("Fusion session is no longer available.");
      return value;
    }
    const router = createFusionRouter<Model<Api>>({
      async getAuth() {
        const registry = context().modelRegistry;
        const resolved = await registry.getProviderAuth("github-copilot");
        const apiKey = resolved?.auth.apiKey;
        const baseUrl = resolved?.auth.baseUrl ?? registry.getProvider("github-copilot")?.baseUrl;
        if (!apiKey || !baseUrl) throw new Error("Fusion Standard needs GitHub Copilot authentication; run /login.");
        return { apiKey, baseUrl };
      },
      findModel: (id) => context().modelRegistry.find("github-copilot", id),
      isAllowed(model) {
        const active = context();
        if (!active.modelRegistry.hasConfiguredAuth(model)) return false;
        const scoped = active.scopedModels ?? [];
        return scoped.length === 0 || scoped.some(({ model: allowed }) =>
          allowed.provider === model.provider && allowed.id === model.id,
        );
      },
      fetch: (...args) => globalThis.fetch(...args),
      now: () => Date.now(),
    });
    routers.set(sessionId, router);
    return router;
  }

  function dispatchModel(decision: Decision, sessionId: string, registry: Registry, router: Router): Model<Api> {
    // Every route gets its own ID, even when it shares a token with another
    // request. This keeps concurrent compaction markers independent. Retain
    // each dispatch until expiry or session shutdown: Pi may use it first for
    // compaction and then for the actual request.
    for (const [id, entry] of dispatches) {
      if (entry.decision.expiresAt <= Date.now() / 1000) dispatches.delete(id);
    }
    const physical = decision.model;
    if (!Number.isSafeInteger(physical.contextWindow) || physical.contextWindow <= 0 ||
      !Number.isSafeInteger(physical.maxTokens) || physical.maxTokens <= 0) {
      throw new Error("Fusion selected a model without valid context and output limits.");
    }
    // GitHub may cap prompt input below a model's total context window. Pi's
    // compaction check needs the input ceiling, not the larger advertised total.
    const contextWindow = Math.min(physical.contextWindow, decision.maxContextTokens ?? Infinity, decision.maxPromptTokens ?? Infinity);
    const maxTokens = Math.min(physical.maxTokens, decision.maxOutputTokens ?? Infinity);
    const model: Model<Api> = {
      id: `dispatch-${randomUUID()}`, name: `${physical.name} (Fusion)`, provider: PROVIDER,
      api: DISPATCH_API, baseUrl: "https://api.githubcopilot.com", reasoning: physical.reasoning,
      thinkingLevelMap: physical.thinkingLevelMap, input: physical.input,
      inputLimits: physical.inputLimits, promptCache: physical.promptCache,
      contextWindow, maxTokens, cost: physical.cost,
    };
    dispatches.set(model.id, { model, decision, sessionId, registry, router });
    return model;
  }

  function stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
    const entry = dispatches.get(model.id);
    if (entry) turn(entry.sessionId).pending.delete(model.id);
    const output = createAssistantMessageEventStream();
    // Persist the real model on errors too; temporary dispatch IDs must never
    // enter session history, where they would be meaningless after restart.
    const errorModel = entry?.decision.model ?? { api: "pi-virtual", provider: PROVIDER, id: MODEL };
    void (async () => {
      if (!entry || entry.decision.expiresAt <= Date.now() / 1000) {
        throw new Error("Fusion's routing session expired; retry the request.");
      }
      const { decision, registry, router, sessionId } = entry;
      const physicalAuth = await registry.getApiKeyAndHeaders(decision.model);
      options?.signal?.throwIfAborted();
      if (!physicalAuth.ok || physicalAuth.apiKey !== decision.authKey) {
        router.invalidate(sessionId, decision.sessionToken);
        throw new Error("Fusion Standard's Copilot credentials changed; retry the request.");
      }
      const target = new URL(physicalAuth.baseUrl ?? decision.model.baseUrl);
      if (target.origin !== decision.baseOrigin) {
        throw new Error("Fusion Standard cannot send its session token to a different model endpoint.");
      }
      // Do not forward the dispatch provider's marker key. The real Copilot
      // provider resolves its own credentials; the token is scoped to this call.
      const { apiKey: _key, headers: outerHeaders, env: _env, ...rest } = options ?? {};
      const inner = registry.streamSimple(decision.model, context, {
        ...rest,
        headers: fusionRequestHeaders(outerHeaders, decision.sessionToken),
      });
      for await (const event of inner) {
        if (event.type === "error" && /\b(401|403)\b|(?:session|routing) token.{0,30}(?:invalid|expired)/i.test(event.error.errorMessage ?? "")) {
          router.invalidate(sessionId, decision.sessionToken);
        }
        output.push(event);
      }
      output.end(await inner.result());
    })().catch((error: unknown) => {
      const aborted = options?.signal?.aborted === true;
      const reason = aborted ? "aborted" : "error";
      const message: AssistantMessage = {
        role: "assistant", content: [], api: errorModel.api, provider: errorModel.provider, model: errorModel.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: reason,
        errorMessage: aborted ? "Fusion Standard request aborted." : error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      output.push({ type: "error", reason, error: message });
      output.end(message);
    });
    return output;
  }

  async function configured(env: (name: string) => Promise<string | undefined>) {
    return hasCopilotConfiguration(getAgentDir(), env);
  }

  pi.registerProvider({
    id: PROVIDER,
    name: "GitHub Copilot Fusion",
    baseUrl: "https://api.githubcopilot.com",
    // The marker makes dispatch models usable only when Copilot is configured.
    // It is never transmitted; the real provider resolves its own credential.
    auth: { apiKey: {
      name: "GitHub Copilot",
      check: async ({ ctx }) => await configured(ctx.env) ? { type: "api_key", source: "GitHub Copilot" } : undefined,
      resolve: async ({ ctx }) => await configured(ctx.env) ? { auth: { apiKey: "fusion-local" }, source: "GitHub Copilot" } : undefined,
    } },
    getModels: () => [...dispatches.values()].map(({ model }) => model),
    // Private dispatch models are routable but never offered in the picker.
    filterModels: () => [],
    stream: (target, context, options) => stream(target, context, options as SimpleStreamOptions),
    streamSimple: stream,
  });

  function registerVirtual(contextWindow: number) {
    pi.registerVirtualModel({
      provider: PROVIDER, id: MODEL, name: "Copilot Fusion Standard",
      input: ["text", "image"], contextWindow, maxTokens: 4096,
      async route(request, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const router = sessionRouter(sessionId, ctx);
        const decision = await router.route(request.messages, sessionId, request.signal);
        if (!contexts.has(sessionId)) throw new Error("Fusion session ended during routing.");
        // Every call has its own ID, so a summary/direct call cannot consume
        // the main request's pending marker before that request is sent.
        const model = dispatchModel(decision, sessionId, ctx.modelRegistry, router);
        if (request.reason !== "direct") {
          const state = turn(sessionId);
          state.routed = true;
          state.pending.add(model.id);
        }
        return { model, thinkingLevel: request.thinkingLevel };
      },
    });
    registeredContextWindow = contextWindow;
  }

  function syncContext(ctx: ExtensionContext) {
    const limit = fusionContextWindow(ctx.scopedModels ?? [], ctx.modelRegistry.getAvailable());
    if (limit !== registeredContextWindow) registerVirtual(limit);
  }

  registerVirtual(registeredContextWindow);
  pi.on("session_start", (_event, ctx) => { turns.delete(ctx.sessionManager.getSessionId()); syncContext(ctx); });
  pi.on("model_select", (_event, ctx) => { turns.delete(ctx.sessionManager.getSessionId()); syncContext(ctx); });
  pi.on("input", (event, ctx) => {
    if (ctx.model?.provider === PROVIDER && ctx.model.id === MODEL && event.streamingBehavior === undefined) {
      turns.delete(ctx.sessionManager.getSessionId());
    }
    return { action: "continue" };
  });
  pi.on("session_before_compact", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER || ctx.model.id !== MODEL || event.reason === "manual") return;
    // Threshold compaction is allowed only after a route and before its model
    // request. Deferring post-response checks lets the next prompt choose a
    // larger model before Pi decides whether any context needs summarizing.
    // Overflow recovery is allowed after a model was actually selected.
    const state = turn(ctx.sessionManager.getSessionId());
    if (event.reason === "threshold" ? state.pending.size === 0 : !state.routed) return { cancel: true };
  });
  pi.on("agent_settled", (_event, ctx) => { turns.delete(ctx.sessionManager.getSessionId()); });
  pi.on("session_shutdown", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    routers.get(id)?.clear();
    routers.delete(id);
    contexts.delete(id);
    turns.delete(id);
    for (const [key, entry] of dispatches) if (entry.sessionId === id) dispatches.delete(key);
  });
}
