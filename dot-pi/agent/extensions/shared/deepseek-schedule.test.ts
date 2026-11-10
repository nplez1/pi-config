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
  TOKEN_MIX,
  blendedPrice,
  cacheBandAt,
  cheaperAtPrompt,
  cheaperOnMyMix,
  deepinfraMissAt,
  deepseekCost,
  effectiveCost,
  priceAtMissShare,
} from "./deepseek-schedule.ts";

const near = (actual: number, expected: number, tolerance = 0.02) =>
  expect(Math.abs(actual - expected) / expected).toBeLessThan(tolerance);

/** Prompts in the first band, a typical working band, and the last band. */
const SHORT = 30_000;
const MID = 200_000;
const HUGE = 600_000;

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
      expect(band.ratio).toBeGreaterThanOrEqual(1);
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
      expect(CACHE_BANDS[i].ratio).toBeGreaterThanOrEqual(CACHE_BANDS[i - 1].ratio);
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

  test("deepinfraMissAt is the band's DeepSeek share times its ratio", () => {
    for (const band of CACHE_BANDS) {
      near(deepinfraMissAt(band.upTo), band.deepseekMiss * band.ratio);
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
});

describe("cheaperAtPrompt", () => {
  test("rejects DeepInfra list at off-peak", () => {
    expect(cheaperAtPrompt(DEEPINFRA_LIST, deepseekCost("off-peak"), SHORT)).toBe(false);
  });

  test("takes DeepInfra list at peak, by ~25% on a short prompt", () => {
    expect(cheaperAtPrompt(DEEPINFRA_LIST, deepseekCost("peak"), SHORT)).toBe(true);
    const band = cacheBandAt(SHORT);
    const margin =
      priceAtMissShare(DEEPINFRA_LIST, band.deepseekMiss * band.ratio) /
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
      expect(cheaperAtPrompt(dearer, deepseekCost("peak"), prompt)).toBe(false);
      expect(cheaperAtPrompt(dearer, deepseekCost("off-peak"), prompt)).toBe(false);
    }
  });

  test("off-peak break-even is ~33% off on a short prompt", () => {
    const breakEvenAt = (prompt: number) => {
      for (let discount = 0; discount <= 1; discount += 0.001) {
        if (cheaperAtPrompt(effectiveCost(DEEPINFRA_LIST, discount), deepseekCost("off-peak"), prompt)) {
          return discount;
        }
      }
      return 1;
    };
    const short = breakEvenAt(SHORT);
    expect(short).toBeGreaterThan(0.31);
    expect(short).toBeLessThan(0.35);
  });

  // The property the old single-scalar model could not express: the discount
  // DeepInfra needs to win off-peak grows with the context it is asked to hold.
  test("the off-peak break-even rises with the prompt size", () => {
    const breakEvenAt = (prompt: number) => {
      for (let discount = 0; discount <= 1; discount += 0.001) {
        if (cheaperAtPrompt(effectiveCost(DEEPINFRA_LIST, discount), deepseekCost("off-peak"), prompt)) {
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
      expect(cheaperAtPrompt(promo, deepseekCost("off-peak"), prompt)).toBe(true);
      expect(cheaperAtPrompt(promo, deepseekCost("peak"), prompt)).toBe(true);
    }
  });

  test("the same 51% promo stops winning off-peak past 524K", () => {
    // The regression the size-aware bands exist to catch. DeepInfra's cache
    // penalty there (~19.8x) puts the two cards at parity, so off-peak falls
    // back to DeepSeek — which the old 1.87 scalar never did.
    const promo = effectiveCost(DEEPINFRA_LIST, 0.51);
    expect(cheaperAtPrompt(promo, deepseekCost("off-peak"), HUGE)).toBe(false);
    // Peak is a different question and DeepInfra still wins it comfortably.
    expect(cheaperAtPrompt(promo, deepseekCost("peak"), HUGE)).toBe(true);
  });

  test("is not the every-axis rule", () => {
    // The band the old rule got wrong: 45% off is cheaper on the mix, but
    // DeepInfra's cache-read rate ($0.0033) is still above DeepSeek's ($0.003).
    const card = effectiveCost(DEEPINFRA_LIST, 0.45);
    expect(card.cacheRead).toBeGreaterThan(deepseekCost("off-peak").cacheRead);
    expect(cheaperAtPrompt(card, deepseekCost("off-peak"), MID)).toBe(true);
  });
});

describe("cheaperOnMyMix (aggregate)", () => {
  // Kept for the summary figures the README quotes; the router uses
  // cheaperAtPrompt, which prices both sides at the context's own band.
  test("agrees with cheaperAtPrompt near the aggregate's centre of mass", () => {
    const promo = effectiveCost(DEEPINFRA_LIST, 0.51);
    for (const prompt of [SHORT, MID, 400_000]) {
      expect(cheaperAtPrompt(promo, deepseekCost("off-peak"), prompt)).toBe(true);
    }
    expect(cheaperOnMyMix(promo, deepseekCost("off-peak"))).toBe(true);
  });

  test("rejects DeepInfra list at off-peak", () => {
    expect(cheaperOnMyMix(DEEPINFRA_LIST, deepseekCost("off-peak"))).toBe(false);
  });
});
