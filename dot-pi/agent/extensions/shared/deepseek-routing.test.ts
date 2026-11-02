// Run with `bun test dot-pi/agent/extensions/shared/`.
//
// These pin the router's *recovery* behaviour, not which side wins — that is
// `deepseek-schedule.test.ts`'s job, and it depends on the live DeepInfra
// discount rather than on anything here.
//
// What matters: a stale availability or credential snapshot must never end the
// turn. `route()` throwing makes pi end the request with an error it does not
// retry, so a registry that has not caught up keeps killing every request until
// the process restarts — which is what happened on 2026-11-01, a 3.6 h stall.
//
// The extension is exercised through its real entry point: a fake ExtensionAPI
// captures the virtual model it registers, and `route()` is called with a fake
// modelRegistry standing in for pi's cache.

import { describe, expect, test } from "bun:test";
import register from "../deepseek-routing.ts";

const DEEPSEEK = { provider: "deepseek", id: "deepseek-flash" };
const DEEPINFRA = { provider: "deepinfra", id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" };
const SIDES = ["deepseek", "deepinfra"];

interface FakeRegistry {
  find(provider: string, id: string): unknown;
  getAvailable?(): unknown[];
  hasConfiguredAuth?(model: unknown): boolean;
}

/** A registry whose catalog is intact but whose credential cache says no. */
const staleCredentials: FakeRegistry = {
  find: (provider, id) => {
    if (provider === DEEPSEEK.provider && id === DEEPSEEK.id) return DEEPSEEK;
    if (provider === DEEPINFRA.provider && id === DEEPINFRA.id) return DEEPINFRA;
    return undefined;
  },
  getAvailable: () => [],
  hasConfiguredAuth: () => false,
};

/** A registry that has forgotten both entries entirely. */
const emptyCatalog: FakeRegistry = {
  find: () => undefined,
  getAvailable: () => [],
  hasConfiguredAuth: () => false,
};

/** A healthy registry that knows both sides have credentials. */
const healthy: FakeRegistry = {
  find: (provider, id) => {
    if (provider === DEEPSEEK.provider && id === DEEPSEEK.id) return DEEPSEEK;
    if (provider === DEEPINFRA.provider && id === DEEPINFRA.id) return DEEPINFRA;
    return undefined;
  },
  getAvailable: () => [DEEPSEEK, DEEPINFRA],
  hasConfiguredAuth: () => true,
};

/** Only one side left in the catalog. */
function only(side: typeof DEEPSEEK): FakeRegistry {
  return {
    find: (provider, id) => (provider === side.provider && id === side.id ? side : undefined),
    getAvailable: () => [side],
    hasConfiguredAuth: () => true,
  };
}

/** The virtual model the extension registers, wrapped in a zero-arg `route()`. */
function harness(registry: FakeRegistry) {
  const models: { id?: string; route?: (r: unknown, c: unknown) => { model: { provider: string; id: string } } }[] = [];
  const pi = {
    registerProvider: () => {},
    registerVirtualModel: (model: unknown) => void models.push(model as never),
    on: () => {},
  };
  // SAFETY: the fake only has to satisfy the surface the extension calls.
  register(pi as never);
  const router = models.find((model) => model.id === "deepseek-flash-auto");
  if (!router?.route) throw new Error("router was not registered");
  const ctx = { modelRegistry: registry, hasUI: false, ui: { setStatus: () => {} } };
  return () => router.route!({ reason: "user", thinkingLevel: "high" }, ctx);
}

describe("router recovery", () => {
  test("routes to one of the two sides when the registry is healthy", () => {
    for (const tier of ["peak", "off-peak"] as const) {
      process.env.PI_DEEPSEEK_TIER = tier;
      expect(SIDES).toContain(harness(healthy)().model.provider);
    }
  });

  test("does not end the turn when the credential snapshot is stale", () => {
    // The regression: every side reported no credentials, so the old code threw
    // and pi ended the request without retrying.
    for (const tier of ["peak", "off-peak"] as const) {
      process.env.PI_DEEPSEEK_TIER = tier;
      const route = harness(staleCredentials);
      expect(() => route()).not.toThrow();
      expect(SIDES).toContain(route().model.provider);
    }
  });

  test("throws only when the catalog itself has lost both sides", () => {
    // Nothing to name: this is the one case where an error is the only answer,
    // and the message says so rather than blaming a credential.
    process.env.PI_DEEPSEEK_TIER = "off-peak";
    expect(() => harness(emptyCatalog)()).toThrow(/model catalog/);
  });

  test("falls to the other side when only it is in the catalog", () => {
    // Whichever tier is asked for, a missing side must not become a throw.
    for (const tier of ["peak", "off-peak"] as const) {
      process.env.PI_DEEPSEEK_TIER = tier;
      expect(harness(only(DEEPSEEK))().model.provider).toBe("deepseek");
      expect(harness(only(DEEPINFRA))().model.provider).toBe("deepinfra");
    }
  });
});
