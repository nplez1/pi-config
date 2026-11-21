/**
 * continue.ts — `/continue`: resume a stopped session without sending anything.
 *
 * For sessions that died mid-work: a dropped connection, a killed terminal, or a
 * run that stopped for no visible reason. The model picks up from the transcript
 * exactly as it stood, and no user text is added to it.
 *
 * Pi has no public call that starts a run from the existing transcript (its own
 * `agent.continue()` is internal). So this extension uses the public path it
 * does have: a hidden, empty custom message that starts the run. A `context`
 * handler then strips that marker before every model request, so the request
 * is the transcript alone. The marker stays in the session file as an empty,
 * hidden entry; it never reaches the model or the screen.
 *
 * Refusals, rather than a run that would fail:
 *
 *   - busy agent: wait for the current run to finish.
 *   - last reply completed (`stop` / `length`): nothing is pending. Send a message.
 *
 * Interrupted tails are handled the way pi's own auto-retry handles a failed
 * attempt. A trailing assistant reply that errored, was aborted, or issued tool
 * calls with no result is omitted from that request, along with any results
 * after it. Completed tool results are kept.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "continue-run";

/** The fields this file reads from an agent message. */
export interface Turn {
  role: string;
  customType?: string;
  stopReason?: string;
  toolCallId?: string;
  content?: unknown;
}

export const isMarker = (m: Turn): boolean => m.role === "custom" && m.customType === MARKER;

/** Assistant stop reasons that mean the reply finished on its own. */
const COMPLETE = new Set(["stop", "length"]);

function toolCallIds(m: Turn): string[] {
  const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: string; id?: string }>) : [];
  return blocks.flatMap((b) => (b.type === "toolCall" && b.id ? [b.id] : []));
}

/**
 * Omit an interrupted attempt at the tail: the last assistant reply, plus any
 * results after it, when that reply errored, was aborted, or issued tool calls
 * that have no result. Otherwise the messages are returned unchanged.
 */
export function omitInterruptedTail<T extends Turn>(messages: T[]): T[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].role === "toolResult") end--;
  if (end === 0 || messages[end - 1].role !== "assistant") return messages;

  const tail = messages[end - 1];
  const answered = new Set(messages.slice(end).map((m) => m.toolCallId));
  const unpaired = toolCallIds(tail).some((id) => !answered.has(id));
  const interrupted = tail.stopReason === "error" || tail.stopReason === "aborted" || unpaired;
  return interrupted ? messages.slice(0, end - 1) : messages;
}

export default function (pi: ExtensionAPI) {
  pi.on("context", (event) => {
    if (!event.messages.some((m) => isMarker(m as unknown as Turn))) return undefined;
    const visible = (event.messages as unknown as Turn[]).filter((m) => !isMarker(m));
    return { messages: omitInterruptedTail(visible) as typeof event.messages };
  });

  pi.registerCommand("continue", {
    description: "Resume a stopped session: the model runs on the existing transcript, nothing is added",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("/continue needs an idle agent. Wait for the current run to finish.", "warning");
        return;
      }
      const transcript = (ctx.sessionManager.buildSessionProjection().messages as unknown as Turn[]).filter(
        (m) => !isMarker(m),
      );
      const last = transcript.at(-1);
      if (!last) {
        ctx.ui.notify("Nothing to resume: this session has no messages yet.", "info");
        return;
      }
      if (last.role === "assistant" && COMPLETE.has(last.stopReason ?? "")) {
        ctx.ui.notify("The last reply finished on its own, so there is nothing to resume. Send a message to carry on.", "info");
        return;
      }
      pi.sendMessage({ customType: MARKER, content: "", display: false }, { triggerTurn: true });
    },
  });
}
