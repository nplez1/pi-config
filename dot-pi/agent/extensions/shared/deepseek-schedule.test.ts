// Run with `bun test dot-pi/agent/extensions/shared/`.
//
// These pin the provider comparison's arithmetic, not the rate card: the rates
// change with DeepSeek's schedule and DeepInfra's promos, but the token mix is
// a property of how the machine is used, and the break-even discount it implies
// is the whole decision. A silent drift in `TOKEN_MIX` would flip the router
// without anything else failing.

import { describe, expect, test } from "bun:test";
import {
  DEEPINFRA_BASELINE_COST,
  DEEPINFRA_INPUT_MULTIPLIER,
  DEEPINFRA_LIST,
  DEEPSEEK_FLASH,
  TOKEN_MIX,
  blendedPrice,
  cheaperOnMyMix,
  deepseekCost,
  effectiveCost,
} from "./deepseek-schedule.ts";

const near = (actual: number, expected: number, tolerance = 0.02) =>
  expect(Math.abs(actual - expected) / expected).toBeLessThan(tolerance);

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

describe("blendedPrice", () => {
  test("prices DeepSeek's two tiers ~2x apart", () => {
    near(blendedPrice(deepseekCost("peak")) / blendedPrice(deepseekCost("off-peak")), 2);
  });

  test("prices a billion tokens of this usage at ~$5 off-peak and ~$10 at peak", () => {
    near(blendedPrice(deepseekCost("off-peak")) * 1e3, 5.09);
    near(blendedPrice(deepseekCost("peak")) * 1e3, 10.18);
  });

  test("prices DeepInfra list at ~$8.84 once its cache misses are counted", () => {
    near(blendedPrice(DEEPINFRA_LIST, DEEPINFRA_INPUT_MULTIPLIER) * 1e3, 8.84);
  });

  test("inputMultiplier scales only the input axis", () => {
    const rates = deepseekCost("off-peak");
    const delta = blendedPrice(rates, 2) - blendedPrice(rates);
    near(delta, TOKEN_MIX.input * rates.input);
  });
});

describe("cheaperOnMyMix", () => {
  // DeepInfra's list card is >= DeepSeek off-peak on every axis, so an
  // every-axis test rejects it outright. The mix does not: output is a tie and
  // cache reads are only 2x, so ~42% off is enough to win.
  test("rejects DeepInfra list at off-peak", () => {
    expect(cheaperOnMyMix(DEEPINFRA_LIST, deepseekCost("off-peak"), DEEPINFRA_INPUT_MULTIPLIER)).toBe(false);
  });

  test("takes DeepInfra list at peak, by ~13%", () => {
    expect(cheaperOnMyMix(DEEPINFRA_LIST, deepseekCost("peak"), DEEPINFRA_INPUT_MULTIPLIER)).toBe(true);
    const margin =
      blendedPrice(DEEPINFRA_LIST, DEEPINFRA_INPUT_MULTIPLIER) / blendedPrice(deepseekCost("peak"));
    expect(margin).toBeGreaterThan(0.85);
    expect(margin).toBeLessThan(0.9);
  });

  test("off-peak break-even is ~42% off, not the 50% an every-axis rule needs", () => {
    const offPeak = deepseekCost("off-peak");
    let breakEven = 0;
    for (let discount = 0; discount <= 1; discount += 0.001) {
      if (cheaperOnMyMix(effectiveCost(DEEPINFRA_LIST, discount), offPeak, DEEPINFRA_INPUT_MULTIPLIER)) {
        breakEven = discount;
        break;
      }
    }
    expect(breakEven).toBeGreaterThan(0.41);
    expect(breakEven).toBeLessThan(0.44);
  });

  test("without the cache-miss penalty the break-even drops to ~38%", () => {
    const offPeak = deepseekCost("off-peak");
    let breakEven = 0;
    for (let discount = 0; discount <= 1; discount += 0.001) {
      if (cheaperOnMyMix(effectiveCost(DEEPINFRA_LIST, discount), offPeak)) {
        breakEven = discount;
        break;
      }
    }
    expect(breakEven).toBeGreaterThan(0.37);
    expect(breakEven).toBeLessThan(0.4);
  });

  test("the promo wins at both tiers, penalty included", () => {
    for (const tier of ["peak", "off-peak"] as const) {
      expect(cheaperOnMyMix(DEEPINFRA_BASELINE_COST, deepseekCost(tier), DEEPINFRA_INPUT_MULTIPLIER)).toBe(true);
    }
  });

  test("DeepSeek wins off-peak once the promo is gone", () => {
    expect(cheaperOnMyMix(DEEPINFRA_LIST, deepseekCost("off-peak"), DEEPINFRA_INPUT_MULTIPLIER)).toBe(false);
  });

  test("is not the every-axis rule", () => {
    // The band the old rule got wrong: 45% off is cheaper on the mix, but
    // DeepInfra's cache-read rate ($0.0033) is still above DeepSeek's ($0.003).
    const card = effectiveCost(DEEPINFRA_LIST, 0.45);
    expect(card.cacheRead).toBeGreaterThan(deepseekCost("off-peak").cacheRead);
    expect(cheaperOnMyMix(card, deepseekCost("off-peak"), DEEPINFRA_INPUT_MULTIPLIER)).toBe(true);
  });
});

describe("rate card", () => {
  test("the router targets the same checkpoint DeepSeek serves", () => {
    expect(DEEPSEEK_FLASH.id).toBe("deepseek-flash");
  });
});
