import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Prompt-cache keep-alive for the primary model.
//
// The cache expires after the model's promptCache lifetime, so any wait longer than
// that loses it. Two waits matter:
//
//   1. A tool call is running. Pi's own warmer covers it (cacheWarming "streaming").
//   2. The primary has settled, and work will re-enter this session: a background
//      subagent is running, or a /loop job (live or cold) has its next fire armed.
//      Pi's warmer stops at settle under "streaming" and never asks again, so this
//      extension sends the refreshes itself.
//
// Refresh economics, from the same data Pi uses:
//   warmCost = prompt tokens at the cache-read price (+1 output token)
//   missCost = prompt tokens at the cache-write (or input) price, minus the cache-read price
//
// Known next fire (a loop job, no subagent running): warm only if the refreshes until
// that fire cost less than one miss; otherwise let the cache lapse and pay one miss.
// Unknown end (a background subagent is running): warm until cumulative refresh spend
// reaches one miss, then stop. The counter resets on every real request.
//
// While this extension is refreshing, it vetoes Pi's own idle refreshes so the two do
// not run in parallel.
//
// Diagnostics: every start, refresh (with its usage.cacheRead / cacheWrite), error and
// stop is appended as one JSON line to ~/.pi/agent/logs/cache-keepalive.jsonl, so a
// refresh that did or did not keep the prefix cached is visible after the fact.

const LOG_DIR = join(homedir(), ".pi", "agent", "logs");
const LOG_FILE = join(LOG_DIR, "cache-keepalive.jsonl");

// Switching the keep-alive off for a session, without touching the global setting:
//   /cache-keepalive off        turns it off for this session (persisted in the session file)
//   /cache-keepalive on         turns it back on
//   PI_CACHE_KEEPALIVE=off      launch default for sessions that have no saved choice
// When off, this extension sends no refreshes and vetoes Pi's own warm-ups too.
const STATE_ENTRY = "cache-keepalive-state";

function envDefaultEnabled(): boolean {
	const value = (process.env.PI_CACHE_KEEPALIVE ?? "").trim().toLowerCase();
	return !(["off", "0", "false", "no", "disabled"].includes(value));
}

function logEvent(event: string, data: Record<string, unknown> = {}) {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
	} catch {
		// Logging must never break the keep-alive itself.
	}
}

/** Pi refreshes at 90% of the TTL, but never later than 10 seconds before it. */
function refreshDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

type EventBus = { on(event: string, handler: (data: any) => void): unknown };
type Keepalive = {
	timer?: ReturnType<typeof setTimeout>;
	controller: AbortController;
	ctx: any;
	model: any;
	messages: unknown;
	options: Record<string, unknown>;
	delayMs: number;
	startedAt: number;
	refreshes: number;
	/** Known next fire, or undefined when a subagent of unknown length is pending. */
	fireAt?: number;
	warmCost: number;
	missCost: number;
};

export default function (pi: ExtensionAPI) {
	let warmSpent = 0;
	let notifiedCap = false;
	let keepalive: Keepalive | undefined;
	let enabled = envDefaultEnabled();

	// Work that will re-enter this session by itself.
	// Background subagents (including scheduled cold-loop runs) from start to terminal state.
	const runningSubagents = new Set<string>();
	// Armed next fires of live and cold /loop jobs, published by loop.ts as "loop:state".
	let loopFires: { id: string; nextAt: number }[] = [];

	// The transcript sent with the last real request, for replaying as a refresh.
	let lastRequest:
		| { messages: unknown; model: any; reasoning?: string; sessionId?: string }
		| undefined;

	const continuationExpected = () => runningSubagents.size > 0 || loopFires.length > 0;

	const stopKeepalive = (reason = "stopped") => {
		if (!keepalive) return;
		if (keepalive.timer) clearTimeout(keepalive.timer);
		keepalive.controller.abort();
		logEvent("stop", {
			reason,
			refreshes: keepalive.refreshes,
			elapsedMs: Date.now() - keepalive.startedAt,
			warmSpent,
			pendingSubagents: runningSubagents.size,
			loopFires: loopFires.length,
		});
		keepalive = undefined;
	};

	const reset = () => {
		warmSpent = 0;
		notifiedCap = false;
	};

	const priceOf = (model: any, tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }) => {
		const rate = model?.cost ?? {};
		return (
			((tokens.input ?? 0) * (rate.input ?? 0) +
				(tokens.output ?? 0) * (rate.output ?? 0) +
				(tokens.cacheRead ?? 0) * (rate.cacheRead ?? 0) +
				(tokens.cacheWrite ?? 0) * (rate.cacheWrite ?? 0)) /
			1_000_000
		);
	};

	// Same arithmetic as Pi's CacheWarmer.evaluate, from the last assistant usage on this branch.
	const estimateCosts = (ctx: any, model: any) => {
		const branch: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
		let promptTokens = 0;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type === "message" && entry.message?.role === "assistant") {
				const u = entry.message.usage;
				promptTokens = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
				break;
			}
		}
		const hit = priceOf(model, { cacheRead: promptTokens });
		const miss = priceOf(model, model?.cost?.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens });
		return {
			promptTokens,
			warmCost: priceOf(model, { cacheRead: promptTokens, output: 1 }),
			missCost: Math.max(0, miss - hit),
		};
	};

	const nearestFire = (): number | undefined => {
		if (loopFires.length === 0) return undefined;
		return Math.min(...loopFires.map((job) => job.nextAt));
	};

	const scheduleTick = (ka: Keepalive) => {
		ka.timer = setTimeout(() => void refresh(ka), ka.delayMs);
		ka.timer.unref?.();
	};

	const refresh = async (ka: Keepalive) => {
		ka.timer = undefined;
		if (keepalive !== ka) return;
		if (!continuationExpected()) return stopKeepalive("no pending subagent or loop fire");

		const costs = estimateCosts(ka.ctx, ka.model);
		if (costs.missCost <= 0) return stopKeepalive("no miss cost");

		// Known fire and the refreshes until it already cost more than a miss: let it lapse.
		if (ka.fireAt !== undefined) {
			const refreshesLeft = Math.ceil(Math.max(0, ka.fireAt - Date.now()) / ka.delayMs);
			if (refreshesLeft * costs.warmCost >= costs.missCost) return stopKeepalive("known fire too far away");
		}

		if (warmSpent + costs.warmCost > costs.missCost) {
			if (!notifiedCap) {
				notifiedCap = true;
				ka.ctx?.ui?.notify?.(
					`Cache keep-alive stopped: warm spend $${warmSpent.toFixed(3)} reached one miss ($${costs.missCost.toFixed(3)}).`,
					"info",
				);
			}
			return stopKeepalive("warm spend reached one miss");
		}

		try {
			const stream = ka.ctx.modelRegistry.streamSimple(
				ka.model,
				{ messages: ka.messages },
				{ ...ka.options, maxTokens: 1, maxRetries: 0, signal: ka.controller.signal },
			);
			const message = await stream.result();
			if (keepalive !== ka) return;
			const usage = message?.usage ?? {};
			ka.refreshes++;
			// The line that answers "did this refresh keep the prefix cached?": a healthy
			// refresh reads roughly promptTokens from cache and writes nothing.
			logEvent("refresh", {
				n: ka.refreshes,
				model: ka.model?.id,
				stopReason: message?.stopReason,
				errorMessage: message?.errorMessage,
				promptTokensExpected: costs.promptTokens,
				input: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				output: usage.output,
				costTotal: usage.cost?.total,
				elapsedMs: Date.now() - ka.startedAt,
				pendingSubagents: runningSubagents.size,
				loopFires: loopFires.length,
			});
			if (message?.stopReason === "error" || message?.stopReason === "aborted") {
				return stopKeepalive(`refresh ${message?.stopReason}`);
			}
			warmSpent += Number(message?.usage?.cost?.total) || costs.warmCost;
		} catch (err) {
			logEvent("refresh_error", { message: err instanceof Error ? err.message : String(err) });
			return stopKeepalive("refresh threw");
		}
		if (keepalive === ka) scheduleTick(ka);
	};

	const startKeepalive = (ctx: any) => {
		if (!enabled) return logEvent("start_skipped", { reason: "disabled for this session" });
		if (keepalive) return;
		if (!lastRequest) return logEvent("start_skipped", { reason: "no request recorded" });
		if (!continuationExpected()) return logEvent("start_skipped", { reason: "no pending subagent or loop" });
		const { model, messages, reasoning, sessionId } = lastRequest;
		if (!model) return logEvent("start_skipped", { reason: "no model" });

		// Same replay rule as Pi: an Anthropic request with thinking is only replayable on adaptive thinking.
		if (reasoning && model.api === "anthropic-messages" && model.compat?.forceAdaptiveThinking !== true) {
			return logEvent("start_skipped", { reason: "thinking not replayable", model: model.id });
		}

		const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
		const ttlSeconds = model.promptCache?.[retention];
		const delayMs = ttlSeconds === undefined ? undefined : refreshDelayMs(ttlSeconds * 1000);
		if (delayMs === undefined) {
			return logEvent("start_skipped", { reason: "no promptCache lifetime", model: model.id, retention });
		}

		const costs = estimateCosts(ctx, model);
		if (costs.missCost <= 0) {
			return logEvent("start_skipped", { reason: "no miss cost", model: model.id, promptTokens: costs.promptTokens });
		}

		// A known fire with no subagent pending: decide now whether warming beats the miss.
		const fireAt = runningSubagents.size === 0 ? nearestFire() : undefined;
		if (fireAt !== undefined) {
			const refreshesLeft = Math.ceil(Math.max(0, fireAt - Date.now()) / delayMs);
			if (refreshesLeft * costs.warmCost >= costs.missCost) {
				return logEvent("start_skipped", { reason: "known fire too far away", refreshesLeft });
			}
		}

		const options: Record<string, unknown> = {};
		if (reasoning) options.reasoning = reasoning;
		if (sessionId) options.sessionId = sessionId;

		keepalive = {
			controller: new AbortController(),
			ctx,
			model,
			messages,
			options,
			delayMs,
			startedAt: Date.now(),
			refreshes: 0,
			fireAt,
			warmCost: costs.warmCost,
			missCost: costs.missCost,
		};
		logEvent("start", {
			model: model.id,
			api: model.api,
			retention,
			delayMs,
			promptTokens: costs.promptTokens,
			missCost: costs.missCost,
			warmCost: costs.warmCost,
			reasoning: reasoning ?? null,
			hasSessionId: sessionId !== undefined,
			messageCount: Array.isArray(messages) ? messages.length : null,
			pendingSubagents: runningSubagents.size,
			loopFires: loopFires.length,
			fireAt: fireAt ?? null,
		});
		scheduleTick(keepalive);
	};

	pi.on("agent_start", () => {
		stopKeepalive("agent started");
		reset();
	});
	pi.on("turn_start", () => {
		stopKeepalive("turn started");
		reset();
	});

	pi.on("context_with_system", (event: any, ctx: any) => {
		// Read-only: this only records the transcript for a later refresh.
		const reasoning = ctx?.thinkingLevel && ctx.thinkingLevel !== "off" ? ctx.thinkingLevel : undefined;
		lastRequest = {
			messages: event?.messages,
			model: ctx?.model,
			reasoning,
			sessionId: ctx?.sessionManager?.getSessionId?.(),
		};
	});

	pi.on("agent_settled", (event: any, ctx: any) => {
		if (event?.aborted) return logEvent("settled_aborted");
		startKeepalive(ctx);
	});

	pi.on("model_select", () => stopKeepalive("model changed"));

	// The bus is bound at session_start, not at load. A listener added while the
	// extension loads is not carried into the session that follows, so the
	// subagent events never reached it (the log showed agent_settled with nothing
	// pending while a background agent was running). Released at session_shutdown
	// so a reload never leaves a second listener behind.
	let busUnbind: Array<() => void> = [];
	const unbindBus = () => {
		for (const off of busUnbind) off();
		busUnbind = [];
	};
	const bindBus = () => {
		unbindBus();
		const bus = (pi as { events?: EventBus }).events;
		logEvent("bus_bind", { hasBus: bus !== undefined, hasOn: typeof bus?.on === "function" });
		if (!bus) return;
		const listen = (channel: string, handler: (data: any) => void) => {
			const off = bus.on(channel, handler);
			if (typeof off === "function") busUnbind.push(off as () => void);
		};
		listen("subagents:started", (data: any) => {
			if (typeof data?.id !== "string") return;
			runningSubagents.add(data.id);
			logEvent("subagent_started", { id: data.id, type: data.type, pending: runningSubagents.size });
		});
		const forgetSubagent = (event: string) => (data: any) => {
			if (typeof data?.id !== "string") return;
			runningSubagents.delete(data.id);
			logEvent(event, { id: data.id, pending: runningSubagents.size });
		};
		listen("subagents:completed", forgetSubagent("subagent_completed"));
		listen("subagents:failed", forgetSubagent("subagent_failed"));
		listen("loop:state", (data: any) => {
			loopFires = Array.isArray(data?.jobs)
				? data.jobs.filter((job: any) => typeof job?.id === "string" && Number.isFinite(job?.nextAt))
				: [];
		});
	};

	pi.on("cache_warming_decision", (event: any, ctx: any) => {
		// Our own refresher is running: let it be the only one.
		if (keepalive) return { action: "stop" };
		// Keep-alive is off for this session: Pi's warm-ups are off too.
		if (!enabled && event?.action === "warm") return { action: "stop" };
		// Pi's own refreshes, during tool waits: keep the break-even cap.
		if (event?.action !== "warm") return undefined;

		const warmCost = Number(event?.warmCost) || 0;
		const missCost = Number(event?.missCost) || 0;
		if (missCost > 0 && warmSpent + warmCost > missCost) {
			if (!notifiedCap) {
				notifiedCap = true;
				ctx?.ui?.notify?.(
					`Cache keep-alive stopped: warm spend $${warmSpent.toFixed(3)} reached one miss ($${missCost.toFixed(3)}).`,
					"info",
				);
			}
			return { action: "stop" };
		}
		warmSpent += warmCost;
		return undefined;
	});

	const setEnabled = (value: boolean, ctx: any) => {
		enabled = value;
		if (!value) stopKeepalive("disabled for this session");
		pi.appendEntry(STATE_ENTRY, { enabled: value });
		logEvent("toggle", { enabled: value });
		ctx?.ui?.notify?.(statusText(), "info");
	};

	const statusText = () =>
		enabled
			? "cache keep-alive: on for this session (per-wait cap active)"
			: "cache keep-alive: off for this session (no refreshes, no Pi warm-ups)";

	pi.registerCommand("cache-keepalive", {
		description: "Turn the prompt-cache keep-alive on or off for this session: /cache-keepalive [on|off|status]",
		getArgumentCompletions: (prefix: string) => {
			const items = ["on", "off", "status"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") return setEnabled(arg === "on", ctx);
			if (arg !== "" && arg !== "status") {
				return ctx?.ui?.notify?.("Usage: /cache-keepalive [on|off|status]", "info");
			}
			ctx?.ui?.notify?.(statusText(), "info");
		},
	});

	pi.on("session_start", (_event: any, ctx: any) => {
		stopKeepalive("session start");
		reset();
		lastRequest = undefined;
		runningSubagents.clear();
		// The last saved choice for this session wins; otherwise the launch default applies.
		const entries: any[] = ctx?.sessionManager?.getEntries?.() ?? [];
		const saved = entries
			.filter((entry) => entry?.type === "custom" && entry.customType === STATE_ENTRY)
			.at(-1);
		enabled = typeof saved?.data?.enabled === "boolean" ? saved.data.enabled : envDefaultEnabled();
		logEvent("session_start", { pid: process.pid, enabled });
		bindBus();
		ctx?.ui?.notify?.(statusText(), "info");
	});

	pi.on("session_shutdown", () => {
		stopKeepalive("session shutdown");
		unbindBus();
	});
}
