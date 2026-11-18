import { expect, test } from "bun:test";
import { COPILOT_CONTEXT_API_VERSION, copilotLongContext, fetchCopilotCatalog, longContextHeaders } from "./copilot-long-context";

const base = "https://api.individual.githubcopilot.com";
const model = { provider: "github-copilot", id: "model", api: "openai-responses", baseUrl: base, maxTokens: 128_000 };
const row = {
  id: model.id, model_picker_enabled: true, supported_endpoints: ["/responses"],
  billing: { token_prices: { default: { max_prompt_tokens: 200_000 }, long_context: { max_prompt_tokens: 1_000_000 } } },
  capabilities: { limits: { max_prompt_tokens: 980_000, max_context_window_tokens: 1_000_000, max_output_tokens: 64_000 } },
};

const setup = (entry = row, selected = model, authBase?: string) => copilotLongContext({ data: [entry] }, selected, authBase);

test("selects a safe prompt budget and output cap from the catalog", () => {
  expect(setup()).toEqual({ defaultPrompt: 200_000, contextWindow: 936_000, maxTokens: 64_000 });
});

test("honors the long-tier cap, the endpoint prompt cap, and a lower configured output limit", () => {
  const tier = setup({ ...row, billing: { token_prices: { ...row.billing.token_prices, long_context: { max_prompt_tokens: 400_000 } } } });
  expect(tier?.contextWindow).toBe(400_000);
  expect(setup(row, { ...model, maxTokens: 10_000 })).toMatchObject({ contextWindow: 980_000, maxTokens: 10_000 });
});

test("supports the older context_max field and only lists tiers larger than default", () => {
  const entry = { ...row, billing: { token_prices: { default: { context_max: 200_000 }, long_context: { context_max: 500_000 } } } };
  expect(copilotLongContext({ data: [entry] }, model)?.contextWindow).toBe(500_000);
  expect(setup({ ...row, billing: { token_prices: { ...row.billing.token_prices, long_context: { max_prompt_tokens: 200_000 } } } })).toBeUndefined();
});

test("ignores legacy, disabled, unlisted, malformed, unwired, and non-Copilot models", () => {
  const withoutTier = { ...row, billing: { token_prices: { default: { max_prompt_tokens: 200_000 } } } };
  expect(copilotLongContext({ data: [withoutTier, { ...row, policy: { state: "disabled" } },
    { ...row, policy: { state: "unconfigured" } }, { ...row, model_picker_enabled: false }, null,
    { ...row, supported_endpoints: ["ws:/responses"] }, { ...row, id: "different-model" },
    { ...row, capabilities: { supports: { tool_calls: false }, ...row.capabilities } },
    { ...row, capabilities: { limits: { ...row.capabilities.limits, max_context_window_tokens: "1000000" } } },
  ] }, model)).toBeUndefined();
  expect(setup(row, { ...model, provider: "anthropic" })).toBeUndefined();
  expect(setup(row, { ...model, api: "pi-virtual" })).toBeUndefined();
  expect(() => copilotLongContext({ data: {} }, model)).toThrow("invalid model catalog");
});

test("checks the actual request endpoint, including Pi's credential-specific override", () => {
  expect(setup(row, { ...model, baseUrl: "https://proxy.example" })).toBeUndefined();
  expect(setup(row, model, "https://proxy.example")).toBeUndefined();
  expect(setup(row, { ...model, baseUrl: "https://proxy.example" }, base)).toBeDefined();
});

test("replaces API version case-insensitively without changing other model headers", () => {
  const headers = { "X-Extra": "kept", "x-github-api-version": "old" };
  expect(longContextHeaders(headers)).toEqual({ "X-Extra": "kept", "X-GitHub-Api-Version": COPILOT_CONTEXT_API_VERSION });
  expect(headers["x-github-api-version"]).toBe("old");
});

test("catalog lookup uses the version header and cannot redirect the bearer to another host", async () => {
  const fetcher = (async (input, init) => {
    expect(String(input)).toBe(`${base}/models`);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-github-api-version")).toBe(COPILOT_CONTEXT_API_VERSION);
    return Response.json({ data: [row] });
  }) as typeof fetch;
  expect(await fetchCopilotCatalog(base, "test-key", fetcher)).toEqual({ data: [row] });
});

test("refuses untrusted catalog URLs before calling fetch and does not expose server bodies", async () => {
  const neverFetch = (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
  for (const url of ["http://api.githubcopilot.com", "https://githubcopilot.com.evil.example", "https://evil.example/?githubcopilot.com", "https://user@api.githubcopilot.com", "https://api.githubcopilot.com:1234", "https://api.githubcopilot.com/proxy"]) {
    await expect(fetchCopilotCatalog(url, "test-key", neverFetch)).rejects.toThrow("direct GitHub Copilot HTTPS endpoint");
  }
  const forbidden = (async () => new Response("secret body", { status: 403 })) as unknown as typeof fetch;
  await expect(fetchCopilotCatalog(base, "test-key", forbidden)).rejects.toThrow(/^GitHub Copilot catalog request failed \(HTTP 403\)\.$/);
});
