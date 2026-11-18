import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  COPILOT_CONTEXT_API_VERSION, CopilotCatalogError, copilotLongContext, copilotVersionHeader,
  fetchCopilotCatalog, isCopilotChatModel, isDirectCopilotEndpoint, longContextHeaders,
} from "./shared/copilot-long-context";

type Setup =
  | { ok: true; model: Model<Api>; defaultPrompt: number; contextWindow: number; priceNeutral: boolean }
  | { ok: false; message: string; level: "info" | "warning" };

export default function (pi: ExtensionAPI) {
  // Use a session-local clone so Pi gets both the new budget and the request header.
  // The registry and settings (including the current model ID) stay unchanged.
  // Keys are the long-context clones; values are the registry models they replace.
  const originals = new WeakMap<Model<Api>, Model<Api>>();
  // Model IDs the user turned off with `/long-context off`; auto-enable skips them.
  const optedOut = new Set<string>();
  let switching = false;
  let closing = false;

  async function select(model: Model<Api>): Promise<boolean> {
    const thinkingLevel = pi.getThinkingLevel();
    if (!await pi.setModel(model)) return false;
    if (pi.getThinkingLevel() !== thinkingLevel) pi.setThinkingLevel(thinkingLevel);
    return true;
  }

  // Resolves the long-context clone for a registry model. Returns undefined only when the session is closing.
  async function setupFor(model: Model<Api>, ctx: ExtensionContext): Promise<Setup | undefined> {
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
    const raw = await fetchCopilotCatalog(endpoint, auth.apiKey);
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
          const setup = await setupFor(model, ctx);
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
}
