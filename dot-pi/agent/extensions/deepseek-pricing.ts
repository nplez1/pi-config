// deepseek-pricing.ts
//
// DeepSeek bills two rate tiers by time of day (peak = 2x off-peak):
//   Peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday.
// pi's built-in model catalog stores ONE static rate per field, so pi cannot
// model this itself. This extension rewrites usage.cost per message at
// message_end, using the message's own timestamp to pick peak vs off-peak
// rates. Session totals are summed from stored message costs, so correcting
// here makes the footer, /session, and RPC totals accurate.
//
// Rates are per 1M tokens, USD — from
// https://api-docs.deepseek.com/quick_start/pricing (re-verified 2026-09-12).
// DeepSeek V4.1 Flash replaced V4 Flash: the live /models endpoint now lists
// only `deepseek-flash` and `deepseek-v4-pro`. The retired `deepseek-v4-flash`
// and `deepseek-v4-flash-vision-exp` ids are still accepted and served as
// V4.1 Flash at Flash prices, so they are kept below as aliases — a session
// saved before the rename restores its id verbatim and still prices right.
//
// Complemented by a static off-peak cost override in ~/.pi/agent/models.json,
// which keeps the in-flight streaming estimate (before message_end fires) and
// the /model picker display on realistic numbers.
//
// The footer tier indicator ("peak"/"off-peak", rendered by
// nice-model-footer.ts) is refreshed from session_start and model_select, so
// it appears as soon as a deepseek model is selected — before the first
// message is ever sent — and it is cleared when the active model leaves
// deepseek. A minute-level timer re-checks the tier while a deepseek model is
// active so the label stays truthful when wall time crosses a peak boundary
// mid-session without any message traffic.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RateSet {
  input: number;
  output: number;
  cacheRead: number;
}

const CACHE_WRITE_RATE = 0; // DeepSeek has no cache-write pricing.

const FLASH_RATES: { offPeak: RateSet; peak: RateSet } = {
  offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003 },
  peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
};

const RATES: Record<string, { offPeak: RateSet; peak: RateSet }> = {
  // DeepSeek V4.1 Flash (current id).
  "deepseek-flash": FLASH_RATES,
  // Retired ids, served as V4.1 Flash — see header note.
  "deepseek-v4-flash": FLASH_RATES,
  "deepseek-v4-flash-vision-exp": FLASH_RATES,
  "deepseek-v4-pro": {
    offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
  },
};

/** Peak hours: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri (half-open intervals). */
function isPeak(timestamp: number): boolean {
  const d = new Date(timestamp);
  const day = d.getUTCDay(); // 0 = Sunday
  if (day === 0 || day === 6) return false;
  const hour = d.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** Minimum shape of a model (provider + bare id, e.g. "deepseek-v4-flash"). */
interface TierModel {
  provider: string;
  id: string;
}

/** Session-context surface this extension relies on (ExtensionContext fits). */
interface TierContext {
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void };
}

/**
 * Tier label for a deepseek model we have rates for ("peak"/"off-peak"),
 * computed against the current wall clock. Returns undefined for every other
 * model — which also means the footer indicator should be cleared.
 */
function currentTier(model: TierModel | undefined): string | undefined {
  if (!model || model.provider !== "deepseek") return undefined;
  if (!RATES[model.id]) return undefined;
  return isPeak(Date.now()) ? "peak" : "off-peak";
}

/** Re-check cadence while a deepseek model is active (peak windows flip hourly). */
const TIER_REFRESH_MS = 60_000;

export default function (pi: ExtensionAPI) {
  // ---- footer indicator: shown from selection, before any message is sent ----
  // State is per extension instance and tracks the active session's UI.
  let activeUI: TierContext | undefined;
  let activeModel: TierModel | undefined;
  let appliedText: string | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  function stopRefresh(): void {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  /**
   * Recompute the tier for `model` and publish it to the footer via `ctx`'s
   * UI. A non-deepseek model (or none) clears the indicator. `force`
   * republishes even when the label is unchanged (used at session boundaries
   * so the footer always reflects the current session state).
   */
  function updateTier(ctx: TierContext, model: TierModel | undefined, force = false): void {
    activeUI = ctx;
    activeModel = model;
    const text = currentTier(model);
    if (force || text !== appliedText) {
      appliedText = text;
      if (ctx.hasUI) ctx.ui.setStatus("deepseek-pricing", text);
    }
    if (text && ctx.hasUI) {
      // Keep the label truthful while idle: the peak/off-peak boundary can
      // flip mid-session without any model change or message traffic.
      if (refreshTimer === undefined) {
        refreshTimer = setInterval(() => {
          const fresh = currentTier(activeModel);
          if (fresh !== undefined && fresh !== appliedText && activeUI?.hasUI) {
            appliedText = fresh;
            activeUI.ui.setStatus("deepseek-pricing", fresh);
          }
        }, TIER_REFRESH_MS);
      }
    } else {
      stopRefresh();
    }
  }

  // Show the tier right when a session starts on a deepseek model (startup,
  // resume, new, fork) — before any request is made.
  pi.on("session_start", (_event, ctx) => {
    updateTier(ctx, ctx.model, true);
  });

  // React to /model, Ctrl+P cycling, and session restore: reflect the newly
  // selected model immediately, clearing the indicator when leaving deepseek.
  pi.on("model_select", (event, ctx) => {
    updateTier(ctx, event.model);
  });

  // Extensions are rebound per session; drop session-scoped state and timer.
  pi.on("session_shutdown", () => {
    stopRefresh();
    activeUI = undefined;
    activeModel = undefined;
    appliedText = undefined;
  });

  pi.on("message_end", (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    if (msg.provider !== "deepseek") return;
    const rates = RATES[msg.model];
    if (!rates || !msg.usage) return;

    const peak = isPeak(msg.timestamp);
    const basis = peak ? rates.peak : rates.offPeak;
    const { input, output, cacheRead, cacheWrite } = msg.usage;

    const cost = {
      input: (basis.input / 1e6) * input,
      output: (basis.output / 1e6) * output,
      cacheRead: (basis.cacheRead / 1e6) * cacheRead,
      cacheWrite: (CACHE_WRITE_RATE / 1e6) * cacheWrite,
      total: 0,
    };
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;

    // Belt-and-suspenders re-sync from the message itself (normally
    // session_start / model_select / the timer already have it right).
    updateTier(ctx, { provider: msg.provider, id: msg.model });

    return {
      message: {
        ...msg,
        usage: { ...msg.usage, cost },
      },
    };
  });
}
