// One plugin for the GitHub Copilot account: the live catalog and billing on
// Pi's native provider, session-local long context, and Fusion Standard.
//
// They share one account and one selected model. The catalog bounds a model's
// budget, long context raises it for the current selection only, and Fusion has
// to know when a compaction check may run at all. Kept in separate extension
// files the coupling was implicit: the Fusion entry recognized the selected
// model by provider name, and long context was recognized by the HTTP header it
// puts on its session-local model clone.
//
// The sections appear in the order their session hooks have to run, not in the
// order a reader would choose: see the two notes inside the factory. Registering
// a provider or a model makes Pi rebuild its model list, and Pi then also re-reads
// the selected model from the registry, so registration has to come before
// anything that selects a session-local clone, and the refresh and clamp that
// undo the rebuild's effect on models.json overrides have to come last.
import { randomUUID } from "node:crypto";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withCopilotBilling } from "./shared/copilot-billing";
import { withCopilotCatalog } from "./shared/copilot-catalog";
import { hasCopilotConfiguration } from "./shared/copilot-fusion-auth";
import { createFusionRouter, fusionContextWindow, fusionRequestHeaders, UNKNOWN_FUSION_CONTEXT } from "./shared/copilot-fusion-router";
import {
  COPILOT_CONTEXT_API_VERSION, COPILOT_PROVIDER, CopilotCatalogError, copilotLongContext,
  copilotVersionHeader, fetchCopilotCatalog, isCopilotChatModel, isDirectCopilotEndpoint, longContextHeaders,
} from "./shared/copilot-long-context";

const FUSION_PROVIDER = "copilot-fusion";
const FUSION_MODEL = "standard";
const DISPATCH_API = "copilot-fusion-dispatch";
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_ACCOUNTS = 4;
// Marks a provider this plugin already wrapped, so a reload wraps that
// provider's original base again instead of stacking a second catalog layer.
const CATALOG_BASE = Symbol.for("pi-config.copilot.catalog-base");

function wrappedBase(provider: Provider): Provider | undefined {
  return (provider as Provider & { [key: symbol]: Provider | undefined })[CATALOG_BASE];
}

export default function (pi: ExtensionAPI) {
  // ---- the account's catalog: registration ----------------------------------
  // Registered before Fusion and long context on purpose: `registerProvider`
  // makes Pi rebuild its model list and re-read the selected model from the
  // registry, which discards a session-local clone. A clone selected later in the
  // same session_start therefore survives; the refresh and clamp that follow a
  // rebuild are the last section instead.
  //
  // Pi's own provider refresh, the long-context probe and /copilot-refresh all
  // want the versioned /models response for the same account, so remember it
  // briefly: one model selection could otherwise send it three times. The key is
  // the resolved credential — memory only, never persisted or logged.
  const catalogReads = new Map<string, { at: number; value: unknown }>();
  const catalogPending = new Map<string, Promise<unknown>>();

  function versionedCatalog(endpoint: string, apiKey: string, force = false, signal?: AbortSignal): Promise<unknown> {
    const key = `${endpoint}\u0000${apiKey}`;
    const cached = catalogReads.get(key);
    if (!force && cached && Date.now() - cached.at < CATALOG_TTL_MS) return Promise.resolve(cached.value);
    // Concurrent callers share one request, so the request itself deliberately
    // ignores their signals: one aborted caller must not cancel it for the
    // others. Each caller still stops waiting on its own signal, and
    // fetchCopilotCatalog enforces its own deadline.
    const pending = catalogPending.get(key);
    const read = pending ?? fetchCopilotCatalog(endpoint, apiKey).then((value) => {
      const now = Date.now();
      catalogReads.delete(key);
      for (const [other, entry] of catalogReads) {
        if (now - entry.at >= CATALOG_TTL_MS) catalogReads.delete(other);
      }
      catalogReads.set(key, { at: now, value });
      for (const oldest of catalogReads.keys()) {
        if (catalogReads.size <= CATALOG_ACCOUNTS) break;
        catalogReads.delete(oldest);
      }
      return value;
    }).finally(() => { catalogPending.delete(key); });
    if (!pending) catalogPending.set(key, read);
    return signal ? stopWaiting(read, signal) : read;
  }

  // Gives up on the shared read when this caller aborts, without cancelling it.
  function stopWaiting(read: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(undefined);
      };
      if (signal.aborted) {
        read.catch(() => {});
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      read.then((value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }

  let catalog: ReturnType<typeof withCopilotCatalog> | undefined;

  async function registerCatalog(ctx: ExtensionContext) {
    if (catalog) return;
    // Compose over the provider registered for github-copilot rather than
    // replacing it: another extension's Copilot provider, and in this plugin's
    // own case the provider it wrapped before a /reload, stays underneath. Pi
    // still applies models.json above the result. Reading the registration (not
    // the composed provider Pi serves) is what keeps the marker, and the base it
    // names, out of the composed copy's reach.
    const registry = ctx.modelRegistry;
    // Pi holds one native provider and one config registration per id, and
    // registering the native one drops the config one. Re-apply a config
    // registration that is already there, so an extension that serves Copilot
    // through a config keeps working, layered over this catalog — the same result
    // as if it had registered after this plugin.
    const configured = registry.getRegisteredProviderConfig?.(COPILOT_PROVIDER);
    const registered = registry.getRegisteredNativeProvider?.(COPILOT_PROVIDER);
    const base = registered ? wrappedBase(registered) ?? registered : await builtinCopilotProvider();
    if (!base) return;
    const wrapped = withCopilotCatalog(base, { versionedCatalog });
    catalog = wrapped;
    pi.registerProvider(Object.assign(withCopilotBilling(wrapped.provider), { [CATALOG_BASE]: base }));
    if (configured) pi.registerProvider(COPILOT_PROVIDER, configured);
  }

  // Pi's own Copilot provider, before models.json is composed on top, so the
  // file's overrides apply exactly once. No network, no stored credential.
  async function builtinCopilotProvider(): Promise<Provider | undefined> {
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false,
    });
    return runtime.getProvider(COPILOT_PROVIDER);
  }

  pi.on("session_start", (_event, ctx) => registerCatalog(ctx));

  // ---- Fusion Standard ------------------------------------------------------
  // Fusion is a virtual model: route first, then let Pi compact against the
  // selected model. A private dispatch model keeps the request-scoped token out
  // of model metadata and session entries; it is sent only in the actual request.
  let registeredContextWindow = UNKNOWN_FUSION_CONTEXT;
  type Router = ReturnType<typeof createFusionRouter<Model<Api>>>;
  type Route = Awaited<ReturnType<Router["route"]>>;
  type Registry = ExtensionContext["modelRegistry"];
  type Turn = { routed: boolean; pending: Set<string> };
  const contexts = new Map<string, ExtensionContext>();
  const routers = new Map<string, Router>();
  const turns = new Map<string, Turn>();
  const dispatches = new Map<string, { model: Model<Api>; decision: Route; router: Router; registry: Registry; sessionId: string }>();

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
        const resolved = await registry.getProviderAuth(COPILOT_PROVIDER);
        const apiKey = resolved?.auth.apiKey;
        const baseUrl = resolved?.auth.baseUrl ?? registry.getProvider(COPILOT_PROVIDER)?.baseUrl;
        if (!apiKey || !baseUrl) throw new Error("Fusion Standard needs GitHub Copilot authentication; run /login.");
        return { apiKey, baseUrl };
      },
      findModel: (id) => context().modelRegistry.find(COPILOT_PROVIDER, id),
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

  function dispatchModel(decision: Route, sessionId: string, registry: Registry, router: Router): Model<Api> {
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
      id: `dispatch-${randomUUID()}`, name: `${physical.name} (Fusion)`, provider: FUSION_PROVIDER,
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
    const errorModel = entry?.decision.model ?? { api: "pi-virtual", provider: FUSION_PROVIDER, id: FUSION_MODEL };
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
    id: FUSION_PROVIDER,
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
      provider: FUSION_PROVIDER, id: FUSION_MODEL, name: "Fusion/Standard",
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
    if (ctx.model?.provider === FUSION_PROVIDER && ctx.model.id === FUSION_MODEL && event.streamingBehavior === undefined) {
      turns.delete(ctx.sessionManager.getSessionId());
    }
    return { action: "continue" };
  });
  pi.on("agent_settled", (_event, ctx) => { turns.delete(ctx.sessionManager.getSessionId()); });
  pi.on("session_before_compact", (event, ctx) => {
    if (ctx.model?.provider !== FUSION_PROVIDER || ctx.model.id !== FUSION_MODEL || event.reason === "manual") return;
    // Threshold compaction is allowed only after a route and before its model
    // request. Deferring post-response checks lets the next prompt choose a
    // larger model before Pi decides whether any context needs summarizing.
    // Overflow recovery is allowed after a model was actually selected.
    const state = turn(ctx.sessionManager.getSessionId());
    if (event.reason === "threshold" ? state.pending.size === 0 : !state.routed) return { cancel: true };
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    routers.get(id)?.clear();
    routers.delete(id);
    contexts.delete(id);
    turns.delete(id);
    for (const [key, entry] of dispatches) if (entry.sessionId === id) dispatches.delete(key);
  });

  // ---- long context ---------------------------------------------------------
  // A session-local clone carries both the larger budget and the request header.
  // The registry and settings (including the current model ID) stay unchanged.
  // Keys are the long-context clones; values are the registry models they
  // replace. The version header on a clone is also what tells the catalog clamp
  // at the end of this factory that the budget is deliberate, not to be re-bounded.
  const originals = new WeakMap<Model<Api>, Model<Api>>();
  // Model IDs the user turned off with `/long-context off`; auto-enable skips them.
  const optedOut = new Set<string>();
  let switching = false;
  let closing = false;

  type Setup =
    | { ok: true; model: Model<Api>; defaultPrompt: number; contextWindow: number; priceNeutral: boolean }
    | { ok: false; message: string; level: "info" | "warning" };

  async function select(model: Model<Api>): Promise<boolean> {
    const thinkingLevel = pi.getThinkingLevel();
    if (!await pi.setModel(model)) return false;
    if (pi.getThinkingLevel() !== thinkingLevel) pi.setThinkingLevel(thinkingLevel);
    return true;
  }

  // Resolves the long-context clone for a registry model. Returns undefined only when the session is closing.
  async function setupFor(model: Model<Api>, ctx: ExtensionContext, force = false): Promise<Setup | undefined> {
    const fail = (message: string, level: "info" | "warning" = "info"): Setup => ({ ok: false, message, level });
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (closing) return undefined;
    if (!auth.ok || !auth.apiKey) return fail("Could not resolve Copilot credentials. Check /login.", "warning");
    const endpoint = auth.baseUrl ?? model.baseUrl;
    if (!isDirectCopilotEndpoint(endpoint)) return fail("Long context is only supported on direct GitHub Copilot endpoints.");
    // Configured headers can take precedence over model metadata in Pi's transports.
    if (Object.entries(auth.headers ?? {}).some(([key, value]) => copilotVersionHeader(key) && value !== COPILOT_CONTEXT_API_VERSION)) {
      return fail("A configured Copilot API version conflicts with long context. No changes were made.", "warning");
    }
    // The automatic check reuses the catalog the provider already read; the
    // command re-reads it, so a tier enabled on the account meanwhile is seen.
    const raw = await versionedCatalog(endpoint, auth.apiKey, force);
    if (closing) return undefined;
    const limits = copilotLongContext(raw, model, auth.baseUrl);
    if (!limits) return fail("The selected Copilot model has no supported long-context tier on this account.");
    const { defaultPrompt, contextWindow, maxTokens, priceNeutral } = limits;
    const next = { ...model, contextWindow, maxTokens, headers: longContextHeaders(model.headers) };
    return { ok: true, model: next, defaultPrompt, contextWindow, priceNeutral };
  }

  // Long context is the default wherever its tier costs no more. The decision is
  // cached per model for a few minutes so the catalog is not re-read on every message.
  // Pi emits no model_select when the same model is re-selected, so input also checks.
  type Decision = { apply: false } | { apply: true; defaultPrompt: number; contextWindow: number; maxTokens: number };
  const DECISION_TTL_MS = 5 * 60_000;
  const decisions = new Map<string, { at: number; value: Decision }>();
  const sameSelection = (a: Model<Api> | undefined, b: Model<Api>) => a?.id === b.id && a?.provider === b.provider;

  async function ensureDefault(model: Model<Api> | undefined, ctx: ExtensionContext) {
    // Offline mode disables automatic network activity, so no catalog probe runs.
    if (process.env.PI_OFFLINE !== undefined || !model || closing || switching || !ctx.isIdle()) return;
    if (!isCopilotChatModel(model) || originals.has(model) || optedOut.has(model.id)) return;
    try {
      let decision: Decision;
      const cached = decisions.get(model.id);
      if (cached && Date.now() - cached.at < DECISION_TTL_MS) {
        decision = cached.value;
      } else {
        const setup = await setupFor(model, ctx);
        if (!setup) return;
        decision = setup.ok && setup.priceNeutral
          ? { apply: true, defaultPrompt: setup.defaultPrompt, contextWindow: setup.model.contextWindow, maxTokens: setup.model.maxTokens }
          : { apply: false };
        decisions.set(model.id, { at: Date.now(), value: decision });
      }
      if (!decision.apply || closing || !sameSelection(ctx.model, model) || !ctx.isIdle()) return;
      switching = true;
      const next = { ...model, contextWindow: decision.contextWindow, maxTokens: decision.maxTokens, headers: longContextHeaders(model.headers) };
      if (!await select(next)) return;
      if (closing) return;
      originals.set(next, model);
      ctx.ui.notify(`Long context enabled for ${model.name}: ${decision.defaultPrompt.toLocaleString()} → ${decision.contextWindow.toLocaleString()} prompt tokens at no extra AI credit cost. Use /long-context off to turn it off.`, "info");
    } catch {
      // Network or catalog failures keep the standard budget; /long-context reports the details.
    } finally {
      switching = false;
    }
  }

  pi.on("session_start", (_event, ctx) => ensureDefault(ctx.model, ctx));
  pi.on("model_select", (_event, ctx) => ensureDefault(ctx.model, ctx));
  pi.on("input", async (event, ctx) => {
    // Only idle submissions; a message queued during a run must not switch models mid-run.
    if (event.streamingBehavior === undefined) await ensureDefault(ctx.model, ctx);
    return { action: "continue" as const };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    closing = true;
    // /reload keeps the AgentSession's model object but replaces this extension.
    if (event.reason !== "reload" || !ctx.model) return;
    const original = originals.get(ctx.model);
    if (original) await select(original);
  });

  pi.registerCommand("long-context", {
    description: "Enable long context for the selected Copilot model (off to restore)",
    async handler(args, ctx) {
      const model = ctx.model;
      if (!model || !isCopilotChatModel(model)) {
        ctx.ui.notify("Long context is not supported for the selected model.", "info");
        return;
      }
      const mode = args.trim().toLowerCase();
      if (mode && mode !== "on" && mode !== "off") {
        ctx.ui.notify("Usage: /long-context [on|off]", "info");
        return;
      }
      const original = originals.get(model);
      if (mode === "off" ? !original : original) {
        ctx.ui.notify(mode === "off" ? "Long context is not enabled by this command." : "Long context is already enabled.", "info");
        return;
      }
      if (switching || !ctx.isIdle()) {
        ctx.ui.notify("Wait for the current operation to finish, then try /long-context again.", "warning");
        return;
      }
      switching = true;
      try {
        let next = original;
        let notice = "Previous context settings restored.";
        if (!next) {
          const setup = await setupFor(model, ctx, true);
          if (!setup) return;
          if (!setup.ok) {
            ctx.ui.notify(setup.message, setup.level);
            return;
          }
          next = setup.model;
          const cost = setup.priceNeutral ? "No extra AI credit cost on this tier." : "Larger prompts may use more AI credits.";
          notice = `Long context enabled for ${model.name}: ${setup.defaultPrompt.toLocaleString()} → ${setup.contextWindow.toLocaleString()} prompt tokens. ${cost}`;
        }
        if (ctx.model !== model || !ctx.isIdle()) {
          ctx.ui.notify("The session changed during the lookup. No changes were made.", "warning");
          return;
        }
        if (!await select(next)) throw new CopilotCatalogError("Could not apply the Copilot context settings. Check /login.");
        if (closing) return;
        if (!original) {
          originals.set(next, model);
          optedOut.delete(model.id);
        } else {
          optedOut.add(model.id);
        }
        ctx.ui.notify(notice, "info");
      } catch (error) {
        if (closing) return;
        // Never surface remote response bodies or credential details.
        ctx.ui.notify(error instanceof CopilotCatalogError ? error.message : "Could not switch Copilot context settings. Check /login and your connection.", "error");
      } finally {
        switching = false;
      }
    },
  });

  // ---- the account's catalog: refresh and clamp -----------------------------
  // Last on purpose: registering the provider above (and Fusion's
  // `registerVirtual`) makes Pi rebuild its model list, and a rebuild re-applies
  // models.json overrides on top of the budget this plugin already applied.
  // Refreshing and clamping after that is what makes the clamped budget the last
  // word on the selection.
  async function clampSelection(ctx: ExtensionContext) {
    const model = ctx.model;
    if (!catalog || !model || !ctx.isIdle()) return;
    const bounded = catalog.clamp(model);
    if (bounded === model) return;
    const thinkingLevel = pi.getThinkingLevel();
    if (await pi.setModel(bounded) && pi.getThinkingLevel() !== thinkingLevel) pi.setThinkingLevel(thinkingLevel);
  }

  function refresh(ctx: ExtensionContext, force = false) {
    return ctx.modelRegistry.refresh({ providers: [COPILOT_PROVIDER], force, signal: AbortSignal.timeout(force ? 10_000 : 3_000) });
  }

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_OFFLINE !== undefined || !ctx.model ||
      !(isCopilotChatModel(ctx.model) || ctx.model.provider === FUSION_PROVIDER)) return;
    // Pi also refreshes this catalog when opening its picker. This earlier,
    // bounded refresh protects the already-selected model on its first turn.
    await refresh(ctx);
    await clampSelection(ctx);
  });
  pi.on("model_select", (_event, ctx) => clampSelection(ctx));

  pi.registerCommand("copilot-refresh", {
    description: "Refresh the account's GitHub Copilot model catalog and limits",
    async handler(_args, ctx) {
      if (process.env.PI_OFFLINE !== undefined || !ctx.isIdle()) {
        ctx.ui.notify("Copilot refresh requires an idle, online session.", "info");
        return;
      }
      if (!ctx.modelRegistry.getProviderAuthStatus(COPILOT_PROVIDER)) {
        ctx.ui.notify("Run /login and select GitHub Copilot first.", "info");
        return;
      }
      // Only a session whose registry had no Copilot provider at start is still
      // without the wrapper; every other start registered it already.
      await registerCatalog(ctx);
      const result = await refresh(ctx, true);
      if (result.aborted || result.errors.has(COPILOT_PROVIDER) || !catalog?.hasLiveCatalog()) {
        ctx.ui.notify("Copilot catalog refresh failed; keeping existing models.", "warning");
        return;
      }
      await clampSelection(ctx);
      const count = ctx.modelRegistry.getAvailable().filter((model) => model.provider === COPILOT_PROVIDER).length;
      ctx.ui.notify(`Copilot catalog: ${count} available chat models.`, "info");
    },
  });
}
