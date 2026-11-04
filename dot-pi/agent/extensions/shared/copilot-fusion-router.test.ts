import { describe, expect, test } from "bun:test";
import { createFusionRouter, fusionContextWindow, fusionRequestHeaders, UNKNOWN_FUSION_CONTEXT, type FusionModel } from "./copilot-fusion-router";

const now = 1_800_000_000_000;
const model: FusionModel = { provider: "github-copilot", id: "model-a", input: ["text", "image"] };
const second: FusionModel = { provider: "github-copilot", id: "model-b", input: ["text", "image"] };
const user = (text: string, timestamp = 1) => [{ role: "user", timestamp, content: text }];

function setup() {
  const requests: { url: string; init: RequestInit }[] = [];
  let auth = { apiKey: "access-1", baseUrl: "https://api.business.githubcopilot.com" };
  let allowed = true;
  let response: unknown = { selected_model: { id: model.id }, session_token: "session-secret", expires_at: now / 1000 + 3600 };
  let status = 200;
  const router = createFusionRouter({
    getAuth: async () => auth,
    findModel: (id) => [model, second].find((item) => item.id === id),
    isAllowed: () => allowed,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    now: () => now,
  });
  return { router, requests, setAuth: (value: typeof auth) => { auth = value; },
    setAllowed: (value: boolean) => { allowed = value; }, setResponse: (value: unknown) => { response = value; },
    setStatus: (value: number) => { status = value; } };
}

describe("Fusion context sizing", () => {
  const large = { provider: "github-copilot", contextWindow: 1_000_000 };
  const smaller = { provider: "github-copilot", contextWindow: 500_000 };
  const other = { provider: "other", contextWindow: 8_000 };

  test("uses the smallest enabled Copilot model, not an unrelated provider", () => {
    expect(fusionContextWindow([{ model: large }, { model: smaller }, { model: other }], [])).toBe(500_000);
  });

  test("respects a scoped subset and otherwise uses available Copilot models", () => {
    expect(fusionContextWindow([{ model: large }], [large, smaller])).toBe(1_000_000);
    expect(fusionContextWindow([], [large, smaller, other])).toBe(500_000);
  });

  test("uses a safe fallback when scope or metadata is unknown", () => {
    expect(fusionContextWindow([{ model: other }], [large])).toBe(UNKNOWN_FUSION_CONTEXT);
    expect(fusionContextWindow([], [])).toBe(UNKNOWN_FUSION_CONTEXT);
    expect(fusionContextWindow([{ model: large }, { model: { provider: "github-copilot" } }], [])).toBe(UNKNOWN_FUSION_CONTEXT);
    expect(fusionContextWindow([{ model: { provider: "github-copilot", contextWindow: NaN } }], [])).toBe(UNKNOWN_FUSION_CONTEXT);
  });
});

describe("Copilot Fusion Standard router", () => {
  test("sends the verified Fusion request and keeps the response token out of the request body", async () => {
    const h = setup();
    const decision = await h.router.route(user("fix the test"), "session-1");
    expect(decision.model).toEqual(model);
    expect(decision.sessionToken).toBe("session-secret");
    expect(h.requests[0].url).toBe("https://api.business.githubcopilot.com/auto");
    const init = h.requests[0].init;
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ Authorization: "Bearer access-1", "X-GitHub-Api-Version": "2026-08-01" });
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: "fix the test", has_image: false, tier: "balance", fusion: true,
      multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 }, hydra_rl_multi_turn: {},
    });
    expect(String(init.body)).not.toContain("session-secret");
  });

  test("keeps tool follow-ups on the same token but reroutes a new user turn", async () => {
    const h = setup();
    await h.router.route(user("one", 1), "session-1");
    await h.router.route([...user("one", 1), { role: "toolResult", content: "ok" }], "session-1");
    expect(h.requests).toHaveLength(1);
    await h.router.route(user("two", 2), "session-1");
    expect(h.requests).toHaveLength(2);
  });

  test("isolates sessions and never caches calls with no session ID", async () => {
    const h = setup();
    const a = await h.router.route(user("one"), "a");
    h.setResponse({ selected_model: { id: second.id }, session_token: "other-token", expires_at: now / 1000 + 3600 });
    const b = await h.router.route(user("one"), "b");
    expect(a.sessionToken).toBe("session-secret");
    expect(b.sessionToken).toBe("other-token");
    expect((await h.router.route(user("one"), "a")).sessionToken).toBe("session-secret");
    await h.router.route(user("one"));
    await h.router.route(user("one"));
    expect(h.requests).toHaveLength(4);
  });

  test("invalidates a cached decision on credential changes and shutdown", async () => {
    const h = setup();
    await h.router.route(user("one"), "a");
    h.setAuth({ apiKey: "access-2", baseUrl: "https://api.business.githubcopilot.com" });
    await h.router.route(user("one"), "a");
    h.router.clear();
    await h.router.route(user("one"), "a");
    expect(h.requests).toHaveLength(3);
  });

  test("separates tokens and replaces auth and API-version headers per call", () => {
    const outer = { Authorization: "dummy", "copilot-session-token": "old", "x-github-api-version": "old", "X-Trace": "keep" };
    const first = fusionRequestHeaders(outer, "first");
    const second = fusionRequestHeaders(outer, "second");
    expect(first).toEqual({ "X-Trace": "keep", "X-GitHub-Api-Version": "2026-08-01", "Copilot-Session-Token": "first" });
    expect(second["Copilot-Session-Token"]).toBe("second");
    expect(outer["copilot-session-token"]).toBe("old");
  });

  test("invalidates only the matching session token", async () => {
    const h = setup();
    await h.router.route(user("one"), "a");
    h.router.invalidate("a", "another-token");
    await h.router.route(user("one"), "a");
    expect(h.requests).toHaveLength(1);
    h.router.invalidate("a", "session-secret");
    await h.router.route(user("one"), "a");
    expect(h.requests).toHaveLength(2);
  });

  test("does not reuse a session token after the Copilot endpoint changes", async () => {
    const h = setup();
    await h.router.route(user("one"), "a");
    h.setAuth({ apiKey: "access-1", baseUrl: "https://api.individual.githubcopilot.com" });
    await h.router.route(user("one"), "a");
    expect(h.requests).toHaveLength(2);
  });

  test("fails closed on router errors, unavailable models, and out-of-scope models", async () => {
    const h = setup();
    h.setStatus(404);
    await expect(h.router.route(user("one"))).rejects.toThrow("HTTP 404");
    h.setStatus(200);
    h.setResponse({ selected_model: { id: "missing" }, session_token: "secret", expires_at: now / 1000 + 3600 });
    await expect(h.router.route(user("one"))).rejects.toThrow("missing from Pi's catalog");
    h.setResponse({ selected_model: { id: model.id }, session_token: "secret", expires_at: now / 1000 + 3600 });
    h.setAllowed(false);
    await expect(h.router.route(user("one"))).rejects.toThrow("outside the enabled model scope");
  });

  test("reroutes when a cached token approaches expiry", async () => {
    let clock = now;
    let count = 0;
    const router = createFusionRouter({
      getAuth: async () => ({ apiKey: "x", baseUrl: "https://api.githubcopilot.com" }),
      findModel: () => model, isAllowed: () => true,
      fetch: (async () => { count++; return new Response(JSON.stringify({ selected_model: { id: model.id }, session_token: `token-${count}`, expires_at: clock / 1000 + 1000 })); }) as typeof fetch,
      now: () => clock,
    });
    await router.route(user("one"), "session");
    clock += 701_000;
    expect((await router.route(user("one"), "session")).sessionToken).toBe("token-2");
    expect(count).toBe(2);
  });

  test("rejects malformed or nearly expired tokens", async () => {
    const h = setup();
    for (const data of [
      { selected_model: { id: model.id }, session_token: "", expires_at: now / 1000 + 3600 },
      { selected_model: { id: model.id }, session_token: "secret", expires_at: now / 1000 + 299 },
      { session_token: "secret", expires_at: now / 1000 + 3600 },
    ]) {
      h.setResponse(data);
      await expect(h.router.route(user("one"))).rejects.toThrow("invalid routing decision");
    }
  });

  test("rejects untrusted endpoints before sending credentials or prompts", async () => {
    const h = setup();
    h.setAuth({ apiKey: "secret", baseUrl: "https://githubcopilot.com.evil.example" });
    await expect(h.router.route(user("private"))).rejects.toThrow("direct GitHub Copilot HTTPS endpoint");
    expect(h.requests).toHaveLength(0);
  });

  test("flags images and rejects a selected text-only model", async () => {
    const h = setup();
    const images = [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image" }] }];
    await h.router.route(images);
    expect(JSON.parse(String(h.requests[0].init.body)).has_image).toBe(true);
    const textOnly = createFusionRouter({
      getAuth: async () => ({ apiKey: "x", baseUrl: "https://api.githubcopilot.com" }),
      findModel: () => ({ ...model, input: ["text"] }), isAllowed: () => true,
      fetch: (async () => new Response(JSON.stringify({ selected_model: { id: model.id }, session_token: "s", expires_at: now / 1000 + 3600 }))) as typeof fetch,
      now: () => now,
    });
    await expect(textOnly.route(images)).rejects.toThrow("does not support image input");
  });

  test("aborts an in-flight router request", async () => {
    const controller = new AbortController();
    const router = createFusionRouter({
      getAuth: async () => ({ apiKey: "x", baseUrl: "https://api.githubcopilot.com" }),
      findModel: () => model, isAllowed: () => true,
      fetch: ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as typeof fetch,
      now: () => now,
    });
    const pending = router.route(user("one"), "session", controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  test("honors cancellation before any routing request", async () => {
    const h = setup();
    const controller = new AbortController(); controller.abort();
    await expect(h.router.route(user("one"), "a", controller.signal)).rejects.toBeDefined();
    expect(h.requests).toHaveLength(0);
  });
});
