/**
 * scheduled-rpc.ts — the `/loop` side of the pi-subagents scheduler.
 *
 * `/loop` presents scheduled work as one surface with two backends:
 *
 *   live  a timer that re-enters this session (`pi.sendUserMessage`)
 *   cold  a job in pi-subagents' scheduler that spawns a fresh subagent
 *
 * Cold exists because the live backend pays for the main context on every tick:
 * the whole transcript goes to the model again, and the tick's own messages stay
 * in it. A cold tick is a separate subagent session, so a context-free repeat
 * costs a fresh small context instead of a growing large one. It is cheaper even
 * when prompt caching makes the live tick look nearly free.
 *
 * This module holds the parts that are pure or transport-only, so `loop.ts`
 * stays about scheduling policy:
 *
 *   callRpc        request/response over `pi.events`, per-request reply channel
 *   reduceColdJobs fold a `subagents:scheduled` event into a job map
 *   describeCold   one-line view for `/loop list`
 *
 * Both backends are session-scoped. The scheduler's store is keyed by sessionId,
 * so a job is visible exactly while its session lives and comes back on
 * `/resume` — never beyond that.
 */

/** Channels published by pi-subagents (`src/schedule-rpc.ts` there). */
export const RPC_LIST = "subagents:rpc:schedules:list";
export const RPC_CREATE = "subagents:rpc:schedules:create";
export const RPC_REMOVE = "subagents:rpc:schedules:remove";

/**
 * Channels this extension SERVES, so the model can arm a live loop.
 *
 * The mirror image of the three above, and the literals are duplicated in
 * pi-subagents' `src/schedule-live-rpc.ts` — two repos, one wire, no shared
 * module to hang the constant on. Change one, change both.
 *
 * Cold work already flowed both ways: `/loop` calls pi-subagents for it. Live
 * work only ever needed the user, because the only way to create a live loop
 * was to type `/loop`. Giving the model a `backend: "live"` option means the
 * call now runs the other way, and it has to land here: the `jobs` table is a
 * closure in this extension, so nothing else can add to it.
 */
export const LIVE_CREATE = "loop:rpc:schedules:create";
export const LIVE_LIST = "loop:rpc:schedules:list";
export const LIVE_REMOVE = "loop:rpc:schedules:remove";

/** Scheduler lifecycle events on the same bus. */
export const EVENT_SCHEDULED = "subagents:scheduled";
export const EVENT_READY = "subagents:scheduler_ready";

/** How long to wait for a reply before calling the scheduler unavailable. */
export const RPC_TIMEOUT_MS = 4_000;

/** The slice of `pi.events` this module uses. */
export type RpcEventBus = {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
};

/** A scheduled subagent job as `/loop` displays it. */
export type ColdJob = {
	id: string;
	name: string;
	schedule: string;
	scheduleType: "cron" | "once" | "interval";
	intervalMs?: number;
	enabled: boolean;
	prompt: string;
	runCount: number;
	lastStatus?: "success" | "error" | "running";
	/** ISO. Refreshed on every fire; absent until the scheduler knows it. */
	nextRun?: string;
};

/** Reply envelope shared with pi-subagents' RPC layer. */
type RpcReply<T> = { success: true; data?: T } | { success: false; error: string };

let requestCounter = 0;

/**
 * Send one RPC and await its reply.
 *
 * The reply channel is scoped to the request id, so two in-flight calls cannot
 * read each other's answers. A timeout is not an error the caller must handle
 * loudly: it means "no scheduler in this session" (pi-subagents absent, or its
 * scheduling feature switched off), and every caller here has a sensible
 * fallback for that.
 */
export function callRpc<T>(
	bus: RpcEventBus,
	channel: string,
	params: Record<string, unknown>,
	timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
	const requestId = `loop-${++requestCounter}-${channel}`;
	const replyChannel = `${channel}:reply:${requestId}`;

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			fn();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error(`no reply from ${channel} within ${timeoutMs}ms`))),
			timeoutMs,
		);
		const unsubscribe = bus.on(replyChannel, (raw) => {
			const reply = raw as RpcReply<T> | undefined;
			finish(() => {
				if (!reply) reject(new Error(`${channel} replied with no envelope`));
				else if (reply.success === true) resolve(reply.data as T);
				else reject(new Error(reply.error));
			});
		});
		bus.emit(channel, { ...params, requestId });
	});
}

/**
 * Fold one `subagents:scheduled` event into the mirrored job map.
 *
 * Pure and total: unknown event shapes are ignored rather than thrown on, so a
 * newer pi-subagents adding an event type cannot break `/loop`'s footer.
 * `fired` is deliberately *not* handled here — a fire does not carry the new
 * next-run time, and inventing one from `intervalMs` would be wrong for cron
 * jobs. The caller refreshes instead; see `loop.ts`.
 */
export function reduceColdJobs(current: Map<string, ColdJob>, event: unknown): Map<string, ColdJob> {
	const e = event as { type?: string; job?: unknown; jobId?: string } | undefined;
	if (!e || typeof e.type !== "string") return current;

	const next = new Map(current);
	if (e.type === "removed" && typeof e.jobId === "string") {
		next.delete(e.jobId);
		return next;
	}
	if ((e.type === "added" || e.type === "updated" || e.type === "restored") && isColdJob(e.job)) {
		next.set(e.job.id, e.job);
	}
	return next;
}

/** Structural check for a job payload, so a malformed event cannot enter the map. */
function isColdJob(value: unknown): value is ColdJob {
	const job = value as Partial<ColdJob> | undefined;
	return (
		!!job &&
		typeof job.id === "string" &&
		typeof job.schedule === "string" &&
		typeof job.prompt === "string" &&
		typeof job.enabled === "boolean"
	);
}

/** `nextRun` as epoch ms, or undefined when unset or unparseable. */
export function coldNextAt(job: ColdJob): number | undefined {
	if (!job.nextRun) return undefined;
	const parsed = Date.parse(job.nextRun);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** `/loop list` row for a cold job. */
export function describeCold(job: ColdJob, now: number): string {
	const cadence = job.scheduleType === "interval" ? `every ${job.schedule}` : job.schedule;
	const nextAt = coldNextAt(job);
	const next = nextAt === undefined ? "unscheduled" : `next in ${formatSpan(Math.max(0, nextAt - now))}`;
	const state = job.enabled ? "" : " · paused";
	return `◷ ${job.id} · [cold] ${cadence} · ${next} · runs ${job.runCount} · "${truncate(job.prompt)}"${state}`;
}

/** Local copy of loop.ts's duration formatting, kept dependency-free. */
function formatSpan(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${Math.max(1, seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

function truncate(value: string, max = 60): string {
	const single = value.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
