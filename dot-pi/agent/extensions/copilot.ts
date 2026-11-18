import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withCopilotBilling } from "./shared/copilot-billing";
import { withCopilotCatalog } from "./shared/copilot-catalog";
import { COPILOT_PROVIDER, isCopilotChatModel } from "./shared/copilot-long-context";

export default async function (pi: ExtensionAPI) {
  // Use the same built-in provider as this Pi version, before models.json is
  // composed on top. No package subpath or duplicate Copilot OAuth flow needed.
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
  });
  const base = runtime.getProvider(COPILOT_PROVIDER);
  if (!base) return;
  const { provider, clamp, hasLiveCatalog } = withCopilotCatalog(base);
  pi.registerProvider(withCopilotBilling(provider));

  async function clampSelection(ctx: ExtensionContext) {
    const model = ctx.model;
    if (!model || !ctx.isIdle()) return;
    const bounded = clamp(model);
    if (bounded === model) return;
    const thinkingLevel = pi.getThinkingLevel();
    if (await pi.setModel(bounded) && pi.getThinkingLevel() !== thinkingLevel) pi.setThinkingLevel(thinkingLevel);
  }

  function refresh(ctx: ExtensionContext, force = false) {
    return ctx.modelRegistry.refresh({ providers: [COPILOT_PROVIDER], force, signal: AbortSignal.timeout(force ? 10_000 : 3_000) });
  }

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_OFFLINE !== undefined || !ctx.model ||
      !(isCopilotChatModel(ctx.model) || ctx.model.provider === "copilot-fusion")) return;
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
      const result = await refresh(ctx, true);
      if (result.aborted || result.errors.has(COPILOT_PROVIDER) || !hasLiveCatalog()) {
        ctx.ui.notify("Copilot catalog refresh failed; keeping existing models.", "warning");
        return;
      }
      await clampSelection(ctx);
      const count = ctx.modelRegistry.getAvailable().filter((model) => model.provider === COPILOT_PROVIDER).length;
      ctx.ui.notify(`Copilot catalog: ${count} available chat models.`, "info");
    },
  });
}
