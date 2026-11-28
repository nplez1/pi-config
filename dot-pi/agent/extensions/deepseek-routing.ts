// deepseek-routing.ts
//
// Keeps DeepSeek V4.1 Flash traffic on whichever provider is cheapest right now
// once its wait is priced in — see "Latency" below.
//
// The same checkpoint is sold three ways. DeepSeek direct bills two tiers by
// wall clock (peak = 2x off-peak, see shared/deepseek-schedule.ts). DeepInfra
// resells it flat with a promo discount. IsoQuant resells it flat at a fifth of
// DeepSeek's input rate, with no peak tier and no promo. This extension
// registers the DeepInfra side and a virtual model,
// `deepseek/deepseek-flash-auto`, that picks a physical provider per request.
// IsoQuant's provider is registered by a MACHINE-LOCAL extension, so this file
// treats that side as optional: a side pi cannot resolve is not a candidate,
// which is also how a machine with no DeepInfra key keeps working.
//
//   peak      -> DeepInfra while its promo is live, else IsoQuant
//   off-peak  -> DeepInfra while its promo is live, else DeepSeek
//
// Neither line is pre-decided, and neither is a branch in this file. Every
// request prices all available cards at this machine's measured token mix and
// cache behaviour and takes the cheapest; the two lines above are just what
// that arithmetic returns for the rates in force on 2026-11-16. No side is
// assumed to win any tier — a change to one card, to the mix, or to a measured
// cache ratio changes the answer on its own.
//
// "Cheaper" is measured, not asserted axis by axis. `TOKEN_MIX` in
// shared/deepseek-schedule.ts records how this machine actually spends tokens
// on DeepSeek (99.4% of every prompt is a cache read), and `cheapestSideAt`
// prices each card at that mix. The old every-axis test treated the three
// prices as equally important, which is wrong by a factor of ~290 — it demanded
// a 50% DeepInfra discount where the mix-weighted break-even is ~37%.
//
// The comparison also has to price the tokens each side would actually bill, and
// that is not a constant: DeepInfra's cache degrades with CONTEXT SIZE while
// DeepSeek's improves, and IsoQuant's tracks DeepSeek's almost exactly. So
// `priceSide` prices every side at the miss share measured for ITS cache in the
// band this session's latest prompt falls in. A single scalar here was right
// only for the ~160K band this machine happens to live in; at 524K+ it kept
// choosing DeepInfra for a context where the two cards reach parity.
//
// What that arithmetic currently says, so a reader can sanity-check it against
// any rate change (per billion tokens, this machine's mix, 200K prompt):
//
//   DeepSeek off-peak  $5.06   IsoQuant          $6.09   ($6.13 aggregate)
//   DeepSeek peak     $10.11  DeepInfra @51%    $4.26
//   DeepInfra list     $8.70
//
// IsoQuant is the cheapest side at peak whenever DeepInfra's promo lapses — 0.60x
// DeepSeek's peak card at 200K — and it beats DeepSeek off-peak on a short
// prompt, where its 4.3x cheaper input rate more than covers the extra misses.
// From ~65K up off-peak it is third, and while a deep DeepInfra promo is live it
// is third everywhere: 27% off DeepInfra's list is enough to undercut it at
// 524K, 49% at a short prompt. Its cache is never the argument, by design: the
// measured ratios are 1.23 at short prompts and 0.75-0.85 above 65K, so it holds
// a prefix about as well as DeepSeek direct does.
//
//  - Promos. DeepInfra discounts its list price from time to time (51% off on
//    2026-11-01, so $0.098/$0.294/$0.00294). On those cards its list price is
//    already ahead at peak and far behind off-peak, so the promo is what makes
//    it the cheaper side at every hour for a short prompt — but that is a
//    reading of the numbers, not a rule the code encodes, and it stops being
//    true past 524K tokens where DeepInfra's cache penalty outweighs it.
//    DeepInfra publishes its rates publicly at
//    /v1/openai/models, so the extension refetches them each session instead of
//    trusting a hardcoded number. IsoQuant needs no fetch: its card is flat and
//    published (see `ISOQUANT_RATES`), so a static reading is the real rate.
//
//  - Latency. Price alone sent most traffic to DeepInfra, which answers in about
//    twice IsoQuant's time for a saving of fractions of a cent per million
//    tokens. Each side's measured wall-clock rate (`LATENCY_BANDS`) is priced at
//    `PI_ROUTER_VALUE_OF_TIME` USD/hour (default $5) and added to its card, so
//    the ranking is price plus wait. `PI_ROUTER_VALUE_OF_TIME=0` restores the
//    price-only ranking.
//
//  - Failover. A retry after a provider-side error (5xx, 429, overload,
//    network) crosses to the next-cheapest side that is not the one that
//    failed, for that one request, so a DeepSeek peak-time outage or a DeepInfra
//    blip does not stall the turn. The session returns to the clock/price choice
//    on the next user message. Router state remembers the failover, so a broken
//    side cannot be retried in a loop and three sides still cannot ping-pong.
//
//  - A side can also fail without erroring, and that case reached `route()` as
//    no failure at all. On 2026-11-16 DeepInfra returned HTTP 200 and a complete
//    stream while producing nothing usable six times in nine hours: five `length`
//    stops that spent the whole output budget, arriving as a tool call cut
//    mid-argument so it never ran, and a 22-minute stream that produced one short
//    thinking block and ended when the operator killed the session.
//    There is no error to retry on, so `looksLikeProviderFailure` and the
//    crossing above both stayed silent while the router kept choosing the side
//    producing nothing. A side whose answer degenerates is now demoted to last
//    for 30 minutes — relearned from the branch at session start, so a resume
//    inherits it — and DeepInfra's output budget is capped at 128K so one costs
//    ~8 minutes instead of 24. The other two sides keep their catalog caps.
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
// the per-token price at whatever was true when the file was written. The same
// rule is why this file must NOT re-register IsoQuant: that provider's model
// list and cost belong to the extension that owns it, and a `{}` registration
// here would replace them.
//
// Credentials: this file holds none. The DeepInfra key lives in
// ~/.pi/agent/auth.json as provider "deepinfra" (see README); the pricing
// endpoint needs no key at all. IsoQuant's key lives beside it as provider
// "isoquant", or the side simply does not appear.
//
// Portability: the virtual model is registered under the `deepseek` provider, so
// it exists only where DeepSeek has credentials — a machine without them never
// lists it and never runs this code. Every other side is gated per request:
// pi's find() returns catalog entries whose provider has no credentials and
// aborts a request routed to one, so resolve() prefers getAvailable() and falls
// back to hasConfiguredAuth() — the check pi itself applies — so a DeepSeek-only
// machine stays on DeepSeek instead of erroring, and a machine without the
// IsoQuant extension never sees that side as a candidate at all. A cached
// verdict that says "no" is repaired rather than trusted: a live
// `getProviderAuth()` plus a re-registration put the provider back into the
// catalog and the credential cache pi reads, which is what makes a stale
// registry cost one stderr line instead of a dead turn.
//
//  - A dead context is not a credential problem, and conflating the two is what
//    made one failure recur. Every field of the context `route()` is handed is a
//    getter that begins with the extension runner's staleness check, so once pi
//    replaces or reloads the session behind this registration — `/new`, `/fork`,
//    `/resume`, `/reload`, or another session's runner in the same process —
//    *every* registry read throws at once. That reads exactly like "no side has
//    a credential": same shape, every side, with nothing wrong with any key, and
//    the recovery chain above cannot help because it re-checks the same dead
//    context. So `route()` recognises that state and answers with the last
//    physical model it knows to be good instead of ending the turn, and a guard
//    around the whole of `route()` does the same for anything this file has not
//    anticipated. pi re-checks credentials on what `route()` returns, so the
//    worst case becomes pi's own accurate error rather than a dead turn.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CACHE_WRITE_RATE,
  DEEPINFRA_FLASH,
  DEEPINFRA_LIST,
  ISOQUANT_FLASH,
  ISOQUANT_RATES,
  PROVIDER_LABEL,
  RATES,
  ROUTER,
  SIDES,
  currentTier,
  deepseekCost,
  effectiveCost,
  refFor,
  scoreSide,
  sideOf,
  type ModelRef,
  type Quote,
  type RateSet,
  type Side,
  type Tier,
} from "./shared/deepseek-schedule";

/** DeepInfra's model catalog, which carries list pricing and the discount. */
const MODELS_URL = "https://api.deepinfra.com/v1/openai/models";
const PRICING_TIMEOUT_MS = 5_000;

/** The catalog agrees on 1M of context; DeepInfra's output cap below is ours. */
const CONTEXT_WINDOW = 1_000_000;
/**
 * DeepInfra's output budget, deliberately under the catalog's 384K.
 *
 * Only its own registration uses this, and only a physical model's cap bounds a
 * request: the virtual model's declared `maxTokens` is the figure pi shows before
 * the first answer, not what it sends. DeepSeek direct keeps the catalog's
 * 384,000 and IsoQuant declares its own, so this bounds the side that misbehaved
 * rather than every side.
 *
 * A degenerate stream spends the whole budget before it stops, so the cap is the
 * only thing that bounds one: on 2026-11-16 DeepInfra streamed at ~262 tok/s, so
 * 384K is 24 minutes of producing nothing. The largest legitimate generation in
 * this machine's history is 56,499 tokens (no turn at all between 64K and 189K),
 * so 128K is 2.3x headroom over anything real while cutting the worst case to
 * ~8 minutes. What a hit produces is a tool call truncated mid-argument, which
 * pi refuses to run — recoverable, unlike the unbounded turn that cost a whole
 * session. `degeneratedResponse` reads this same number as its threshold.
 */
const MAX_TOKENS = 131_072;

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

/** The parts of a session entry the re-arm walk reads. */
interface BranchEntry {
  type?: string;
  message?: {
    role?: string;
    provider?: string;
    /** Unix milliseconds, per session-format.md. */
    timestamp?: number;
    durationMs?: number;
    stopReason?: string;
    content?: unknown;
    usage?: { output?: number };
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
  /** Present on a real session context; lets the label skip an unreachable side. */
  modelRegistry?: RouteContext["modelRegistry"];
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

/** How long a side whose answer degenerated is passed over. */
const DEGRADED_COOLDOWN_MS = 30 * 60_000;
/** Below this many characters per second, an aborted answer produced nothing. */
const DEGENERATE_ABORT_RATE = 5;
/** An abort shorter than this is someone pressing Escape, whatever it produced. */
const DEGENERATE_ABORT_MS = 5 * 60_000;

/**
 * A response that failed without failing. pi received HTTP 200 and a complete
 * stream, so there was no error and no retry — which is why neither
 * `looksLikeProviderFailure` above nor the retry path in `decideRoute` ever sees
 * one. A provider can serve nothing but garbage for hours and still be the
 * router's cheapest side.
 *
 * Two shapes were observed on 2026-11-16, both from DeepInfra serving this
 * checkpoint, six times across two worktrees inside nine hours. Five were
 * `length` after spending the entire output budget: it arrives as a tool call cut
 * mid-argument (pi: "the response hit the output token limit, so its arguments
 * may be truncated") and so never runs. The sixth was a 1,334s stream that
 * produced one 533-character thinking block and then nothing at all.
 */
function degeneratedResponse(message: {
  stopReason?: string;
  durationMs?: number;
  content?: unknown;
  usage?: { output?: number };
}): boolean {
  if (message.stopReason === "length") return (message.usage?.output ?? 0) >= MAX_TOKENS * 0.9;
  if (message.stopReason !== "aborted") return false;
  const millis = message.durationMs ?? 0;
  if (millis < DEGENERATE_ABORT_MS) return false;
  // `usage` cannot answer here: an aborted assistant message reports all zeros
  // however much it produced, because the figures arrive in the stream's last
  // chunk and an abort never receives one. Every abort in this machine's history
  // reports output 0, so what is left is what actually came out. The stall runs at
  // 0.40 chars/s and the slowest healthy abort at 59, so the threshold is an
  // order of magnitude clear of both.
  return producedChars(message.content) / (millis / 1000) < DEGENERATE_ABORT_RATE;
}

/**
 * Characters a message produced: text, thinking and tool arguments. Approximate
 * by design — it only has to separate "produced something" from "produced
 * nothing", and both sides of that line are orders of magnitude apart.
 */
function producedChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const parts = block as Record<string, unknown>;
    for (const key of ["text", "thinking", "arguments"] as const) {
      if (typeof parts[key] === "string") chars += parts[key].length;
    }
    if (parts.input && typeof parts.input === "object") chars += JSON.stringify(parts.input).length;
  }
  return chars;
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
 *
 * The registry is optional because the footer label also asks this, from a
 * context that may not carry one — a label with no snapshot falls back to the
 * price ranking rather than losing the status line.
 */
function availableIds(ctx: { modelRegistry?: RouteContext["modelRegistry"] }): Set<string> | undefined {
  try {
    const available = ctx.modelRegistry?.getAvailable?.();
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
            // Automatic prefix caching, no write cost. Measured on this machine:
            // hits still land at 2,119 s on the DeepSeek side and 8,693 s on
            // IsoQuant, and pi-smart-compaction already assumes 2 h here.
            promptCache: { short: 7200 },
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
   * The largest prompt this session has sent, in tokens — the size every card is
   * priced at. `route()` is handed no token count, so the last turn's usage is
   * the estimate: the next prompt is that plus the new content, which cannot
   * move it across a band by itself. Assistant messages from ANY side count,
   * because the prompt is the same conversation whichever side answers it.
   */
  let promptTokens: number | undefined;
  /**
   * Each side whose last answer degenerated, and when it may be tried again.
   *
   * Keyed by side rather than held as one entry: a second side degenerating inside
   * the window used to overwrite the first and release it early, which is the
   * opposite of what a bad night needs.
   *
   * Session-scoped like the rest of this state, but `rearmFromBranch` reads the
   * branch back at session start, so resuming a killed session inherits what the
   * killed session saw.
   */
  const degraded = new Map<Side, number>();

  /** Every side's current card, as pairs of side and rate for the ranking. */
  function quotesAt(tier: Tier): Quote[] {
    return [
      { side: "deepseek", rates: deepseekCost(tier) },
      { side: "deepinfra", rates: deepInfraCost },
      { side: "isoquant", rates: ISOQUANT_RATES },
    ];
  }

  /** Whether `side` is being passed over right now, expiring a lapsed cooldown. */
  function demoted(side: Side | undefined): boolean {
    if (!side) return false;
    const until = degraded.get(side);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    degraded.delete(side);
    return false;
  }

  /**
   * All three sides, best first at this session's prompt size and the cards in
   * force — "best" being `scoreSide`: the card's price plus the side's measured
   * wait at `PI_ROUTER_VALUE_OF_TIME`. This is the router's whole policy: the
   * first entry is the answer when pi can reach it, and the rest are the
   * fallbacks.
   *
   * A side whose answer just degenerated is demoted to last, so every caller
   * inherits the avoidance — the sticky continuation path, the retry crossing, the
   * fresh decision and the footer label alike. Demoted rather than dropped: a
   * machine whose only credential is on that side must still answer, and every
   * caller falls through the order in turn.
   */
  function rankedSides(tier: Tier): ModelRef[] {
    const ranked = quotesAt(tier)
      .map((quote) => ({
        ref: refFor(quote.side),
        price: scoreSide(quote.side, quote.rates, promptTokens),
      }))
      .sort((a, b) => a.price - b.price)
      .map((sorted) => sorted.ref);
    const healthy: ModelRef[] = [];
    const passedOver: ModelRef[] = [];
    for (const ref of ranked) (demoted(sideOf(ref)) ? passedOver : healthy).push(ref);
    return passedOver.length === 0 ? ranked : [...healthy, ...passedOver];
  }

  /**
   * `preferred` first, then the remaining sides cheapest-first — the order to
   * fall back through. `preferred` goes through `sideOf` so a model object from
   * some other provider cannot slip into the ranking.
   */
  function orderFrom(preferred: ModelRef | undefined, tier: Tier): ModelRef[] {
    const preferredSide = sideOf(preferred);
    const cheapest = rankedSides(tier);
    if (!preferredSide) return cheapest;
    // Sticky first, unless it is the side being passed over: the ranking has
    // already put it last, and re-promoting it would undo the avoidance.
    if (demoted(preferredSide)) return cheapest;
    return [refFor(preferredSide), ...cheapest.filter((ref) => sideOf(ref) !== preferredSide)];
  }

  /**
   * The first side of `order` pi can reach, for the footer label. Price alone is
   * the right answer on a machine that has every credential, and the wrong one
   * on a machine missing a key — where the label would promise a provider the
   * request can never go to. The availability snapshot is a cache, so it only
   * ever demotes: when it cannot answer, the price winner is still shown.
   */
  function reachableSide(ctx: LabelContext | undefined, order: ModelRef[]): ModelRef {
    const available = ctx ? availableIds(ctx) : undefined;
    if (!available) return order[0];
    return order.find((ref) => available.has(`${ref.provider}/${ref.id}`.toLowerCase())) ?? order[0];
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
    if (!sideOf(model)) return;
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
    // The model that just answered, then the one that just failed, then anything
    // this session has already routed to, cheapest side first.
    const justHandled = request.previous?.model ?? request.failed?.model;
    if (justHandled) return justHandled;
    for (const ref of rankedSides(currentTier())) {
      const kept = knownSide(ref);
      if (kept) return kept;
    }
    return undefined;
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
  function labelFor(model: CatalogModel | undefined, ctx?: LabelContext): string | undefined {
    if (!model || model.provider !== "deepseek") return undefined;
    const tier = currentTier();
    if (model.id === ROUTER.id) {
      return `${tier} → ${PROVIDER_LABEL[reachableSide(ctx, rankedSides(tier)).provider]}`;
    }
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
    const text = labelFor(model, ctx);
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
        const fresh = labelFor(activeModel, activeCtx);
        if (fresh !== undefined && fresh !== appliedText && activeCtx?.hasUI) {
          appliedText = fresh;
          activeCtx.ui.setStatus(STATUS_KEY, fresh);
        }
      }, REFRESH_MS);
    }
  }

  /**
   * Relearn a recent degeneration from the branch.
   *
   * The observation is this session's, but killing a stuck session and resuming it
   * is exactly how an operator recovers one, and `/new` starts knowing nothing —
   * so the provider that broke a session would be preferred again by the very
   * session started to replace it. The branch still holds the evidence, so read it
   * back: a degenerate answer whose stream ended inside the cooldown window re-arms
   * its side, with whatever remains of the window.
   *
   * Each session learns separately. Sharing one verdict across processes would need
   * a file outside the session store, which is not worth it for 30 minutes.
   */
  function rearmFromBranch(ctx: { sessionManager?: { getBranch?(): unknown[] } }): void {
    const entries = (ctx.sessionManager?.getBranch?.() ?? []) as BranchEntry[];
    const now = Date.now();
    for (const entry of entries) {
      const msg = entry.type === "message" ? entry.message : undefined;
      if (!msg || msg.role !== "assistant") continue;
      if (!degeneratedResponse(msg)) continue;
      // The stream ended `durationMs` after the message started; a cooldown that
      // already lapsed while the session was down stays lapsed.
      const started = typeof msg.timestamp === "number" ? msg.timestamp : now;
      const ended = started + (msg.durationMs ?? 0);
      if (now - ended >= DEGRADED_COOLDOWN_MS) continue;
      const side = SIDES.find((routed) => refFor(routed).provider === msg.provider);
      if (side) degraded.set(side, ended + DEGRADED_COOLDOWN_MS);
    }
  }

  // Show the label before the first request of a session (startup, resume, fork).
  pi.on("session_start", (_event, ctx) => {
    updateLabel(ctx, ctx.model, true);
    // The context is fresh here, so this is the one moment the catalog can be
    // read for free. Whatever dies later, every side in the catalog now has a
    // model object — including the ones this machine has no credential for, as
    // `find()` returns those too; `resolve()` is what checks reachability.
    for (const side of SIDES) remember(findInCatalog(ctx, refFor(side)));
    rearmFromBranch(ctx);
  });

  // React to /model, Ctrl+P cycling, and session restore.
  pi.on("model_select", (event, ctx) => {
    updateLabel(ctx, event.model);
  });

  // Track the prompt size the cards are priced at, so each side's cache penalty
  // follows the context instead of a constant. Only the routed sides matter; a
  // virtual-model or unrelated-provider message says nothing about the prompt
  // these cards would be billed for.
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    const side = SIDES.find((routed) => refFor(routed).provider === msg.provider);
    if (!side) return;
    if (degeneratedResponse(msg)) {
      degraded.set(side, Date.now() + DEGRADED_COOLDOWN_MS);
      console.error(
        `deepseek-routing: ${msg.provider} answered with stopReason "${msg.stopReason}" after ` +
          `${Math.round((msg.durationMs ?? 0) / 1000)}s producing ${producedChars(msg.content)} characters; ` +
          `passing over it for ${Math.round(DEGRADED_COOLDOWN_MS / 60_000)} minutes`,
      );
    }
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
    degraded.clear();
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
   * The side to use for this request: the first reachable entry of `order`,
   * where `order` is the price ranking with any preferred side moved to the
   * front.
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
   * momentarily empty — which reads as "no side has a key". pi does not trust
   * the snapshot for this either; its send path accepts
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
   * from "no side has a key" to a reader of the four facts. There the router
   * answers with the last model it saw work and says so.
   */
  async function resolveBest(ctx: RouteContext, order: ModelRef[]): Promise<CatalogModel> {
    const decided = decide(ctx, order);
    if (decided) return decided;

    // A dead context cannot be re-checked, probed or repaired — every one of
    // those reads the same invalidated runner, so the chain below would report
    // "no credentials" about keys that are perfectly fine. Answer from what this
    // session has already used instead.
    if (await contextIsStale(ctx, order)) {
      const kept = firstKnown(order);
      if (kept) {
        note(`the extension context is stale, so the registry cannot be read; kept ${kept.provider}/${kept.id}`);
        return kept;
      }
      // Nothing cached yet: not deliberate, so the guard around `route()` gets a
      // chance to answer with the model that just handled the turn.
      throw new Error(await describeFailure(ctx, order));
    }

    await recheckCredentials(ctx, order);
    const recovered = decide(ctx, order);
    if (recovered) {
      note(`credential snapshot was stale; re-checked live and routed to ${recovered.provider}/${recovered.id}`);
      return recovered;
    }

    // Prove a side usable live, then repair what pi reads. A live credential
    // alone is not enough: pi's post-route check reads the cache again. This
    // walks `order`, so the cheapest side that can be repaired wins, not the
    // first one this file happens to list.
    for (const side of order) {
      const state = await probe(ctx, side);
      if (!state.live) continue;
      repair(ctx, side);
      const repaired = decide(ctx, order);
      if (repaired) {
        note(`repaired the registry for ${side.provider}; routed to ${repaired.provider}/${repaired.id}`);
        return repaired;
      }
    }

    throw new RouteFailure(await describeFailure(ctx, order));
  }

  /** The last model this session used from any side of `order`, in that order. */
  function firstKnown(order: ModelRef[]): CatalogModel | undefined {
    for (const ref of order) {
      const kept = knownSide(ref);
      if (kept) return kept;
    }
    return undefined;
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

  /** Whether every side in `order` is unreadable — a dead context, not a credential. */
  async function contextIsStale(ctx: RouteContext, order: ModelRef[]): Promise<boolean> {
    if (order.length === 0) return false;
    for (const side of order) {
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
   *
   * IsoQuant is deliberately not repaired here: its model list and cost belong to
   * the extension that registers it, and re-registering with an empty object
   * would replace them. A lost IsoQuant registration is simply a side this file
   * cannot offer, so the ranking moves on to the next one.
   */
  function repair(ctx: RouteContext, side: ModelRef): void {
    try {
      if (side.provider === DEEPINFRA_FLASH.provider) registerDeepInfra(deepInfraCost);
      else if (side.provider !== ISOQUANT_FLASH.provider) pi.registerProvider(side.provider, {});
    } catch (error) {
      console.error(`deepseek-routing: could not re-register ${side.provider}: ${String(error)}`);
    }
  }

  /**
   * The error, carrying what the registry said about each side.
   *
   * It reports the sides that are actually in play: one that was never in this
   * machine's catalog (no IsoQuant extension installed, say) is not a failure and
   * naming it would read as one, so it is filtered out — unless nothing else was
   * in the catalog either, in which case every side is the story.
   */
  async function describeFailure(ctx: RouteContext, order: ModelRef[]): Promise<string> {
    const states: { side: ModelRef; state: SideState }[] = [];
    for (const side of order) states.push({ side, state: await probe(ctx, side) });
    const inPlayStates = states.filter(({ state }) => state.catalog || registryUnreadable(state));
    const shown = inPlayStates.length > 0 ? inPlayStates : states;
    const details = shown.map(({ side, state }) =>
      registryUnreadable(state)
        ? `${side.provider}/${side.id}: the model registry could not be read`
        : `${side.provider}/${side.id}: ${state.catalog ? "in the catalog" : "missing from the catalog"}, ` +
            `credential ${state.store === "none" ? "not in the credential store" : `in the credential store (${state.store})`}, ` +
            `cached verdict ${state.snapshot === undefined ? "unavailable" : state.snapshot ? "configured" : "no credentials"}, ` +
            `live check ${state.live === undefined ? "unavailable" : state.live ? "found one" : "found none"}`,
    );
    // Name the real cause. "Check auth.json" is actively misleading here: the
    // credentials are fine, the context that would read them is not.
    const dead = shown.length > 0 && shown.every(({ state }) => registryUnreadable(state));
    let registry = "";
    try {
      const error = ctx.modelRegistry.getError?.();
      if (error) registry = ` Registry reports: ${error.split("\n").join(" ")}.`;
    } catch {
      // A stale context cannot report; the per-side lines already say so.
    }
    const names = shown.map(({ side }) => `${side.provider}/${side.id}`);
    const lead =
      names.length === 1
        ? `deepseek-routing: ${names[0]} is not usable. `
        : `deepseek-routing: none of ${names.join(", ")} is usable. `;
    return (
      `${lead}${details.join("; ")}.${registry} ` +
      (dead
        ? `The extension context is stale — pi replaced or reloaded the session under this router — so no ` +
          `registry read can succeed and no credential is at fault. `
        : "") +
      `Run /reload to rebuild the registry; if a credential is really missing, ` +
      `check it in ~/.pi/agent/auth.json`
    );
  }

  /** The side the snapshots pick as they stand; undefined when none is usable. */
  function decide(ctx: RouteContext, order: ModelRef[]): CatalogModel | undefined {
    const available = availableIds(ctx);
    for (const ref of order) {
      const wanted = resolve(ctx, ref, available);
      if (!wanted) continue;
      remember(wanted);
      if (available === undefined) {
        note(`availability snapshot is empty; routed to ${wanted.provider}/${wanted.id} without it`);
      } else {
        warnedStaleSnapshot = false;
      }
      return wanted;
    }
    const fallback = pickConfigured(ctx, order);
    if (fallback) {
      remember(fallback);
      note(`availability snapshot omitted ${fallback.provider}/${fallback.id}; using the catalog entry`);
      return fallback;
    }
    return undefined;
  }

  /**
   * Rebuild the credential snapshot for every side from a live check — the
   * scoped form of `/reload`. Best effort: a pi without `refresh()`, or a
   * failing refresh, leaves the snapshot as it was and the caller throws.
   *
   * Scoped to the sides this machine's catalog actually has: asking pi to check
   * a provider that was never registered (no IsoQuant extension here, say) can
   * only fail, and the caller would report that noise as the reason the turn
   * died.
   */
  async function recheckCredentials(ctx: RouteContext, order: ModelRef[]): Promise<void> {
    const providers = inPlay(ctx, order).map((ref) => ref.provider);
    if (providers.length === 0) return;
    try {
      await ctx.modelRegistry.refresh?.({ allowNetwork: false, providers });
    } catch {
      // The stale snapshot stands; the error message covers that case.
    }
  }

  /** The sides of `order` whose provider this machine's catalog actually has. */
  function inPlay(ctx: RouteContext, order: ModelRef[]): ModelRef[] {
    return order.filter((ref) => findInCatalog(ctx, ref) !== undefined);
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
    // the prompt cache survives. Crossing a peak boundary, or re-ranking on a
    // price change, mid-turn would cost more than the per-token difference it
    // saves.
    if (request.reason === "continuation") {
      const previous = request.previous?.model;
      if (sideOf(previous)) {
        return {
          model: await resolveBest(ctx, orderFrom(previous, currentTier())),
          thinkingLevel: request.thinkingLevel,
        };
      }
    }

    // A retry: cross to the next-cheapest side that is not the one that failed,
    // once, and only for provider-side failures.
    if (request.reason === "retry") {
      const failed = request.failed;
      const failedSide = sideOf(failed?.model);
      if (failed?.model && failedSide && !request.state?.failedOver && looksLikeProviderFailure(failed.message)) {
        const order = rankedSides(currentTier()).filter((ref) => sideOf(ref) !== failedSide);
        const target = decide(ctx, order);
        if (target) {
          return {
            model: target,
            thinkingLevel: request.thinkingLevel,
            state: { failedOver: true },
          };
        }
      }
      if (failed?.model) {
        return {
          model: await resolveBest(ctx, orderFrom(failed.model, currentTier())),
          thinkingLevel: request.thinkingLevel,
        };
      }
    }

    // A fresh user message (or a direct request such as a compaction summary)
    // starts a new decision. Wait for the live price first, so the decision is
    // never made on the seeded list price when the real one is a request away;
    // pi awaits `route()`, and the wait is bounded by the fetch timeout.
    // Continuations and retries above deliberately skip it — they must not
    // spend latency mid-turn.
    await refreshPricing();
    const target = await resolveBest(ctx, rankedSides(currentTier()));
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
