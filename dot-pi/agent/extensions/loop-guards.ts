/**
 * loop-guards.ts — stop the two tool calls that spend a whole turn to learn nothing.
 *
 * Both guards come from measured session history rather than taste. Across 785
 * sessions (62.8k turns) on this machine:
 *
 *   - 314 `sleep` calls burned 26.1 hours of literal wall-clock, each one inside a
 *     turn that re-read ~212k prompt tokens to discover nothing changed. 122 of them
 *     were in the recent (November) window alone, so this is current behaviour, not
 *     an artefact of old models.
 *   - The guard that was meant to catch them caught none: over the 2026-11-24 release
 *     session (86 minutes of it spent inside `sleep`), `grep -c loop-guards` on the
 *     transcript returned 0. All 17 sleeps were shaped
 *     `cd /Volumes/.../main && sleep 480; git status --porcelain | head -8`, and the
 *     parser only matched a `sleep` in the very first token. A guard that only sees
 *     the shape the model rarely writes is a guard that does not run.
 *   - 352 `get_subagent_result` calls, of which 184 came back "still running" and 143
 *     were bare `{}` polls. Pi notifies on completion, so a non-waiting poll is a turn
 *     spent asking a question whose answer arrives by itself.
 *
 * Neither guard guesses. A short `sleep` is left alone, a `sleep` that gates real work
 * is clamped rather than deleted, and the agent is told what happened in the tool
 * result it reads next. The point is to convert silent wall-clock burn into a visible,
 * correctable habit — and to make the correct call (`wait: true`) the one that runs.
 *
 * Everything here is a pure function over the tool arguments so `node --test` can
 * exercise it without a session; the only import is type-only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A `sleep` longer than this, in front of a command, is clamped to this. */
export const MAX_SLEEP_SECONDS = 120;

/** A bare `sleep` (nothing after it) longer than this is refused outright. */
export const MAX_BARE_SLEEP_SECONDS = 30;

/** Longest agent id we accept before declining to force a wait. */
const MAX_AGENT_ID = 200;

export interface SleepParse {
  /** How long the command would sleep, in seconds. */
  seconds: number;
  /** What runs after the sleep, without its separator. Empty for a bare sleep. */
  rest: string;
  /**
   * Everything before `sleep`, verbatim and including its separator, so a rewrite can put
   * the command back exactly where it was. Empty when `sleep` is the first token.
   */
  prefix: string;
}

/**
 * Statements that position the shell without changing what runs next. Each pattern keeps
 * its own separator, and they may chain in any order (`cd /x && set -e; A=1 && sleep 60`).
 * A wrapper is deliberately absent: `timeout 30 sleep 900` and `bash -c "sleep 900"` put
 * the sleep inside a program, where the delay is the program's business, not a stand-in
 * for a wait.
 */
const NOOP_PREFIXES: RegExp[] = [
  // cd <path> &&  /  cd <path>;
  /^[ \t]*cd[ \t]+(?:"[^"]*"|'[^']*'|[^\s;&|]+)[ \t]*(?:&&|;|\n)[ \t]*/,
  // a leading `true &&`
  /^[ \t]*true[ \t]*(?:&&|;|\n)[ \t]*/,
  // set -e;  /  set -euo pipefail;
  /^[ \t]*set[ \t]+-[A-Za-z]+[ \t]*(?:&&|;|\n)[ \t]*/,
  // FOO=1 &&  /  export A=1 B=2;  /  ORCA_QUEUE=off &&
  /^[ \t]*(?:(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|"']*)[ \t]*)+(?:&&|;|\n)[ \t]*/,
];

/** Split a command into the no-op prefixes it opens with and the statement that follows. */
function stripNoopPrefixes(command: string): { prefix: string; body: string } {
  let prefix = "";
  let body = command;
  for (;;) {
    const match = NOOP_PREFIXES.map((pattern) => pattern.exec(body)).find((m) => m !== null && m[0].length > 0);
    if (!match) break;
    prefix += match[0];
    body = body.slice(match[0].length);
  }
  return { prefix, body };
}

/**
 * Parse a command whose first statement is `sleep`, behind any chain of no-op prefixes.
 * Returns null when `sleep` is not the leading statement, so a sleep buried in a pipeline,
 * a loop body or a `timeout`/`bash -c` wrapper is untouched: there the sleep is part of the
 * program, not a stand-in for a wait.
 *
 * GNU/macOS `sleep` accept an `s`/`m`/`h` suffix; commands are usually separated by
 * `;` or `&&`, but models also emit a newline (seen in the transcripts), so both count.
 */
export function parseLeadingSleep(command: string): SleepParse | null {
  const { prefix, body } = stripNoopPrefixes(command);
  const match = /^[ \t]*sleep[ \t]+(\d+(?:\.\d+)?)([smhSMH]?)[ \t]*([\s\S]*)$/.exec(body);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60 : unit === "h" ? 3600 : 1;
  const seconds = Number(match[1]) * multiplier;
  if (!Number.isFinite(seconds)) return null;
  // Strip the separator that introduced whatever follows: `;`, `&&`, or a newline.
  const rest = match[3].replace(/^(?:[ \t]*(?:&&|;|\|\|)[ \t]*|[ \t]*\n[ \t]*)/, "");
  return { seconds, rest: rest.trim(), prefix };
}

export type SleepVerdict =
  | { action: "allow" }
  | { action: "rewrite"; command: string; note: string }
  | { action: "block"; reason: string };

/**
 * Decide what to do with a `sleep`-led command.
 *
 * - No leading sleep, or a sleep short enough to be a deliberate settle: allowed.
 * - Bare sleep longer than MAX_BARE_SLEEP_SECONDS: blocked. Nothing follows it, so the
 *   turn exists only to wait — the one shape that is unambiguously a wasted turn.
 * - Sleep longer than MAX_SLEEP_SECONDS gating real work: clamped, keeping the work.
 *   The command still runs; only the dead time is cut.
 */
export function guardSleep(command: string): SleepVerdict {
  const parsed = parseLeadingSleep(command);
  if (!parsed) return { action: "allow" };
  const { seconds, rest, prefix } = parsed;
  if (!Number.isFinite(seconds) || seconds <= 0) return { action: "allow" };

  if (rest.length === 0) {
    if (seconds <= MAX_BARE_SLEEP_SECONDS) return { action: "allow" };
    return {
      action: "block",
      reason:
        `loop-guards blocked \`sleep ${formatSeconds(seconds)}\`: nothing follows it, so this turn would only wait. ` +
        `You are almost always waiting for something you can test: run one bounded poll ` +
        `(\`for i in $(seq 60); do <check> && break; sleep 2; done\`) with a \`timeout\`, or if this is a ` +
        `subagent call get_subagent_result with wait: true. If a fixed delay is genuinely required, ` +
        `sleep ${MAX_BARE_SLEEP_SECONDS} or less and say why.`,
    };
  }

  if (seconds <= MAX_SLEEP_SECONDS) return { action: "allow" };
  return {
    action: "rewrite",
    command: `${prefix}sleep ${MAX_SLEEP_SECONDS}; ${rest}`,
    note:
      `loop-guards clamped \`sleep ${formatSeconds(seconds)}\` to ${MAX_SLEEP_SECONDS}s. ` +
      `The command after it still ran, immediately after the clamp. ` +
      `A fixed delay cannot confirm anything changed — prefer a bounded poll that exits on the condition, ` +
      `or get_subagent_result with wait: true.`,
  };
}

/**
 * A non-waiting `get_subagent_result` for a named agent is a poll, and Pi delivers the
 * same answer by notification. Forcing the wait turns the poll into the thing the model
 * actually wants. Calls with no agent id (a fleet status listing) are left alone, since
 * waiting on "whichever agent" has no defined completion.
 */
export function shouldForceSubagentWait(input: Record<string, unknown> | undefined): boolean {
  if (!input) return false;
  if (input.wait === true) return false;
  const id = input.agent_id ?? input.agentId;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_AGENT_ID;
}

function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export interface GuardCounters {
  sleepsBlocked: number;
  sleepsClamped: number;
  pollsForced: number;
}

function newCounters(): GuardCounters {
  return { sleepsBlocked: 0, sleepsClamped: 0, pollsForced: 0 };
}

function describeCounters(c: GuardCounters): string {
  const total = c.sleepsBlocked + c.sleepsClamped + c.pollsForced;
  if (total === 0) return "loop-guards: no guards fired this session.";
  return (
    `loop-guards (this session): ${c.sleepsBlocked} bare sleep(s) blocked, ` +
    `${c.sleepsClamped} sleep(s) clamped, ${c.pollsForced} subagent poll(s) forced to wait.`
  );
}

export default function (pi: ExtensionAPI) {
  const counters = newCounters();
  /** toolCallId -> note to append to that call's result. */
  const pendingNotes = new Map<string, string>();

  const remember = (id: string, note: string) => {
    // Bounded: a long session must not accumulate notes for results that never arrive.
    if (pendingNotes.size > 64) pendingNotes.clear();
    pendingNotes.set(id, note);
  };

  pi.on("session_start", () => {
    Object.assign(counters, newCounters());
    pendingNotes.clear();
  });

  pi.on("session_shutdown", () => {
    pendingNotes.clear();
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "get_subagent_result") {
      const input = event.input as Record<string, unknown>;
      if (shouldForceSubagentWait(input)) {
        input.wait = true;
        counters.pollsForced += 1;
      }
      return undefined;
    }

    if (event.toolName !== "bash") return undefined;
    const input = event.input as { command?: string };
    if (typeof input.command !== "string" || !input.command) return undefined;

    const verdict = guardSleep(input.command);
    if (verdict.action === "block") {
      counters.sleepsBlocked += 1;
      return { block: true, reason: verdict.reason };
    }
    if (verdict.action === "rewrite") {
      input.command = verdict.command;
      counters.sleepsClamped += 1;
      remember(event.toolCallId, verdict.note);
      return undefined;
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return undefined;
    const note = pendingNotes.get(event.toolCallId);
    if (!note) return undefined;
    pendingNotes.delete(event.toolCallId);

    // Append to the trailing text block so any image content keeps its order.
    const content = [...event.content];
    const last = content.at(-1);
    if (last && last.type === "text") {
      content[content.length - 1] = { ...last, text: `${last.text}\n\n[loop-guards] ${note}` };
    } else {
      content.push({ type: "text", text: `[loop-guards] ${note}` });
    }
    return { content };
  });

  pi.on("before_agent_start", (event) => {
    // One standing rule, so the guard is a nudge rather than a surprise. Pi diffs prompt
    // sections and patches only what changed, so this does not invalidate the cache each turn.
    const guidelines = event.systemPromptOptions.promptGuidelines;
    const rule =
      "Never call bash `sleep` to wait for something: poll a condition with a bounded loop under a `timeout`, or use `get_subagent_result` with `wait: true`. A bare sleep spends a turn to learn nothing.";
    if (Array.isArray(guidelines) && !guidelines.includes(rule)) guidelines.push(rule);
    return undefined;
  });

  pi.registerCommand("loop-guards", {
    description: "Show what the sleep and subagent-poll guards have intercepted this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(describeCounters(counters), "info");
    },
  });
}
