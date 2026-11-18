// Deterministic account catalog and SSE; no request is allowed off process.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODELS = [
  ["claude-haiku-5.5", "/v1/messages"],
  ["discovered-chat", "/chat/completions"],
  ["discovered-responses", "/responses"],
  ["disabled-model", "/responses"],
  ["unlisted-model", "/responses"],
  ["unsupported-model", "/other-protocol"],
];

function sse(events: Array<Record<string, unknown> | string>, named = false) {
  const body = events.map((item) => typeof item === "string" ? `data: ${item}\n\n`
    : `${named ? `event: ${item.type}\n` : ""}data: ${JSON.stringify(item)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("billing-concurrency-fixture", {
    async handler(_args, ctx) {
      if (!ctx.model) throw new Error("Missing fixture model");
      const context = { messages: [{ role: "user" as const, content: "OK?", timestamp: 0 }] };
      const registry = ctx.modelRegistry;
      const a = registry.stream(ctx.model, context, { headers: { "x-fixture-credit": "111" } });
      const b = registry.streamSimple(ctx.model, context, { headers: { "x-fixture-credit": "222" } });
      const messages = await Promise.all([a.result(), b.result()]);
      pi.appendEntry("credits-fixture", messages.map((message) => message.usage));
    },
  });
  let sequence = 0;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.individual.githubcopilot.com" || request.headers.get("authorization") !== "Bearer billing-fixture") {
      throw new Error("Unexpected destination or credential in Copilot fixture");
    }
    if (url.pathname === "/models") {
      if (process.env.COPILOT_FIXTURE_UNAVAILABLE) return Response.json({}, { status: 503 });
      const versioned = request.headers.get("x-github-api-version") === "2026-08-01";
      return Response.json({ data: MODELS.map(([id, path]) => ({
        id, name: `Live ${id}`, model_picker_enabled: id !== "unlisted-model",
        ...(id === "disabled-model" ? { policy: { state: "disabled" } } : {}),
        supported_endpoints: [path],
        capabilities: { type: "chat", supports: { tool_calls: true, vision: true }, limits: {
          max_prompt_tokens: versioned ? 960_000 : 100_000,
          max_context_window_tokens: versioned ? 1_000_000 : 120_000,
          max_output_tokens: versioned ? 40_000 : 20_000,
        } },
        ...(versioned ? { billing: { token_prices: { batch_size: 1_000_000,
          default: { max_prompt_tokens: 100_000, input_price: 10, output_price: 50, cache_read_price: 1, cache_write_price: 12.5 },
          long_context: { max_prompt_tokens: 960_000, input_price: 50, output_price: 250, cache_read_price: 5, cache_write_price: 62.5 },
        } } } : {}),
      })) });
    }
    const payload = await request.json() as { model: string };
    const id = `fixture-${++sequence}`;
    if (url.pathname === "/v1/messages") {
      const initialUsage = { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 4 };
      const amount = Number(request.headers.get("x-fixture-credit") ?? "42500000");
      return sse([
        { type: "message_start", message: { id, type: "message", model: payload.model, role: "assistant", content: [], usage: initialUsage } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 }, copilot_usage: { total_nano_aiu: amount } },
        { type: "message_stop" },
      ], true);
    }
    if (url.pathname === "/chat/completions") {
      // Deliberately omit the provider-reported amount on the first chat call;
      // the previous Messages stream's amount must not leak into this request.
      const amount = process.env.COPILOT_FIXTURE_CHAT_WITHOUT_AMOUNT ? undefined : { total_nano_aiu: 0 };
      return sse([{ id, object: "chat.completion.chunk", model: payload.model, created: 0,
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 }, copilot_usage: amount,
      }, "[DONE]"]);
    }
    if (url.pathname === "/responses") {
      const item = { type: "message", id: `${id}_out`, role: "assistant", status: "in_progress", content: [] };
      const part = { type: "output_text", text: "OK", annotations: [] };
      const completed = { ...item, status: "completed", content: [part] };
      const response = { id, object: "response", model: payload.model, output: [], status: "in_progress" };
      return sse([
        { type: "response.created", response },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OK" },
        { type: "response.output_item.done", output_index: 0, item: completed },
        { type: "response.completed", response: { ...response, output: [completed], status: "completed",
          usage: { input_tokens: 40, output_tokens: 2, total_tokens: 42 } }, copilot_usage: { total_nano_aiu: 1_230_000_000 } },
      ]);
    }
    throw new Error("Unexpected Copilot fixture request");
  }) as typeof fetch;
}
