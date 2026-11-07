/**
 * loop.ts — `/loop`: session-scoped recurring prompts, with a persistent footer
 * call-out showing how many loops are armed and when the next one fires.
 *
 * Ported from Claude Code's bundled `/loop` skill (2.1.x), which is the one
 * recurring-work surface that behaves well in a terminal: the loop re-enters the
 * *live session* as a user message, so it inherits the conversation, the model,
 * and the tools — unlike a scheduled subagent, which starts cold. That
 * distinction is the whole point:
 *
 *   /loop      a prompt re-entering this session, dies with the session
 *   subagents  `Agent(schedule:)` — a job that spawns a fresh subagent per fire
 *
 * Two modes, exactly as Claude's skill defines them:
 *
 *   fixed    `/loop 5m check the deploy` — a timer at a fixed interval.
 *   dynamic  `/loop check the deploy`    — no timer. The model self-paces by
 *            calling the `ScheduleWakeup` tool at the end of each turn; a tick
 *            that neither reschedules nor stops gets one fallback wakeup, and
 *            the loop ends when that tick is also silent.
 *
 * Behaviour carried over on purpose (each is a lesson Claude's version encodes):
 *
 *   - Fires land between turns. A loop that came due mid-response waits for the
 *     turn to end; it never steers a turn that is already in flight.
 *   - No catch-up. N missed fires become one fire, not N.
 *   - Recurring loops expire 7 days after creation: one final fire, then gone.
 *     A forgotten loop cannot run forever.
 *   - The first iteration runs immediately at creation rather than waiting for
 *     the first timer tick.
 *   - `/loop` with no prompt falls back to `.pi/loop.md` (project) then
 *     `~/.pi/agent/loop.md` (user), capped at 25 KB.
 *
 * Deliberate differences from Claude:
 *
 *   - The footer gets a real persistent segment (`◷ 1 loop · next in 4m 30s`)
 *     instead of a per-call tool row. Claude's REPL has no persistent scheduled
 *     counter in 2.1.316; pi's `setStatus` does.
 *   - Intervals are millisecond timers, so sub-minute cadences work as written
 *     instead of being rounded up to cron's one-minute granularity. The floor is
 *     still 60 s, because a sub-minute loop is a busy-wait with extra tokens.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────────────

/** A loop faster than this is a busy-wait; Claude's cron floor is the same. */
export const MIN_INTERVAL_MS = 60_000;
/** `ScheduleWakeup` clamps here, like Claude's [60, 3600]. */
export const MIN_WAKEUP_SECONDS = 60;
export const MAX_WAKEUP_SECONDS = 3600;
/** Recurring loops expire: one final fire, then self-delete. */
export const LOOP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A tick that neither reschedules nor stops gets this one grace wakeup. */
export const FALLBACK_WAKEUP_MS = 20 * 60 * 1000;
export const MAX_LOOPS = 50;
/** loop.md past this is truncated — it lands in every tick's context. */
export const MAX_LOOP_FILE_BYTES = 25_000;
/** Footer refresh cadence: the countdown is the feature, so this is per-second. */
const TICK_MS = 1000;
/** Status key. The footer reads extension statuses generically, so any key works. */
const STATUS_KEY = "loop";

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const UNIT_WORDS: Record<string, number> = {
  second: 1000,
  seconds: 1000,
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
};

// ── Types ────────────────────────────────────────────────────────────────────

export type LoopMode = "fixed" | "dynamic";

export type ParsedLoop =
  | { ok: true; mode: "fixed"; prompt: string; intervalMs: number; intervalText: string }
  | { ok: true; mode: "dynamic"; prompt: string }
  /** `/loop 5m` — a cadence with no prompt, which resolves to loop.md or usage. */
  | { ok: true; mode: "interval-only"; intervalMs: number; intervalText: string }
  | { ok: false; error: string };

export type LoopJob = {
  id: string;
  prompt: string;
  mode: LoopMode;
  /** Fixed loops only. */
  intervalMs?: number;
  /** Epoch ms of the next fire; undefined while a dynamic loop awaits its wakeup. */
  nextAt?: number;
  createdAt: number;
  expiresAt: number;
  runs: number;
  lastRunAt?: number;
  /** Consecutive `noop: true` ticks, surfaced in the footer so quiet holds stay legible. */
  quietStreak: number;
  /** Set once a due fire is waiting for the current turn to end. */
  pending: boolean;
  /** The reason the model gave for its last self-paced delay. */
  wakeupReason?: string;
  /** A dynamic loop gets exactly one fallback wakeup before it ends. */
  fallbackArmed: boolean;
};

/** What the footer needs, so formatting stays pure and testable. */
export type LoopFooterView = {
  mode: LoopMode;
  nextAt?: number;
  quietStreak: number;
};

// ── Parsing (pure) ───────────────────────────────────────────────────────────

/** `5m` → 300000. Bare interval tokens only (`^N[smhd]$`). */
export function parseIntervalToken(token: string): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(token.trim());
  if (!match) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  return ms > 0 ? ms : undefined;
}

/**
 * Parse `/loop` arguments into a mode, an interval, and a prompt.
 *
 * Priority order is Claude's, and the order matters:
 *   1. leading interval token   `5m /babysit-prs`
 *   2. trailing "every" clause  `check the deploy every 20m`
 *   3. otherwise dynamic        `check the deploy`
 *
 * Rule 2 only matches when what follows "every" is a time expression, so
 * `check every PR` stays a dynamic loop with its prompt intact.
 */
export function parseLoopInput(raw: string): ParsedLoop {
  const input = raw.trim();
  if (!input) return { ok: false, error: "empty" };

  // 0. An interval with nothing after it: the cadence still means something, but
  // the prompt has to come from loop.md. Treating the token as the prompt (rule
  // 3) would ask the model to "do 5m".
  const intervalOnly = parseIntervalToken(input);
  if (intervalOnly !== undefined) {
    return { ok: true, mode: "interval-only", intervalMs: intervalOnly, intervalText: input };
  }

  // 1. Leading interval token.
  const leading = /^(\S+)\s+([\s\S]+)$/.exec(input);
  if (leading) {
    const intervalMs = parseIntervalToken(leading[1]);
    if (intervalMs !== undefined) {
      return { ok: true, mode: "fixed", prompt: leading[2].trim(), intervalMs, intervalText: leading[1] };
    }
  }

  // 2. Trailing "every <N><unit>" / "every <N> <unit word>" clause.
  const trailing = /^([\s\S]+?)\s+every\s+(\d+)\s*(s|m|h|d|seconds?|minutes?|hours?|days?)$/i.exec(input);
  if (trailing) {
    const unit = trailing[3].toLowerCase();
    const unitMs = UNIT_MS[unit] ?? UNIT_WORDS[unit];
    const prompt = trailing[1].trim();
    if (unitMs && prompt) {
      const intervalMs = Number(trailing[2]) * unitMs;
      if (intervalMs > 0) {
        return {
          ok: true,
          mode: "fixed",
          prompt,
          intervalMs,
          intervalText: `${trailing[2]}${unit.length === 1 ? unit : ` ${unit}`}`,
        };
      }
    }
  }

  // 3. No interval: the whole input is the prompt, self-paced.
  return { ok: true, mode: "dynamic", prompt: input };
}

// ── Formatting (pure) ────────────────────────────────────────────────────────

/** `270000` → `4m 30s`. Deliberately coarse: this is a footer, not a stopwatch. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/**
 * The persistent footer segment. Undefined when nothing is armed, which is the
 * signal to clear the status rather than render an empty one.
 *
 *   ◷ 1 loop · next in 4m 30s
 *   ◷ 2 loops · next in 12s · quiet ×3
 *   ◷ 1 loop · running
 */
export function formatFooter(views: readonly LoopFooterView[], now: number): string | undefined {
  if (views.length === 0) return undefined;
  const count = views.length === 1 ? "1 loop" : `${views.length} loops`;
  const nextAt = views.reduce<number | undefined>((soonest, view) => {
    if (view.nextAt === undefined) return soonest;
    return soonest === undefined || view.nextAt < soonest ? view.nextAt : soonest;
  }, undefined);
  const parts = [`◷ ${count}`];
  // A dynamic loop mid-turn has no armed wakeup yet: "running" is honest, where
  // "next in 0s" would not be.
  parts.push(nextAt === undefined ? "running" : `next in ${formatDuration(Math.max(0, nextAt - now))}`);
  const quiet = Math.max(0, ...views.map((view) => view.quietStreak));
  if (quiet >= 2) parts.push(`quiet ×${quiet}`);
  return parts.join(" · ");
}

/** `1h 2m` for a loop's cadence in listings. */
export function formatInterval(intervalMs: number): string {
  return `every ${formatDuration(intervalMs)}`;
}

/**
 * Advance a fixed loop's next fire.
 *
 * No catch-up: when the timer came due while a turn was running, the next slot
 * is one interval after *now*, not one interval after the missed slot — otherwise
 * a long turn would queue a burst of fires to drain afterwards.
 */
export function nextFixedRun(previousNextAt: number, now: number, intervalMs: number): number {
  const drifted = previousNextAt + intervalMs;
  return drifted > now ? drifted : now + intervalMs;
}

/** Clamp a self-paced delay into Claude's [60, 3600] window. */
export function clampWakeupSeconds(value: unknown): { seconds?: number; clamped: boolean; error?: string } {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { clamped: false, error: "`delaySeconds` must be a positive number." };
  }
  const rounded = Math.round(value);
  const seconds = Math.min(MAX_WAKEUP_SECONDS, Math.max(MIN_WAKEUP_SECONDS, rounded));
  return { seconds, clamped: seconds !== rounded };
}

/** `14:03:12` — the same shape Claude's `ScheduleWakeup` result reports. */
export function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toTimeString().slice(0, 8);
}

export type SettleDecision = "wait" | "arm-fallback" | "end-loop";

/**
 * What a settled turn means for a self-paced loop.
 *
 * A turn that ends with a wakeup armed is a loop that chose to continue. A turn
 * that ends silent is ambiguous — the model may simply have forgotten — so the
 * first one buys a single grace wakeup and the second ends the loop. A loop that
 * never ran has nothing to judge yet.
 */
export function decideDynamicSettle(input: {
  stopped: boolean;
  runs: number;
  nextAt: number | undefined;
  fallbackArmed: boolean;
}): SettleDecision {
  if (input.stopped) return "wait";
  if (input.nextAt !== undefined) return "wait";
  if (input.runs === 0) return "wait";
  return input.fallbackArmed ? "end-loop" : "arm-fallback";
}

// ── Extension ────────────────────────────────────────────────────────────────

type Job = LoopJob & { stopped: boolean };

function newJobId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, Job>();
  let ticker: NodeJS.Timeout | undefined;
  let uiCtx: ExtensionContext | undefined;
  /** The model's `ScheduleWakeup` prompt override applies to the next fire only. */
  let nextPromptOverride: string | undefined;

  const dynamicJob = (): Job | undefined => [...jobs.values()].find((job) => job.mode === "dynamic");

  function updateFooter(): void {
    if (!uiCtx?.hasUI) return;
    const views: LoopFooterView[] = [...jobs.values()].map((job) => ({
      mode: job.mode,
      nextAt: job.nextAt,
      quietStreak: job.quietStreak,
    }));
    uiCtx.ui.setStatus(STATUS_KEY, formatFooter(views, Date.now()));
  }

  function ensureTicker(): void {
    if (ticker || jobs.size === 0) return;
    ticker = setInterval(tick, TICK_MS);
    // Why: a live interval would hold the process open on a clean exit; pi owns
    // its own lifetime, this timer should not extend it.
    ticker.unref?.();
  }

  function stopTickerIfIdle(): void {
    if (jobs.size > 0 || !ticker) return;
    clearInterval(ticker);
    ticker = undefined;
  }

  function removeJob(job: Job): void {
    jobs.delete(job.id);
    stopTickerIfIdle();
    updateFooter();
  }

  /** Inject the loop's prompt as a user message. Only ever called while idle. */
  function fire(job: Job): void {
    const now = Date.now();
    // Only a self-paced loop can carry an override, and there is at most one of
    // them, so the override never has to be matched back to a job.
    const prompt = job.mode === "dynamic" && nextPromptOverride ? nextPromptOverride : job.prompt;
    nextPromptOverride = undefined;

    job.runs += 1;
    job.lastRunAt = now;
    job.pending = false;
    if (job.mode === "fixed" && job.intervalMs) {
      job.nextAt = nextFixedRun(job.nextAt ?? now, now, job.intervalMs);
    } else {
      // A dynamic loop has no armed wakeup until the model schedules one at the
      // end of this turn; `agent_settled` is what turns that silence into either
      // a fallback wakeup or the loop's end.
      job.nextAt = undefined;
    }

    // Expiry: the final fire still happens, then the loop is gone.
    if (now >= job.expiresAt) {
      removeJob(job);
      if (uiCtx?.hasUI) uiCtx.ui.notify(`Loop expired after 7 days: "${truncate(prompt)}"`, "info");
    } else {
      updateFooter();
    }

    pi.sendUserMessage(prompt);
  }

  function tick(): void {
    const now = Date.now();
    for (const job of [...jobs.values()]) {
      if (job.stopped) continue;
      if (job.nextAt !== undefined && job.nextAt <= now) job.pending = true;
    }
    updateFooter();
    drain();
  }

  /** Fire every due loop, one per idle window, never mid-turn. */
  function drain(): void {
    if (!uiCtx) return;
    if (!uiCtx.isIdle()) return;
    const due = [...jobs.values()]
      .filter((job) => job.pending && !job.stopped)
      .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))[0];
    if (!due) return;
    fire(due);
  }

  function addJob(job: Job): void {
    jobs.set(job.id, job);
    ensureTicker();
    updateFooter();
  }

  function makeJob(mode: LoopMode, prompt: string, intervalMs?: number): Job {
    const now = Date.now();
    return {
      id: newJobId(),
      prompt,
      mode,
      intervalMs,
      nextAt: mode === "fixed" ? now : undefined,
      createdAt: now,
      expiresAt: now + LOOP_TTL_MS,
      runs: 0,
      quietStreak: 0,
      pending: false,
      fallbackArmed: false,
      stopped: false,
    };
  }

  function describe(job: Job): string {
    const cadence = job.mode === "fixed" && job.intervalMs ? formatInterval(job.intervalMs) : "self-paced";
    const next =
      job.nextAt === undefined
        ? "awaiting wakeup"
        : `next in ${formatDuration(Math.max(0, job.nextAt - Date.now()))}`;
    const expiresIn = formatDuration(Math.max(0, job.expiresAt - Date.now()));
    return `◷ ${job.id} · ${cadence} · ${next} · runs ${job.runs} · expires in ${expiresIn} · "${truncate(job.prompt)}"`;
  }

  /** `.pi/loop.md` (project) wins over `~/.pi/agent/loop.md` (user), like Claude. */
  function readLoopFile(cwd: string): { path: string; content: string } | undefined {
    for (const path of [join(cwd, ".pi", "loop.md"), join(homedir(), ".pi", "agent", "loop.md")]) {
      try {
        if (!existsSync(path) || !statSync(path).isFile()) continue;
        const raw = readFileSync(path, "utf8");
        const content = raw.length > MAX_LOOP_FILE_BYTES ? raw.slice(0, MAX_LOOP_FILE_BYTES) : raw;
        if (content.trim()) return { path, content: content.trim() };
      } catch {
        // An unreadable loop.md is not worth failing /loop over; try the next one.
      }
    }
    return undefined;
  }

  // ── Tool: ScheduleWakeup ───────────────────────────────────────────────────

  pi.registerTool({
    name: "ScheduleWakeup",
    label: "Schedule Wakeup",
    description:
      "Schedule when to resume work in /loop dynamic mode. Call it at the end of each turn to keep a self-paced loop alive; call it with `stop: true` to end the loop immediately.",
    promptSnippet: "Self-pace a dynamic /loop by scheduling the next iteration, or end it with stop",
    promptGuidelines: [
      "Use ScheduleWakeup only when a /loop was created without an interval (dynamic mode); a fixed-interval loop arms itself and does not need it.",
      "Call ScheduleWakeup as the last thing in a dynamic loop's turn: without it the loop falls back to one 20-minute wakeup and then ends.",
      "Prefer delays of 1200-1800 seconds when the tick is a quiet check, and under 270 seconds only when actively polling something that changes quickly.",
      "Use ScheduleWakeup with `stop: true` when the loop's work is finished; do not keep a loop alive to keep watching.",
    ],
    parameters: Type.Object({
      delaySeconds: Type.Optional(
        Type.Number({ description: "Seconds until the next iteration. Clamped to [60, 3600]. Required unless stop is true." }),
      ),
      reason: Type.Optional(Type.String({ description: "One short sentence on why this delay was chosen." })),
      prompt: Type.Optional(
        Type.String({ description: "Prompt for the next iteration. Omit to re-use the loop's own prompt." }),
      ),
      noop: Type.Optional(
        Type.Boolean({ description: "true when this tick changed nothing worth keeping; consecutive noops collapse in the footer." }),
      ),
      stop: Type.Optional(Type.Boolean({ description: "End the dynamic loop immediately instead of scheduling another wakeup." })),
    }),
    async execute(_toolCallId, params) {
      const job = dynamicJob();

      if (params.stop === true) {
        if (!job) {
          return text(
            "Loop stopped — there was no dynamic loop running in this session. If a fixed-interval /loop is running, stop it with `/loop stop`.",
          );
        }
        job.stopped = true;
        removeJob(job);
        return text(`Loop stopped — "${truncate(job.prompt)}" will not fire again.`);
      }

      if (!job) {
        return text(
          "Wakeup not scheduled — no dynamic loop is running. ScheduleWakeup only drives a /loop created without an interval; a fixed-interval loop arms its own timer.",
        );
      }

      const clamped = clampWakeupSeconds(params.delaySeconds);
      if (clamped.seconds === undefined) {
        return text(`Wakeup not scheduled — ${clamped.error}`);
      }
      if (typeof params.reason !== "string" || !params.reason.trim()) {
        return text("Wakeup not scheduled — `reason` is required when scheduling another wakeup.");
      }

      const now = Date.now();
      job.nextAt = now + clamped.seconds * 1000;
      job.wakeupReason = params.reason.trim();
      job.fallbackArmed = false;
      job.pending = false;
      job.quietStreak = params.noop === true ? job.quietStreak + 1 : 0;
      if (typeof params.prompt === "string" && params.prompt.trim()) {
        nextPromptOverride = params.prompt.trim();
      }
      ensureTicker();
      updateFooter();

      const clampNote = clamped.clamped ? `, clamped from ${Math.round(params.delaySeconds as number)}s` : "";
      return text(
        `Next wakeup scheduled for ${formatClockTime(job.nextAt)} (in ${clamped.seconds}s${clampNote}). Reason: ${job.wakeupReason}`,
      );
    },
  });

  // ── Command: /loop ─────────────────────────────────────────────────────────

  pi.registerCommand("loop", {
    description: "Run a prompt repeatedly in this session: /loop [interval] <prompt> · /loop list · /loop stop [id|all]",
    getArgumentCompletions: (prefix: string) => {
      const values = ["list", "stop", "stop all", "5m", "10m", "30m", "1h"];
      const items = values
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const input = args.trim();
      const [head, ...rest] = input.split(/\s+/);

      if (head === "list" || (!input && jobs.size > 0)) {
        if (jobs.size === 0) {
          ctx.ui.notify("No loops running.", "info");
          return;
        }
        for (const job of jobs.values()) ctx.ui.notify(describe(job), "info");
        return;
      }

      if (head === "stop") {
        const target = rest.join(" ").trim();
        if (jobs.size === 0) {
          ctx.ui.notify("No loops running.", "info");
          return;
        }
        if (!target || target === "all") {
          const count = jobs.size;
          for (const job of [...jobs.values()]) {
            job.stopped = true;
            jobs.delete(job.id);
          }
          stopTickerIfIdle();
          updateFooter();
          ctx.ui.notify(`Stopped ${count} loop${count === 1 ? "" : "s"}.`, "info");
          return;
        }
        const job = jobs.get(target);
        if (!job) {
          ctx.ui.notify(`No loop with id "${target}". Try /loop list.`, "warning");
          return;
        }
        job.stopped = true;
        removeJob(job);
        ctx.ui.notify(`Stopped loop ${target}.`, "info");
        return;
      }

      // Bare `/loop` falls back to loop.md, then to usage.
      let parsed: ParsedLoop;
      if (!input) {
        const file = readLoopFile(ctx.cwd);
        if (!file) {
          ctx.ui.notify(
            "Usage: /loop [interval] <prompt> · e.g. /loop 5m check the deploy, or /loop check the deploy for a self-paced loop. No .pi/loop.md to fall back on.",
            "info",
          );
          return;
        }
        parsed = { ok: true, mode: "dynamic", prompt: file.content };
      } else {
        parsed = parseLoopInput(input);
      }

      if (!parsed.ok) {
        ctx.ui.notify("Usage: /loop [interval] <prompt>", "info");
        return;
      }

      // `/loop 5m` with no prompt takes its prompt from loop.md, at that cadence.
      // Without a loop.md there is nothing to run, and inventing a prompt is not
      // this command's job — say so instead.
      if (parsed.mode === "interval-only") {
        const file = readLoopFile(ctx.cwd);
        if (!file) {
          ctx.ui.notify(
            `/loop ${parsed.intervalText} needs a prompt: /loop ${parsed.intervalText} <prompt>. A bare cadence runs .pi/loop.md or ~/.pi/agent/loop.md, and neither exists.`,
            "warning",
          );
          return;
        }
        parsed = { ok: true, mode: "fixed", prompt: file.content, intervalMs: parsed.intervalMs, intervalText: parsed.intervalText };
      }

      if (jobs.size >= MAX_LOOPS) {
        ctx.ui.notify(`Too many loops (${MAX_LOOPS} max). Stop one with /loop stop.`, "warning");
        return;
      }

      if (parsed.mode === "dynamic" && dynamicJob()) {
        ctx.ui.notify(
          "A self-paced loop is already running. Stop it first (/loop stop) or give this one an interval: /loop 5m <prompt>.",
          "warning",
        );
        return;
      }

      let intervalMs: number | undefined;
      if (parsed.mode === "fixed") {
        intervalMs = parsed.intervalMs;
        if (intervalMs < MIN_INTERVAL_MS) {
          ctx.ui.notify(
            `${parsed.intervalText} is below the ${formatDuration(MIN_INTERVAL_MS)} floor; using ${formatDuration(MIN_INTERVAL_MS)}.`,
            "warning",
          );
          intervalMs = MIN_INTERVAL_MS;
        }
      }

      const job = makeJob(parsed.mode, parsed.prompt, intervalMs);
      addJob(job);
      const cadence = parsed.mode === "fixed" ? formatInterval(intervalMs as number) : "self-paced";
      ctx.ui.notify(
        `Loop ${job.id} armed · ${cadence} · expires in 7 days · stop with /loop stop ${job.id}. Running the first iteration now.`,
        "info",
      );
      // Claude runs the first iteration immediately instead of waiting for the
      // first timer tick; a loop you cannot see start is a loop you cannot trust.
      fire(job);
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    // Loops are session-scoped by design (Claude restores only on --resume), so
    // a new session starts empty and a stale footer segment is cleared here.
    updateFooter();
  });

  pi.on("turn_end", async (_event, ctx) => {
    uiCtx = ctx;
    drain();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    uiCtx = ctx;
    const job = dynamicJob();
    if (job) {
      const decision = decideDynamicSettle(job);
      if (decision === "arm-fallback") {
        // The turn ended without a ScheduleWakeup call. One grace wakeup keeps a
        // loop alive across a turn that simply forgot to reschedule; a second
        // silent turn means the model is done with it.
        job.fallbackArmed = true;
        job.nextAt = Date.now() + FALLBACK_WAKEUP_MS;
        job.wakeupReason = "fallback (no wakeup scheduled last turn)";
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Self-paced loop ${job.id} did not reschedule; one fallback wakeup in ${formatDuration(FALLBACK_WAKEUP_MS)}. It ends if that turn is also silent.`,
            "info",
          );
        }
      } else if (decision === "end-loop") {
        job.stopped = true;
        removeJob(job);
        if (ctx.hasUI) ctx.ui.notify(`Self-paced loop ${job.id} ended: two ticks in a row did not reschedule.`, "info");
      }
    }
    updateFooter();
    drain();
  });

  pi.on("session_shutdown", async () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    jobs.clear();
    uiCtx = undefined;
  });
}

// ── Small helpers ────────────────────────────────────────────────────────────

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: { result: value } };
}

function truncate(value: string, max = 60): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
