// shared/deepseek-schedule.ts
//
// Single source of truth for DeepSeek's peak/off-peak billing schedule, its
// per-tier rate card, and the model ids the peak router swaps between.
// Imported by deepseek-pricing.ts (billing + footer label) and
// deepseek-routing.ts (provider choice), so the price shown and the provider
// actually used can never disagree.
//
// DeepSeek bills two rate tiers by wall clock (peak = 2x off-peak), from
// https://api-docs.deepseek.com/quick_start/pricing (re-verified 2026-11-01):
//
//   "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
//    excluding Chinese public holidays. All other hours are off-peak, including
//    weekends and Chinese public holidays in full."
//
//   MODEL VERSION      deepseek-flash = DeepSeek-V4.1-Flash-1017
//   1M INPUT (CACHE HIT)   off-peak $0.003   peak $0.006
//   1M INPUT (CACHE MISS)  off-peak $0.15    peak $0.30
//   1M OUTPUT              off-peak $0.60    peak $1.20
//   (deepseek-v4-pro is 2x-4x these; disabled by policy in model-roles.json)
//
// Comparing providers needs a third input the rate card does not carry: how
// this machine spends tokens. `TOKEN_MIX` below is that measurement, and
// `blendedPrice` is the one number to compare two cards by. Never compare
// providers axis-by-axis — a dominance test on three prices of very different
// weight is what made the router 8 points of discount too conservative.

export interface RateSet {
  input: number;
  output: number;
  cacheRead: number;
}

/** DeepSeek has no cache-write pricing. */
export const CACHE_WRITE_RATE = 0;

const FLASH_RATES: { offPeak: RateSet; peak: RateSet } = {
  offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003 },
  peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
};

/** Per-model rate card, keyed by DeepSeek's bare model id (USD per 1M tokens). */
export const RATES: Record<string, { offPeak: RateSet; peak: RateSet }> = {
  // DeepSeek V4.1 Flash, current id. Served as DeepSeek-V4.1-Flash-1017.
  "deepseek-flash": FLASH_RATES,
  // Retired ids, still accepted and billed at the Flash price.
  "deepseek-v4-flash": FLASH_RATES,
  "deepseek-v4-flash-vision-exp": FLASH_RATES,
  "deepseek-v4-pro": {
    offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
  },
};

/**
 * Chinese public holidays are off-peak all day ("in full"). Add UTC dates
 * ("YYYY-MM-DD") here when the State Council publishes them; an unlisted
 * holiday is treated as a weekday, so the day is priced against DeepSeek's peak
 * card and the router may pick the other side on that basis.
 */
export const DEEPSEEK_HOLIDAYS: readonly string[] = [];

export type Tier = "peak" | "off-peak";

/** Peak if `timestamp` falls in 01:00-04:00 or 06:00-10:00 UTC, Mon-Fri. */
export function isPeak(timestamp: number): boolean {
  const d = new Date(timestamp);
  const day = d.getUTCDay(); // 0 = Sunday
  if (day === 0 || day === 6) return false;
  if (DEEPSEEK_HOLIDAYS.includes(d.toISOString().slice(0, 10))) return false;
  const hour = d.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** The tier `timestamp` bills at. */
export function tierAt(timestamp: number): Tier {
  return isPeak(timestamp) ? "peak" : "off-peak";
}

/**
 * The tier to act on right now: the live schedule, unless PI_DEEPSEEK_TIER
 * forces one ("peak" or "off-peak"). The override exists so routing and the
 * footer can be exercised outside the UTC windows without editing code.
 */
export function currentTier(timestamp: number = Date.now()): Tier {
  const forced = process.env.PI_DEEPSEEK_TIER?.trim().toLowerCase();
  if (forced === "peak") return "peak";
  if (forced === "off-peak" || forced === "offpeak") return "off-peak";
  return tierAt(timestamp);
}

/** A physical or virtual model reference, as `provider` + bare `id`. */
export interface ModelRef {
  provider: string;
  id: string;
}

/** DeepSeek direct — half price off-peak, and the billing baseline. */
export const DEEPSEEK_FLASH: ModelRef = { provider: "deepseek", id: "deepseek-flash" };

/**
 * Same checkpoint (DeepSeek-V4.1-Flash-1017) resold by DeepInfra at a flat
 * rate. Which tier it wins is not declared anywhere — `cheaperAtPrompt` decides
 * it per request. On the 2026-11-01 cards its list price is 25% cheaper than
 * DeepSeek's peak card on a short prompt and 49% dearer than the off-peak one;
 * the 51% promo is 64% cheaper than peak and 27% cheaper than off-peak. Those
 * figures are for a short prompt — see `CACHE_BANDS` for why the off-peak margin
 * shrinks as the context grows and reverses past 524K.
 */
export const DEEPINFRA_FLASH: ModelRef = {
  provider: "deepinfra",
  id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
};

/**
 * DeepInfra list price for that model, USD per 1M tokens (verified 2026-11-01
 * against https://api.deepinfra.com/v1/openai/models, which is public).
 * DeepInfra bills `list * (1 - discount)`; see `effectiveCost`.
 */
export const DEEPINFRA_LIST: RateSet = { input: 0.2, output: 0.6, cacheRead: 0.006 };

/** DeepInfra's discount is a fraction off list: 0.51 -> pay 49%. */
export function effectiveCost(list: RateSet, discount: number): RateSet {
  const factor = 1 - discount;
  return {
    input: list.input * factor,
    output: list.output * factor,
    cacheRead: list.cacheRead * factor,
  };
}

/** DeepSeek's rate card for `tier`. */
export function deepseekCost(tier: Tier): RateSet {
  return RATES[DEEPSEEK_FLASH.id][tier === "peak" ? "peak" : "offPeak"];
}

/**
 * How this machine actually spends tokens, as shares of one turn's total token
 * count — the weighting every provider comparison below uses.
 *
 * Measured over 40,374 assistant messages on deepseek-flash across this
 * machine's whole history, with every turn that followed a provider switch
 * dropped — that miss belongs to the router, not to the provider. Reproduce with
 *   measure-token-mix.mjs --provider deepseek
 * which prints 33,303,992 input misses, 9,153,055,326 cache reads and 25,870,415
 * output. Cache reads are 99.4% of every prompt, because a long agent session
 * replays its whole history each turn.
 *
 * This is deliberately the DEEPSEEK baseline, not the mix of the routed
 * workload. DeepInfra re-reads more of the prompt than DeepSeek does, and that
 * difference is priced by `CACHE_BANDS` scaling DeepInfra's input
 * axis. Measuring the mix on DeepInfra traffic instead would put its extra
 * misses in the weighting AND in the multiplier, counting the same penalty
 * twice; the DeepInfra-only figure is 0.0080/0.9890/0.0030, a 2.2x larger input
 * share for exactly that reason.
 *
 * Token shares and SPEND shares are wildly different, and only the token
 * shares belong in a price comparison. On DeepSeek's off-peak card these
 * tokens spend 10.4% on input, 57.2% on cache reads, 32.4% on output — and
 * cache reads are both the heaviest axis and the one the two cards differ most
 * on (DeepInfra list is 2x DeepSeek off-peak there, 1.33x on input and 1.0x on
 * output), so the decision is essentially a cache-read comparison.
 *
 * The old `cheaperOnEveryAxis` rule tested dominance instead: DeepInfra had to
 * be at least as cheap on all three axes. That test is never *wrong*, it is
 * just far too conservative — it demanded a 50% DeepInfra discount where a
 * short prompt's break-even is 37.8%.
 */
export const TOKEN_MIX: RateSet = {
  input: 0.003615,
  cacheRead: 0.993578,
  output: 0.002808,
};

/**
 * One band of `CACHE_BANDS`.
 */
export interface CacheBand {
  /** Largest prompt this band covers, in tokens. */
  upTo: number;
  /**
   * DeepSeek's cache-miss share of the prompt, measured in this band. This has
   * to be band-local: it falls 55x from 3.3% at short prompts to 0.06% past
   * 524K, because a long prompt is mostly one fixed prefix being replayed.
   * Substituting the aggregate `TOKEN_MIX.input` here is what makes an earlier
   * version of this table price both sides wrongly at the top.
   */
  deepseekMiss: number;
  /** DeepInfra's miss share ÷ DeepSeek's, measured in this band. */
  ratio: number;
}

/**
 * Both sides' cache behaviour as a function of CONTEXT SIZE — the measurement
 * the router's provider choice rests on.
 *
 * DeepSeek caches KV state on disk, which is what makes a huge prefix cheap to
 * keep resident; DeepInfra's cache is best-effort and memory-resident, so a long
 * context is what it evicts first. Measured over every same-provider turn pair
 * whose previous turn was under 60 seconds away, so elapsed time cannot explain
 * the difference:
 *
 *   prompt size    DeepSeek      DeepInfra     ratio
 *   0-65K          1 per 30      1 per 30      1.02x
 *   65K-131K       1 per 116     1 per 98      1.18x
 *   131K-262K      1 per 386     1 per 173     2.23x
 *   262K-524K      1 per 841     1 per 316     2.66x
 *   524K-1M        1 per 1675    1 per 85      19.8x
 *
 * Read the direction, not just the size: DeepSeek's cache gets *better* as the
 * prompt grows. DeepInfra's gets worse. The old single 1.87 scalar was a fair
 * average over a workload that lives around 160K tokens, and wrong by 2x at
 * short prompts and by 9x at the top.
 *
 * Reproduce with `measure-token-mix.mjs --penalty`, which prints the turn counts
 * so a thin band is visible. The 524K-1M row rests on ONE DeepInfra session (91
 * turns) against DeepSeek's 11, so its ratio is indicative; that band lands near
 * parity either way, which is why the router stops preferring DeepInfra there.
 */
export const CACHE_BANDS: readonly CacheBand[] = [
  { upTo: 65_000, deepseekMiss: 0.032846, ratio: 1.02 },
  { upTo: 131_000, deepseekMiss: 0.008615, ratio: 1.18 },
  { upTo: 262_000, deepseekMiss: 0.002587, ratio: 2.23 },
  { upTo: 524_000, deepseekMiss: 0.001189, ratio: 2.66 },
  { upTo: Number.POSITIVE_INFINITY, deepseekMiss: 0.000597, ratio: 19.82 },
];

/**
 * The band that covers a prompt of `promptTokens`, or the smallest one when the
 * size is unknown. Unknown means "the first request of a session", which really
 * is short, so this never invents a penalty for a context that does not exist.
 */
export function cacheBandAt(promptTokens?: number): CacheBand {
  const first = CACHE_BANDS[0];
  // Only a missing or unreadable size is "unknown". Infinity is a real answer —
  // the last band covers it — and falls through the loop below.
  if (promptTokens === undefined || Number.isNaN(promptTokens)) return first;
  for (const band of CACHE_BANDS) {
    if (promptTokens <= band.upTo) return band;
  }
  return CACHE_BANDS[CACHE_BANDS.length - 1];
}

/**
 * DeepInfra's cache-miss share at `promptTokens`, from the measured ratio — the
 * share its card is actually billed on. Replaces the input-axis multiplier an
 * earlier version applied to the aggregate mix.
 */
export function deepinfraMissAt(promptTokens?: number): number {
  const band = cacheBandAt(promptTokens);
  return band.deepseekMiss * band.ratio;
}

/** Share of a turn's tokens that is prompt rather than output. */
const PROMPT_SHARE = 1 - TOKEN_MIX.output;

/**
 * Price of 1M tokens of this usage at `rates`, given the share of the prompt
 * that is a cache MISS, in USD. Miss share and cache-read share are
 * complements, so a provider that re-reads more of the prompt also collects
 * less cache-read revenue on the same turn.
 */
export function priceAtMissShare(rates: RateSet, missShare: number): number {
  return (
    PROMPT_SHARE * missShare * rates.input +
    PROMPT_SHARE * (1 - missShare) * rates.cacheRead +
    TOKEN_MIX.output * rates.output
  );
}

/**
 * Price of 1M tokens of this usage at `rates`, at this machine's AGGREGATE mix —
 * the number to quote when no prompt size is in play. `inputMultiplier` scales
 * the aggregate miss share, which is how the DeepInfra side is priced when the
 * size is unknown. Per *billion* tokens (x1e3):
 *
 *   DeepSeek off-peak   $5.19     DeepInfra list  (aggregate)  $8.35
 *   DeepSeek peak      $10.38     DeepInfra @51%  (aggregate)  $4.09
 *
 * A summary, not a substitute for `cheaperAtPrompt`: it holds DeepSeek's miss
 * share at 0.36% when a 524K prompt's is 0.06% and a 30K prompt's is 3.3%.
 */
export function blendedPrice(rates: RateSet, inputMultiplier = 1): number {
  return priceAtMissShare(rates, TOKEN_MIX.input * inputMultiplier);
}

/**
 * Whether `candidate` costs less than `baseline` at this machine's aggregate
 * mix. Replaces the old every-axis test, which demanded a 50% discount against
 * a 37.8% break-even for a short prompt.
 */
export function cheaperOnMyMix(
  candidate: RateSet,
  baseline: RateSet,
  candidateInputMultiplier = 1,
): boolean {
  return blendedPrice(candidate, candidateInputMultiplier) < blendedPrice(baseline);
}

/**
 * Whether `candidate` costs less than `baseline` at a prompt of `promptTokens` —
 * the comparison the router makes, with each side priced at the cache behaviour
 * measured for that context size. This is the one that decides a request.
 *
 * The off-peak break-even discount it implies moves with the prompt, and past
 * 524K no plausible discount makes DeepInfra the better buy: that band lands
 * near parity, and the router stops preferring it there.
 */
export function cheaperAtPrompt(
  candidate: RateSet,
  baseline: RateSet,
  promptTokens?: number,
): boolean {
  const band = cacheBandAt(promptTokens);
  return (
    priceAtMissShare(candidate, band.deepseekMiss * band.ratio) <
    priceAtMissShare(baseline, band.deepseekMiss)
  );
}

/** The virtual model that routes between the two. */
export const ROUTER: ModelRef = { provider: "deepseek", id: "deepseek-flash-auto" };

/** Display name of each side, for the footer label. */
export const PROVIDER_LABEL: Record<string, string> = {
  deepseek: "DeepSeek",
  deepinfra: "DeepInfra",
};

/** Whether `ref` is one of the two sides the router swaps between. */
export function isRouted(ref: ModelRef | undefined): boolean {
  if (!ref) return false;
  return (
    (ref.provider === DEEPSEEK_FLASH.provider && ref.id === DEEPSEEK_FLASH.id) ||
    (ref.provider === DEEPINFRA_FLASH.provider && ref.id === DEEPINFRA_FLASH.id)
  );
}

/** The other side from `ref` (undefined if `ref` is neither side). */
export function otherSide(ref: ModelRef | undefined): ModelRef | undefined {
  if (!ref) return undefined;
  if (ref.provider === DEEPSEEK_FLASH.provider && ref.id === DEEPSEEK_FLASH.id) return DEEPINFRA_FLASH;
  if (ref.provider === DEEPINFRA_FLASH.provider && ref.id === DEEPINFRA_FLASH.id) return DEEPSEEK_FLASH;
  return undefined;
}
