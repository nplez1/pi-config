import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  COPILOT_CONTEXT_API_VERSION, CopilotCatalogError, copilotLongContext, copilotVersionHeader,
  fetchCopilotCatalog, isCopilotChatModel, isDirectCopilotEndpoint, longContextHeaders,
} from "./shared/copilot-long-context";

export default function (pi: ExtensionAPI) {
  // Use a session-local clone so Pi gets both the new budget and the request header.
  // The registry and settings (including the current model ID) stay unchanged.
  const originals = new WeakMap<Model<Api>, Model<Api>>();
  let switching = false;
  let closing = false;

  async function select(model: Model<Api>): Promise<boolean> {
    const thinkingLevel = pi.getThinkingLevel();
    if (!await pi.setModel(model)) return false;
    if (pi.getThinkingLevel() !== thinkingLevel) pi.setThinkingLevel(thinkingLevel);
    return true;
  }

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
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (closing) return;
          if (!auth.ok || !auth.apiKey) {
            ctx.ui.notify("Could not resolve Copilot credentials. Check /login.", "warning");
            return;
          }
          const endpoint = auth.baseUrl ?? model.baseUrl;
          if (!isDirectCopilotEndpoint(endpoint)) {
            ctx.ui.notify("Long context is only supported on direct GitHub Copilot endpoints.", "info");
            return;
          }
          // Configured headers can take precedence over model metadata in Pi's transports.
          if (Object.entries(auth.headers ?? {}).some(([key, value]) => copilotVersionHeader(key) && value !== COPILOT_CONTEXT_API_VERSION)) {
            ctx.ui.notify("A configured Copilot API version conflicts with long context. No changes were made.", "warning");
            return;
          }
          const raw = await fetchCopilotCatalog(endpoint, auth.apiKey);
          if (closing) return;
          const limits = copilotLongContext(raw, model, auth.baseUrl);
          if (!limits) {
            ctx.ui.notify("The selected Copilot model has no supported long-context tier on this account.", "info");
            return;
          }
          const { defaultPrompt, contextWindow, maxTokens } = limits;
          next = { ...model, contextWindow, maxTokens, headers: longContextHeaders(model.headers) };
          notice = `Long context enabled for ${model.name}: ${defaultPrompt.toLocaleString()} → ${contextWindow.toLocaleString()} prompt tokens. Larger prompts may use more AI credits.`;
        }
        if (ctx.model !== model || !ctx.isIdle()) {
          ctx.ui.notify("The session changed during the lookup. No changes were made.", "warning");
          return;
        }
        if (!await select(next)) throw new CopilotCatalogError("Could not apply the Copilot context settings. Check /login.");
        if (closing) return;
        if (!original) originals.set(next, model);
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
