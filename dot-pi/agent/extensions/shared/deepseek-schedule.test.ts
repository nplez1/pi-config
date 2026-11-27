// Run with `bun test dot-pi/agent/extensions/shared/`.
//
// Two jobs. The structural assertions (a share distribution, miss share and
// cache-read share being complements, the bands covering every size, the
// break-even rising with context) pin properties that must hold for any rates.
// The figure assertions ($5.21, $8.37, the 25% peak margin) pin the numbers
// quoted in the module comments and the README, so prose and code cannot drift
// apart — they are expected to be updated together when a card changes.

import { describe, expect, test } from "bun:test";
import {
  CACHE_BANDS,
  DEEPINFRA_LIST,
  DEFAULT_VALUE_OF_TIME_USD_PER_HOUR,
  LATENCY_BANDS,
  ISOQUANT_RATES,
  SIDES,
  TOKEN_MIX,
  bestSideAt,
  blendedPrice,
  cacheBandAt,
  cheapestSideAt,
  cheaperOnMyMix,
  deepseekCost,
  effectiveCost,
  missShareAt,
  priceAtMissShare,
  priceSide,
  refFor,
  scoreSide,
  valueOfTimeUsdPerHour,
  waitSecondsPerMillion,
  sideOf,
  type RateSet,
  type Side,
} from "./deepseek-schedule.ts";

const near = (actual: number, expected: number, tolerance = 0.02) =>
  expect(Math.abs(actual - expected) / expected).toBeLessThan(tolerance);

/** Prompts in the first band, a typical working band, and the last band. */
const SHORT = 30_000;
const MID = 200_000;
const HUGE = 600_000;

/**
 * Whether `candidate` beats `baseline` at a prompt of `prompt` — each priced at
 * its OWN measured cache behaviour, which is what the router compares.
 */
const beats = (
  candidate: Side,
  candidateRates: RateSet,
  baseline: Side,
  baselineRates: RateSet,
  prompt: number,
) => priceSide(candidate, candidateRates, prompt) < priceSide(baseline, baselineRates, prompt);

describe("TOKEN_MIX", () => {
  test("is a share distribution", () => {
    const sum = TOKEN_MIX.input + TOKEN_MIX.cacheRead + TOKEN_MIX.output;
    near(sum, 1, 1e-6);
  });

  test("is dominated by cache reads", () => {
    expect(TOKEN_MIX.cacheRead).toBeGreaterThan(0.99);
    expect(TOKEN_MIX.cacheRead).toBeGreaterThan(200 * TOKEN_MIX.input);
    expect(TOKEN_MIX.cacheRead).toBeGreaterThan(200 * TOKEN_MIX.output);
  });
});

describe("CACHE_BANDS", () => {
  test("covers every prompt size in ascending order", () => {
    for (let i = 1; i < CACHE_BANDS.length; i += 1) {
      expect(CACHE_BANDS[i].upTo).toBeGreaterThan(CACHE_BANDS[i - 1].upTo);
    }
    expect(CACHE_BANDS[CACHE_BANDS.length - 1].upTo).toBe(Number.POSITIVE_INFINITY);
  });

  test("every band is a plausible miss share", () => {
    for (const band of CACHE_BANDS) {
      expect(band.deepseekMiss).toBeGreaterThan(0);
      expect(band.deepseekMiss).toBeLessThan(0.2);
      // Parity, not an advantage: a side can cache slightly BETTER than DeepSeek
      // (DeepInfra sits at 0.99x on the short band), so this is a sanity range
      // rather than a floor of 1.
      expect(band.ratios.deepinfra).toBeGreaterThan(0.9);
      expect(band.ratios.isoquant).toBeGreaterThan(0.5);
    }
  });

  // The measured property the router depends on: DeepSeek's cache improves as
  // the prompt grows, so its miss share falls — which is why the aggregate
  // TOKEN_MIX.input cannot stand in for a band.
  test("DeepSeek's miss share falls as the context grows", () => {
    for (let i = 1; i < CACHE_BANDS.length; i += 1) {
      expect(CACHE_BANDS[i].deepseekMiss).toBeLessThan(CACHE_BANDS[i - 1].deepseekMiss);
    }
  });

  test("DeepInfra's disadvantage grows as the context grows", () => {
    for (let i = 1; i < CACHE_BANDS.length; i += 1) {
      expect(CACHE_BANDS[i].ratios.deepinfra).toBeGreaterThanOrEqual(CACHE_BANDS[i - 1].ratios.deepinfra);
    }
  });

  // IsoQuant forwards to the same upstream checkpoint, and its measurement says
  // so: within a factor of two of DeepSeek at every size, never the 20x blow-up
  // DeepInfra shows at the top. That is why its card, not its cache, decides.
  test("IsoQuant's cache tracks DeepSeek's instead of degrading", () => {
    for (const band of CACHE_BANDS) {
      expect(band.ratios.isoquant).toBeGreaterThan(0.6);
      expect(band.ratios.isoquant).toBeLessThan(1.5);
    }
  });

  test("the aggregate miss share is not any band's", () => {
    // The trap the first version fell into: TOKEN_MIX.input is a weighted
    // average over all sizes, 6x the short band's and 6x the huge band's.
    for (const band of CACHE_BANDS) {
      expect(Math.abs(band.deepseekMiss - TOKEN_MIX.input)).toBeGreaterThan(0.0005);
    }
  });
});

describe("cacheBandAt", () => {
  test("picks the band that contains the size", () => {
    expect(cacheBandAt(SHORT)).toBe(CACHE_BANDS[0]);
    expect(cacheBandAt(MID)).toBe(CACHE_BANDS[2]);
    expect(cacheBandAt(HUGE)).toBe(CACHE_BANDS[CACHE_BANDS.length - 1]);
  });

  test("treats an unknown size as the smallest band, not the average", () => {
    // The first request of a session has no usage to read, and a fresh prompt
    // really is short. Guessing the 160K average here would over-price it.
    expect(cacheBandAt(undefined)).toBe(CACHE_BANDS[0]);
    expect(cacheBandAt(Number.NaN)).toBe(CACHE_BANDS[0]);
  });

  test("missShareAt is the band's DeepSeek share times the side's ratio", () => {
    for (const band of CACHE_BANDS) {
      near(missShareAt("deepseek", band.upTo), band.deepseekMiss);
      near(missShareAt("deepinfra", band.upTo), band.deepseekMiss * band.ratios.deepinfra);
      near(missShareAt("isoquant", band.upTo), band.deepseekMiss * band.ratios.isoquant);
    }
  });
});

describe("priceAtMissShare", () => {
  test("miss share and cache-read share are complements", () => {
    // At a 100% miss share the prompt is all input; at 0% it is all cache read.
    const rates = deepseekCost("off-peak");
    const allMiss = priceAtMissShare(rates, 1);
    const allHit = priceAtMissShare(rates, 0);
    near(allMiss - allHit, (1 - TOKEN_MIX.output) * (rates.input - rates.cacheRead));
  });

  test("a dearer input rate costs more, and a dearer cache read costs less", () => {
    const base = deepseekCost("off-peak");
    expect(priceAtMissShare({ ...base, input: base.input * 2 }, 0.01)).toBeGreaterThan(
      priceAtMissShare(base, 0.01),
    );
    expect(priceAtMissShare({ ...base, cacheRead: base.cacheRead * 2 }, 0.01)).toBeGreaterThan(
      priceAtMissShare(base, 0.01),
    );
  });
});

describe("blendedPrice", () => {
  test("prices DeepSeek's two tiers ~2x apart", () => {
    near(blendedPrice(deepseekCost("peak")) / blendedPrice(deepseekCost("off-peak")), 2);
  });

  test("prices a billion tokens of the aggregate mix at ~$5.21 off-peak and ~$10.41 at peak", () => {
    near(blendedPrice(deepseekCost("off-peak")) * 1e3, 5.21);
    near(blendedPrice(deepseekCost("peak")) * 1e3, 10.41);
  });

  test("prices DeepInfra list at ~$8.37 on the aggregate mix", () => {
    near(blendedPrice(DEEPINFRA_LIST) * 1e3, 8.37);
  });

  test("prices IsoQuant at ~$6.13 on the aggregate mix", () => {
    // Not the router's number (it prices the band, not the aggregate), just the
    // figure the README quotes for a card that has no cache argument.
    near(blendedPrice(ISOQUANT_RATES) * 1e3, 6.13);
  });
});

describe("priceSide", () => {
  test("prices each side at its own cache behaviour, not DeepSeek's", () => {
    // Same card, same prompt, different cache: naming the side has to change the
    // answer, or the bands are not being applied.
    const card = deepseekCost("off-peak");
    expect(priceSide("deepinfra", card, HUGE)).toBeGreaterThan(priceSide("deepseek", card, HUGE));
    expect(priceSide("isoquant", card, HUGE)).toBeLessThan(priceSide("deepinfra", card, HUGE));
  });

  test("an unknown prompt size is priced as the smallest band", () => {
    expect(priceSide("deepinfra", DEEPINFRA_LIST, undefined)).toBe(
      priceSide("deepinfra", DEEPINFRA_LIST, SHORT),
    );
  });
});

describe("the two-card comparison", () => {
  test("rejects DeepInfra list at off-peak", () => {
    expect(beats("deepinfra", DEEPINFRA_LIST, "deepseek", deepseekCost("off-peak"), SHORT)).toBe(false);
  });

  test("takes DeepInfra list from DeepSeek's peak card, by ~25% on a short prompt", () => {
    expect(beats("deepinfra", DEEPINFRA_LIST, "deepseek", deepseekCost("peak"), SHORT)).toBe(true);
    const band = cacheBandAt(SHORT);
    const margin =
      priceAtMissShare(DEEPINFRA_LIST, band.deepseekMiss * band.ratios.deepinfra) /
      priceAtMissShare(deepseekCost("peak"), band.deepseekMiss);
    expect(margin).toBeGreaterThan(0.72);
    expect(margin).toBeLessThan(0.78);
  });

  // No tier is pre-decided. A DeepInfra card dearer than DeepSeek's peak card
  // has to lose at peak at every size — the guard against "peak -> DeepInfra"
  // creeping back in as an assumption rather than a result.
  test("does not assume DeepInfra wins at peak", () => {
    const dearer = { input: 0.5, output: 1.5, cacheRead: 0.012 };
    for (const prompt of [SHORT, MID, HUGE]) {
      expect(beats("deepinfra", dearer, "deepseek", deepseekCost("peak"), prompt)).toBe(false);
      expect(beats("deepinfra", dearer, "deepseek", deepseekCost("off-peak"), prompt)).toBe(false);
    }
  });

  test("off-peak break-even is ~32% off on a short prompt", () => {
    const breakEvenAt = (prompt: number) => {
      for (let discount = 0; discount <= 1; discount += 0.001) {
        if (beats("deepinfra", effectiveCost(DEEPINFRA_LIST, discount), "deepseek", deepseekCost("off-peak"), prompt)) {
          return discount;
        }
      }
      return 1;
    };
    const short = breakEvenAt(SHORT);
    expect(short).toBeGreaterThan(0.3);
    expect(short).toBeLessThan(0.35);
  });

  // The property the old single-scalar model could not express: the discount
  // DeepInfra needs to win off-peak grows with the context it is asked to hold.
  test("the off-peak break-even rises with the prompt size", () => {
    const breakEvenAt = (prompt: number) => {
      for (let discount = 0; discount <= 1; discount += 0.001) {
        if (beats("deepinfra", effectiveCost(DEEPINFRA_LIST, discount), "deepseek", deepseekCost("off-peak"), prompt)) {
          return discount;
        }
      }
      return 1;
    };
    const short = breakEvenAt(SHORT);
    const mid = breakEvenAt(MID);
    const huge = breakEvenAt(HUGE);
    expect(mid).toBeGreaterThan(short);
    expect(huge).toBeGreaterThan(mid);
    // Past 524K the promo's 51% is no longer enough.
    expect(huge).toBeGreaterThan(0.51);
  });

  test("the 51% promo wins off-peak up to 400K", () => {
    const promo = effectiveCost(DEEPINFRA_LIST, 0.51);
    for (const prompt of [SHORT, MID, 400_000]) {
      expect(beats("deepinfra", promo, "deepseek", deepseekCost("off-peak"), prompt)).toBe(true);
      expect(beats("deepinfra", promo, "deepseek", deepseekCost("peak"), prompt)).toBe(true);
    }
  });

  test("the same 51% promo stops winning off-peak past 524K", () => {
    // The regression the size-aware bands exist to catch. DeepInfra's cache
    // penalty there (~19.8x) puts the two cards at parity, so off-peak falls
    // back to DeepSeek — which the old 1.87 scalar never did.
    const promo = effectiveCost(DEEPINFRA_LIST, 0.51);
    expect(beats("deepinfra", promo, "deepseek", deepseekCost("off-peak"), HUGE)).toBe(false);
    // Peak is a different question and DeepInfra still wins it comfortably.
    expect(beats("deepinfra", promo, "deepseek", deepseekCost("peak"), HUGE)).toBe(true);
  });

  test("is not the every-axis rule", () => {
    // The band the old rule got wrong: 45% off is cheaper on the mix, but
    // DeepInfra's cache-read rate ($0.0033) is still above DeepSeek's ($0.003).
    const card = effectiveCost(DEEPINFRA_LIST, 0.45);
    expect(card.cacheRead).toBeGreaterThan(deepseekCost("off-peak").cacheRead);
    expect(beats("deepinfra", card, "deepseek", deepseekCost("off-peak"), MID)).toBe(true);
  });
});

describe("IsoQuant", () => {
  test("beats DeepInfra's list card at every size", () => {
    for (const prompt of [SHORT, MID, HUGE]) {
      expect(beats("isoquant", ISOQUANT_RATES, "deepinfra", DEEPINFRA_LIST, prompt)).toBe(true);
    }
    // By 30-50%, at the working prompt size.
    const ratio = priceSide("isoquant", ISOQUANT_RATES, MID) / priceSide("deepinfra", DEEPINFRA_LIST, MID);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.75);
  });

  test("takes peak from DeepSeek and from DeepInfra's list card", () => {
    for (const prompt of [SHORT, MID, HUGE]) {
      expect(beats("isoquant", ISOQUANT_RATES, "deepseek", deepseekCost("peak"), prompt)).toBe(true);
      expect(beats("isoquant", ISOQUANT_RATES, "deepinfra", DEEPINFRA_LIST, prompt)).toBe(true);
    }
  });

  test("wins off-peak on a short prompt and loses it from 131K up", () => {
    // Its input rate is a fifth of DeepSeek's, which covers its extra short-prompt
    // misses; from 131K up DeepSeek's cheaper cache read and its own better cache
    // together win. This is the crossover the bands exist to express.
    expect(beats("isoquant", ISOQUANT_RATES, "deepseek", deepseekCost("off-peak"), SHORT)).toBe(true);
    for (const prompt of [MID, HUGE]) {
      expect(beats("isoquant", ISOQUANT_RATES, "deepseek", deepseekCost("off-peak"), prompt)).toBe(false);
    }
  });

  test("loses to a live DeepInfra promo at every size", () => {
    // The honest answer while the promo is deep: 51% off list undercuts even a
    // card this cheap, which is why the router does not choose IsoQuant today.
    const promo = effectiveCost(DEEPINFRA_LIST, 0.51);
    for (const prompt of [SHORT, MID, HUGE]) {
      expect(beats("isoquant", ISOQUANT_RATES, "deepinfra", promo, prompt)).toBe(false);
    }
  });
});

describe("cheapestSideAt", () => {
  const promo = effectiveCost(DEEPINFRA_LIST, 0.51);
  const a = { side: "deepseek" as const, rates: deepseekCost("off-peak") };
  const b = { side: "deepinfra" as const, rates: promo };
  const c = { side: "isoquant" as const, rates: ISOQUANT_RATES };

  test("picks the cheapest card, so the promo keeps DeepInfra off-peak", () => {
    for (const prompt of [SHORT, MID, 400_000]) expect(cheapestSideAt([a, b, c], prompt)).toBe("deepinfra");
  });

  test("hands the same off-peak question to DeepSeek at 600K", () => {
    expect(cheapestSideAt([a, b, c], HUGE)).toBe("deepseek");
  });

  test("hands peak to IsoQuant once DeepInfra is back at list price", () => {
    const peak = { side: "deepseek" as const, rates: deepseekCost("peak") };
    const list = { side: "deepinfra" as const, rates: DEEPINFRA_LIST };
    for (const prompt of [SHORT, MID, HUGE]) expect(cheapestSideAt([peak, list, c], prompt)).toBe("isoquant");
  });

  test("does not depend on the order of the candidates", () => {
    for (const order of [[a, b, c], [c, b, a], [b, c, a]]) {
      expect(cheapestSideAt(order, MID)).toBe("deepinfra");
    }
  });

  test("is undefined for no candidates", () => {
    expect(cheapestSideAt([], MID)).toBeUndefined();
  });
});

describe("sides", () => {
  test("SIDES lists each provider exactly once", () => {
    const providers = SIDES.map((side) => refFor(side).provider);
    expect(new Set(providers).size).toBe(SIDES.length);
  });

  test("sideOf round-trips every side and rejects anything else", () => {
    for (const side of SIDES) expect(sideOf(refFor(side))).toBe(side);
    expect(sideOf({ provider: "deepseek", id: "deepseek-v4-pro" })).toBeUndefined();
    expect(sideOf(undefined)).toBeUndefined();
  });
});

describe("cheaperOnMyMix (aggregate)", () => {
  // Kept for the summary figures the README quotes; the router uses
  // `priceSide`, which prices each side at the context's own band.
  test("agrees with the per-band comparison near the aggregate's centre of mass", () => {
    const promo = effectiveCost(DEEPINFRA_LIST, 0.51);
    for (const prompt of [SHORT, MID, 400_000]) {
      expect(beats("deepinfra", promo, "deepseek", deepseekCost("off-peak"), prompt)).toBe(true);
    }
    expect(cheaperOnMyMix(promo, deepseekCost("off-peak"))).toBe(true);
  });

  test("rejects DeepInfra list at off-peak", () => {
    expect(cheaperOnMyMix(DEEPINFRA_LIST, deepseekCost("off-peak"))).toBe(false);
  });
});

describe("LATENCY_BANDS", () => {
  test("shares CACHE_BANDS' boundaries, so one prompt size picks the same band in both", () => {
    expect(LATENCY_BANDS.map((band) => band.upTo)).toEqual(CACHE_BANDS.map((band) => band.upTo));
  });

  test("has a positive rate for every side in every band", () => {
    for (const band of LATENCY_BANDS) for (const side of SIDES) expect(band.msPerOutputToken[side]).toBeGreaterThan(0);
  });
});

describe("valueOfTimeUsdPerHour", () => {
  test("defaults when unset, blank or unreadable", () => {
    for (const raw of [undefined, "", "  ", "fast", "-1", "Infinity"]) {
      expect(valueOfTimeUsdPerHour({ PI_ROUTER_VALUE_OF_TIME: raw })).toBe(DEFAULT_VALUE_OF_TIME_USD_PER_HOUR);
    }
  });

  test("takes a non-negative number, including zero", () => {
    expect(valueOfTimeUsdPerHour({ PI_ROUTER_VALUE_OF_TIME: "0" })).toBe(0);
    expect(valueOfTimeUsdPerHour({ PI_ROUTER_VALUE_OF_TIME: "12.5" })).toBe(12.5);
  });
});

describe("scoreSide", () => {
  const promo = effectiveCost(DEEPINFRA_LIST, 0.51);

  test("is the card's price when time is free", () => {
    expect(scoreSide("deepinfra", promo, MID, 0)).toBe(priceSide("deepinfra", promo, MID));
  });

  test("adds the measured wait at the given rate", () => {
    const waitUsd = (waitSecondsPerMillion("isoquant", MID) * 5) / 3600;
    expect(scoreSide("isoquant", ISOQUANT_RATES, MID, 5)).toBeCloseTo(priceSide("isoquant", ISOQUANT_RATES, MID) + waitUsd, 12);
  });

  test("pins the module comment: 13.8 s saved and a ~$0.48/hour break-even at 131K-262K", () => {
    const saved = waitSecondsPerMillion("deepinfra", MID) - waitSecondsPerMillion("isoquant", MID);
    near(saved, 13.8);
    const extra = priceSide("isoquant", ISOQUANT_RATES, MID) - priceSide("deepinfra", promo, MID);
    near((extra / saved) * 3600, 0.48, 0.05);
  });
});

describe("bestSideAt", () => {
  const quotes = [
    { side: "deepseek" as const, rates: deepseekCost("off-peak") },
    { side: "deepinfra" as const, rates: effectiveCost(DEEPINFRA_LIST, 0.51) },
    { side: "isoquant" as const, rates: ISOQUANT_RATES },
  ];

  test("agrees with cheapestSideAt when time is free", () => {
    for (const prompt of [SHORT, MID, HUGE]) expect(bestSideAt(quotes, prompt, 0)).toBe(cheapestSideAt(quotes, prompt));
  });

  test("hands the measured faster side a fraction-of-a-cent price gap", () => {
    expect(cheapestSideAt(quotes, MID)).toBe("deepinfra");
    expect(bestSideAt(quotes, MID, DEFAULT_VALUE_OF_TIME_USD_PER_HOUR)).toBe("isoquant");
  });

  test("takes DeepSeek direct past 524K, where it is the fastest side", () => {
    expect(bestSideAt(quotes, HUGE, DEFAULT_VALUE_OF_TIME_USD_PER_HOUR)).toBe("deepseek");
  });
});
