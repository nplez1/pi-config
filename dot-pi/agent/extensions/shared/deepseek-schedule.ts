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
 * rate. Which tier it wins is not declared anywhere — `cheaperOnMyMix` decides
 * it per request. On the 2026-11-01 cards its list price is 13% cheaper than
 * DeepSeek's peak card on this machine's mix and 74% dearer than the off-peak
 * one; the 51% promo is 57% cheaper than peak and 15% cheaper than off-peak.
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
 * Measured over 38,556 assistant messages on deepseek-flash, 2026-10-14 until
 * 2026-11-01 09:00 UTC — the DeepSeek-only period, before the router took over,
 * so DeepInfra's cache behaviour cannot contaminate the baseline. Reproduce with
 *   measure-token-mix.mjs --since 2026-10-14 --until 2026-11-01T09:00Z
 * which prints 29,452,209 input misses, 8,485,449,080 cache reads and
 * 22,644,163 output. Cache reads are 99.4% of every prompt, because a long
 * agent session replays its whole history each turn.
 *
 * Token shares and SPEND shares are wildly different, and only the token
 * shares belong in a price comparison. On DeepSeek's off-peak card these
 * tokens spend 10.2% on input, 58.6% on cache reads, 31.2% on output — and
 * cache reads are both the heaviest axis and the one the two cards differ most
 * on (DeepInfra list is 2x DeepSeek off-peak there, 1.33x on input and 1.0x on
 * output), so the decision is essentially a cache-read comparison.
 *
 * The old `cheaperOnEveryAxis` rule tested dominance instead: DeepInfra had to
 * be at least as cheap on all three axes. That test is never *wrong*, it is
 * just far too conservative — it demands a 50% DeepInfra discount where this
 * mix's break-even is 42.5%.
 */
export const TOKEN_MIX: RateSet = {
  input: 0.00345,
  cacheRead: 0.9939,
  output: 0.00265,
};

/**
 * DeepInfra re-reads more of the prompt as cache misses than DeepSeek does:
 * median 1 miss per 136 cache reads over 23 sessions of >=60 assistant
 * messages, against 1 per 254 over 135 DeepSeek sessions (re-derive both with
 * `measure-token-mix.mjs`). Scales the input axis of a DeepInfra card in
 * `blendedPrice` so the comparison prices the tokens DeepInfra would actually
 * bill, not the ones DeepSeek bills.
 *
 * An estimate, not a measurement with an interval. A narrower filter — sessions
 * served entirely by one provider — gives 1.61, so the two filters bracket
 * 1.6-1.9; that is a choice of sampling, not a confidence range, and the ratio
 * of two per-session medians is not exactly the ratio to apply to an aggregate
 * mix (taken literally, the implied per-session figure is ~2.1). It moves the
 * off-peak break-even from 38% to 42.5%, so it only decides that band, and it
 * is small next to the 2x that separates the two cards on cache reads.
 */
export const DEEPINFRA_INPUT_MULTIPLIER = 1.87;

/**
 * Price of 1M tokens of *this* usage at `rates`, in USD — the single number to
 * compare two cards by. `inputMultiplier` scales the input axis for a provider
 * that re-reads more of the prompt as cache misses (see
 * `DEEPINFRA_INPUT_MULTIPLIER`); pass 1 for the baseline side.
 *
 * The absolute values look small because 1M tokens of this usage is mostly
 * cache reads; read them as the ratio. Per *billion* tokens (x1e3):
 *
 *   DeepSeek off-peak  $5.09      DeepInfra list      $8.84
 *   DeepSeek peak      $10.18     DeepInfra @51% off  $4.33
 */
export function blendedPrice(rates: RateSet, inputMultiplier = 1): number {
  return (
    TOKEN_MIX.input * inputMultiplier * rates.input +
    TOKEN_MIX.cacheRead * rates.cacheRead +
    TOKEN_MIX.output * rates.output
  );
}

/**
 * Whether `candidate` costs less than `baseline` for this machine's token mix,
 * with `candidate`'s extra cache misses accounted for. Replaces the old
 * every-axis test, which is 8 points of discount too conservative: 50% against
 * this mix's 42.5% break-even.
 */
export function cheaperOnMyMix(
  candidate: RateSet,
  baseline: RateSet,
  candidateInputMultiplier = 1,
): boolean {
  return blendedPrice(candidate, candidateInputMultiplier) < blendedPrice(baseline);
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
