/**
 * loop.ts — `/loop`: every recurring prompt in a session, with a persistent
 * footer call-out showing what is armed and when the next fire lands.
 *
 * Ported from Claude Code's bundled `/loop` skill (2.1.x), then widened: the
 * same command now drives two backends, because the choice between them is about
 * *where the tick runs*, not about which tool you reach for.
 *
 *   live    a timer re-enters this session as a user message, so the tick
 *           inherits the conversation, the model and the tools. The price is the
 *           main context: every tick re-sends the transcript, and the tick's own
 *           messages stay in it.
 *   cold    the job lives in pi-subagents' scheduler, which spawns a fresh
 *           subagent per fire. A context-free repeat pays for a small fresh
 *           context instead of a growing large one — cheaper even when prompt
 *           caching makes the live tick look nearly free.
 *
 * Both are session-scoped, both come back on `/resume`, and neither outlives the
 * session. That is why there is no durable flag here: persistence across
 * sessions is not a mode of this extension, it is a different product.
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
 *     turn to end; it never steers a turn that is already in flight. While it
 *     waits it is reported as due (footer and `list`), not as "next in 0s".
 *   - No catch-up. N missed fires become one fire, not N — but the N-1 are
 *     counted (`skipped`) and the fire records how late it was, so a laptop
 *     asleep through a 2-hourly job is visible rather than silent. The cadence
 *     stays anchored to its original phase instead of restarting from the late
 *     fire, so "every 2h" does not drift.
 *   - Unbounded recurring loops expire 7 days after creation: removed at the mark, and only a fire
 *     already waiting for the session still lands. A forgotten loop cannot run forever. A loop given
 *     `maxRuns` or `until` already has an end, so the TTL does not apply to it.
 *   - A loop pauses itself after `pauseAfterFailures` (default 3) failed fires in
 *     a row, so a broken loop stops billing every fire.
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

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  callRpc,
  coldNextAt,
  describeCold,
  EVENT_READY,
  EVENT_SCHEDULED,
  LIVE_CREATE,
  LIVE_LIST,
  LIVE_REMOVE,
  LIVE_RUN,
  LIVE_UPDATE,
  reduceColdJobs,
  RPC_CREATE,
  RPC_LIST,
  RPC_REMOVE,
  type ColdJob,
  type RpcEventBus,
} from "./shared/scheduled-rpc";

// ── Constants ────────────────────────────────────────────────────────────────

/** A loop faster than this is a busy-wait; Claude's cron floor is the same. */
export const MIN_INTERVAL_MS = 60_000;
/** `ScheduleWakeup` clamps here, like Claude's [60, 3600]. */
export const MIN_WAKEUP_SECONDS = 60;
export const MAX_WAKEUP_SECONDS = 3600;
/** Recurring loops expire: removed at the mark, so only a fire already waiting still lands. */
export const LOOP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A tick that neither reschedules nor stops gets this one grace wakeup. */
export const FALLBACK_WAKEUP_MS = 20 * 60 * 1000;
export const MAX_LOOPS = 50;
/** Fires kept per loop: enough to answer "what did it find lately", small enough to persist every fire. */
export const HISTORY_MAX = 10;
/** Failed fires in a row that pause a loop when the caller set no policy; `0` disables. */
export const DEFAULT_PAUSE_AFTER_FAILURES = 3;
/** A fire's summary is the head of its last reply — a pointer back into the transcript, not a copy. */
const SUMMARY_MAX = 280;
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

export type LoopMode = "fixed" | "dynamic" | "once";

/** One fire, as `get` reports it. */
export type FireRecord = {
  /** Epoch ms the fire was delivered. */
  at: number;
  /**
   * `running` until the fire's first turn ends; an error in any later turn of
   * the same fire sticks. `unknown` is a fire the session closed under.
   */
  outcome: "running" | "ok" | "error" | "unknown";
  error?: string;
  /** A `run` request, not the cadence. */
  manual?: boolean;
  /** How long after its slot it was delivered — a busy session or a sleeping machine. */
  lateMs?: number;
  /** Slots that passed unfired before this one, because there is no catch-up. */
  skipped?: number;
  /** Head of the fire's last assistant text. */
  summary?: string;
};

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
  /**
   * Set by a run-now request, cleared by the fire it causes.
   *
   * `nextFixedRun` advances from the *scheduled* slot, so a manual fire at 3:00
   * of a loop due at 3:20 would push the next fire to 3:45 and silently swallow
   * the 3:20 one. A manual fire is an extra iteration, not a replacement, so the
   * armed slot survives it. Transient on purpose: it describes one pending fire,
   * and a restart has nothing to carry it for.
   */
  manualRun?: boolean;
  /**
   * A paused loop keeps its id, its prompt and its cadence but arms nothing, so
   * it is neither running nor gone. Pausing is how a caller holds a repeat still
   * without forgetting what it said; resuming arms a fire immediately.
   */
  paused: boolean;
  /** Stop after this many fires; absent means repeat until cancelled or expired. */
  maxRuns?: number;
  /** Epoch ms after which it must not fire; absent means no stop time of its own. */
  until?: number;
  /**
   * What the last fire's turn ended as.
   *
   * Lives on the job rather than only in the transcript because a loop that is
   * failing every time otherwise looks identical to one that is working: `runs`
   * climbs either way, and a caller has no other way to notice.
   */
  lastOutcome?: "ok" | "error";
  lastError?: string;
  /** The reason the model gave for its last self-paced delay. */
  wakeupReason?: string;
  /** A dynamic loop gets exactly one fallback wakeup before it ends. */
  fallbackArmed: boolean;
  /** Slots that passed without a fire, across the loop's life (asleep, busy, or closed). */
  skipped: number;
  /** When the waiting fire came due; set only while `pending`. */
  dueSince?: number;
  /** Newest last, at most `HISTORY_MAX`. */
  history: FireRecord[];
  /** Failed fires in a row before it pauses itself; absent = the default, `0` = never. */
  pauseAfterFailures?: number;
  /** Failed fires since the last good one; reset by a good fire or a resume. */
  failureStreak: number;
  /** Why it is paused when nobody asked — the failure policy tripped. */
  pausedReason?: string;
};

/** What the footer needs, so formatting stays pure and testable. */
export type LoopFooterView = {
  /**
   * Which backend this entry came from. The two are counted separately because
   * they cost different things: a live tick pays the main context again, a cold
   * one pays for a fresh subagent session instead.
   */
  kind: "live" | "cold";
  mode: LoopMode;
  nextAt?: number;
  quietStreak: number;
  /** A paused entry arms nothing, which is why the countdown alone cannot say why. */
  paused?: boolean;
  /** Due, but held until the current turn ends. */
  due?: boolean;
};

// ── Parsing (pure) ───────────────────────────────────────────────────────────

/** `5m` → 300000. Bare interval tokens only (`^N[smhd]$`). */
export function parseIntervalToken(token: string): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(token.trim());
  if (!match) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  return ms > 0 ? ms : undefined;
}

function boundMaxRuns(value: unknown): number | undefined {
  // `0` is how a caller says "no bound", so it normalizes to absent rather than
  // being refused as an invalid count.
  if (value === undefined || value === 0) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("`maxRuns` must be a whole number of at least 1, or 0 to clear it.");
  }
  return value;
}

function boundPauseAfterFailures(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("`pauseAfterFailures` must be a whole number: N pauses after N failed fires in a row, 0 never pauses.");
  }
  return value;
}

function boundUntil(value: unknown, now: number): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined; // "" clears an existing stop time
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new Error('`until` must be an ISO timestamp, or "" to clear it.');
  if (at <= now) throw new Error(`\`until\` ${new Date(at).toISOString()} is in the past, so the loop would never fire.`);
  return at;
}

/**
 * A live loop's schedule: an interval (`5m`) or a one-shot (`+10m` / ISO).
 *
 * Cron is refused by name rather than rounded into something else. A live loop
 * re-enters this conversation, so a wall-clock expression spanning days would
 * fire into a transcript nobody is watching, and the cold backend already serves
 * that shape properly.
 */
export function parseLiveSchedule(
  text: string,
  now: number,
): { mode: "fixed"; intervalMs: number } | { mode: "once"; fireAt: number } | undefined {
  const token = text.trim();
  const interval = parseIntervalToken(token);
  // The floor is this extension's rule wherever the request comes from.
  if (interval !== undefined) return { mode: "fixed", intervalMs: Math.max(interval, MIN_INTERVAL_MS) };

  const relative = /^\+(\d+)([smhd])$/.exec(token);
  if (relative) {
    const fireAt = now + Number(relative[1]) * UNIT_MS[relative[2]];
    return fireAt > now ? { mode: "once", fireAt } : undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(token)) {
    const at = Date.parse(token);
    return Number.isNaN(at) || at <= now ? undefined : { mode: "once", fireAt: at };
  }

  return undefined;
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

/**
 * `--cold` selects the subagent backend and is stripped before the prompt is
 * read, so `--cold` never leaks into the text the model is asked to act on.
 * Deliberately position-independent: both `/loop 5m --cold x` and
 * `/loop 5m x --cold` mean the same thing.
 */
export function stripColdFlag(raw: string): { cold: boolean; input: string } {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const cold = tokens.includes("--cold");
  return { cold, input: tokens.filter((token) => token !== "--cold").join(" ") };
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
  const live = views.filter((view) => view.kind === "live").length;
  const cold = views.length - live;
  const nextAt = views.reduce<number | undefined>((soonest, view) => {
    // A paused entry arms nothing, whatever a stale `nextAt` says (a cold job's
    // stored next run outlives its timer). Counting it would print a countdown
    // for work nobody is waiting on.
    if (view.paused === true || view.due === true || view.nextAt === undefined) return soonest;
    return soonest === undefined || view.nextAt < soonest ? view.nextAt : soonest;
  }, undefined);
  const parts = [`◷ ${countLabel(live, cold)}`];
  // A due fire held behind a busy turn is its own state: "next in 0s" for a
  // minute reads as a stuck timer, when the truth is that the session is busy.
  const due = views.filter((view) => view.due === true && view.paused !== true).length;
  if (due > 0) parts.push(`${due} due · waiting for idle`);
  // A dynamic loop mid-turn has no armed wakeup yet: "running" is honest, where
  // "next in 0s" would not be. Every entry paused is a third state: nothing is
  // armed and nothing is in flight, and the roster explains the empty countdown.
  if (nextAt !== undefined) parts.push(`next in ${formatDuration(Math.max(0, nextAt - now))}`);
  else if (due === 0) parts.push(views.every((view) => view.paused === true) ? "paused" : "running");
  const quiet = Math.max(0, ...views.map((view) => view.quietStreak));
  if (quiet >= 2) parts.push(`quiet ×${quiet}`);
  return parts.join(" · ");
}

/** `1 loop · 1 job` — each backend named, and omitted when it has none. */
export function countLabel(live: number, cold: number): string {
  const parts: string[] = [];
  if (live > 0) parts.push(live === 1 ? "1 loop" : `${live} loops`);
  if (cold > 0) parts.push(cold === 1 ? "1 job" : `${cold} jobs`);
  return parts.join(" · ") || "nothing scheduled";
}

/** `1h 2m` for a loop's cadence in listings. */
export function formatInterval(intervalMs: number): string {
  return `every ${formatDuration(intervalMs)}`;
}

/**
 * Advance a fixed loop's next fire.
 *
 * No catch-up: a fire that comes late (a long turn, a sleeping laptop) is one
 * fire, and the slots it ran past are dropped rather than queued as a burst. The
 * next fire is the first slot *on the original phase* after now — not one
 * interval after the late fire, which made "every 2h" slide off the clock by
 * however late each fire happened to be.
 */
export function nextFixedRun(previousNextAt: number, now: number, intervalMs: number): number {
  return previousNextAt + (missedSlots(previousNextAt, now, intervalMs) + 1) * intervalMs;
}

/** Slots after `previousNextAt` that are already at or before `now` — the fires a late one stands in for. */
export function missedSlots(previousNextAt: number, now: number, intervalMs: number): number {
  if (!(intervalMs > 0) || now <= previousNextAt) return 0;
  return Math.floor((now - previousNextAt) / intervalMs);
}

/** The newest-last fire log, trimmed to `HISTORY_MAX`. */
export function pushHistory(history: readonly FireRecord[], record: FireRecord): FireRecord[] {
  return [...history, record].slice(-HISTORY_MAX);
}

/** The text a fire's turn ended with, collapsed to one line. Undefined for a tool-only turn. */
export function summarizeTurn(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => (part as { type?: unknown })?.type === "text")
            .map((part) => String((part as { text?: unknown }).text ?? ""))
            .join(" ")
        : "";
  const single = text.replace(/\s+/g, " ").trim();
  if (!single) return undefined;
  return single.length > SUMMARY_MAX ? `${single.slice(0, SUMMARY_MAX - 1)}…` : single;
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
 *
 * A paused loop is not silent, it was told to stop: pausing *is* an armed no-op,
 * so a settle decides nothing for it. Without this the next turn to end would
 * buy it a grace wakeup — the footer would grow a countdown for a loop that can
 * never fire, and the settle after that would end a loop the user only held.
 */
export function decideDynamicSettle(input: {
  stopped: boolean;
  paused?: boolean;
  runs: number;
  nextAt?: number;
  fallbackArmed: boolean;
}): SettleDecision {
  if (input.stopped) return "wait";
  if (input.paused === true) return "wait";
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
  /**
   * The cold backend, mirrored from pi-subagents' event stream. `/loop` owns no
   * timer for these: the scheduler does, and this map exists so one footer can
   * count both backends and `/loop list` can show them in one place.
   */
  let coldJobs = new Map<string, ColdJob>();
  /** Undefined when the host gives no event bus (tests, or an older pi). */
  const bus = (pi as { events?: RpcEventBus }).events;
  const unsubscribes: Array<() => void> = [];
  /** Subscriptions are per-activation; a second session_start must not double them. */
  let coldWired = false;
  /** Same guard for the channels this extension SERVES to the model. */
  let liveWired = false;

  const dynamicJob = (): Job | undefined => [...jobs.values()].find((job) => job.mode === "dynamic");

  /** A loop with an end of its own (`maxRuns` / `until`) is not forgotten, so the TTL backstop skips it. */
  const hasBound = (job: LoopJob): boolean => job.maxRuns !== undefined || job.until !== undefined;
  const isExpired = (job: LoopJob, now: number): boolean => !hasBound(job) && now >= job.expiresAt;

  /**
   * Pause or resume, in one place so the RPC, the failure policy and any future
   * caller mean the same thing. Pausing unarms; resuming re-arms the cadence.
   */
  function setPaused(job: Job, paused: boolean): void {
    job.paused = paused;
    job.pending = false;
    job.dueSince = undefined;
    job.manualRun = false;
    job.fallbackArmed = false;
    if (paused) {
      job.nextAt = undefined;
      return;
    }
    // A resume is the caller vouching for the loop again, so the failure policy
    // starts counting afresh rather than re-tripping on the next single error.
    job.pausedReason = undefined;
    job.failureStreak = 0;
    // Resuming re-arms the cadence, it does not fire: `run` is the verb for
    // "do it now", and the cold backend's resume means exactly this too
    // (its timer restarts one interval out). A self-paced loop has no cadence
    // to restart, so it is armed to fire and pace itself again.
    job.nextAt = job.mode === "fixed" && job.intervalMs ? Date.now() + job.intervalMs : Date.now();
  }

  /**
   * Publish every armed next fire, live and cold, so cache-keepalive can hold the
   * prompt cache across a settled wait. Cold fires count too: a cold run's result
   * is delivered as a steer message that triggers a turn in this session, so it
   * needs the cache just as a live tick does. Emitted only when the set changes,
   * because the ticker calls this every second.
   */
  let publishedLoopState = "";
  function publishLoopState(): void {
    if (!bus?.emit) return;
    const live = [...jobs.values()]
      .filter((job) => !job.stopped && job.nextAt !== undefined)
      .map((job) => ({ id: job.id, nextAt: job.nextAt }));
    const cold = [...coldJobs.values()]
      .filter((job) => job.enabled && coldNextAt(job) !== undefined)
      .map((job) => ({ id: job.id, nextAt: coldNextAt(job) }));
    const all = [...live, ...cold];
    const key = JSON.stringify(all);
    if (key === publishedLoopState) return;
    publishedLoopState = key;
    bus.emit("loop:state", { jobs: all });
  }

  function updateFooter(): void {
    // Every path that changes what is armed lands here, so this is the one place
    // that keeps the ticker in step with both backends — including the cold
    // events that never touch `jobs`.
    syncTicker();
    publishLoopState();
    if (!uiCtx?.hasUI) return;
    const views: LoopFooterView[] = [
      ...[...jobs.values()].map((job) => ({
        kind: "live" as const,
        mode: job.mode,
        nextAt: job.nextAt,
        quietStreak: job.quietStreak,
        paused: job.paused,
        due: job.pending,
      })),
      ...[...coldJobs.values()].map((job) => ({
        kind: "cold" as const,
        // A cold job has no self-paced mode; its cadence is always the schedule
        // it was created with, and it never accumulates a quiet streak here.
        mode: "fixed" as const,
        nextAt: coldNextAt(job),
        quietStreak: 0,
        // Paused cold jobs arm nothing either, and `running` for one would read
        // as a job mid-fire. `enabled: false` is this backend's word for it.
        paused: !job.enabled,
      })),
    ];
    uiCtx.ui.setStatus(STATUS_KEY, formatFooter(views, Date.now()));
  }

  /**
   * Re-read the scheduler's job list. The event stream is the fast path, but it
   * cannot express a next-run time after a fire, so this is also the repair
   * step: one list call per fire keeps the countdown honest for cron jobs too.
   */
  async function refreshColdJobs(): Promise<void> {
    if (!bus) return;
    try {
      const data = await callRpc<{ jobs?: ColdJob[] }>(bus, RPC_LIST, {});
      coldJobs = new Map((data.jobs ?? []).map((job) => [job.id, job]));
    } catch {
      // No scheduler in this session — pi-subagents absent, or scheduling
      // switched off. Live loops are unaffected, so this stays silent.
      coldJobs = new Map();
    }
    updateFooter();
  }

  /** Ask the scheduler to cancel a cold job. False when there is nothing to ask. */
  async function removeColdJob(id: string): Promise<boolean> {
    if (!bus) return false;
    try {
      await callRpc(bus, RPC_REMOVE, { jobId: id });
      return true;
    } catch {
      return false;
    }
  }

  function wireColdBackend(): void {
    if (!bus?.on || coldWired) return;
    coldWired = true;
    unsubscribes.push(
      bus.on(EVENT_SCHEDULED, (event) => {
        coldJobs = reduceColdJobs(coldJobs, event);
        // A fire is the one event whose payload cannot say when the next one is.
        if ((event as { type?: string } | undefined)?.type === "fired") void refreshColdJobs();
        else updateFooter();
      }),
    );
    // Emitted by pi-subagents at session_start, after it has re-armed whatever
    // the store held. Subscribing here rather than reading the store ourselves
    // keeps the scheduler's storage private to the scheduler.
    unsubscribes.push(bus.on(EVENT_READY, () => void refreshColdJobs()));
  }

  // ── The live backend's RPC surface ────────────────────────────────────────
  //
  // `jobs` is a closure in this file, so no other extension can arm a live loop
  // by writing to a store — the only way in was the slash command. These
  // channels are the way in for the model, via pi-subagents' `manage_schedules`
  // → `backend: "live"`. They cover the whole lifecycle that tool offers:
  // create, list, update (cadence / prompt / paused), run-now, remove.
  //
  // Deliberately NOT a second model-facing tool registered here. The repo's
  // rule is one door per audience — the user types `/loop`, the model calls
  // `manage_schedules` — and a tool here would be the second model door the
  // Agent tool's retired `schedule` param used to be. A model that can pause a
  // loop but not cancel it, or cancel one it cannot see, has half a door; that
  // is why every verb lands on the same channels rather than a subset.
  function wireLiveBackend(): void {
    if (!bus?.on || liveWired) return;
    liveWired = true;

    /** Reply on the per-request channel, or drop it when there is nobody to answer. */
    function replyChannelFor(raw: unknown, channel: string): ((payload: unknown) => void) | undefined {
      const requestId = (raw as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId !== "string") return undefined;
      const replyChannel = `${channel}:reply:${requestId}`;
      return (payload) => bus?.emit(replyChannel, payload);
    }

    /** One job as every caller sees it, so list/update/run answer the same shape. */
    function jobView(job: Job) {
      return {
        id: job.id,
        prompt: job.prompt,
        mode: job.mode,
        intervalMs: job.intervalMs,
        nextAt: job.nextAt,
        fireAt: job.mode === "once" ? job.nextAt : undefined,
        runs: job.runs,
        paused: job.paused,
        pausedReason: job.pausedReason,
        maxRuns: job.maxRuns,
        until: job.until,
        // Only an unbounded loop expires; a bounded one reports no TTL it will not hit.
        expiresAt: hasBound(job) ? undefined : job.expiresAt,
        lastRunAt: job.lastRunAt,
        lastOutcome: job.lastOutcome,
        lastError: job.lastError,
        // Due but held: the session has not gone idle since it came due.
        waitingForIdle: job.pending && !job.paused ? true : undefined,
        dueSince: job.pending ? job.dueSince : undefined,
        skipped: job.skipped,
        pauseAfterFailures: job.pauseAfterFailures ?? DEFAULT_PAUSE_AFTER_FAILURES,
        failureStreak: job.failureStreak,
        history: job.history,
      };
    }

    unsubscribes.push(
      bus.on(LIVE_CREATE, (raw) => {
        const reply = replyChannelFor(raw, LIVE_CREATE);
        if (!reply) return;
        const request = raw as
          | { schedule?: unknown; prompt?: unknown; maxRuns?: unknown; until?: unknown; pauseAfterFailures?: unknown }
          | undefined;
        try {
          if (!uiCtx) throw new Error("This session has no context yet; try again once it has started.");
          const prompt = typeof request?.prompt === "string" ? request.prompt.trim() : "";
          if (!prompt) throw new Error("`prompt` is required.");
          const schedule = typeof request?.schedule === "string" ? request.schedule.trim() : "";
          const now = Date.now();
          const shape = parseLiveSchedule(schedule, now);
          if (shape === undefined) {
            throw new Error(
              `"${schedule}" is not a live-loop schedule. Use an interval (5m / 30m / 1h / 2d) or a one-shot (+10m or an ISO timestamp); 6-field cron exists on the cold backend only.`,
            );
          }
          if (jobs.size >= MAX_LOOPS) {
            throw new Error(`This session already has ${MAX_LOOPS} live loops; stop one before adding another.`);
          }
          const job = shape.mode === "fixed" ? makeJob("fixed", prompt, shape.intervalMs) : makeJob("once", prompt);
          // A one-shot's due instant is the whole of its schedule, so it replaces
          // the "arm at now" that `makeJob` gives a repeat.
          if (shape.mode === "once") job.nextAt = shape.fireAt;
          job.maxRuns = boundMaxRuns(request?.maxRuns);
          job.until = boundUntil(request?.until, now);
          job.pauseAfterFailures = boundPauseAfterFailures(request?.pauseAfterFailures);
          addJob(job);
          // No `fire(job)` here, unlike the slash command: that runs between
          // turns, whereas this arrives mid-turn from a tool call. `makeJob`
          // arms `nextAt` at now, so the ticker's drain() picks it up as soon as
          // the session is idle — "runs immediately", never "steers the turn
          // that created it".
          if (uiCtx.hasUI) {
            uiCtx.ui.notify(
              shape.mode === "once"
                ? `Live loop ${job.id} armed by the model · fires once into this conversation, spending the main context · stop with /loop stop ${job.id}.`
                : `Live loop ${job.id} armed by the model · ${formatInterval(shape.intervalMs)} · re-enters this conversation, so each fire spends the main context · stop with /loop stop ${job.id}.`,
              "info",
            );
          }
          reply({
            success: true,
            data: {
              id: job.id,
              mode: job.mode,
              intervalMs: job.intervalMs,
              nextAt: job.nextAt,
              fireAt: job.mode === "once" ? job.nextAt : undefined,
            },
          });
        } catch (err) {
          reply({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    unsubscribes.push(
      bus.on(LIVE_LIST, (raw) => {
        const reply = replyChannelFor(raw, LIVE_LIST);
        if (!reply) return;
        reply({
          success: true,
          data: { jobs: [...jobs.values()].map(jobView) },
        });
      }),
    );

    // Update: cadence, prompt, and paused in one call, because "change the
    // interval and keep it paused" is one intention, not two round trips.
    unsubscribes.push(
      bus.on(LIVE_UPDATE, (raw) => {
        const reply = replyChannelFor(raw, LIVE_UPDATE);
        if (!reply) return;
        const request = raw as
          | {
              jobId?: unknown;
              schedule?: unknown;
              prompt?: unknown;
              paused?: unknown;
              maxRuns?: unknown;
              until?: unknown;
              pauseAfterFailures?: unknown;
            }
          | undefined;
        try {
          const jobId = typeof request?.jobId === "string" ? request.jobId : "";
          const job = jobs.get(jobId);
          if (!job) throw new Error(`No live loop with id "${jobId}".`);
          const changed: string[] = [];
          const boundedBefore = hasBound(job);

          if (typeof request?.schedule === "string" && request.schedule.trim()) {
            const text = request.schedule.trim();
            const shape = parseLiveSchedule(text, Date.now());
            if (shape === undefined) {
              throw new Error(
                `"${text}" is not a live-loop schedule. Use an interval (5m / 30m / 1h / 2d) or a one-shot (+10m or an ISO timestamp); 6-field cron exists on the cold backend only.`,
              );
            }
            // Re-sending the schedule it already has is not a change. A caller
            // that cannot tell "applied" from "no-op" will re-send and report
            // success either way, which is how a wrong update goes unnoticed.
            if (shape.mode === "fixed") {
              // Changing the cadence makes it a fixed loop: the caller chose the
              // rhythm, and a self-paced loop has none to keep.
              if (job.mode !== "fixed" || job.intervalMs !== shape.intervalMs) {
                job.mode = "fixed";
                job.intervalMs = shape.intervalMs;
                if (!job.paused) job.nextAt = Date.now() + shape.intervalMs;
                changed.push(formatInterval(shape.intervalMs));
              }
            } else if (job.mode !== "once" || job.nextAt !== shape.fireAt) {
              job.mode = "once";
              job.intervalMs = undefined;
              if (!job.paused) job.nextAt = shape.fireAt;
              changed.push(`one-shot at ${new Date(shape.fireAt).toISOString()}`);
            }
          }

          if (typeof request?.prompt === "string" && request.prompt.trim()) {
            const prompt = request.prompt.trim();
            if (prompt !== job.prompt) {
              job.prompt = prompt;
              changed.push(`prompt "${truncate(prompt)}"`);
            }
          }

          if (typeof request?.paused === "boolean" && request.paused !== job.paused) {
            setPaused(job, request.paused);
            changed.push(request.paused ? "paused" : "resumed");
          }

          // Bounds are settable and clearable in the same call: `maxRuns: 0` and
          // an empty `until` mean "no bound", because a loop that was given one
          // and then told to keep going is a real request.
          if (typeof request?.maxRuns === "number") {
            const next = request.maxRuns === 0 ? undefined : boundMaxRuns(request.maxRuns);
            if (next !== job.maxRuns) {
              job.maxRuns = next;
              changed.push(next === undefined ? "maxRuns removed" : `max ${next} runs`);
            }
          }
          if (typeof request?.until === "string") {
            const next = boundUntil(request.until, Date.now());
            if (next !== job.until) {
              job.until = next;
              changed.push(next === undefined ? "until removed" : `until ${new Date(next).toISOString()}`);
            }
          }

          if (request?.pauseAfterFailures !== undefined) {
            const next = boundPauseAfterFailures(request.pauseAfterFailures);
            if (next !== (job.pauseAfterFailures ?? DEFAULT_PAUSE_AFTER_FAILURES)) {
              job.pauseAfterFailures = next;
              changed.push(next === 0 ? "never pauses on failure" : `pauses after ${next} failed fires`);
            }
          }

          // Clearing the last bound makes it an unbounded loop again, which is
          // what the TTL exists for — counted from now, not from creation, so a
          // loop unbounded on day 8 is not expired on the spot.
          if (boundedBefore && !hasBound(job)) job.expiresAt = Date.now() + LOOP_TTL_MS;

          // An empty request is a caller mistake worth naming. A request whose
          // values the loop already has is not: re-asserting a desired state is
          // how an idempotent caller works, and `changed: []` already tells it
          // that nothing moved.
          const supplied = ["schedule", "prompt", "paused", "maxRuns", "until", "pauseAfterFailures"].some((field) => {
            const value = (request as Record<string, unknown> | undefined)?.[field];
            return typeof value === "string" ? field === "until" || value.trim() !== "" : value !== undefined;
          });
          if (!supplied) {
            throw new Error(
              "Nothing to change: pass at least one of `schedule`, `prompt`, `paused`, `maxRuns`, `until` or `pauseAfterFailures`.",
            );
          }
          if (changed.length > 0) {
            saveLoops();
            updateFooter();
          }
          reply({ success: true, data: { job: jobView(job), changed } });
        } catch (err) {
          reply({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    // Run-now: mark it due and let drain() deliver it. Firing inside this call
    // would steer the very turn that asked for it, which is the one thing a
    // loop must never do.
    unsubscribes.push(
      bus.on(LIVE_RUN, (raw) => {
        const reply = replyChannelFor(raw, LIVE_RUN);
        if (!reply) return;
        const jobId = (raw as { jobId?: unknown } | undefined)?.jobId;
        const job = typeof jobId === "string" ? jobs.get(jobId) : undefined;
        if (!job) {
          reply({ success: false, error: `No live loop with id "${String(jobId)}".` });
          return;
        }
        if (job.paused) {
          reply({ success: false, error: `Loop ${job.id} is paused. Resume it first, then run it.` });
          return;
        }
        job.pending = true;
        job.dueSince = job.dueSince ?? Date.now();
        job.manualRun = true;
        job.nextAt = job.nextAt ?? Date.now();
        updateFooter();
        reply({ success: true, data: { job: jobView(job), queuedForNextIdle: true } });
      }),
    );

    unsubscribes.push(
      bus.on(LIVE_REMOVE, (raw) => {
        const reply = replyChannelFor(raw, LIVE_REMOVE);
        if (!reply) return;
        const jobId = (raw as { jobId?: unknown } | undefined)?.jobId;
        const job = typeof jobId === "string" ? jobs.get(jobId) : undefined;
        if (!job) {
          reply({ success: false, error: `No live loop with id "${String(jobId)}".` });
          return;
        }
        job.stopped = true;
        removeJob(job);
        reply({ success: true, data: { removed: job.id } });
      }),
    );
  }

  /**
   * The ticker re-renders the footer's countdown, and cold work needs that as
   * much as live work does: `/loop` owns no timer for a cold job, so with one
   * armed and no live loop the footer kept whatever `next in …` was written at
   * the last event and froze there. Live loops also use the tick to notice a due
   * fire, which is why the ticker is not a footer-only concern.
   */
  function syncTicker(): void {
    if (jobs.size + coldJobs.size > 0) ensureTicker();
    else stopTickerIfIdle();
  }

  function ensureTicker(): void {
    if (ticker || jobs.size + coldJobs.size === 0) return;
    ticker = setInterval(tick, TICK_MS);
    // Why: a live interval would hold the process open on a clean exit; pi owns
    // its own lifetime, this timer should not extend it.
    ticker.unref?.();
  }

  function stopTickerIfIdle(): void {
    if (jobs.size + coldJobs.size > 0 || !ticker) return;
    clearInterval(ticker);
    ticker = undefined;
  }

  function removeJob(job: Job): void {
    jobs.delete(job.id);
    stopTickerIfIdle();
    saveLoops();
    updateFooter();
  }

  /**
   * The loop whose injected prompt started the run in flight, so every
   * `turn_end` of that run is attributed to its fire. Held until the run
   * settles (or the next fire), because a fire that calls tools spans several
   * turns, and its first one is rarely where it says what it found.
   */
  let pendingOutcomeId: string | undefined;

  /**
   * Record how a loop's turn ended.
   *
   * A live loop's fire is a normal turn, so a failing model or a broken tool call
   * leaves no trace on the job itself: `runs` climbs whether the work succeeded
   * or not, and a caller checking `list` cannot tell a healthy loop from one that
   * has errored every time. The turn's own stop reason is the honest signal, and
   * it is the only place it exists. An error in any turn of the fire sticks.
   */
  function recordOutcome(event: unknown): void {
    const id = pendingOutcomeId;
    if (id === undefined) return;
    const job = jobs.get(id);
    const entry = job?.history.at(-1);
    if (!job || !entry) return;
    const message = (event as { message?: { stopReason?: unknown } } | undefined)?.message;
    const reason = message?.stopReason;
    const failed = reason === "error" || reason === "aborted";
    const summary = summarizeTurn(message);
    if (summary) entry.summary = summary;
    if (failed && entry.outcome !== "error") {
      entry.outcome = "error";
      entry.error = `turn ended: ${String(reason)}`;
      job.lastOutcome = "error";
      job.lastError = entry.error;
      job.failureStreak += 1;
      applyFailurePolicy(job);
    } else if (!failed && entry.outcome === "running") {
      entry.outcome = "ok";
      job.lastOutcome = "ok";
      job.lastError = undefined;
    }
    saveLoops();
  }

  /** A fire's run is over: a good one ends the failure streak. */
  function closeOutcome(): void {
    const id = pendingOutcomeId;
    pendingOutcomeId = undefined;
    const job = id === undefined ? undefined : jobs.get(id);
    if (job && job.history.at(-1)?.outcome === "ok" && job.failureStreak !== 0) {
      job.failureStreak = 0;
      saveLoops();
    }
  }

  /**
   * Pause a loop that keeps failing, instead of letting it bill every fire.
   *
   * Pause rather than cancel: the id, the prompt and the history survive, so the
   * caller can read what went wrong and `resume` once it is fixed.
   */
  function applyFailurePolicy(job: Job): void {
    const limit = job.pauseAfterFailures ?? DEFAULT_PAUSE_AFTER_FAILURES;
    if (limit <= 0 || job.failureStreak < limit || job.paused) return;
    setPaused(job, true);
    job.pausedReason = `paused after ${job.failureStreak} failed fires in a row`;
    updateFooter();
    if (uiCtx?.hasUI) {
      uiCtx.ui.notify(
        `Loop ${job.id} ${job.pausedReason} (last: ${job.lastError ?? "error"}). Resume it with manage_schedules { action: "resume", id: "${job.id}" } once fixed, or cancel it.`,
        "warning",
      );
    }
  }

  /** Inject the loop's prompt as a user message. Only ever called while idle. */
  function fire(job: Job): void {
    if (job.paused) return;
    const now = Date.now();
    // Bounds are enforced here, not only on the tick: the tick sees a job that is
    // due, and one whose last fire used up its allowance must not get another.
    if (job.maxRuns !== undefined && job.runs >= job.maxRuns) {
      removeJob(job);
      if (uiCtx?.hasUI) {
        uiCtx.ui.notify(`Loop ended after its ${job.maxRuns} run${job.maxRuns === 1 ? "" : "s"}: "${truncate(job.prompt)}"`, "info");
      }
      return;
    }
    if (job.until !== undefined && now >= job.until) {
      removeJob(job);
      if (uiCtx?.hasUI) uiCtx.ui.notify(`Loop reached its stop time and ended: "${truncate(job.prompt)}"`, "info");
      return;
    }
    // Only a self-paced loop can carry an override, and there is at most one of
    // them, so the override never has to be matched back to a job.
    const prompt = job.mode === "dynamic" && nextPromptOverride ? nextPromptOverride : job.prompt;
    nextPromptOverride = undefined;

    // The previous fire's run is over by now (fires only land when idle).
    closeOutcome();
    job.runs += 1;
    job.lastRunAt = now;
    pendingOutcomeId = job.id;
    job.pending = false;
    job.dueSince = undefined;
    const manual = job.manualRun === true;
    job.manualRun = false;
    const slot = job.nextAt;
    // Lateness is measured against the slot this fire stands in for. A manual
    // fire has no slot of its own, so it is never "late".
    const onSlot = !manual || (slot !== undefined && slot <= now);
    const lateMs = onSlot && slot !== undefined && now - slot >= 1000 ? now - slot : undefined;
    let skipped = 0;
    if (job.mode === "fixed" && job.intervalMs) {
      // A manual fire that lands before the armed slot leaves that slot alone:
      // `run` means "also now", so the 3:20 fire of a 25m loop still happens.
      const keepArmed = manual && slot !== undefined && slot > now;
      if (!keepArmed) skipped = missedSlots(slot ?? now, now, job.intervalMs);
      job.nextAt = keepArmed ? slot : nextFixedRun(slot ?? now, now, job.intervalMs);
    } else if (job.mode === "once") {
      // Its fire is the whole schedule, so nothing is re-armed. The job is removed
      // on the next tick, once this fire has been delivered, rather than here —
      // this function is mid-delivery.
      job.nextAt = undefined;
    } else {
      // A dynamic loop has no armed wakeup until the model schedules one at the
      // end of this turn; `agent_settled` is what turns that silence into either
      // a fallback wakeup or the loop's end.
      job.nextAt = undefined;
    }

    job.skipped += skipped;
    job.history = pushHistory(job.history, {
      at: now,
      outcome: "running",
      ...(manual ? { manual: true } : {}),
      ...(lateMs !== undefined ? { lateMs } : {}),
      ...(skipped > 0 ? { skipped } : {}),
    });
    // Said once, at the fire that noticed: the counter on the job is the durable record.
    if (skipped > 0 && uiCtx?.hasUI) {
      uiCtx.ui.notify(
        `Loop ${job.id} fired ${formatDuration(lateMs ?? 0)} late and skipped ${skipped} slot${skipped === 1 ? "" : "s"} (no catch-up: the machine slept or the session was busy).`,
        "info",
      );
    }

    // Expiry: a fire already waiting still lands; the loop itself is gone.
    if (isExpired(job, now)) {
      removeJob(job);
      if (uiCtx?.hasUI) uiCtx.ui.notify(`Loop expired after 7 days: "${truncate(prompt)}"`, "info");
    } else {
      saveLoops();
      updateFooter();
    }

    pi.sendUserMessage(prompt);
  }

  function tick(): void {
    const now = Date.now();
    for (const job of [...jobs.values()]) {
      if (job.stopped) continue;
      // Expiry is checked before the paused skip: a paused loop arms nothing, so
      // it would otherwise outlive the 7-day TTL in this session and fire once
      // more on resume — a forgotten loop running forever, which is the one thing
      // the TTL exists to prevent.
      if (isExpired(job, now)) {
        removeJob(job);
        if (uiCtx?.hasUI) uiCtx.ui.notify(`Loop expired after 7 days: "${truncate(job.prompt)}"`, "info");
        continue;
      }
      // Bounds are checked before the paused skip for the same reason expiry is: a
      // held loop must not outlive its own limits and fire once more on resume.
      if (job.maxRuns !== undefined && job.runs >= job.maxRuns) {
        removeJob(job);
        if (uiCtx?.hasUI) {
          uiCtx.ui.notify(`Loop ended after its ${job.maxRuns} run${job.maxRuns === 1 ? "" : "s"}: "${truncate(job.prompt)}"`, "info");
        }
        continue;
      }
      if (job.until !== undefined && now >= job.until) {
        removeJob(job);
        if (uiCtx?.hasUI) uiCtx.ui.notify(`Loop reached its stop time and ended: "${truncate(job.prompt)}"`, "info");
        continue;
      }
      // A spent one-shot arms nothing, so the roster would keep reporting it as
      // "running" forever; it goes once its fire has been delivered.
      if (job.mode === "once" && job.runs > 0 && !job.pending) {
        removeJob(job);
        if (uiCtx?.hasUI) uiCtx.ui.notify(`One-shot loop fired and ended: "${truncate(job.prompt)}"`, "info");
        continue;
      }
      if (job.paused) continue;
      if (job.nextAt !== undefined && job.nextAt <= now && !job.pending) {
        job.pending = true;
        job.dueSince = job.nextAt;
      }
    }
    updateFooter();
    drain();
  }

  /** Fire every due loop, one per idle window, never mid-turn. */
  function drain(): void {
    if (!uiCtx) return;
    if (!uiCtx.isIdle()) return;
    const due = [...jobs.values()]
      .filter((job) => job.pending && !job.stopped && !job.paused)
      .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))[0];
    if (!due) return;
    fire(due);
  }

  function addJob(job: Job): void {
    jobs.set(job.id, job);
    ensureTicker();
    saveLoops();
    updateFooter();
  }

  // ── Session-scoped persistence ──────────────────────────────────────────────
  //
  // Live loops used to be memory-only, which made them the one backend that
  // `/resume` could not restore. They are now written beside the session, keyed
  // by session id: a new session starts empty, and a resumed one finds its own
  // loops again. Nothing outlives the session — the file is per-session state,
  // not a schedule that keeps running when nothing is listening.

  /** `<cwd>/.pi/loops/<sessionId>.json`, mirroring pi-subagents' store layout. */
  function loopsPath(): string | undefined {
    return uiCtx ? loopsPathFor(uiCtx) : undefined;
  }

  function saveLoops(): void {
    const path = loopsPath();
    if (!path) return;
    const data: PersistedLoops = {
      version: 1,
      loops: [...jobs.values()].map((job) => ({
        id: job.id,
        prompt: job.prompt,
        mode: job.mode,
        intervalMs: job.intervalMs,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt,
        runs: job.runs,
        paused: job.paused,
        // A fixed loop's slot is kept too, so a resume lands back on its phase
        // and can count the slots that passed while the session was closed.
        nextAt: job.mode === "dynamic" ? undefined : job.nextAt,
        maxRuns: job.maxRuns,
        until: job.until,
        lastRunAt: job.lastRunAt,
        lastOutcome: job.lastOutcome,
        lastError: job.lastError,
        skipped: job.skipped,
        history: job.history,
        pauseAfterFailures: job.pauseAfterFailures,
        failureStreak: job.failureStreak,
        pausedReason: job.pausedReason,
      })),
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      // The store sits under the session's cwd, which is usually somebody's
      // repository, and that repository has no reason to know this directory.
      // A self-ignoring folder keeps per-session state out of `git add -A`
      // without editing every repo pi is ever run in.
      const ignore = join(dirname(path), ".gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "# pi /loop per-session state\n*\n");
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, path);
    } catch {
      // A loop that cannot be written still runs; persistence is a resume
      // convenience, never a precondition for scheduling.
    }
  }

  /**
   * Re-arm the loops a resumed session had. No catch-up: a fixed loop resumes at
   * its next slot on the original phase (one interval from now for a store that
   * predates saved slots), and a self-paced one gets the fallback wakeup, so a
   * session that was closed overnight does not open with a burst of fires. The
   * slots it slept through are added to `skipped` and said once.
   */
  function loadLoops(ctx: ExtensionContext): void {
    const path = loopsPathFor(ctx);
    if (!path || !existsSync(path)) return;
    let data: PersistedLoops;
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as PersistedLoops;
    } catch {
      return;
    }
    const now = Date.now();
    const missedWhileClosed: string[] = [];
    for (const saved of data.loops ?? []) {
      if (!saved?.id || !saved.prompt) continue;
      const bounded = saved.maxRuns !== undefined || saved.until !== undefined;
      if (!bounded && now >= saved.expiresAt) continue;
      if (jobs.has(saved.id)) continue;
      const interval = saved.intervalMs ?? MIN_INTERVAL_MS;
      let fixedNext = now + interval;
      let closedSkips = 0;
      if (saved.mode === "fixed" && !saved.paused && typeof saved.nextAt === "number") {
        if (saved.nextAt > now) fixedNext = saved.nextAt;
        else {
          // The saved slot itself passed unfired, and so did every slot after it up to now.
          closedSkips = missedSlots(saved.nextAt, now, interval) + 1;
          fixedNext = nextFixedRun(saved.nextAt, now, interval);
          missedWhileClosed.push(`${saved.id} (${closedSkips})`);
        }
      }
      const restored: Job = {
        id: saved.id,
        prompt: saved.prompt,
        mode: saved.mode === "dynamic" ? "dynamic" : saved.mode === "once" ? "once" : "fixed",
        intervalMs: saved.intervalMs,
        // A paused loop comes back paused: the store records the decision, not
        // just the cadence, and re-arming it would undo what someone asked for.
        // A one-shot comes back at the instant it was waiting for, not "now":
        // a resume is not a reason to fire it early.
        nextAt: saved.paused
          ? undefined
          : saved.mode === "dynamic"
            ? now + FALLBACK_WAKEUP_MS
            : saved.mode === "once"
              ? (saved.nextAt ?? now)
              : fixedNext,
        createdAt: saved.createdAt,
        expiresAt: saved.expiresAt,
        runs: saved.runs ?? 0,
        quietStreak: 0,
        pending: false,
        paused: saved.paused === true,
        maxRuns: saved.maxRuns,
        until: saved.until,
        lastRunAt: saved.lastRunAt,
        lastOutcome: saved.lastOutcome,
        lastError: saved.lastError,
        fallbackArmed: false,
        stopped: false,
        skipped: (saved.skipped ?? 0) + closedSkips,
        history: Array.isArray(saved.history) ? saved.history.slice(-HISTORY_MAX) : [],
        pauseAfterFailures: saved.pauseAfterFailures,
        failureStreak: saved.failureStreak ?? 0,
        pausedReason: saved.pausedReason,
      };
      // A fire still "running" when the session closed has no turn left to finish it.
      const last = restored.history.at(-1);
      if (last?.outcome === "running") last.outcome = "unknown";
      jobs.set(restored.id, restored);
    }
    if (missedWhileClosed.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Restored live loops missed fires while this session was closed: ${missedWhileClosed.join(", ")}. No catch-up; each resumes at its next slot.`,
        "info",
      );
    }
    if (jobs.size > 0) ensureTicker();
    saveLoops();
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
      paused: false,
      fallbackArmed: false,
      stopped: false,
      skipped: 0,
      history: [],
      failureStreak: 0,
    };
  }

  function describe(job: Job): string {
    const cadence =
      job.mode === "once"
        ? "one-shot"
        : job.mode === "fixed" && job.intervalMs
          ? formatInterval(job.intervalMs)
          : "self-paced";
    const now = Date.now();
    const next = job.paused
      ? job.pausedReason ?? "paused"
      : job.pending
        ? `due ${formatDuration(Math.max(0, now - (job.dueSince ?? now)))} ago, waiting for idle`
        : job.nextAt === undefined
          ? job.mode === "once"
            ? "spent"
            : "awaiting wakeup"
          : `next in ${formatDuration(Math.max(0, job.nextAt - now))} (${formatClockTime(job.nextAt).slice(0, 5)})`;
    const bounds = [
      job.maxRuns !== undefined ? `max ${job.maxRuns} runs` : undefined,
      job.until !== undefined ? `until ${new Date(job.until).toISOString()}` : undefined,
      job.lastOutcome ? `last: ${job.lastOutcome}` : undefined,
      job.skipped > 0 ? `skipped ${job.skipped}` : undefined,
      // The TTL only binds an unbounded loop, so a bounded one does not claim it.
      hasBound(job) ? undefined : `expires in ${formatDuration(Math.max(0, job.expiresAt - now))}`,
    ]
      .filter(Boolean)
      .join(" · ");
    return `◷ ${job.id} · ${cadence} · ${next} · runs ${job.runs}${bounds ? ` · ${bounds}` : ""} · "${truncate(job.prompt)}"`;
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
      "Pace an existing self-paced /loop: say when to resume this loop's next turn, or end it with `stop: true`. " +
      "This is NOT how scheduled work is created — for anything recurring or delayed (a job that fires every 25 minutes, a check you want run later) call manage_schedules { action: \"create\" } instead. " +
      "This tool only applies inside a /loop that was created without an interval; outside one it does nothing.",
    promptSnippet: "Self-pace a dynamic /loop by scheduling the next iteration, or end it with stop",
    promptGuidelines: [
      "Use ScheduleWakeup only when a /loop was created without an interval (dynamic mode); a fixed-interval loop arms itself and does not need it.",
      "To create scheduled or recurring work — including a prompt that should repeat every N minutes — use manage_schedules, never this tool, and never by asking the user to type a command.",
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

      if (job.paused) {
        return text(`Wakeup not scheduled — loop ${job.id} is paused. Resume it with manage_schedules { action: "resume", id: "${job.id}" } if it should keep going.`);
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
    description:
      "Run a prompt repeatedly in this session: /loop [interval] [--cold] <prompt> · /loop list · /loop stop|cancel [id|all]",
    getArgumentCompletions: (prefix: string) => {
      const values = ["list", "stop", "stop all", "5m", "10m", "30m", "1h"];
      const items = values
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const { cold, input } = stripColdFlag(args.trim());
      const [head, ...rest] = input.split(/\s+/);

      if (head === "list" || (!input && jobs.size + coldJobs.size > 0)) {
        if (jobs.size === 0 && coldJobs.size === 0) {
          ctx.ui.notify("Nothing scheduled.", "info");
          return;
        }
        const now = Date.now();
        for (const job of jobs.values()) ctx.ui.notify(describe(job), "info");
        for (const job of coldJobs.values()) ctx.ui.notify(describeCold(job, now), "info");
        return;
      }

      // `cancel` is the tool's word for the same act, so both spellings work here.
      if (head === "stop" || head === "cancel") {
        const target = rest.join(" ").trim();
        if (!target || target === "all") {
          // The mirror can lag a session start, and `stop all` must not report
          // "nothing scheduled" while the scheduler still holds jobs.
          await refreshColdJobs();
          if (jobs.size + coldJobs.size === 0) {
            ctx.ui.notify("Nothing scheduled.", "info");
            return;
          }
          const count = jobs.size;
          for (const job of [...jobs.values()]) {
            job.stopped = true;
            jobs.delete(job.id);
          }
          stopTickerIfIdle();
          saveLoops();
          let coldStopped = 0;
          for (const id of [...coldJobs.keys()]) {
            if (await removeColdJob(id)) coldStopped += 1;
          }
          await refreshColdJobs();
          updateFooter();
          const coldNote = coldStopped > 0 ? ` and ${coldStopped} job${coldStopped === 1 ? "" : "s"}` : "";
          ctx.ui.notify(`Stopped ${count} loop${count === 1 ? "" : "s"}${coldNote}.`, "info");
          return;
        }
        const job = jobs.get(target);
        if (job) {
          job.stopped = true;
          removeJob(job);
          ctx.ui.notify(`Stopped loop ${target}.`, "info");
          return;
        }
        // A cold id is resolved against the scheduler, not the mirror: the mirror
        // is filled from events and can lag a session start, and a `stop` typed
        // early must still reach the job it names.
        await refreshColdJobs();
        if (coldJobs.has(target) && (await removeColdJob(target))) {
          await refreshColdJobs();
          ctx.ui.notify(`Stopped cold job ${target}.`, "info");
          return;
        }
        ctx.ui.notify(`No scheduled work with id "${target}". Try /loop list.`, "warning");
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

      // `--cold` hands the job to pi-subagents, which spawns a fresh subagent per
      // fire instead of re-entering this session. Same command, same footer,
      // same session-scoped lifetime — a different execution home.
      if (cold) {
        if (parsed.mode !== "fixed") {
          ctx.ui.notify(
            "--cold needs an interval: /loop 5m --cold <prompt>. A self-paced loop has to run in this session to pick its own delay.",
            "warning",
          );
          return;
        }
        if (!bus) {
          ctx.ui.notify("--cold needs pi-subagents for its scheduler, and this session has no event bus.", "warning");
          return;
        }
        let coldCadence = parsed.intervalText;
        if (parsed.intervalMs < MIN_INTERVAL_MS) {
          ctx.ui.notify(
            `${parsed.intervalText} is below the ${formatDuration(MIN_INTERVAL_MS)} floor; using ${formatDuration(MIN_INTERVAL_MS)}.`,
            "warning",
          );
          coldCadence = formatDuration(MIN_INTERVAL_MS);
        }
        try {
          const created = await callRpc<{ id: string; nextRun?: string }>(bus, RPC_CREATE, {
            schedule: coldCadence,
            prompt: parsed.prompt,
            subagent_type: "general-purpose",
          });
          await refreshColdJobs();
          ctx.ui.notify(
            `Cold loop ${created.id} armed · every ${coldCadence} · runs in a subagent session, not this context · first run ${created.nextRun ?? "pending"} · stop with /loop stop ${created.id}.`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`Cold loop not armed — ${err instanceof Error ? err.message : String(err)}`, "warning");
        }
        return;
      }

      const existingDynamic = parsed.mode === "dynamic" ? dynamicJob() : undefined;
      if (existingDynamic) {
        const state = existingDynamic.paused ? "paused" : "running";
        ctx.ui.notify(
          `A self-paced loop is already ${state} (${existingDynamic.id}). Resume it (/loop stop ${existingDynamic.id} and re-arm, or ask for it back with the model's manage_schedules) or give this one an interval: /loop 5m <prompt>.`,
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
    // Session-scoped by design: a new session starts empty, and `/resume` finds
    // its own loops again from the per-session store. Nothing outlives a
    // session, which is why there is no durable flag to set here.
    wireColdBackend();
    wireLiveBackend();
    // A fresh session must republish its loop state, even when it matches the last one.
    publishedLoopState = "";
    loadLoops(ctx);
    // The scheduler emits `subagents:scheduler_ready` from its own session_start
    // handler, which may run before this one. Asking once here covers the other
    // ordering; the call is idempotent.
    void refreshColdJobs();
    updateFooter();
  });

  pi.on("turn_end", async (event, ctx) => {
    uiCtx = ctx;
    recordOutcome(event);
    drain();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    uiCtx = ctx;
    closeOutcome();
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
    for (const off of unsubscribes.splice(0)) off();
    coldWired = false;
    liveWired = false;
    jobs.clear();
    coldJobs = new Map();
    uiCtx = undefined;
  });
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** On-disk shape for a session's live loops. */
type PersistedLoops = {
  version: 1;
  loops: Array<{
    id: string;
    prompt: string;
    mode: LoopMode;
    intervalMs?: number;
    createdAt: number;
    expiresAt: number;
    runs: number;
    /** Absent in stores written before pausing existed; absent means armed. */
    paused?: boolean;
    /** The armed slot: a one-shot's instant, or a fixed loop's next slot (absent in older stores). */
    nextAt?: number;
    maxRuns?: number;
    until?: number;
    lastRunAt?: number;
    lastOutcome?: "ok" | "error";
    lastError?: string;
    /** Absent in stores written before missed-fire accounting. */
    skipped?: number;
    history?: FireRecord[];
    pauseAfterFailures?: number;
    failureStreak?: number;
    pausedReason?: string;
  }>;
};

/** The session id a loop store is keyed by; undefined when the host exposes none. */
function sessionIdOf(ctx: ExtensionContext | undefined): string | undefined {
  const manager = (ctx as { sessionManager?: { getSessionId?: () => string | undefined } } | undefined)
    ?.sessionManager;
  return manager?.getSessionId?.();
}

/** `<cwd>/.pi/loops/<sessionId>.json` — per-session, never a standing schedule. */
function loopsPathFor(ctx: ExtensionContext): string | undefined {
  const sessionId = sessionIdOf(ctx);
  return sessionId ? join(ctx.cwd, ".pi", "loops", `${sessionId}.json`) : undefined;
}


function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: { result: value } };
}

function truncate(value: string, max = 60): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
