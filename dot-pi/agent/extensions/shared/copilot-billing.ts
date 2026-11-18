import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Provider, type StreamOptions, type Usage } from "@earendil-works/pi-ai";

const NANO_AIU_PER_CREDIT = 1_000_000_000;
// https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals
const USD_PER_CREDIT = 0.01;

export interface CopilotUsage extends Usage {
  copilotBilling?: { totalNanoAiu: number; aiCredits: number };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function copilotReportedNanoAiu(data: unknown): number | undefined {
  const event = record(data);
  if (!event) return;
  // CAPI adds copilot_usage to Messages deltas, Chat Completions chunks, and
  // Responses completion events. Also accept its nested usage form.
  const response = record(event.response);
  for (const owner of [event, record(event.usage), response, record(response?.usage)]) {
    const value = record(owner?.copilot_usage)?.total_nano_aiu;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
}

function applyCopilotBilling(message: AssistantMessage, totalNanoAiu: number | undefined): AssistantMessage {
  if (totalNanoAiu === undefined) return message;
  const aiCredits = totalNanoAiu / NANO_AIU_PER_CREDIT;
  const usage: CopilotUsage = {
    ...message.usage,
    copilotBilling: { totalNanoAiu, aiCredits },
    // Pi deliberately keeps estimated component costs alongside a provider total.
    cost: { ...message.usage.cost, total: totalNanoAiu / (NANO_AIU_PER_CREDIT / USD_PER_CREDIT), totalFromProvider: true },
  };
  return { ...message, usage };
}

function capture<T extends StreamOptions>(
  options: T | undefined,
  start: (options: T) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  let nanoAiu: number | undefined;
  // The callback belongs to one physical stream. Messages deltas do not carry
  // a response ID, so a session-wide hook cannot safely attribute concurrent calls.
  const inner = start({
    ...options,
    async onProviderStreamEvent(data, model) {
      nanoAiu = copilotReportedNanoAiu(data) ?? nanoAiu;
      await options?.onProviderStreamEvent?.(data, model);
    },
  } as T);
  const output = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) {
      if (event.type === "done") {
        output.push({ ...event, message: applyCopilotBilling(event.message, nanoAiu) });
        return;
      }
      if (event.type === "error") {
        output.push({ ...event, error: applyCopilotBilling(event.error, nanoAiu) });
        return;
      }
      output.push(event);
    }
    output.end(applyCopilotBilling(await inner.result(), nanoAiu));
  })().catch(() => {
    // Native AssistantMessageEventStream reports failures as terminal events;
    // preserve its finalized result if forwarding ever fails unexpectedly.
    void inner.result().then((message) => output.end(applyCopilotBilling(message, nanoAiu)));
  });
  return output;
}

export function withCopilotBilling(base: Provider): Provider {
  return {
    ...base,
    stream: (model, context, options) => capture(options, (wrapped) => base.stream(model, context, wrapped)),
    streamSimple: (model, context, options) => capture(options, (wrapped) => base.streamSimple(model, context, wrapped)),
  };
}
