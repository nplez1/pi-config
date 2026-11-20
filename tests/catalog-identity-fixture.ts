// Reports, once per session start, what the catalog provider registration looks
// like from inside the registry. The extension being reviewed wraps whatever
// serves github-copilot and marks it, and a /reload has to unwrap to the same
// base instead of stacking another layer: this fixture is how the test sees it.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CATALOG_BASE = Symbol.for("pi-config.copilot.catalog-base");
const PROVIDER = "github-copilot";

type State = { base?: unknown };
// Survives a /reload even when the extension module is evaluated again.
const state = globalThis as { __catalogIdentity?: State };
state.__catalogIdentity ??= {};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload-identity-fixture", { async handler(_args, ctx) { await ctx.reload(); } });

  pi.on("session_start", (_event, ctx) => {
    const registry = ctx.modelRegistry;
    const registered = registry.getRegisteredNativeProvider?.(PROVIDER);
    const base = registered ? registered[CATALOG_BASE] : undefined;
    const known = state.__catalogIdentity!;
    const report = {
      registered: registered !== undefined,
      marked: base !== undefined,
      // A fresh layer must be this plugin's unwrapped base, not the provider it
      // wrapped on an earlier start.
      sameBaseAsFirstStart: base !== undefined && (known.base === undefined || known.base === base),
      baseIsTheRegistration: base !== undefined && base === registered,
      models: [...new Set((registry.getProvider(PROVIDER)?.getModels() ?? []).map((model) => model.id))].sort(),
    };
    known.base ??= base;
    const path = process.env.COPILOT_IDENTITY_REPORT;
    if (path) appendFileSync(path, `${JSON.stringify(report)}\n`);
  });
}
