/**
 * toolcall-rescue.ts — a tool call written as text must not end the turn.
 *
 * DeepSeek models can answer with the call written out in DeepSeek's own DSML
 * dialect instead of sending it through the tool channel. Every tag is wrapped
 * in U+FF5C `DSML` U+FF5C (`\uff5c` below, written as an escape so this file
 * stays ASCII):
 *
 *   <\uff5cDSML\uff5cinvoke name="codemode" string="true">…</\uff5cDSML\uff5cinvoke>
 *
 * Pi has no DSML parser — `strings pi-bin | rg -i dsml` returns nothing — so the
 * markup arrives as ordinary assistant text, with `stopReason: "stop"` and zero
 * tool calls. Pi reads a finished reply and settles the run: nothing executes,
 * nothing errors, and a long job is simply gone.
 *
 * Measured on this machine (2026-11-28, `~/.pi/agent/sessions`): three assistant
 * turns carried a DSML envelope as their entire text — `isoquant` /
 * `deepseek-v4.1-flash-1017-fast` every time, `stopReason: "stop"`, zero tool
 * calls — against 126 sessions that used that model. All three ended their turn,
 * and all three mangled the tool name ("codemod", "codemap", "codemodode" for
 * `codemode`), which is why the corrective message names the closest real tool
 * rather than only complaining.
 *
 * The turn boundary is the only place an extension can fix this: a hook cannot
 * execute a tool (`ctx.executeTool` belongs to tool execute contexts), and the
 * drafts `turn_end` may append are `custom`, `custom_message`, `context_edit`
 * and `compaction` — never a tool call. So the reply text is edited out of model
 * context, one hidden corrective message carrying the recovered call is appended,
 * and `continue: true` keeps the run alive. The malformed reply then costs one
 * cheap turn instead of the job.
 *
 * Everything except the handler is a pure function over the message, so
 * `node --test tests/toolcall-rescue.test.mjs` exercises it without a session.
 * The only import is type-only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** DeepSeek's DSML wrapper: `<` U+FF5C `DSML` U+FF5C, then the tag name. */
const DSML_MARKER = /\uff5c\s*DSML\s*\uff5c/gi;
const DSML_PROBE = /\uff5c\s*DSML\s*\uff5c/i;

/** Envelope tags DSML shares with the Anthropic/Hermes XML dialect. */
const ENVELOPE_OPEN = /<\s*(?:function_calls|invoke)\b/i;

/** A reply that ends inside a closing envelope tag is a call, not prose about one. */
const ENVELOPE_CLOSE_AT_END = /<\s*\/\s*(?:invoke|calls|function_calls)\s*>\s*$/i;

/** Anything from a closing envelope tag onward is markup, not an argument value. */
const ENVELOPE_TAIL = /<\s*\/\s*(?:parameter|invoke|calls|function_calls)\s*>/i;

/**
 * How many turns in a row may be rescued before the guard stops rescuing. A model
 * that answers every corrective message with the same envelope would otherwise be
 * kept alive forever by this extension; three attempts is enough to correct a
 * slip and short enough to give the session back to you.
 */
export const MAX_CONSECUTIVE_RESCUES = 3;

/** Argument values are shown to the model, not streamed to it: cap them. */
const MAX_PARAM_CHARS = 400;

/** The replacement that stays in model context where the envelope was. */
export const RESCUE_REPLACEMENT =
  "[pi] This reply was a tool call written as text, in a dialect Pi cannot execute, so the turn ended. " +
  "The call is re-issued in the next message; nothing was run and nothing was lost.";

export interface ForeignParameter {
  name: string;
  value: string;
}

export interface ForeignCall {
  name: string;
  parameters: ForeignParameter[];
}

export interface DetectedEnvelope {
  /** `dsml` when DeepSeek's markers were present, `xml` for the plain tag dialect. */
  dialect: "dsml" | "xml";
  calls: ForeignCall[];
  /** Prose the reply carried before the envelope, if any. */
  lead: string;
}

/** A message/content block shape, read defensively: this runs over whatever pi hands over. */
interface ShellMessage {
  role?: string;
  stopReason?: string;
  content?: unknown;
}

export interface TurnShell {
  outcome?: string;
  toolResults?: readonly unknown[];
  message?: ShellMessage;
}

export interface ToolNameSuggestion {
  /** The real tool to use, when the written name is not one. */
  tool: string | null;
  /** How the name was wrong, when it was. */
  note: string | null;
}

function blocksOf(content: unknown): Array<{ type?: string; text?: string; name?: string }> {
  return Array.isArray(content) ? (content as Array<{ type?: string; text?: string; name?: string }>) : [];
}

/** The assistant's reply as text, without thinking or tool-call blocks. */
export function assistantText(message: ShellMessage | undefined): string {
  return blocksOf(message?.content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/** Whether the reply already carried a real tool call. */
export function hasToolCalls(message: ShellMessage | undefined): boolean {
  return blocksOf(message?.content).some((block) => block.type === "toolCall");
}

/** Remove DeepSeek's wrapper tokens, leaving the tag structure they wrap. */
export function stripDsml(text: string): string {
  return text.replace(DSML_MARKER, "");
}

/** Cut a value off at the first closing envelope tag it runs into. */
function clipEnvelopeTail(value: string): string {
  const tail = ENVELOPE_TAIL.exec(value);
  return (tail ? value.slice(0, tail.index) : value).trim();
}

const NAME_ATTRIBUTE = /\bname\s*=\s*["']([^"']*)["']/i;

function parseParameters(body: string): ForeignParameter[] {
  const open = /<\s*parameter\b([^>]*)>/gi;
  const opened: Array<{ name: string; start: number; bodyStart: number }> = [];
  for (let match = open.exec(body); match; match = open.exec(body)) {
    const name = NAME_ATTRIBUTE.exec(match[1])?.[1]?.trim();
    if (!name) continue;
    opened.push({ name, start: match.index, bodyStart: match.index + match[0].length });
  }
  return opened.map((parameter, index) => {
    const end = index + 1 < opened.length ? opened[index + 1].start : body.length;
    const value = clipEnvelopeTail(body.slice(parameter.bodyStart, end)).slice(0, MAX_PARAM_CHARS);
    return { name: parameter.name, value };
  });
}

/** Every `<invoke name="…">` in the text, with its parameters in the order written. */
export function parseCalls(text: string): ForeignCall[] {
  const starts: number[] = [];
  const open = /<\s*invoke\b/gi;
  for (let match = open.exec(text); match; match = open.exec(text)) starts.push(match.index);

  const calls: ForeignCall[] = [];
  starts.forEach((start, index) => {
    const segment = text.slice(start, index + 1 < starts.length ? starts[index + 1] : text.length);
    const headerEnd = segment.indexOf(">");
    if (headerEnd < 0) return;
    const name = NAME_ATTRIBUTE.exec(segment.slice(0, headerEnd + 1))?.[1]?.trim();
    if (!name) return;
    const close = segment.slice(headerEnd + 1).search(/<\s*\/\s*invoke\s*>/i);
    const body = close < 0 ? segment.slice(headerEnd + 1) : segment.slice(headerEnd + 1, headerEnd + 1 + close);
    calls.push({ name, parameters: parseParameters(body) });
  });
  return calls;
}

/** Index of the first DSML marker in the original text, as an envelope start. */
function firstMarkerIndex(text: string): number {
  const match = DSML_PROBE.exec(text);
  if (!match) return -1;
  // The marker opens the tag, so the envelope starts at its `<`.
  const before = text.slice(0, match.index);
  return before.endsWith("<") ? match.index - 1 : match.index;
}

/**
 * Find a tool-call envelope in an assistant reply, or null when there is none.
 *
 * Deliberately conservative, because a false positive edits a good reply out of
 * context: an envelope has to sit outside a fenced code block, and the plain XML
 * dialect additionally has to *end* the reply with a closing tag. DeepSeek's
 * markers are accepted on their own — nothing else writes U+FF5C `DSML` U+FF5C,
 * and the observed failures are degraded enough (`</parameter>` with no opener,
 * `</calls>` with no `function_calls`) that requiring a well-formed envelope
 * would reject the very case this exists for.
 */
export function detectEnvelope(text: string): DetectedEnvelope | null {
  if (!text) return null;
  const normalized = stripDsml(text);
  const open = ENVELOPE_OPEN.exec(normalized);
  const hasMarker = DSML_PROBE.test(text);
  if (!open && !hasMarker) return null;

  const start = open ? open.index : firstMarkerIndex(text);
  if (start < 0) return null;
  const lead = normalized.slice(0, start);
  // A code fence before the envelope means the reply is explaining the format.
  if ((lead.match(/```/g) ?? []).length % 2 === 1) return null;

  const dialect = hasMarker ? "dsml" : "xml";
  const calls = parseCalls(normalized.slice(start));
  if (dialect === "xml") {
    if (!ENVELOPE_CLOSE_AT_END.test(normalized)) return null;
    if (calls.length === 0) return null;
  }
  return { dialect, calls, lead };
}

/**
 * The envelope a completed turn failed to execute, or null.
 *
 * Every condition here is one of the three facts the failing turns shared:
 * `outcome: "completed"` with `stopReason: "stop"`, no tool result, and no tool
 * call — the run believed the reply was finished.
 */
export function rescueFor(turn: TurnShell): DetectedEnvelope | null {
  if (turn.outcome !== "completed") return null;
  if ((turn.toolResults?.length ?? 0) > 0) return null;
  if (turn.message?.role !== "assistant") return null;
  if (hasToolCalls(turn.message)) return null;
  return detectEnvelope(assistantText(turn.message));
}

/** Edit distance, capped: only used to rank short tool names. */
export function distance(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * Whether a suggestion is close enough to be worth naming.
 *
 * Two bounds, because either one alone is wrong. Absolute: roughly a third of the
 * written name, floor 2 — `codemap` for `codemode` is three edits of seven, and a
 * two-edit floor would have rejected a misspelling that showed up in a real
 * session. Relative: half the longer of the two names, so a short name cannot make
 * two edits look close enough — without it, `ab` would be "corrected" to `cd`.
 */
function closeEnough(written: string, tool: string, score: number): boolean {
  const absolute = Math.max(2, Math.ceil(written.length / 3));
  const relative = Math.ceil(Math.max(written.length, tool.length) / 2);
  return score <= absolute && score <= relative;
}

/**
 * Resolve the written name against the tools that are actually active.
 *
 * The three observed failures wrote `codemod`, `codemap` and `codemodode` for
 * `codemode`. A name Pi does not know is worth saying out loud: the model then
 * cannot re-issue the same misspelling and spend another turn on it.
 */
export function suggestTool(name: string, tools: readonly string[]): ToolNameSuggestion {
  const exact = tools.find((tool) => tool === name);
  if (exact) return { tool: exact, note: null };

  const capitalised = tools.find((tool) => tool.toLowerCase() === name.toLowerCase());
  if (capitalised) return { tool: capitalised, note: `tool names are case-sensitive, so \`${name}\` is not one` };

  let best: { tool: string; score: number } | null = null;
  for (const tool of tools) {
    const score = distance(name, tool);
    if (best === null || score < best.score) best = { tool, score };
  }
  if (best && closeEnough(name, best.tool, best.score)) {
    return { tool: best.tool, note: `no tool is named \`${name}\`; the closest is \`${best.tool}\`` };
  }
  return { tool: null, note: `no tool is named \`${name}\`, and no active tool is close to it` };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** The hidden corrective message: what was written, and what to do instead. */
export function renderRescue(envelope: DetectedEnvelope, tools: readonly string[]): string {
  const dialect = envelope.dialect === "dsml" ? "DeepSeek's DSML dialect" : "an XML tool-call envelope";
  const lines: string[] = [
    `Pi did not run anything in your last reply. The tool call was written as text in ${dialect} instead of ` +
      `being sent through the tool channel, so Pi had nothing to execute and the turn ended. The text has been ` +
      `removed from this conversation; no work was lost.`,
    "",
    "Re-issue that call now, as a real tool call. Do not re-plan, do not re-read files, and do not explain this " +
      "message: the recovered call below is what you already decided.",
  ];

  if (envelope.calls.length === 0) {
    lines.push("", "Nothing usable could be recovered from the text, so rebuild the call from what you were doing.");
  } else {
    lines.push("", "Recovered from the text:");
    for (const call of envelope.calls) {
      const suggestion = suggestTool(call.name, tools);
      lines.push(suggestion.note ? `  - tool: \`${call.name}\` — ${suggestion.note}` : `  - tool: \`${call.name}\``);
      for (const parameter of call.parameters) {
        lines.push(`  - ${parameter.name}: ${quote(parameter.value)}`);
      }
      if (suggestion.tool && suggestion.note) lines.push(`  - use \`${suggestion.tool}\` for it.`);
    }
  }

  lines.push(
    "",
    "Never write a tool call as markup in your reply: Pi executes tool calls, not text. If a call is still the " +
      "right thing to do, make it exactly as recovered above.",
  );
  return lines.join("\n");
}

interface RescuerCounters {
  rescued: number;
  /** The last envelope seen, for `/toolcall-rescue`. */
  last: { dialect: string; names: string } | null;
}

export default function (pi: ExtensionAPI) {
  let consecutive = 0;
  let gaveUp = false;
  const counters: RescuerCounters = { rescued: 0, last: null };

  const reset = () => {
    consecutive = 0;
    gaveUp = false;
  };

  // A new human instruction deserves a fresh budget, and so does a new session.
  pi.on("session_start", reset);
  pi.on("input", reset);

  pi.on("turn_end", async (event, ctx) => {
    const envelope = rescueFor(event as unknown as TurnShell);
    if (!envelope) {
      // Progress, or a reply with nothing wrong with it: the next slip is a slip.
      reset();
      return undefined;
    }

    if (consecutive >= MAX_CONSECUTIVE_RESCUES) {
      if (!gaveUp && ctx.hasUI) {
        gaveUp = true;
        ctx.ui.notify(
          `toolcall-rescue: giving up after ${MAX_CONSECUTIVE_RESCUES} malformed tool calls in a row. ` +
            `The model keeps writing ${envelope.dialect} envelopes as text; send a message to restart, or switch model.`,
          "warning",
        );
      }
      return undefined;
    }

    consecutive += 1;
    counters.rescued += 1;
    counters.last = { dialect: envelope.dialect, names: envelope.calls.map((call) => call.name).join(", ") || "(none)" };

    const tools = pi.getActiveTools?.() ?? [];
    if (ctx.hasUI) {
      const what = envelope.calls.map((call) => call.name).join(", ") || "an unnamed call";
      ctx.ui.notify(`toolcall-rescue: ${what} was written as ${envelope.dialect} text; asked for a real call`, "warning");
    }

    return {
      entries: [
        ...event.entries,
        { type: "context_edit", targetId: event.messageEntryId, replacement: RESCUE_REPLACEMENT },
        {
          type: "custom_message",
          customType: "toolcall-rescue",
          content: renderRescue(envelope, tools),
          display: false,
        },
      ],
      // The point of the extension: the turn pi read as finished is not finished.
      continue: true,
    };
  });

  pi.registerCommand("toolcall-rescue", {
    description: "Report how many tool calls written as text were rescued this session",
    handler: async (_args, ctx) => {
      if (counters.rescued === 0) {
        ctx.ui.notify("toolcall-rescue: nothing rescued this session.", "info");
        return;
      }
      const last = counters.last ? ` Last: \`${counters.last.names}\` as ${counters.last.dialect}.` : "";
      ctx.ui.notify(`toolcall-rescue: ${counters.rescued} malformed tool call(s) rescued.${last}`, "info");
    },
  });
}
