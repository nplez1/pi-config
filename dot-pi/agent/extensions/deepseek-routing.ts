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
// on DeepSeek (99.4% of every prompt is a cache read), and `cheaperAtPrompt`
// compares the two cards at that mix. The old every-axis test treated the three
// prices as equally important, which is wrong by a factor of ~290 — it demanded
// a 50% DeepInfra discount where the mix-weighted break-even is ~37%.
//
// The comparison also has to price the tokens DeepInfra would actually bill, and
// that is not a constant: DeepInfra's cache degrades with CONTEXT SIZE while
// DeepSeek's improves, so `cheaperAtPrompt` prices BOTH sides at the miss share
// measured for this session's latest prompt size. A single scalar here was right
// only for the ~160K band this machine happens to live in; at 524K+ it kept
// choosing DeepInfra for a context where the two cards reach parity.
//
//  - Promos. DeepInfra discounts its list price from time to time (51% off on
//    2026-11-01, so $0.098/$0.294/$0.00294). On those cards its list price is
//    already ahead at peak and far behind off-peak, so the promo is what makes
//    it the cheaper side at every hour for a short prompt — but that is a
//    reading of the numbers, not a rule the code encodes, and it stops being
//    true past 524K tokens where DeepInfra's cache penalty outweighs it.
//    DeepInfra publishes its rates publicly at
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
// machine stays on DeepSeek instead of erroring. A cached verdict that says
// "no" is repaired rather than trusted: a live `getProviderAuth()` plus a
// re-registration put the provider back into the catalog and the credential
// cache pi reads, which is what makes a stale registry cost one stderr line
// instead of a dead turn.
//
//  - A dead context is not a credential problem, and conflating the two is what
//    made one failure recur. Every field of the context `route()` is handed is a
//    getter that begins with the extension runner's staleness check, so once pi
//    replaces or reloads the session behind this registration — `/new`, `/fork`,
//    `/resume`, `/reload`, or another session's runner in the same process —
//    *every* registry read throws at once. That reads exactly like "neither side
//    has a credential": same shape, both sides, with nothing wrong with either
//    key, and the recovery chain above cannot help because it re-checks the same
//    dead context. So `route()` recognises that state and answers with the last
//    physical model it knows to be good instead of ending the turn, and a guard
//    around the whole of `route()` does the same for anything this file has not
//    anticipated. pi re-checks credentials on what `route()` returns, so the
//    worst case becomes pi's own accurate error rather than a dead turn.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CACHE_WRITE_RATE,
  DEEPINFRA_FLASH,
  DEEPINFRA_LIST,
  DEEPSEEK_FLASH,
  PROVIDER_LABEL,
  RATES,
  ROUTER,
  cheaperAtPrompt,
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
/**
 * What the registry says about one side. Gathered only on the failure path, so
 * a healthy request pays nothing for it.
 */
interface SideState {
  /** The catalog still lists the model. */
  catalog: boolean;
  /** pi's cached credential verdict; undefined when the registry cannot say. */
  snapshot: boolean | undefined;
  /** Where the credential store reports the provider from, or "none". */
  store: string;
  /** A live credential resolution, which never reads the cached verdict. */
  live: boolean | undefined;
}

interface RouteContext {
  modelRegistry: {
    find(provider: string, id: string): CatalogModel | undefined;
    /** Credential-backed models; present in pi 1.4.0 (the subagents plugin uses it too). */
    getAvailable?(): CatalogModel[];
    /** pi's own pre-flight check; present in pi 1.4.0. */
    hasConfiguredAuth?(model: CatalogModel): boolean;
    /**
     * Resolve a provider's credential the way a request would — live, without
     * reading the cached verdict. The one check that cannot be stale.
     */
    getProviderAuth?(provider: string): Promise<unknown>;
    /** Where the credential store reports a provider from, without resolving it. */
    getProviderAuthStatus?(provider: string): { configured: boolean; source?: string } | undefined;
    /** Composition and availability errors, for triage; present in pi 1.5.0. */
    getError?(): string | undefined;
    /**
     * Rebuild the provider/credential snapshot, scoped by `providers` — the
     * programmatic form of `/reload`; present in pi 1.4.0.
     */
    refresh?(options?: { allowNetwork?: boolean; providers?: string[] }): Promise<unknown>;
  };
}

/**
 * A verdict this file means to report: the registry is readable and positively
 * says no request can be served. A distinct class so the guard around `route()`
 * can tell a deliberate verdict from an unexpected failure and only rescue the
 * latter — a real missing credential deserves the message, not a retry.
 */
class RouteFailure extends Error {}

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
   *
   * It owns applying the result as well as fetching it. Assigning
   * `deepInfraCost` from a separate `.then()` would work only by promise
   * callback order — the prefetch's handler registered first, the awaited one
   * second — and a route that reached here with no prefetch pending would then
   * wait for the fetch and decide on list price anyway.
   */
  let pricing: Promise<RateSet | undefined> | undefined;

  function refreshPricing(): Promise<RateSet | undefined> {
    pricing ??= fetchDeepInfraCost()
      .catch(() => undefined)
      .then((cost) => {
        // Offline, or DeepInfra is having a bad day: list price and DeepSeek
        // direct keep working.
        if (!cost) return undefined;
        const changed =
          cost.input !== deepInfraCost.input ||
          cost.output !== deepInfraCost.output ||
          cost.cacheRead !== deepInfraCost.cacheRead;
        if (!changed) return cost;
        deepInfraCost = cost;
        registerDeepInfra(cost);
        // The footer label is computed at session start, before this lands.
        if (activeCtx && activeModel) updateLabel(activeCtx, activeModel, true);
        return cost;
      });
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

  /**
   * The largest prompt this session has sent, in tokens — the size
   * `cheaperAtPrompt` prices both cards at. `route()` is handed no token count,
   * so the last turn's usage is the estimate: the next prompt is that plus the
   * new content, which cannot move it across a band by itself. Assistant
   * messages on either side count, because the prompt is the same conversation
   * either way.
   */
  let promptTokens: number | undefined;

  /** Which side to use for `tier`, at this session's prompt size and price. */
  function chooseSide(tier: Tier): ModelRef {
    return cheaperAtPrompt(deepInfraCost, deepseekCost(tier), promptTokens)
      ? DEEPINFRA_FLASH
      : DEEPSEEK_FLASH;
  }

  /**
   * The physical model objects this session has actually seen, by provider.
   *
   * A dead context cannot read the catalog at all, and pi needs a model *object*
   * rather than an id, so the last good object is the only thing that can keep
   * the turn alive. Seeded at `session_start`, refreshed on every decision, and
   * topped up from `request.previous` / `request.failed`, which pi supplies for
   * the two reasons the context has been observed to die on.
   */
  const known = new Map<string, CatalogModel>();

  function remember(model: CatalogModel | undefined): void {
    if (!model) return;
    if (model.provider !== DEEPSEEK_FLASH.provider && model.provider !== DEEPINFRA_FLASH.provider) return;
    known.set(model.provider, model);
  }

  /** The last model this session used from `ref`'s provider, if any. */
  function knownSide(ref: ModelRef | undefined): CatalogModel | undefined {
    return ref ? known.get(ref.provider) : undefined;
  }

  /**
   * The physical model to keep the turn alive on, best first: the one that just
   * answered, the one that just failed, then anything this session has routed to.
   * Undefined only for a session that has never routed at all.
   */
  function lastKnown(request: RouteRequest): CatalogModel | undefined {
    const preferred = chooseSide(currentTier());
    return (
      request.previous?.model ??
      request.failed?.model ??
      knownSide(preferred) ??
      knownSide(otherSide(preferred))
    );
  }

  /** The first line of an error, for a one-line stderr note. */
  function firstLine(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split("\n")[0];
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
    // The context is fresh here, so this is the one moment the catalog can be
    // read for free. Whatever dies later, both sides now have a model object.
    for (const side of [DEEPSEEK_FLASH, DEEPINFRA_FLASH]) remember(findInCatalog(ctx, side));
  });

  // React to /model, Ctrl+P cycling, and session restore.
  pi.on("model_select", (event, ctx) => {
    updateLabel(ctx, event.model);
  });

  // Track the prompt size that `cheaperAtPrompt` prices, so the DeepInfra cache
  // penalty follows the context instead of a constant. Only the two routed
  // sides matter; a virtual-model or unrelated-provider message says nothing
  // about the prompt these cards would be billed for.
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    if (msg.provider !== DEEPSEEK_FLASH.provider && msg.provider !== DEEPINFRA_FLASH.provider) return;
    const usage = msg.usage;
    if (!usage) return;
    const tokens = (usage.input ?? 0) + (usage.cacheRead ?? 0);
    if (tokens > 0) promptTokens = tokens;
  });

  // Extensions are rebound per session; drop session-scoped state and timer.
  pi.on("session_shutdown", () => {
    stopRefresh();
    activeCtx = undefined;
    activeModel = undefined;
    appliedText = undefined;
    warnedStaleSnapshot = false;
    pricing = undefined;
    promptTokens = undefined;
    known.clear();
    // Back to list price, so a later session whose fetch fails does not inherit
    // this one's discount.
    deepInfraCost = DEEPINFRA_LIST;
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
    /** The availability snapshot, when one can answer; omitted to trust the catalog. */
    available?: Set<string> | undefined,
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
   * A stale *credential* snapshot is recoverable, and on resume it is the
   * likeliest failure there is: `session_start` re-registers the DeepInfra
   * side, the full availability refresh that follows replaces
   * `configuredProviders` wholesale from live `checkAuth` results, and the
   * first request of a resumed session can arrive while that set is
   * momentarily empty — which reads as "neither provider has a key". pi does
   * not trust the snapshot for this either; its send path accepts
   * `hasConfiguredAuth(provider) || await checkAuth(provider)`. The registry
   * exposes the same live check as `refresh({ providers })`, so re-check and
   * re-resolve before failing. Returning the catalog entry alone would not do:
   * pi re-checks credentials on whatever `route()` returns ("If `route()`
   * throws, or returns a virtual model or a model without credentials, the
   * request ends with an error response", docs/virtual-models.md, implemented
   * in `resolveModel` as `hasConfiguredAuth(target.provider)` after the awaited
   * `route()`) — but that check reads the snapshot the refresh has just
   * rebuilt, so recovering the snapshot recovers the turn.
   *
   * When even that re-check leaves the snapshot saying "no", the two things pi
   * reads are repaired instead of trusted: `getProviderAuth()` resolves the
   * credential without consulting the cache at all, and `registerProvider()`
   * both restores a lost registration and marks a provider configured when the
   * credential store has it. Both are skipped unless the live resolution proved
   * the side usable, so a genuinely missing key still fails — with a message
   * that names which of the four facts disagreed.
   *
   * A dead *context* is checked for first, because it is the one failure the
   * chain above cannot fix and the one it used to misreport: once pi has replaced
   * or reloaded the session, every registry read throws, which is indistinguishable
   * from "neither side has a key" to a reader of the four facts. There the router
   * answers with the last model it saw work and says so.
   */
  async function resolveEither(ctx: RouteContext, ref: ModelRef): Promise<CatalogModel> {
    const decided = decide(ctx, ref);
    if (decided) return decided;

    // A dead context cannot be re-checked, probed or repaired — every one of
    // those reads the same invalidated runner, so the chain below would report
    // "no credentials" about keys that are perfectly fine. Answer from what this
    // session has already used instead.
    if (await contextIsStale(ctx, ref)) {
      const kept = knownSide(ref) ?? knownSide(otherSide(ref));
      if (kept) {
        note(`the extension context is stale, so the registry cannot be read; kept ${kept.provider}/${kept.id}`);
        return kept;
      }
      // Nothing cached yet: not deliberate, so the guard around `route()` gets a
      // chance to answer with the model that just handled the turn.
      throw new Error(await describeFailure(ctx, ref));
    }

    await recheckCredentials(ctx, ref);
    const recovered = decide(ctx, ref);
    if (recovered) {
      note(`credential snapshot was stale; re-checked live and routed to ${recovered.provider}/${recovered.id}`);
      return recovered;
    }

    // Prove the side usable live, then repair what pi reads. A live credential
    // alone is not enough: pi's post-route check reads the cache again.
    for (const side of [ref, otherSide(ref)]) {
      if (!side) continue;
      const state = await probe(ctx, side);
      if (!state.live) continue;
      repair(ctx, side);
      const repaired = decide(ctx, ref);
      if (repaired) {
        note(`repaired the registry for ${side.provider}; routed to ${repaired.provider}/${repaired.id}`);
        return repaired;
      }
    }

    throw new RouteFailure(await describeFailure(ctx, ref));
  }

  /**
   * Whether the registry is *unreadable* rather than merely unhelpful.
   *
   * A real `ModelRegistry` always answers `getProviderAuthStatus()` with an
   * object, and resolves `getProviderAuth()` to a value or to `undefined` — only
   * a thrown staleness check makes either unavailable. So "no catalog entry, no
   * cached verdict, nothing in the store, no live answer" is the one combination
   * a live registry cannot produce, and it means the context itself is dead.
   */
  function registryUnreadable(state: SideState): boolean {
    return !state.catalog && state.snapshot === undefined && state.store === "unknown" && state.live === undefined;
  }

  /** Whether both sides of the registry are unreadable — a dead context, not a credential. */
  async function contextIsStale(ctx: RouteContext, ref: ModelRef): Promise<boolean> {
    const sides = [ref, otherSide(ref)].filter((side): side is ModelRef => Boolean(side));
    if (sides.length === 0) return false;
    for (const side of sides) {
      if (!registryUnreadable(await probe(ctx, side))) return false;
    }
    return true;
  }

  /** One side's state, read the four ways the registry can answer. */
  async function probe(ctx: RouteContext, ref: ModelRef): Promise<SideState> {
    const found = findInCatalog(ctx, ref);
    return {
      catalog: Boolean(found),
      snapshot: found ? cachedVerdict(ctx, found) : undefined,
      store: storedSource(ctx, ref.provider),
      live: await liveAuth(ctx, ref.provider),
    };
  }

  /** pi's cached credential verdict for one catalog entry, if it can answer. */
  function cachedVerdict(ctx: RouteContext, model: CatalogModel): boolean | undefined {
    try {
      const verdict = ctx.modelRegistry.hasConfiguredAuth?.(model);
      return typeof verdict === "boolean" ? verdict : undefined;
    } catch {
      return undefined;
    }
  }

  /** Where the credential store reports `provider` from; "none" when it has nothing. */
  function storedSource(ctx: RouteContext, provider: string): string {
    try {
      const status = ctx.modelRegistry.getProviderAuthStatus?.(provider);
      if (!status) return "unknown";
      return status.configured ? (status.source ?? "configured") : "none";
    } catch {
      return "unknown";
    }
  }

  /** Resolve `provider`'s credential live, bypassing the cached verdict. */
  async function liveAuth(ctx: RouteContext, provider: string): Promise<boolean | undefined> {
    try {
      const resolveAuth = ctx.modelRegistry.getProviderAuth;
      if (!resolveAuth) return undefined;
      return (await resolveAuth.call(ctx.modelRegistry, provider)) !== undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Re-register `side` so pi's cached verdict includes it again. `registerProvider`
   * recomposes the provider (restoring a registration this file owns — DeepInfra
   * is not in pi's builtin catalog) and marks it provisionally configured when
   * the credential store has it, which is what `hasConfiguredAuth()` reads.
   */
  function repair(ctx: RouteContext, side: ModelRef): void {
    try {
      if (side.provider === DEEPINFRA_FLASH.provider) registerDeepInfra(deepInfraCost);
      else pi.registerProvider(side.provider, {});
    } catch (error) {
      console.error(`deepseek-routing: could not re-register ${side.provider}: ${String(error)}`);
    }
  }

  /** The error, carrying what the registry said about each side. */
  async function describeFailure(ctx: RouteContext, ref: ModelRef): Promise<string> {
    const sides = [ref, otherSide(ref)].filter((side): side is ModelRef => Boolean(side));
    const states: { side: ModelRef; state: SideState }[] = [];
    for (const side of sides) states.push({ side, state: await probe(ctx, side) });
    const details = states.map(({ side, state }) =>
      registryUnreadable(state)
        ? `${side.provider}/${side.id}: the model registry could not be read`
        : `${side.provider}/${side.id}: ${state.catalog ? "in the catalog" : "missing from the catalog"}, ` +
            `credential ${state.store === "none" ? "not in the credential store" : `in the credential store (${state.store})`}, ` +
            `cached verdict ${state.snapshot === undefined ? "unavailable" : state.snapshot ? "configured" : "no credentials"}, ` +
            `live check ${state.live === undefined ? "unavailable" : state.live ? "found one" : "found none"}`,
    );
    // Name the real cause. "Check auth.json" is actively misleading here: the
    // credentials are fine, the context that would read them is not.
    const dead = states.length > 0 && states.every(({ state }) => registryUnreadable(state));
    let registry = "";
    try {
      const error = ctx.modelRegistry.getError?.();
      if (error) registry = ` Registry reports: ${error.split("\n").join(" ")}.`;
    } catch {
      // A stale context cannot report; the per-side lines already say so.
    }
    return (
      `deepseek-routing: neither ${sides.map((side) => `${side.provider}/${side.id}`).join(" nor ")} is usable. ` +
      `${details.join("; ")}.${registry} ` +
      (dead
        ? `The extension context is stale — pi replaced or reloaded the session under this router — so no ` +
          `registry read can succeed and neither credential is at fault. `
        : "") +
      `Run /reload to rebuild the registry; if a credential is really missing, ` +
      `check it in ~/.pi/agent/auth.json`
    );
  }

  /** The side the snapshots pick as they stand; undefined when neither is usable. */
  function decide(ctx: RouteContext, ref: ModelRef): CatalogModel | undefined {
    const available = availableIds(ctx);
    const wanted = resolve(ctx, ref, available) ?? resolve(ctx, otherSide(ref), available);
    if (wanted) {
      remember(wanted);
      if (available === undefined) {
        note(`availability snapshot is empty; routed to ${wanted.provider}/${wanted.id} without it`);
      } else {
        warnedStaleSnapshot = false;
      }
      return wanted;
    }
    const fallback = pickConfigured(ctx, [ref, otherSide(ref)]);
    if (fallback) {
      remember(fallback);
      note(`availability snapshot omitted ${fallback.provider}/${fallback.id}; using the catalog entry`);
      return fallback;
    }
    return undefined;
  }

  /**
   * Rebuild the credential snapshot for the two sides from a live check — the
   * scoped form of `/reload`. Best effort: a pi without `refresh()`, or a
   * failing refresh, leaves the snapshot as it was and the caller throws.
   */
  async function recheckCredentials(ctx: RouteContext, ref: ModelRef): Promise<void> {
    const providers = [ref.provider, otherSide(ref)?.provider].filter((id): id is string => Boolean(id));
    try {
      await ctx.modelRegistry.refresh?.({ allowNetwork: false, providers });
    } catch {
      // The stale snapshot stands; the error message covers that case.
    }
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

  /**
   * `route()`'s decision, extracted so the guard below covers every path out of
   * it — including the ones that throw.
   */
  async function decideRoute(
    request: RouteRequest,
    ctx: RouteContext,
  ): Promise<{ model: CatalogModel; thinkingLevel: string; state?: RouterState }> {
    // Tool follow-ups and steering mid-turn: stay where the turn started, so
    // the prompt cache survives. Crossing a peak boundary mid-turn would cost
    // more than the per-token difference it saves.
    if (request.reason === "continuation") {
      const previous = request.previous?.model;
      if (previous && (previous.provider === DEEPSEEK_FLASH.provider || previous.provider === DEEPINFRA_FLASH.provider)) {
        return { model: await resolveEither(ctx, previous), thinkingLevel: request.thinkingLevel };
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
        return { model: await resolveEither(ctx, failed.model), thinkingLevel: request.thinkingLevel };
      }
    }

    // A fresh user message (or a direct request such as a compaction summary)
    // starts a new decision. Wait for the live price first, so the decision is
    // never made on the seeded list price when the real one is a request away;
    // pi awaits `route()`, and the wait is bounded by the fetch timeout.
    // Continuations and retries above deliberately skip it — they must not
    // spend latency mid-turn.
    await refreshPricing();
    const target = await resolveEither(ctx, chooseSide(currentTier()));
    return {
      model: target,
      thinkingLevel: request.thinkingLevel,
      state: request.state?.failedOver ? {} : undefined,
    };
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
      // pi hands over the model that just answered for exactly the two reasons a
      // dead context has been seen on, so record it before anything can fail.
      remember(request.previous?.model);
      remember(request.failed?.model);
      try {
        return await decideRoute(request, ctx);
      } catch (error) {
        // A deliberate verdict is the one thing worth ending a turn for: it names
        // a fact the user has to act on, and pi would only replace it with a
        // vaguer one. Anything else keeps the session on the model it last used,
        // which pi then checks for credentials itself.
        if (error instanceof RouteFailure) throw error;
        const kept = lastKnown(request);
        if (!kept) throw error;
        note(`routing failed (${firstLine(error)}); kept ${kept.provider}/${kept.id} instead of ending the turn`);
        return { model: kept, thinkingLevel: request.thinkingLevel };
      }
    },
  });

  // Pick up DeepInfra's current discount once a session exists (never in the
  // factory, which also runs for --list-models and other one-shot invocations).
  // `refreshPricing` applies the result itself; this only starts it early.
  pi.on("session_start", () => {
    void refreshPricing();
  });
}
