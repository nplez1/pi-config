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
const ISOQUANT = { provider: "isoquant", id: "deepseek-v4.1-flash-1017-fast" };
/** The sides a machine without the IsoQuant extension has — the common case. */
const SIDES = ["deepseek", "deepinfra"];
const ALL_SIDES = [...SIDES, "isoquant"];

interface FakeRegistry {
  find(provider: string, id: string): unknown;
  getAvailable?(): unknown[];
  hasConfiguredAuth?(model: unknown): boolean;
  refresh?(options?: { allowNetwork?: boolean; providers?: string[] }): Promise<unknown>;
  getProviderAuth?(provider: string): Promise<unknown>;
  getProviderAuthStatus?(provider: string): { configured: boolean; source?: string } | undefined;
  getError?(): string | undefined;
  repair?(provider: string): void;
  setConfigured?(value: boolean): void;
}

function registry(opts: {
  sides: (typeof DEEPSEEK)[];
  configured: boolean;
  /** Whether getAvailable() answers at all; [] means "cannot answer". */
  snapshot?: boolean;
  /** Whether a live re-check finds credentials, as pi's `refresh()` does. */
  recheck?: boolean;
  /**
   * Whether a *live* credential resolution finds one, as `getProviderAuth()`
   * does. Undefined means the registry cannot answer that question.
   */
  live?: boolean;
  /** The credential store's answer, as `getProviderAuthStatus()` reports it. */
  store?: string;
  /** Composition or availability errors, as `getError()` reports them. */
  error?: string;
  /** Simulates `registerProvider()` marking a provider configured. */
  repair?(provider: string): void;
}): FakeRegistry & {
  refreshes: string[][];
  registered: string[];
  setConfigured(value: boolean): void;
} {
  let configured = opts.configured;
  const refreshes: string[][] = [];
  const registered: string[] = [];
  return {
    refreshes,
    registered,
    find: (provider, id) =>
      opts.sides.find((side) => side.provider === provider && side.id === id),
    getAvailable: () => (opts.snapshot === false ? [] : opts.sides),
    hasConfiguredAuth: () => configured,
    refresh: async (options) => {
      refreshes.push(options?.providers ?? []);
      if (opts.recheck) configured = true;
      return {};
    },
    getProviderAuth: async (provider) =>
      opts.live === undefined ? undefined : opts.live && opts.sides.some((side) => side.provider === provider)
        ? { auth: { apiKey: "live" } }
        : undefined,
    getProviderAuthStatus: (provider) =>
      opts.store === undefined ? undefined : { configured: opts.store !== "none", source: opts.store },
    getError: () => opts.error,
    // pi's `markProvisionallyConfigured`: a re-registered provider is configured
    // again only when the credential store has it.
    repair: () => {
      if (opts.store !== undefined && opts.store !== "none") configured = true;
    },
    setConfigured: (value: boolean) => {
      configured = value;
    },
  };
}

const healthy = registry({ sides: [DEEPSEEK, DEEPINFRA], configured: true });
/** Nothing reports credentials, the cache cannot answer, and a live re-check agrees. */
const staleCredentials = registry({ sides: [DEEPSEEK, DEEPINFRA], configured: false, snapshot: false });
/** The snapshot lost both providers' credentials, but the keys are really there. */
const recoverable = registry({ sides: [DEEPSEEK, DEEPINFRA], configured: false, snapshot: false, recheck: true });
/** The availability cache says both are usable; pi's credential check says no. */
const staleAvailability = registry({ sides: [DEEPSEEK, DEEPINFRA], configured: false });
/**
 * A catalog that lost both sides while the credential store still answers. A
 * real registry cannot be silent on all four questions at once, so the fixture
 * has to answer `getProviderAuthStatus()` — otherwise it is the dead-context
 * shape, not an empty catalog.
 */
const emptyCatalog = registry({ sides: [], configured: false, store: "none", live: false });
/** A machine that also has the machine-local IsoQuant provider registered. */
const threeSides = registry({ sides: [DEEPSEEK, DEEPINFRA, ISOQUANT], configured: true });

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

/** The failure an invalidated extension runner produces on every context read. */
const STALE = "This extension ctx is stale after session replacement or reload.";

/**
 * A registry whose every read throws, the way a context does once pi has
 * replaced or reloaded the session behind the extension registration.
 */
function staleRegistry(): FakeRegistry {
  const boom = (): never => {
    throw new Error(STALE);
  };
  return {
    find: boom,
    getAvailable: boom,
    hasConfiguredAuth: boom,
    refresh: (async () => boom()) as never,
    getProviderAuth: (async () => boom()) as never,
    getProviderAuthStatus: boom,
    getError: boom,
  };
}

/**
 * The virtual model the extension registers, wrapped in a `route()` that also
 * applies pi's post-route credential check and fires `session_start` once.
 */
async function harness(
  reg: FakeRegistry,
  reason: "user" | "continuation" | "retry" = "user",
  options: {
    previous?: typeof DEEPSEEK;
    failed?: typeof DEEPSEEK;
    state?: { failedOver?: true };
    /** Session entries `getBranch()` returns, for the resume re-arm walk. */
    branch?: unknown[];
  } = {},
) {
  const models: { id?: string; route?: (r: unknown, c: unknown) => Promise<{ model: { provider: string; id: string } }> }[] = [];
  const handlers: Record<string, (() => unknown)[]> = {};
  const registered: string[] = [];
  const pi = {
    registerProvider: (provider: string) => {
      registered.push(provider);
      reg.repair?.(provider);
    },
    registerVirtualModel: (model: unknown) => void models.push(model as never),
    on: (event: string, handler: () => unknown) => void (handlers[event] ??= []).push(handler),
  };
  // SAFETY: the fake only has to satisfy the surface the extension calls.
  register(pi as never);
  const router = models.find((model) => model.id === "deepseek-flash-auto");
  if (!router?.route) throw new Error("router was not registered");
  const ctx = {
    modelRegistry: reg,
    hasUI: false,
    model: undefined,
    ui: { setStatus: () => {} },
    sessionManager: { getBranch: () => options.branch ?? [] },
  };
  // session_start handlers take (event, ctx), so the context is the second arg.
  for (const handler of handlers["session_start"] ?? []) {
    await (handler as (e: unknown, c: unknown) => unknown)(undefined, ctx);
  }
  const route = () =>
    router.route!(
      {
        reason,
        thinkingLevel: "high",
        previous: options.previous ? { model: options.previous } : undefined,
        failed: options.failed
          ? { model: options.failed, message: { errorMessage: "429 overload", stopReason: "error" } }
          : undefined,
        state: options.state,
      },
      ctx,
    );
  /** `route()`, then pi's own check — the request pi would actually make. */
  const routeAsPi = async () => {
    const result = await route();
    if (reg.hasConfiguredAuth && !reg.hasConfiguredAuth(result.model.provider)) {
      throw new Error(`${result.model.provider}/${result.model.id}, which has no credentials.`);
    }
    return result;
  };
  return { route, routeAsPi, registered, handlers, ctx };
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

  test("recovers a stale credential snapshot with a live re-check, instead of ending the turn", async () => {
    // The resume failure: the availability refresh that `session_start` triggers
    // replaces `configuredProviders` from live `checkAuth` results, and the
    // first request can arrive while that set is momentarily empty. pi's own
    // send path does not trust the snapshot (`hasConfiguredAuth() || await
    // checkAuth()`), and `refresh({ providers })` runs that live check, so the
    // router does the same before failing.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const { routeAsPi } = await harness(recoverable);
    expect((await routeAsPi()).model.provider).toBe("deepseek");
    // Scoped to the two sides, not a whole-registry rebuild.
    expect(recoverable.refreshes).toEqual([[DEEPSEEK.provider, DEEPINFRA.provider]]);
  });

  test("throws, rather than returning a model pi would reject", async () => {
    // When the live re-check agrees there is no credential, no return value can
    // recover it: pi re-checks the same snapshot. The only remedy left is a
    // clear, actionable error — naming /reload is the point of it.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const { route } = await harness(staleCredentials);
    await expect(route()).rejects.toThrow(/\/reload/);
  });

  test("cannot rescue an availability cache that says yes when auth says no", async () => {
    // A documented limit, not a fix: the router trusts a non-empty availability
    // snapshot, pi then refuses the model it picked, and only /reload helps.
    // Pinned so nobody "fixes" the router by returning a model anyway — pi
    // rejects that too, with a message that blames a credential. The live
    // re-check does not apply here either: `resolve()` already succeeded, so
    // there is nothing stale to rebuild.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const { routeAsPi } = await harness(staleAvailability);
    await expect(routeAsPi()).rejects.toThrow(/no credentials/);
  });

  test("repairs a cached verdict that a live credential contradicts", async () => {
    // The failure this file exists to stop repeating: both providers' keys are
    // in auth.json, but the registry's cached verdict says neither has one, and
    // the scoped re-check cannot move it. `getProviderAuth()` resolves the
    // credential without the cache, and re-registering the provider puts it back
    // into the cache pi re-checks after `route()` returns — so the turn survives
    // instead of dying on a cache that /reload would have rebuilt.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const poisoned = registry({
      sides: [DEEPSEEK, DEEPINFRA],
      configured: false,
      snapshot: false,
      recheck: false,
      live: true,
      store: "stored",
    });
    const { routeAsPi, registered } = await harness(poisoned);
    // The registration the extension makes at load time marks both sides
    // configured; a later full availability pass is what drops them, so poison
    // it after that, exactly as the cache did.
    poisoned.setConfigured(false);
    registered.length = 0;
    expect((await routeAsPi()).model.provider).toBe("deepseek");
    expect(registered).toEqual(["deepseek"]);
  });

  test("names the credential store and the live check when nothing can be repaired", async () => {
    // When the live resolution agrees there is no key, re-registering would only
    // hide the problem. The error has to carry enough to fix it without
    // reproducing it: which fact disagreed, per side.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const gone = registry({
      sides: [DEEPSEEK, DEEPINFRA],
      configured: false,
      snapshot: false,
      recheck: false,
      live: false,
      store: "none",
      error: 'Availability refresh: timed out',
    });
    const { route } = await harness(gone);
    const error = await route().then(
      () => undefined,
      (reason: Error) => reason.message,
    );
    expect(error).toContain("not in the credential store");
    expect(error).toContain("live check found none");
    expect(error).toContain("Availability refresh: timed out");
    expect(error).toContain("/reload");
  });

  test("throws when the catalog itself has lost both sides", async () => {
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const { route } = await harness(emptyCatalog);
    await expect(route()).rejects.toThrow(/missing from the catalog/);
  });

  test("keeps the turn alive when pi invalidates the extension context", async () => {
    // The recurring failure: `/reload`, `/new`, `/fork`, `/resume`, or another
    // session's runner in this process invalidates the runner behind the
    // registration, and every field of the route context is a getter that
    // throws from then on. The router used to read that as "neither side has a
    // credential" and end the turn, over keys that were never the problem.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const reg = registry({ sides: [DEEPSEEK, DEEPINFRA], configured: true });
    const { route, ctx } = await harness(reg);
    // session_start saw a live catalog, so both sides are known; now it dies.
    ctx.modelRegistry = staleRegistry();
    const result = await route();
    expect(SIDES).toContain(result.model.provider);
  });

  test("keeps the model that just answered when the context dies with nothing cached", async () => {
    // A context that is already dead at `session_start` cannot seed the cache,
    // so the only thing left is the model pi hands over for a continuation.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const { route } = await harness(staleRegistry() as FakeRegistry, "continuation", {
      previous: DEEPINFRA,
    });
    expect((await route()).model.provider).toBe("deepinfra");
  });

  test("says the context is stale rather than blaming a credential", async () => {
    // The old message sent the reader to auth.json, which is why this took
    // several sessions to diagnose. A dead context and a missing key are
    // different failures and must not read the same.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const { route } = await harness(staleRegistry() as FakeRegistry, "user");
    const error = await route().then(
      () => undefined,
      (reason: Error) => reason.message,
    );
    expect(error).toContain("extension context is stale");
    expect(error).toContain("no credential is at fault");
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

/** Report an assistant turn of `promptTokens` so the router has a size to price. */
function reportPrompt(
  handlers: Record<string, (() => unknown)[]>,
  promptTokens: number,
  provider = "deepinfra",
): void {
  const fire = handlers["message_end"]?.[0] as ((event: unknown) => unknown) | undefined;
  if (!fire) throw new Error("the extension does not listen for message_end");
  fire({
    message: {
      role: "assistant",
      provider,
      usage: { input: promptTokens * 0.01, cacheRead: promptTokens * 0.99, output: 500 },
    },
  });
}

describe("router prices the context size the last turn reported", () => {
  test("takes the 51% promo at 200K, where DeepInfra still wins off-peak", async () => {
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    stubPricing(async () => pricingResponse(0.098, 0.294, 0.00294, 0));
    const { routeAsPi, handlers } = await harness(healthy);
    reportPrompt(handlers, 200_000);
    expect((await routeAsPi()).model.provider).toBe("deepinfra");
  });

  test("falls back to DeepSeek past 524K, where the two cards reach parity", async () => {
    // The regression the size-aware bands exist to catch: the same live promo
    // that wins at 200K stops winning off-peak at 600K, because DeepInfra's
    // cache cannot hold a context that large. A single scalar never flipped.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    stubPricing(async () => pricingResponse(0.098, 0.294, 0.00294, 0));
    const { routeAsPi, handlers } = await harness(healthy);
    reportPrompt(handlers, 600_000);
    expect((await routeAsPi()).model.provider).toBe("deepseek");
  });

  test("still takes DeepInfra at peak on the same huge context", async () => {
    // Peak is a separate question and the answer does not follow the off-peak one.
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.098, 0.294, 0.00294, 0));
    const { routeAsPi, handlers } = await harness(healthy);
    reportPrompt(handlers, 600_000);
    expect((await routeAsPi()).model.provider).toBe("deepinfra");
  });
});

// A third side changes the answer only where a third card can win, so these pin
// the cases the two-side table cannot express: peak without a promo (IsoQuant),
// off-peak on a fresh short prompt (IsoQuant's input rate), the huge-context
// fallback (DeepSeek), and a failover that has to pick the NEXT-cheapest side
// rather than a fixed "other" one.
describe("router with IsoQuant registered", () => {
  test("routes to one of the three sides when the registry is healthy", async () => {
    for (const tier of ["peak", "off-peak"] as const) {
      process.env.PI_DEEPSEEK_TIER = tier;
      expect(ALL_SIDES).toContain((await (await harness(threeSides)).routeAsPi()).model.provider);
    }
  });

  test("re-checks every side in play, instead of only the winner", async () => {
    // A stale credential snapshot has to be rebuilt for all of them: the side
    // that answers the retry is chosen after the refresh, not before it.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    const reg = registry({
      sides: [DEEPSEEK, DEEPINFRA, ISOQUANT],
      configured: false,
      snapshot: false,
      recheck: true,
    });
    const { routeAsPi } = await harness(reg);
    expect((await routeAsPi()).model.provider).toBe("isoquant");
    expect(reg.refreshes).toHaveLength(1);
    expect([...reg.refreshes[0]].sort()).toEqual([...ALL_SIDES].sort());
  });

  test("takes IsoQuant at peak once DeepInfra is back at list price", async () => {
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    expect((await (await harness(threeSides)).routeAsPi()).model.provider).toBe("isoquant");
  });

  test("still takes DeepInfra at peak while its promo is deep", async () => {
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0.51));
    expect((await (await harness(threeSides)).routeAsPi()).model.provider).toBe("deepinfra");
  });

  test("takes IsoQuant off-peak on a fresh, short prompt", async () => {
    // Its input rate is a fifth of DeepSeek's, and on a session's first request
    // there is no cache to reward DeepSeek's cheaper cache read yet.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    expect((await (await harness(threeSides)).routeAsPi()).model.provider).toBe("isoquant");
  });

  test("drops IsoQuant past 524K off-peak, where DeepSeek's cache wins", async () => {
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const { routeAsPi, handlers } = await harness(threeSides);
    reportPrompt(handlers, 600_000, "isoquant");
    expect((await routeAsPi()).model.provider).toBe("deepseek");
  });

  test("counts the prompt size an IsoQuant turn reported", async () => {
    // The size tracking is per-conversation, not per-provider; an IsoQuant turn
    // must move the band exactly as a DeepInfra one does.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const shortPrompt = await harness(threeSides);
    expect((await shortPrompt.routeAsPi()).model.provider).toBe("isoquant");
    reportPrompt(shortPrompt.handlers, 600_000, "isoquant");
    expect((await shortPrompt.routeAsPi()).model.provider).toBe("deepseek");
  });

  test("crosses a failed side to the next-cheapest, not to a fixed other side", async () => {
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    // Peak with DeepInfra at list: IsoQuant is first, DeepInfra second, DeepSeek
    // last. Failing DeepInfra must therefore land on IsoQuant.
    const { route } = await harness(threeSides, "retry", { failed: DEEPINFRA });
    expect((await route()).model.provider).toBe("isoquant");
  });

  test("crosses away from IsoQuant when it is the one that failed", async () => {
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const { route } = await harness(threeSides, "retry", { failed: ISOQUANT });
    expect((await route()).model.provider).toBe("deepinfra");
  });

  test("does not cross twice when the retry has already failed over", async () => {
    // The ping-pong guard, now with three sides to bounce between.
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const { route } = await harness(threeSides, "retry", { failed: ISOQUANT, state: { failedOver: true } });
    expect((await route()).model.provider).toBe("isoquant");
  });

  test("keeps a continuation on the side that started the turn", async () => {
    // Staying put is what keeps the prompt cache warm; a cheaper side mid-turn
    // is not worth the miss.
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const { route } = await harness(threeSides, "continuation", { previous: DEEPSEEK });
    expect((await route()).model.provider).toBe("deepseek");
  });
});

/** An assistant message as `message_end` reports it. */
function answer(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    provider: DEEPINFRA.provider,
    model: DEEPINFRA.id,
    stopReason: "toolUse",
    durationMs: 3_000,
    usage: { input: 400, cacheRead: 280_000, output: 1_000 },
    ...overrides,
  };
}

/** Fire `message_end`, the hook the router watches for degenerate answers. */
async function report(handlers: Record<string, (() => unknown)[]>, message: unknown) {
  for (const handler of handlers["message_end"] ?? []) {
    await (handler as (event: unknown) => unknown)({ message });
  }
}

/**
 * A turn that failed without failing.
 *
 * DeepInfra returned HTTP 200 and a complete stream five times on 2026-11-16,
 * across two worktrees in nine hours, so pi raised no error and never retried —
 * `looksLikeProviderFailure` and the retry crossing both stayed silent while the
 * router kept choosing the side that was producing nothing. These shapes are
 * straight from those transcripts.
 */
describe("a provider that answers with nothing", () => {
  /** 384K output tokens over 1,465s, arriving as a tool call cut mid-argument. */
  const runaway = answer({
    stopReason: "length",
    durationMs: 1_465_401,
    usage: { input: 453, cacheRead: 279_680, output: 384_000 },
  });

  test("passes over the side whose answer degenerated, breaking mid-turn stickiness", async () => {
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const { route, handlers } = await harness(threeSides, "continuation", { previous: DEEPINFRA });
    // Sticky is the point of the continuation path: the turn stays on DeepInfra
    // to keep the prompt cache warm. A degenerate answer has to override that,
    // or every follow-up in the turn repeats the failure.
    expect((await route()).model.provider).toBe("deepinfra");
    await report(handlers, runaway);
    expect((await route()).model.provider).not.toBe("deepinfra");
  });

  test("keeps the turn alive when that side holds the only credential", async () => {
    // Demoted, not dropped. A one-provider machine still has to answer, and
    // ending the turn is the failure this avoidance exists to prevent.
    const only = registry({ sides: [DEEPINFRA], configured: true });
    const { route, handlers } = await harness(only, "continuation", { previous: DEEPINFRA });
    await report(handlers, runaway);
    expect((await route()).model.provider).toBe("deepinfra");
  });

  test("leaves a side alone when its answer was merely long", async () => {
    // 56,499 tokens is the largest legitimate generation in this machine's
    // history. A `length` stop there is a real truncation, not a runaway.
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const { route, handlers } = await harness(threeSides, "continuation", { previous: DEEPINFRA });
    await report(handlers, answer({ stopReason: "length", durationMs: 130_000, usage: { output: 56_499 } }));
    expect((await route()).model.provider).toBe("deepinfra");
  });

  test("leaves a side alone when the user aborted a healthy stream", async () => {
    // Escape in the first seconds is the common case, and it must not condemn
    // the provider for the next half hour.
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const { route, handlers } = await harness(threeSides, "continuation", { previous: DEEPINFRA });
    await report(handlers, answer({ stopReason: "aborted", durationMs: 1_800, usage: { output: 0 } }));
    expect((await route()).model.provider).toBe("deepinfra");
  });

  test("passes over a side that stalled, then produced nothing, for minutes", async () => {
    // The session-killing shape: 22 minutes of stream, one 533-character thinking
    // block, aborted by hand. 0.4 chars/s.
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const { route, handlers } = await harness(threeSides, "continuation", { previous: DEEPINFRA });
    await report(
      handlers,
      answer({
        stopReason: "aborted",
        durationMs: 1_333_766,
        usage: { output: 0 },
        content: [{ type: "thinking", thinking: "x".repeat(533) }],
      }),
    );
    expect((await route()).model.provider).not.toBe("deepinfra");
  });

  test("leaves a side alone when a long turn was aborted after real work", async () => {
    // Every aborted message reports output 0 however much it produced, because the
    // usage figures arrive in the stream's last chunk. `usage` cannot separate a
    // stall from a slow stream; what came out can. This is the slowest healthy
    // abort on record (3,000 characters over 6.7 minutes, ~7 chars/s), and it must
    // not condemn the provider for the next half hour.
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const { route, handlers } = await harness(threeSides, "continuation", { previous: DEEPINFRA });
    await report(
      handlers,
      answer({
        stopReason: "aborted",
        durationMs: 400_000,
        usage: { output: 0 },
        content: [{ type: "thinking", thinking: "x".repeat(3_000) }],
      }),
    );
    expect((await route()).model.provider).toBe("deepinfra");
  });

  test("relearns a recent degeneration from the branch it resumes", async () => {
    // Kill and resume is the recovery an operator actually performs, and the new
    // session has observed nothing. Without reading the branch back it would
    // prefer the side that just broke the session it replaced.
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const endedRecently = answer({
      stopReason: "aborted",
      durationMs: 1_333_766,
      usage: { output: 0 },
      // Started ~23 minutes ago, so the stream ended about a minute ago.
      timestamp: Date.now() - 1_400_000,
    });
    const { route } = await harness(threeSides, "continuation", {
      previous: DEEPINFRA,
      branch: [{ type: "message", message: endedRecently }],
    });
    expect((await route()).model.provider).not.toBe("deepinfra");
  });

  test("does not relearn a degeneration older than the cooldown", async () => {
    process.env.PI_DEEPSEEK_TIER = "peak";
    stubPricing(async () => pricingResponse(0.2, 0.6, 0.006, 0));
    const endedHoursAgo = answer({
      stopReason: "aborted",
      durationMs: 1_333_766,
      usage: { output: 0 },
      timestamp: Date.now() - 3 * 60 * 60_000,
    });
    const { route } = await harness(threeSides, "continuation", {
      previous: DEEPINFRA,
      branch: [{ type: "message", message: endedHoursAgo }],
    });
    expect((await route()).model.provider).toBe("deepinfra");
  });
});
