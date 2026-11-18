// Offline transport capture for copilot_long_context_test.py. All credentials are fake.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload-context-fixture", { async handler(_args, ctx) { await ctx.reload(); } });
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.individual.githubcopilot.com") throw new Error("Unexpected destination in Copilot fixture");
    const version = request.headers.get("X-GitHub-Api-Version");
    if (request.method === "GET" && url.pathname === "/models") {
      console.error(`COPILOT_CAPTURE:${JSON.stringify({ version, path: url.pathname })}`);
      if (request.headers.get("authorization") !== "Bearer local-wire-check") return new Response(null, { status: 401 });
      return Response.json({ data: [
        ["fixture-messages", "/v1/messages"], ["fixture-completions", "/chat/completions"], ["fixture-responses", "/responses"],
      ].map(([id, path]) => ({
        id, model_picker_enabled: true, supported_endpoints: [path],
        billing: { token_prices: { default: { max_prompt_tokens: 200_000 }, long_context: { max_prompt_tokens: 1_000_000 } } },
        capabilities: { limits: { max_prompt_tokens: 1_000_000, max_context_window_tokens: 1_000_000, max_output_tokens: 64_000 } },
      })) });
    }
    if (request.method !== "POST") throw new Error("Unexpected method in Copilot fixture");
    const payload = await request.json() as { model: string };
    console.error(`COPILOT_CAPTURE:${JSON.stringify({ version, path: url.pathname, model: payload.model, extra: request.headers.get("x-test-extra") })}`);
    return Response.json({ error: { message: "intentional local capture", type: "invalid_request_error" } }, { status: 400 });
  }) as typeof fetch;
}
