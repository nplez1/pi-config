// Run with `bun test dot-pi/agent/extensions/shared/`.
//
// These pin the router's *recovery* behaviour and that its choice follows the
// live price — not which side wins at a given moment, which depends on the
// DeepInfra discount rather than on anything here.
//
// Two facts drive the design:
//
//  - pi checks credentials again on whatever `route()` returns: "If `route()`
//    throws, or returns a virtual model or a model without credentials, the
//    request ends with an error response" (docs/virtual-models.md), implemented
//    in `resolveModel` as `hasConfiguredAuth(target.provider)` after the awaited
//    `route()`. So the harness applies that check too, or a test can pass on a
//    model pi would have rejected.
//  - pi awaits `route()`, so the router can wait for the live pricing fetch
//    before deciding. `stubPricing` below drives that.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import register from "../deepseek-routing.ts";

const DEEPSEEK = { provider: "deepseek", id: "deepseek-flash" };
const DEEPINFRA = { provider: "deepinfra", id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" };
const SIDES = ["deepseek", "deepinfra"];

interface FakeRegistry {
  find(provider: string, id: string): unknown;
  getAvailable?(): unknown[];
  hasConfiguredAuth?(model: unknown): boolean;
}

function registry(opts: {
  sides: (typeof DEEPSEEK)[];
  configured: boolean;
  /** Whether getAvailable() answers at all; [] means "cannot answer". */
  snapshot?: boolean;
}): FakeRegistry {
  return {
    find: (provider, id) =>
      opts.sides.find((side) => side.provider === provider && side.id === id),
    getAvailable: () => (opts.snapshot === false ? [] : opts.sides),
    hasConfiguredAuth: () => opts.configured,
  };
}

const healthy = registry({ sides: [DEEPSEEK, DEEPINFRA], configured: true });
/** Nothing reports credentials, and the availability cache cannot answer. */
const staleCredentials = registry({ sides: [DEEPSEEK, DEEPINFRA], configured: false, snapshot: false });
/** The availability cache says both are usable; pi's credential check says no. */
const staleAvailability = registry({ sides: [DEEPSEEK, DEEPINFRA], configured: false });
const emptyCatalog = registry({ sides: [], configured: false });

/** DeepInfra's public catalog, as the router reads it. */
function pricingResponse(input: number, output: number, cacheRead: number, discount: number) {
  return {
    ok: true,
    json: async () => ({
      data: [
        {
          id: DEEPINFRA.id,
          metadata: { pricing: { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead }, discount },
        },
      ],
    }),
  } as unknown as Response;
}

/** Replace the pricing endpoint for the duration of one test. */
const realFetch = globalThis.fetch;
function stubPricing(response: () => Promise<Response>) {
  // SAFETY: only the one URL the extension fetches is intercepted.
  globalThis.fetch = ((url: string) =>
    String(url).includes("api.deepinfra.com") ? response() : realFetch(url as never)) as never;
}

/**
 * The virtual model the extension registers, wrapped in a `route()` that also
 * applies pi's post-route credential check and fires `session_start` once.
 */
async function harness(reg: FakeRegistry, reason: "user" | "continuation" = "user") {
  const models: { id?: string; route?: (r: unknown, c: unknown) => Promise<{ model: { provider: string; id: string } }> }[] = [];
  const handlers: Record<string, (() => unknown)[]> = {};
  const pi = {
    registerProvider: () => {},
    registerVirtualModel: (model: unknown) => void models.push(model as never),
    on: (event: string, handler: () => unknown) => void (handlers[event] ??= []).push(handler),
  };
  // SAFETY: the fake only has to satisfy the surface the extension calls.
  register(pi as never);
  const router = models.find((model) => model.id === "deepseek-flash-auto");
  if (!router?.route) throw new Error("router was not registered");
  const ctx = { modelRegistry: reg, hasUI: false, model: undefined, ui: { setStatus: () => {} } };
  // session_start handlers take (event, ctx), so the context is the second arg.
  for (const handler of handlers["session_start"] ?? []) {
    await (handler as (e: unknown, c: unknown) => unknown)(undefined, ctx);
  }
  const route = () => router.route!({ reason, thinkingLevel: "high" }, ctx);
  /** `route()`, then pi's own check — the request pi would actually make. */
  const routeAsPi = async () => {
    const result = await route();
    if (reg.hasConfiguredAuth && !reg.hasConfiguredAuth(result.model.provider)) {
      throw new Error(`${result.model.provider}/${result.model.id}, which has no credentials.`);
    }
    return result;
  };
  return { route, routeAsPi };
}

const previousTier = process.env.PI_DEEPSEEK_TIER;
beforeEach(() => {
  // Hermetic by default: a failed fetch leaves the list-price seed in place.
  stubPricing(async () => {
    throw new Error("offline");
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousTier === undefined) delete process.env.PI_DEEPSEEK_TIER;
  else process.env.PI_DEEPSEEK_TIER = previousTier;
});

describe("router recovery", () => {
  test("routes to one of the two sides when the registry is healthy", async () => {
    for (const tier of ["peak", "off-peak"] as const) {
      process.env.PI_DEEPSEEK_TIER = tier;
      expect(SIDES).toContain((await (await harness(healthy)).routeAsPi()).model.provider);
    }
  });

  test("throws, rather than returning a model pi would reject", async () => {
    // pi re-checks credentials on the returned model, so no return value can
    // recover a stale snapshot. The only remedy an extension has is a clear,
    // actionable error: naming /reload is the point of it.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const { route } = await harness(staleCredentials);
    await expect(route()).rejects.toThrow(/\/reload/);
  });

  test("cannot rescue an availability cache that says yes when auth says no", async () => {
    // A documented limit, not a fix: the router trusts a non-empty availability
    // snapshot, pi then refuses the model it picked, and only /reload helps.
    // Pinned so nobody "fixes" the router by returning a model anyway — pi
    // rejects that too, with a message that blames a credential.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const { routeAsPi } = await harness(staleAvailability);
    await expect(routeAsPi()).rejects.toThrow(/no credentials/);
  });

  test("throws when the catalog itself has lost both sides", async () => {
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const { route } = await harness(emptyCatalog);
    await expect(route()).rejects.toThrow(/no credentials, or missing from the catalog/);
  });

  test("falls to the other side when only it is in the catalog", async () => {
    // Whichever tier is asked for, a missing side must not become a throw.
    for (const tier of ["peak", "off-peak"] as const) {
      process.env.PI_DEEPSEEK_TIER = tier;
      const onlyDeepSeek = registry({ sides: [DEEPSEEK], configured: true });
      expect((await (await harness(onlyDeepSeek)).routeAsPi()).model.provider).toBe("deepseek");
      const onlyDeepInfra = registry({ sides: [DEEPINFRA], configured: true });
      expect((await (await harness(onlyDeepInfra)).routeAsPi()).model.provider).toBe("deepinfra");
    }
  });
});

describe("router follows the price, not the clock", () => {
  test("takes DeepInfra at peak when its live card is cheap", async () => {
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.098, 0.294, 0.00294, 0));
    expect((await (await harness(healthy)).routeAsPi()).model.provider).toBe("deepinfra");
  });

  test("applies the live price off-peak, where list price would lose", async () => {
    // The discriminating case: list price stays on DeepSeek off-peak, so only a
    // fetched promo can produce DeepInfra here. A peak case cannot tell the two
    // apart, because list price also wins at peak.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    stubPricing(async () => pricingResponse(0.098, 0.294, 0.00294, 0));
    expect((await (await harness(healthy)).routeAsPi()).model.provider).toBe("deepinfra");
  });

  test("stays on DeepSeek off-peak when DeepInfra's live card is dear", async () => {
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    expect((await (await harness(healthy)).routeAsPi()).model.provider).toBe("deepseek");
  });

  test("leaves DeepSeek at peak when DeepInfra's live card is dearer still", async () => {
    // The requirement: no tier may assume DeepInfra. A card above DeepSeek's
    // peak price has to lose at peak, whatever the clock says.
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.5, 1.5, 0.012, 0));
    expect((await (await harness(healthy)).routeAsPi()).model.provider).toBe("deepseek");
  });

  test("keeps DeepSeek off-peak when the fetch fails", async () => {
    // Seeded with list price, so a failed fetch is conservative rather than
    // routing on an assumed promo.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    stubPricing(async () => {
      throw new Error("offline");
    });
    expect((await (await harness(healthy)).routeAsPi()).model.provider).toBe("deepseek");
  });

  test("ignores a pricing payload with no cache-read figure", async () => {
    // A missing figure must not read as free cache reads, which would win every
    // hour on an axis carrying 99.4% of the weight.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    stubPricing(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: DEEPINFRA.id, metadata: { pricing: { input_tokens: 0.01, output_tokens: 0.01 } } }] }),
    }) as unknown as Response);
    expect((await (await harness(healthy)).routeAsPi()).model.provider).toBe("deepseek");
  });
});
