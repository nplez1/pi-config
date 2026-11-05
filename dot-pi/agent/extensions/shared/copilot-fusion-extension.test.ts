import { afterEach, describe, expect, mock, test } from "bun:test";

// Model the small event-stream surface used by the wrapper. Real transport is
// exercised separately by the Pi-Bolt integration test, not by a paid test.
class FakeStream {
  events: unknown[] = [];
  private done: Promise<unknown>;
  private finish!: (value: unknown) => void;
  constructor() { this.done = new Promise((resolve) => { this.finish = resolve; }); }
  push(event: unknown) { this.events.push(event); }
  end(value: unknown) { this.finish(value); }
  result() { return this.done; }
}
mock.module("@earendil-works/pi-ai/compat", () => ({ createAssistantMessageEventStream: () => new FakeStream() }));
mock.module("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/nonexistent-fusion-test" }));
const { default: register } = await import("../copilot-fusion.ts");
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const physical = { id: "model-a", name: "Model A", provider: "github-copilot", api: "openai-responses", input: ["text"], baseUrl: "https://api.business.githubcopilot.com", contextWindow: 500_000, maxTokens: 64_000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
const virtual = { id: "standard", provider: "copilot-fusion", api: "pi-virtual", contextWindow: 500_000 };
const message = (text: string) => ({ messages: [{ role: "user", timestamp: 1, content: text }] });

type TestProvider = { streamSimple: (m: unknown, c: unknown, o?: unknown) => FakeStream; getModels: () => { id: string; contextWindow: number }[];
  filterModels: (models: unknown[]) => unknown[]; auth: { apiKey: { check: (input: unknown) => Promise<unknown> } } };
type TestVirtual = { contextWindow: number; route: (request: unknown, ctx: unknown) => Promise<{ model: { id: string; contextWindow: number; maxTokens: number }; thinkingLevel: string }> };

function harness(allowed = true, physicalBaseUrl = physical.baseUrl, scopeWindow = physical.contextWindow) {
  let provider: TestProvider | undefined;
  let virtualModel: TestVirtual | undefined;
  const registrations: number[] = [];
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const calls: { model: unknown; context: unknown; options: Record<string, unknown> }[] = [];
  const registry = {
    getProviderAuth: async () => ({ auth: { apiKey: "real-key", baseUrl: "https://api.business.githubcopilot.com" } }),
    getProvider: () => ({ baseUrl: "https://api.business.githubcopilot.com" }),
    getProviderAuthStatus: () => ({ configured: true }),
    find: (_provider: string, id: string) => id === physical.id ? physical : undefined,
    hasConfiguredAuth: () => true,
    getAvailable: () => [physical],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "real-key", baseUrl: physicalBaseUrl }),
    streamSimple: (model: unknown, context: unknown, options: Record<string, unknown>) => {
      calls.push({ model, context, options });
      const answer = { role: "assistant", provider: "github-copilot", model: physical.id, stopReason: "stop", content: [] };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", message: answer }; }, result: async () => answer };
    },
  };
  register({ registerProvider: (value: TestProvider) => { provider = value; },
    registerVirtualModel: (value: TestVirtual) => { virtualModel = value; registrations.push(value.contextWindow); },
    on: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; } } as never);
  if (!provider || !virtualModel) throw new Error("Fusion provider or virtual model not registered");
  const ctx = { modelRegistry: registry, sessionManager: { getSessionId: () => "one" },
    scopedModels: allowed ? [{ model: { ...physical, contextWindow: scopeWindow } }] : [{ model: virtual }], model: virtual };
  handlers.session_start(undefined, ctx);
  return { provider, getVirtual: () => virtualModel!, handlers, registry, calls, registrations, ctx };
}

function stubRouter(limits?: Record<string, number>) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const token = body.prompt.includes("first") ? "token-first" : "token-second";
    return new Response(JSON.stringify({ selected_model: { id: physical.id, ...(limits ? { capabilities: { limits } } : {}) }, session_token: token,
      expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  }) as typeof fetch;
}

async function route(h: ReturnType<typeof harness>, text: string, reason = "user", sessionId = "one") {
  const ctx = { ...h.ctx, sessionManager: { getSessionId: () => sessionId } };
  return h.getVirtual().route({ ...message(text), reason, thinkingLevel: "off" }, ctx);
}

describe("Copilot Fusion Pi provider", () => {
  test("registers the virtual model under the short Fusion/Standard name", () => {
    const h = harness();
    expect((h.getVirtual() as unknown as { name?: string }).name).toBe("Fusion/Standard");
  });

  test("availability follows Copilot configuration rather than the wrapper marker", async () => {
    const h = harness();
    const missing = { ctx: { env: async () => undefined } };
    const configured = { ctx: { env: async (name: string) => name === "COPILOT_GITHUB_TOKEN" ? "fake" : undefined } };
    expect(await h.provider.auth.apiKey.check(missing)).toBeUndefined();
    expect(await h.provider.auth.apiKey.check(configured)).toMatchObject({ type: "api_key" });
  });

  test("updates the selection hint from scope and routes with the actual model window", async () => {
    stubRouter(); const h = harness(true, physical.baseUrl, 1_000_000);
    expect(h.registrations).toEqual([32_768, 1_000_000]);
    const selected = await route(h, "first");
    expect(selected.model.contextWindow).toBe(500_000);
    expect(h.provider.getModels().map((model) => model.id)).toContain(selected.model.id);
    expect(h.provider.filterModels(h.provider.getModels())).toEqual([]);
  });

  test("uses the selected model's provider-reported prompt and output ceilings", async () => {
    stubRouter({ max_context_window_tokens: 500_000, max_prompt_tokens: 372_000, max_output_tokens: 32_000 });
    const h = harness();
    const selected = await route(h, "first");
    expect(selected.model.contextWindow).toBe(372_000);
    expect(selected.model.maxTokens).toBe(32_000);
  });

  test("forwards physical events with scoped token, never the outer dummy key", async () => {
    stubRouter(); const h = harness(); const signal = new AbortController().signal;
    const selected = await route(h, "first");
    const stream = h.provider.streamSimple(selected.model, message("first"), {
      apiKey: "fusion-local", signal, sessionId: "one",
      headers: { Authorization: "dummy", "copilot-session-token": "stale", "X-Trace": "ok" },
    });
    const result = await stream.result() as { provider: string; model: string };
    expect(result.provider).toBe("github-copilot");
    expect(result.model).toBe(physical.id);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].model).toEqual(physical);
    expect(h.calls[0].options.apiKey).toBeUndefined();
    expect(h.calls[0].options.signal).toBe(signal);
    expect(h.calls[0].options.headers).toEqual({ "X-Trace": "ok", "X-GitHub-Api-Version": "2026-08-01", "Copilot-Session-Token": "token-first" });
  });

  test("isolates concurrent session tokens and hides private dispatches", async () => {
    stubRouter(); const h = harness();
    const [a, b] = await Promise.all([route(h, "first", "user", "one"), route(h, "second", "user", "two")]);
    expect(a.model.id).not.toBe(b.model.id);
    const first = h.provider.streamSimple(a.model, message("first"), { sessionId: "one" });
    const second = h.provider.streamSimple(b.model, message("second"), { sessionId: "two" });
    await Promise.all([first.result(), second.result()]);
    expect(h.calls.map((call) => (call.options.headers as Record<string, string>)["Copilot-Session-Token"]).sort()).toEqual(["token-first", "token-second"]);
    expect(h.provider.filterModels(h.provider.getModels())).toEqual([]);
    h.handlers.session_shutdown(undefined, h.ctx);
    expect(h.provider.getModels()).toHaveLength(1);
    h.handlers.session_shutdown(undefined, { ...h.ctx, sessionManager: { getSessionId: () => "two" } });
    expect(h.provider.getModels()).toEqual([]);
  });

  test("concurrent sessions retain their own registries and credentials", async () => {
    stubRouter(); const h = harness();
    const otherCalls: Record<string, unknown>[] = [];
    const otherRegistry = {
      ...h.registry,
      getProviderAuth: async () => ({ auth: { apiKey: "other-key", baseUrl: "https://api.individual.githubcopilot.com" } }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "other-key", baseUrl: "https://api.individual.githubcopilot.com" }),
      streamSimple: (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
        otherCalls.push(options);
        const answer = { role: "assistant", provider: "github-copilot", model: physical.id, stopReason: "stop", content: [] };
        return { async *[Symbol.asyncIterator]() { yield { type: "done", message: answer }; }, result: async () => answer };
      },
    };
    const otherCtx = { ...h.ctx, modelRegistry: otherRegistry, sessionManager: { getSessionId: () => "two" } };
    const [first, second] = await Promise.all([
      h.getVirtual().route({ ...message("first"), reason: "user", thinkingLevel: "off" }, h.ctx),
      h.getVirtual().route({ ...message("second"), reason: "user", thinkingLevel: "off" }, otherCtx),
    ]);
    await Promise.all([
      h.provider.streamSimple(first.model, message("first"), { sessionId: "one" }).result(),
      h.provider.streamSimple(second.model, message("second"), { sessionId: "two" }).result(),
    ]);
    expect(h.calls).toHaveLength(1);
    expect(otherCalls).toHaveLength(1);
    expect((h.calls[0].options.headers as Record<string, string>)["Copilot-Session-Token"]).toBe("token-first");
    expect((otherCalls[0].headers as Record<string, string>)["Copilot-Session-Token"]).toBe("token-second");
  });

  test("clears private dispatches after many turns without exposing tokens", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ selected_model: { id: physical.id }, session_token: `secret-${body.prompt}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    }) as typeof fetch;
    const h = harness();
    for (let index = 0; index < 1000; index++) await route(h, `prompt-${index}`, "user", "one");
    expect(h.provider.getModels()).toHaveLength(1000);
    expect(h.provider.filterModels(h.provider.getModels())).toEqual([]);
    expect(JSON.stringify(h.provider.getModels())).not.toContain("secret-");
    h.handlers.session_shutdown(undefined, h.ctx);
    expect(h.provider.getModels()).toEqual([]);
  });

  test("reuses the routing token but not the dispatch ID for tool continuations", async () => {
    stubRouter(); const fetch = globalThis.fetch; let calls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => { calls++; return fetch(...args); }) as typeof fetch;
    const h = harness();
    const first = await route(h, "first");
    const continuation = await route(h, "first", "continuation");
    expect(continuation.model.id).not.toBe(first.model.id);
    await h.provider.streamSimple(first.model, message("first"), { sessionId: "one" }).result();
    await h.provider.streamSimple(continuation.model, message("first"), { sessionId: "one" }).result();
    expect(calls).toBe(1);
    expect(h.calls.map((call) => (call.options.headers as Record<string, string>)["Copilot-Session-Token"]))
      .toEqual(["token-first", "token-first"]);
  });

  test("concurrent routes in one session retain independent compaction markers", async () => {
    stubRouter(); const h = harness();
    const [first, second] = await Promise.all([route(h, "first"), route(h, "first")]);
    expect(first.model.id).not.toBe(second.model.id);
    const hook = () => h.handlers.session_before_compact({ reason: "threshold" }, h.ctx);
    await h.provider.streamSimple(first.model, message("first"), { sessionId: "one" }).result();
    expect(hook()).toBeUndefined();
    await h.provider.streamSimple(second.model, message("first"), { sessionId: "one" }).result();
    expect(hook()).toEqual({ cancel: true });
  });

  test("fails closed rather than routing an out-of-scope model", async () => {
    stubRouter(); const h = harness(false);
    await expect(route(h, "first")).rejects.toThrow("outside the enabled model scope");
    expect(h.calls).toHaveLength(0);
  });

  test("compacts only after the current turn has selected a model", async () => {
    stubRouter(); const h = harness();
    const hook = (reason: string) => h.handlers.session_before_compact({ reason }, h.ctx);
    h.handlers.input({ streamingBehavior: undefined }, h.ctx);
    expect(hook("threshold")).toEqual({ cancel: true });
    expect(hook("overflow")).toEqual({ cancel: true });
    expect(hook("manual")).toBeUndefined();
    const first = await route(h, "first");
    expect(hook("threshold")).toBeUndefined();
    expect(hook("overflow")).toBeUndefined();
    await h.provider.streamSimple(first.model, message("first"), { sessionId: "one" }).result();
    expect(hook("threshold")).toEqual({ cancel: true });
    h.handlers.input({ streamingBehavior: "followUp" }, h.ctx);
    expect(hook("threshold")).toEqual({ cancel: true });
    expect(hook("overflow")).toBeUndefined();
    await route(h, "second");
    expect(hook("threshold")).toBeUndefined();
    h.handlers.agent_settled(undefined, h.ctx);
    expect(hook("threshold")).toEqual({ cancel: true });
  });

  test("direct summary routes do not permit premature automatic compaction", async () => {
    stubRouter(); const h = harness();
    await route(h, "first", "direct");
    expect(h.handlers.session_before_compact({ reason: "threshold" }, h.ctx)).toEqual({ cancel: true });
  });

  test("a summary dispatch cannot consume the main request's compaction marker", async () => {
    stubRouter(); const h = harness();
    const main = await route(h, "first");
    const summary = await route(h, "first", "direct");
    expect(summary.model.id).not.toBe(main.model.id);
    await h.provider.streamSimple(summary.model, message("first"), { sessionId: "one" }).result();
    expect(h.handlers.session_before_compact({ reason: "threshold" }, h.ctx)).toBeUndefined();
    await h.provider.streamSimple(main.model, message("first"), { sessionId: "one" }).result();
    expect(h.handlers.session_before_compact({ reason: "threshold" }, h.ctx)).toEqual({ cancel: true });
  });

  test("never sends a Fusion token to a different physical endpoint", async () => {
    stubRouter(); const h = harness(true, "https://proxy.example.com");
    const selected = await route(h, "first");
    const stream = h.provider.streamSimple(selected.model, message("first"), { sessionId: "one" });
    const result = await stream.result() as { stopReason: string; errorMessage: string; provider: string; model: string };
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("different model endpoint");
    expect(result.provider).toBe("github-copilot");
    expect(result.model).toBe(physical.id);
    expect(JSON.stringify(result)).not.toContain("token-first");
    expect(JSON.stringify(result)).not.toContain(selected.model.id);
    expect(h.calls).toHaveLength(0);
  });

  test("reports cancellation as aborted", async () => {
    stubRouter(); const h = harness(); const selected = await route(h, "first");
    const controller = new AbortController(); controller.abort();
    const stream = h.provider.streamSimple(selected.model, message("first"), { signal: controller.signal });
    const result = await stream.result() as { stopReason: string };
    expect(result.stopReason).toBe("aborted");
    expect(h.calls).toHaveLength(0);
  });
});
