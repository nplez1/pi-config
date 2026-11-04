// Offline fixture for fusion_compaction_test.py. Every model and token is fake.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const smallPrevious = process.env.FUSION_TEST_SMALL_PREVIOUS === "1";
  let overflowSent = false;
  let retrySent = false;
  let previousRuns = 0;
  let toolRuns = 0;
  const toolLoop = process.env.FUSION_TEST_TOOL_LOOP === "1";
  if (toolLoop) {
    pi.registerTool({
      name: "fusion_fixture_tool", label: "Fusion fixture", description: "Return synthetic context.",
      parameters: Type.Object({}),
      async execute() {
        toolRuns++;
        return { content: [{ type: "text", text: "x ".repeat(70_000) }], details: {} };
      },
    });
  }
  function stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
    if (model.provider === "github-copilot") {
      const token = Object.entries(options?.headers ?? {}).find(([name]) => name.toLowerCase() === "copilot-session-token")?.[1];
      if (token !== "fixture-token") throw new Error("Fusion billing token missing from physical request");
      console.error("FIXTURE_FUSION_HEADER");
    }
    console.error(`FIXTURE_STREAM:${model.id}`);
    const output = createAssistantMessageEventStream();
    // Model usage reflects the tool results actually sent, not the lifetime
    // count: compaction may remove earlier results before this request.
    const visibleToolResults = context.messages.filter((message) => message.role === "toolResult").length;
    const input = model.id === "previous" ? (smallPrevious ? 95_000 : 200_000)
      : toolLoop ? 100 + visibleToolResults * 35_000 : Number(process.env.FUSION_TEST_LAST_USAGE) || 100;
    const callTool = toolLoop && model.id === "small-fixture" && toolRuns < 3;
    if (model.id === "previous") previousRuns++;
    const staleOverflow = model.id === "previous" && process.env.FUSION_TEST_OLD_OVERFLOW === "1" && previousRuns === 4;
    const overflow = staleOverflow || (model.id === "large-fixture" && process.env.FUSION_TEST_OVERFLOW === "1" && !overflowSent);
    if (overflow && !staleOverflow) overflowSent = true;
    const retryable = model.id === "large-fixture" && process.env.FUSION_TEST_RETRY === "1" && !retrySent;
    if (retryable) retrySent = true;
    const message: AssistantMessage = {
      role: "assistant", content: callTool
        ? [{ type: "toolCall", id: `fixture-call-${toolRuns}`, name: "fusion_fixture_tool", arguments: {} }]
        : [{ type: "text", text: "OK" }], api: model.api,
      provider: model.provider, model: model.id,
      usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1,
        cost: { ...cost, total: 0 } },
      stopReason: overflow || retryable ? "error" : callTool ? "toolUse" : "stop",
      ...(overflow ? { errorMessage: "context_length_exceeded" } : retryable ? { errorMessage: "503 Service Unavailable" } : {}), timestamp: Date.now(),
    };
    output.push({ type: "start", partial: message });
    if (overflow || retryable) output.push({ type: "error", reason: "error", error: message });
    else output.push({ type: "done", reason: callTool ? "toolUse" : "stop", message });
    output.end(message);
    return output;
  }
  pi.registerProvider("context-probe", {
    baseUrl: "https://example.invalid", apiKey: "local", api: "context-probe-api",
    models: [{ id: "previous", name: "Previous", reasoning: false, input: ["text"],
      contextWindow: smallPrevious ? 100_000 : 1_000_000, maxTokens: 1_000, cost }], streamSimple: stream,
  });
  pi.registerProvider("github-copilot", {
    baseUrl: "https://api.business.githubcopilot.com", apiKey: "fake-copilot-token", api: "fusion-fixture-api",
    models: [
      { id: "small-fixture", name: "Small", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1_000, cost },
      { id: "large-fixture", name: "Large", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 1_000, cost },
    ], streamSimple: stream,
  });
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (new URL(String(url)).pathname === "/auto") {
      console.error("FIXTURE_ROUTE");
      const limit = Number(process.env.FUSION_TEST_PROMPT_LIMIT);
      return new Response(JSON.stringify({ selected_model: { id: process.env.FUSION_TEST_ROUTED_MODEL ?? "large-fixture",
        ...(limit > 0 ? { capabilities: { limits: { max_prompt_tokens: limit } } } : {}) }, session_token: "fixture-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
    }
    throw new Error("Unexpected network request during fixture");
  }) as typeof fetch;
  pi.on("session_before_compact", (event) => { console.error(`FIXTURE_COMPACTION:${event.reason}`); });
}
