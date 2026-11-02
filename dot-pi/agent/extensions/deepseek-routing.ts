// deepseek-routing.ts
//
// Keeps DeepSeek V4.1 Flash traffic on whichever provider is cheaper right now.
//
// DeepSeek bills two tiers by wall clock (peak = 2x off-peak, see
// shared/deepseek-schedule.ts). DeepInfra resells the same checkpoint
// (DeepSeek-V4.1-Flash-1017) at a flat rate. This extension registers both
// sides plus a virtual model, `deepseek/deepseek-flash-auto`, that picks a
// physical provider per request:
//
//   peak      -> DeepInfra
//   off-peak  -> DeepSeek, unless a DeepInfra promo beats it
//
// Neither tier is pre-decided. Every request compares the two cards at this
// machine's measured token mix and takes whichever is cheaper; the two lines
// above are just what that arithmetic returns for the rates in force on
// 2026-11-01. No branch in this file assumes DeepInfra wins at peak — a change
// to either card, or to the mix, changes the answer on its own.
//
// "Cheaper" is measured, not asserted axis by axis. `TOKEN_MIX` in
// shared/deepseek-schedule.ts records how this machine actually spends tokens
// (99.4% of every prompt is a cache read), and `cheaperOnMyMix` compares the
// two cards at that mix. The old every-axis test treated the three prices as
// equally important, which is wrong by a factor of ~290 — it demanded a 50%
// DeepInfra discount where the mix-weighted break-even is 42%.
//
//  - Promos. DeepInfra discounts its list price from time to time (51% off on
//    2026-11-01, so $0.098/$0.294/$0.00294). On those cards its list price is
//    already ahead at peak and far behind off-peak, so the promo is what makes
//    it the cheaper side at every hour — but that is a reading of the numbers,
//    not a rule the code encodes. DeepInfra publishes its rates publicly at
//    /v1/openai/models, so the extension refetches them each session instead of
//    trusting a hardcoded number.
//
//  - Failover. A retry after a provider-side error (5xx, 429, overload,
//    network) crosses to the other side for that one request, so a DeepSeek
//    peak-time outage or a DeepInfra blip does not stall the turn. The session
//    returns to the clock/price choice on the next user message. Router state
//    remembers the failover so the two sides cannot ping-pong.
//
// Provider selection is per *turn*, not per request: tool follow-ups stay on
// the provider that handled the turn (`request.previous`), which keeps the
// prompt cache warm. Only crossing a peak boundary or a failover costs a cache
// miss. Assistant messages record the physical model that answered, so a
// session that spans a boundary replays correctly and /session prices each
// side separately.
//
// Registering the provider here (rather than in models.json) is what lets the
// cost metadata track DeepInfra's live discount: models.json overrides compose
// above extension registrations, so a static cost there would win and freeze
// the per-token price at whatever was true when the file was written.
//
// Credentials: this file holds none. The DeepInfra key lives in
// ~/.pi/agent/auth.json as provider "deepinfra" (see README); the pricing
// endpoint needs no key at all.
//
// Portability: the virtual model is registered under the `deepseek` provider, so
// it exists only where DeepSeek has credentials — a machine without them never
// lists it and never runs this code. The DeepInfra side is gated per request:
// pi's find() returns catalog entries whose provider has no credentials and
// aborts a request routed to one, so resolve() prefers getAvailable() and falls
// back to hasConfiguredAuth() — the check pi itself applies — so a DeepSeek-only
// machine stays on DeepSeek instead of erroring.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CACHE_WRITE_RATE,
  DEEPINFRA_FLASH,
  DEEPINFRA_INPUT_MULTIPLIER,
  DEEPINFRA_LIST,
  DEEPSEEK_FLASH,
  PROVIDER_LABEL,
  RATES,
  ROUTER,
  cheaperOnMyMix,
  currentTier,
  deepseekCost,
  effectiveCost,
  otherSide,
  type ModelRef,
  type RateSet,
  type Tier,
} from "./shared/deepseek-schedule";

/** DeepInfra's model catalog, which carries list pricing and the discount. */
const MODELS_URL = "https://api.deepinfra.com/v1/openai/models";
const PRICING_TIMEOUT_MS = 5_000;

/** Both sides declare the same limits; the catalog agrees (1M ctx, 384K out). */
const CONTEXT_WINDOW = 1_000_000;
const MAX_TOKENS = 384_000;

/** Mirrors deepseek-flash in pi's catalog: off / low / high / max. */
const THINKING_LEVEL_MAP = {
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

/** Router state, stored on the session branch. */
interface RouterState {
  /** A retry already crossed providers; do not cross back. */
  failedOver?: true;
}

/** Minimal shapes of the pieces of pi's API this file relies on. */
interface CatalogModel extends ModelRef {
  name?: string;
}
interface RouteRequest {
  reason: "user" | "continuation" | "retry" | "direct";
  thinkingLevel: string;
  previous?: { model: CatalogModel; thinkingLevel?: string };
  failed?: {
    model: CatalogModel;
    thinkingLevel?: string;
    message: { errorMessage?: string; stopReason?: string };
  };
  state?: RouterState;
}
interface RouteContext {
  modelRegistry: {
    find(provider: string, id: string): CatalogModel | undefined;
    /** Credential-backed models; present in pi 1.4.0 (the subagents plugin uses it too). */
    getAvailable?(): CatalogModel[];
    /** pi's own pre-flight check; present in pi 1.4.0. */
    hasConfiguredAuth?(model: CatalogModel): boolean;
  };
}

/** Session-context surface used by the footer label (ExtensionContext fits). */
interface LabelContext {
  hasUI: boolean;
  model?: CatalogModel;
  ui: { setStatus(key: string, text: string | undefined): void };
}

/** Status key shared with nice-model-footer.ts. */
const STATUS_KEY = "deepseek-pricing";

/** Re-check cadence while a routed model is active (peak windows flip hourly). */
const REFRESH_MS = 60_000;

/**
 * Provider failures worth crossing over for. Deliberately excludes context
 * overflow, which pi fixes by compacting and retrying on the same model.
 */
const PROVIDER_FAILURE =
  /\b(429|5\d\d)\b|overload|rate.?limit|too many requests|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network error|upstream/i;
const NOT_A_PROVIDER_FAILURE =
  /context.?length|context window|maximum context|prompt is too long|too many tokens/i;

function looksLikeProviderFailure(message: { errorMessage?: string; stopReason?: string } | undefined): boolean {
  const text = `${message?.errorMessage ?? ""} ${message?.stopReason ?? ""}`;
  if (!text.trim()) return false;
  if (NOT_A_PROVIDER_FAILURE.test(text)) return false;
  return PROVIDER_FAILURE.test(text);
}

/** Read DeepInfra's current effective rate for our checkpoint, if reachable. */
async function fetchDeepInfraCost(): Promise<RateSet | undefined> {
  const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(PRICING_TIMEOUT_MS) });
  if (!res.ok) return undefined;
  const body = (await res.json()) as {
    data?: { id?: string; metadata?: { pricing?: Record<string, unknown>; discount?: unknown } }[];
  };
  const entry = body.data?.find((model) => model.id === DEEPINFRA_FLASH.id);
  const pricing = entry?.metadata?.pricing;
  const input = pricing?.input_tokens;
  const output = pricing?.output_tokens;
  const cacheRead = pricing?.cache_read_tokens;
  // Cache reads are 99.4% of the weight, so a missing figure must not be read as
  // "free": that would make DeepInfra win every hour regardless of its price.
  if (typeof input !== "number" || typeof output !== "number" || typeof cacheRead !== "number") {
    return undefined;
  }
  const discount = typeof entry?.metadata?.discount === "number" ? entry.metadata.discount : 0;
  return effectiveCost({ input, output, cacheRead }, discount);
}

/**
 * Lowercased "provider/id" of every model whose provider has credentials, or
 * undefined when the registry cannot answer (then callers fall back to trust
 * `find()`, which is what pi would do). An empty snapshot is "cannot answer":
 * it is a cache, and an unpopulated one must not read as "nothing is usable".
 */
function availableIds(ctx: RouteContext): Set<string> | undefined {
  try {
    const available = ctx.modelRegistry.getAvailable?.();
    if (!Array.isArray(available) || available.length === 0) return undefined;
    return new Set(available.map((model) => `${model.provider}/${model.id}`.toLowerCase()));
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  // DeepInfra's rate, replaced by the live figure once the fetch lands. Seeded
  // with LIST price, not with the current promo: seeding with a discount would
  // route the first requests of every session on an assumption, and a session
  // whose fetch fails would route on it for its whole life — exactly the
  // assume-it-is-cheaper failure this router exists to avoid. At list price the
  // arithmetic is conservative: peak still goes to DeepInfra, off-peak stays on
  // DeepSeek.
  let deepInfraCost: RateSet = DEEPINFRA_LIST;

  /**
   * The live pricing fetch, shared by the session-start prefetch and by
   * `route()` so a cold session does not have to choose on list price. pi
   * awaits `route()`, so awaiting here costs latency only when the fetch has
   * not finished, and it is bounded by `PRICING_TIMEOUT_MS` either way.
   */
  let pricing: Promise<RateSet | undefined> | undefined;

  function refreshPricing(): Promise<RateSet | undefined> {
    pricing ??= fetchDeepInfraCost().catch(() => undefined);
    return pricing;
  }

  /**
   * Register (or re-register) the DeepInfra side with `cost`. Re-registration
   * takes effect immediately for subsequent requests; a failure here must
   * never break the session, since DeepSeek direct still works.
   */
  function registerDeepInfra(cost: RateSet): void {
    try {
      pi.registerProvider("deepinfra", {
        name: "DeepInfra",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        api: "openai-completions",
        models: [
          {
            id: DEEPINFRA_FLASH.id,
            name: "Deepseek v4.1 Flash 1017 (DeepInfra)",
            reasoning: true,
            input: ["text", "image"],
            cost: {
              input: cost.input,
              output: cost.output,
              cacheRead: cost.cacheRead,
              cacheWrite: CACHE_WRITE_RATE,
            },
            contextWindow: CONTEXT_WINDOW,
            maxTokens: MAX_TOKENS,
            thinkingLevelMap: THINKING_LEVEL_MAP,
            // DeepInfra speaks plain OpenAI here: reasoning_effort (all six
            // levels verified accepted 2026-11-01), max_tokens, streamed usage,
            // cached_tokens. Not DeepSeek's thinking.type, which it ignores.
            compat: {
              thinkingFormat: "openai",
              supportsReasoningEffort: true,
              maxTokensField: "max_tokens",
            },
          },
        ],
      });
    } catch (error) {
      // Keep the session alive on DeepSeek direct; note it for /reload triage.
      console.error(`deepseek-routing: could not register deepinfra: ${String(error)}`);
    }
  }

  // Baseline first, so the model is selectable before any network call.
  registerDeepInfra(deepInfraCost);

  /** One stderr note per streak of requests routed without the snapshot. */
  let warnedStaleSnapshot = false;

  /** Which side to use for `tier`, given the current DeepInfra price. */
  function chooseSide(tier: Tier): ModelRef {
    return cheaperOnMyMix(deepInfraCost, deepseekCost(tier), DEEPINFRA_INPUT_MULTIPLIER)
      ? DEEPINFRA_FLASH
      : DEEPSEEK_FLASH;
  }

  // ---- footer indicator ---------------------------------------------------
  // One writer for the "deepseek-pricing" status: this extension knows both the
  // billing tier and where the router will send the request. Showing the target
  // only for the router keeps a plain deepseek/deepseek-flash selection reading
  // as a bare "peak" / "off-peak".
  let activeCtx: LabelContext | undefined;
  let activeModel: CatalogModel | undefined;
  let appliedText: string | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  function stopRefresh(): void {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  /** The footer label for `model` right now, or undefined to clear it. */
  function labelFor(model: CatalogModel | undefined): string | undefined {
    if (!model || model.provider !== "deepseek") return undefined;
    const tier = currentTier();
    if (model.id === ROUTER.id) return `${tier} → ${PROVIDER_LABEL[chooseSide(tier).provider]}`;
    // A directly selected DeepSeek model: show the tier it bills at.
    if (RATES[model.id]) return tier;
    return undefined;
  }

  /**
   * Publish the label for `model`. `force` republishes an unchanged label, used
   * at session boundaries so the footer always reflects the live state.
   */
  function updateLabel(ctx: LabelContext, model: CatalogModel | undefined, force = false): void {
    activeCtx = ctx;
    activeModel = model;
    const text = labelFor(model);
    if (force || text !== appliedText) {
      appliedText = text;
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
    }
    if (text === undefined) {
      stopRefresh();
      return;
    }
    // Keep the label truthful while idle: a peak boundary can cross mid-session
    // without any model change or message traffic.
    if (refreshTimer === undefined) {
      refreshTimer = setInterval(() => {
        const fresh = labelFor(activeModel);
        if (fresh !== undefined && fresh !== appliedText && activeCtx?.hasUI) {
          appliedText = fresh;
          activeCtx.ui.setStatus(STATUS_KEY, fresh);
        }
      }, REFRESH_MS);
    }
  }

  // Show the label before the first request of a session (startup, resume, fork).
  pi.on("session_start", (_event, ctx) => {
    updateLabel(ctx, ctx.model, true);
  });

  // React to /model, Ctrl+P cycling, and session restore.
  pi.on("model_select", (event, ctx) => {
    updateLabel(ctx, event.model);
  });

  // Extensions are rebound per session; drop session-scoped state and timer.
  pi.on("session_shutdown", () => {
    stopRefresh();
    activeCtx = undefined;
    activeModel = undefined;
    appliedText = undefined;
    warnedStaleSnapshot = false;
    pricing = undefined;
  });

  /** The catalog entry for `ref`, whatever the availability snapshot says. */
  function findInCatalog(ctx: RouteContext, ref: ModelRef | undefined): CatalogModel | undefined {
    if (!ref) return undefined;
    try {
      return ctx.modelRegistry.find(ref.provider, ref.id);
    } catch {
      return undefined;
    }
  }

  /** Whether pi would accept a request for `model` (unknown counts as yes). */
  function hasCredentials(ctx: RouteContext, model: CatalogModel): boolean {
    try {
      return ctx.modelRegistry.hasConfiguredAuth?.(model) !== false;
    } catch {
      return true;
    }
  }

  /** Resolve a side in the catalog; undefined when it is not usable. */
  function resolve(
    ctx: RouteContext,
    ref: ModelRef | undefined,
    available: Set<string> | undefined,
  ): CatalogModel | undefined {
    if (!ref) return undefined;
    // `find()` returns catalog entries even for providers with no credentials,
    // and pi aborts a request routed to one. So the snapshot gates the choice
    // while it has an answer, and `hasConfiguredAuth()` — the check pi itself
    // applies, which reads the same snapshot — takes over when it does not.
    // Trusting that one can never pick a side pi would refuse.
    const found = findInCatalog(ctx, ref);
    if (!found) return undefined;
    if (available) return available.has(`${ref.provider}/${ref.id}`.toLowerCase()) ? found : undefined;
    return hasCredentials(ctx, found) ? found : undefined;
  }

  /**
   * The side to use for this request, preferring `ref` and falling back to the
   * other side when that one is not in the catalog.
   *
   * The availability snapshot decides only the preference, never the verdict.
   * pi serves `getAvailable()` from a cache it refreshes asynchronously, so a
   * provider registration or a session start can leave it stale; `route()`
   * throwing ends the request with an error pi does not retry, and every
   * request — user, continuation and retry — comes through here, so a snapshot
   * that has not caught up must not be able to end the turn. Confirm against
   * the catalog before failing a request.
   *
   * Neither can a stale *credential* snapshot be worked around here. pi checks
   * credentials again on whatever `route()` returns — "If `route()` throws, or
   * returns a virtual model or a model without credentials, the request ends
   * with an error response" (docs/virtual-models.md), implemented in
   * `resolveModel` as `hasConfiguredAuth(target.provider)` right after the
   * awaited `route()` — and that reads the same snapshot this file reads. So a
   * return value cannot bypass it: handing back the catalog entry would only
   * trade this error for pi's own, which names the routed model and blames a
   * credential. Throwing here is the whole remedy available to an extension;
   * the way out is `/reload`, which rebuilds the registry, and the message says
   * so.
   */
  function resolveEither(ctx: RouteContext, ref: ModelRef): CatalogModel {
    const available = availableIds(ctx);
    const wanted = resolve(ctx, ref, available) ?? resolve(ctx, otherSide(ref), available);
    if (wanted) {
      if (available === undefined) {
        note(`availability snapshot is empty; routed to ${wanted.provider}/${wanted.id} without it`);
      } else {
        warnedStaleSnapshot = false;
      }
      return wanted;
    }
    const fallback = pickConfigured(ctx, [ref, otherSide(ref)]);
    if (fallback) {
      note(`availability snapshot omitted ${fallback.provider}/${fallback.id}; using the catalog entry`);
      return fallback;
    }
    const other = otherSide(ref);
    throw new Error(
      `deepseek-routing: neither ${ref.provider}/${ref.id} nor ${other?.provider}/${other?.id} is usable ` +
        `— no credentials, or missing from the catalog. The model registry looks stale: run /reload, or ` +
        `restart, to rebuild it. If that persists, check the deepinfra credential in ~/.pi/agent/auth.json`,
    );
  }

  /** One stderr note per streak of requests the snapshot could not place. */
  function note(message: string): void {
    if (warnedStaleSnapshot) return;
    warnedStaleSnapshot = true;
    console.error(`deepseek-routing: ${message}`);
  }
  /** The first of `refs` that is in the catalog and has credentials. */
  function pickConfigured(ctx: RouteContext, refs: (ModelRef | undefined)[]): CatalogModel | undefined {
    for (const ref of refs) {
      const found = findInCatalog(ctx, ref);
      if (found && hasCredentials(ctx, found)) return found;
    }
    return undefined;
  }

  pi.registerVirtualModel<RouterState>({
    provider: ROUTER.provider,
    id: ROUTER.id,
    name: "Deepseek v4.1 Flash Auto",
    // Same levels pi offers for deepseek-flash.
    thinkingLevels: ["off", "low", "high", "max"],
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    input: ["text", "image"],
    async route(request: RouteRequest, ctx: RouteContext) {
      const tier = currentTier();

      // Tool follow-ups and steering mid-turn: stay where the turn started, so
      // the prompt cache survives. Crossing a peak boundary mid-turn would cost
      // more than the per-token difference it saves.
      if (request.reason === "continuation") {
        const previous = request.previous?.model;
        if (previous && (previous.provider === DEEPSEEK_FLASH.provider || previous.provider === DEEPINFRA_FLASH.provider)) {
          return { model: resolveEither(ctx, previous), thinkingLevel: request.thinkingLevel };
        }
      }

      // A retry: cross to the other side once, for provider-side failures only.
      if (request.reason === "retry") {
        const failed = request.failed;
        if (failed?.model && !request.state?.failedOver && looksLikeProviderFailure(failed.message)) {
          const other = otherSide(failed.model);
          const target = resolve(ctx, other);
          if (other && target) {
            return {
              model: target,
              thinkingLevel: request.thinkingLevel,
              state: { failedOver: true },
            };
          }
        }
        if (failed?.model) {
          return { model: resolveEither(ctx, failed.model), thinkingLevel: request.thinkingLevel };
        }
      }

      // A fresh user message (or a direct request such as a compaction summary)
      // starts a new decision. Wait for the live price first, so the decision is
      // never made on the seeded list price when the real one is a request away;
      // pi awaits `route()`, and the wait is bounded by the fetch timeout.
      // Continuations and retries above deliberately skip it — they must not
      // spend latency mid-turn.
      await refreshPricing();
      const target = resolveEither(ctx, chooseSide(currentTier()));
      return {
        model: target,
        thinkingLevel: request.thinkingLevel,
        state: request.state?.failedOver ? {} : undefined,
      };
    },
  });

  // Pick up DeepInfra's current discount once a session exists (never in the
  // factory, which also runs for --list-models and other one-shot invocations).
  pi.on("session_start", () => {
    void refreshPricing().then((cost) => {
      // Offline, or DeepInfra is having a bad day: list price and DeepSeek
      // direct keep working.
      if (!cost) return;
      const changed =
        cost.input !== deepInfraCost.input ||
        cost.output !== deepInfraCost.output ||
        cost.cacheRead !== deepInfraCost.cacheRead;
      if (!changed) return;
      deepInfraCost = cost;
      registerDeepInfra(cost);
    });
  });
}
