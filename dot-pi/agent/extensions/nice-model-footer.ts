/**
 * Nice Model Footer — the built-in footer with three changes:
 *  - the model ID on the right (e.g. "anthropic/claude-opus-4-5") is replaced by
 *    an abbreviated display name (e.g. "Deepseek v4.1 Flash" -> "DSv4.1Flash");
 *  - smart-compaction's idle threshold moves into the context-usage parentheses
 *    ("(auto, idle≥24.0h)") instead of rendering its own status line;
 *  - deepseek's peak/off-peak tier follows the model name.
 *
 * Mirrors dist/modes/interactive/components/footer.js of pi-coding-agent.
 */

import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Token counts with no decimal point, for the context window: 1000000 → "1M".
 *
 * The ↑/↓ counters keep their decimal because they are read as magnitudes, while
 * the window is a fixed capacity — "1.0M" there is a decimal that never changes.
 */
function formatTokensWhole(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Dollars at two decimals, with the leading zero dropped below a dollar:
 * 0.084 → "$.08", 1.234 → "$1.23". Two decimals is the resolution a session
 * actually moves in, and the dropped zero buys back a column.
 */
function formatCost(total: number): string {
	if (total <= 0) return "$0";
	const fixed = total.toFixed(2);
	return fixed.startsWith("0.") ? `$${fixed.slice(1)}` : `$${fixed}`;
}

function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
	return cwd;
}

/**
 * Footer labels, keyed "provider/modelId". Models listed here are shown exactly
 * as written; anything else falls through to `abbreviateModelName`.
 */
const MODEL_ABBREVIATIONS: Record<string, string> = {
	"deepseek/deepseek-flash": "DSv4.1Flash",
	"deepseek/deepseek-flash-auto": "Auto",
	"deepseek/deepseek-v4-pro": "DSv4Pro",
	"deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017": "v4.1Flash v1017",
	"xiaomi/mimo-v2.6-flash": "MiMoV2.6Flash",
	"xiaomi/mimo-v2.6-pro": "MiMoV2.6Pro",
	"xiaomi/mimo-v2.6-pro-ultraspeed": "MiMoV2.6ProUltra",
	"typesafe/jev-latest": "Jev",
	"fireworks/accounts/fireworks/models/deepseek-v4p1-flash": "DSv4.1Flash",
	"fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017": "DSv4.1Flash1017",
	"fireworks/accounts/fireworks/models/deepseek-v4-flash-0731": "DSv4Flash0731",
	"fireworks/accounts/fireworks/models/ember-1": "Ember1",
	"fireworks/accounts/fireworks/models/glm-5p3": "GLM5.3",
	"fireworks/accounts/fireworks/models/glm-5p3-flash": "GLM5.3Flash",
	"fireworks/accounts/fireworks/models/gpt-oss-120b": "GPTOSS120B",
	"fireworks/accounts/fireworks/models/inkling": "Inkling",
	"fireworks/accounts/fireworks/models/kimi-k3": "KimiK3",
	"fireworks/accounts/fireworks/models/minimax-m3": "MiniMaxM3",
	"fireworks/accounts/fireworks/models/minimax-m3p1-flash": "MiniMaxM3.1Flash",
	"fireworks/accounts/fireworks/models/muse-spark-open": "MuseSparkOpen",
	"fireworks/accounts/fireworks/models/nemotron-3-ultra-nvfp4": "Nemotron3Ultra550B",
	"fireworks/accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b": "Nemotron3.5Lightning",
	"fireworks/accounts/fireworks/models/qwen3p8-2p4t-a95b": "Qwen3.8A95B",
	"fireworks/accounts/fireworks/models/qwen3p8-max": "Qwen3.8Max",
	"fireworks/accounts/fireworks/routers/deepseek-flash-latest": "DSFlashLatest",
	"fireworks/accounts/fireworks/routers/deepseek-v4p1-flash-1017-spot": "DSv4.1Flash1017Spot",
	"fireworks/accounts/fireworks/routers/deepseek-v4p1-flash-spot": "DSv4.1FlashSpot",
	"fireworks/accounts/fireworks/routers/glm-5p3-fast": "GLM5.3Fast",
	"fireworks/accounts/fireworks/routers/glm-5p3-spot": "GLM5.3Spot",
	"fireworks/accounts/fireworks/routers/glm-fast-latest": "GLM5.3FastLatest",
	"fireworks/accounts/fireworks/routers/glm-flash-latest": "GLMFlashLatest",
	"fireworks/accounts/fireworks/routers/glm-latest": "GLMLatest",
	"fireworks/accounts/fireworks/routers/kimi-fast-latest": "KimiFastLatest",
	"fireworks/accounts/fireworks/routers/kimi-k3-fast": "KimiK3Fast",
	"fireworks/accounts/fireworks/routers/kimi-k3-spot": "KimiK3Spot",
	"fireworks/accounts/fireworks/routers/kimi-latest": "KimiLatest",
	"fireworks/accounts/fireworks/routers/minimax-latest": "MiniMaxLatest",
	"fireworks/accounts/fireworks/routers/qwen-max-latest": "QwenMaxLatest",
	"m5-omlx/Qwen3.8-27B-oQ4e-mtp": "Qwen3.8-27B-oQ4e",
	"m5-omlx/Qwen3.8-27B_Uncen-oQ4e": "Qwen3.8-27B-UNCEN",
	"omlx/Qwen3.6-35B-A3B-oQ6-mtp": "Q3.6-35B",
	"omlx/Qwen3.6-35B-A3B-oQ4-mtp": "Q3.6-35B",
	"omlx/Qwen3.6-27B-oQ4-fp16-mtp": "Q3.6-27B",
	"omlx/Qwen3.8-27B-oQ4e-fp16-mtp": "Q3.8-27B",
	"omlx/Laguna-S-2.1-oQ4e": "Laguna-S2.1",
	"omlx/Ornith-1.5-35B-A3B-oQ4e-fp16-mtp": "Ornith1.5-35B",
};

/** Vendor words shortened when a model has no explicit label. */
const VENDOR_ACRONYMS: Record<string, string> = {
	deepseek: "DS",
	minimax: "MiniMax",
	mimo: "MiMo",
	qwen: "Q",
};

/** Quantization/runtime tails an id can lose, e.g. "-oQ4e-fp16-mtp". */
const QUANT_TAIL = /-(?:mtp|fp\d+|oq\d+[a-z]?|nvfp4)$/i;

/** "Deepseek v4.1 Flash" -> "DSv4.1Flash"; keeps dots, drops spaces and dashes. */
function abbreviateModelName(name: string): string {
	let short = name.trim();
	for (let i = 0; i < 8; i++) {
		const next = short.replace(QUANT_TAIL, "");
		if (next === short) break;
		short = next;
	}
	const words = short.split(/[\s-]+/).filter(Boolean);
	if (words.length === 0) return short;
	const head = VENDOR_ACRONYMS[words[0].toLowerCase()] ?? words[0];
	return head + words.slice(1).join("");
}

/** Abbreviated footer label for the active model. */
function footerModelLabel(model: { provider: string; id: string; name?: string } | undefined): string {
	if (!model) return "no-model";
	const mapped = MODEL_ABBREVIATIONS[`${model.provider}/${model.id}`];
	if (mapped) return mapped;
	return abbreviateModelName(model.name || model.id.split("/").pop() || model.id);
}

/**
 * Label for the model a virtual selection actually used, e.g. the arrow in
 * "(deepseek) Auto • high → v4.1Flash v1017 (DeepInfra)". A curated label wins
 * over the catalog name, which is long; because it also drops the provider
 * words, the provider goes back in parentheses so the footer still says which
 * side answered. Uncurated models keep their full name.
 */
function routedModelLabel(
	registry: { getProviderDisplayName?: (provider: string) => string },
	physical: { provider: string; id: string; name?: string } | undefined,
	fallbackId: string,
): string {
	if (!physical) return fallbackId;
	const mapped = MODEL_ABBREVIATIONS[`${physical.provider}/${physical.id}`];
	if (!mapped) return physical.name ?? fallbackId;
	let provider: string | undefined;
	try {
		provider = registry.getProviderDisplayName?.(physical.provider);
	} catch {
		provider = undefined;
	}
	return provider ? `${mapped} (${provider})` : mapped;
}

/**
 * smart-compaction publishes "armed · ≥88k · idle≥24.0h"; only the idle
 * threshold belongs in the footer, so the rest of that status stays off-screen.
 */
const SMART_COMPACTION_STATUS = "smart-compaction";
function idleThresholdLabel(statuses: ReadonlyMap<string, string>): string | undefined {
	return statuses.get(SMART_COMPACTION_STATUS)?.match(/idle≥\S+/)?.[0];
}

/**
 * `/loop` publishes "◷ 1 loop · next in 4m 30s". It belongs on the path line —
 * a scheduled loop is a property of where the session is running, and a second
 * status row for one countdown costs a line for the whole session.
 */
const LOOP_STATUS = "loop";

/** Statuses that render somewhere other than the trailing status row. */
const STATUSES_RENDERED_ELSEWHERE = new Set(["deepseek-pricing", SMART_COMPACTION_STATUS, LOOP_STATUS]);

/** Footer statuses are single-line by contract; flatten anything an extension lets through. */
function normalizeStatusText(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const flat = text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
	return flat || undefined;
}

/**
 * The path/branch row, with the loop call-out appended to it.
 *
 * The path is what gets truncated when the two do not fit, because the countdown
 * is the part that changes and the part a person is looking for; a truncated path
 * still identifies the directory.
 */
function composePwdLine(
	pwd: string,
	loopStatus: string | undefined,
	width: number,
	dim: (text: string) => string,
): string {
	if (!loopStatus) return truncateToWidth(dim(pwd), width, dim("..."));
	const tail = ` • ${loopStatus}`;
	const tailWidth = visibleWidth(tail);
	if (tailWidth >= width) return truncateToWidth(dim(loopStatus), width, dim("..."));
	const room = width - tailWidth;
	const head = visibleWidth(pwd) > room ? truncateToWidth(pwd, room, "...") : pwd;
	return truncateToWidth(dim(`${head}${tail}`), width, dim("..."));
}

/** Read compaction.enabled from global + project settings.json (project wins). */
const settingsCache = new Map<string, { mtime: number; enabled: boolean | undefined }>();
function readCompactionEnabled(paths: string[]): boolean {
	let enabled = true;
	for (const p of paths) {
		try {
			const mtime = statSync(p).mtimeMs;
			let cached = settingsCache.get(p);
			if (!cached || cached.mtime !== mtime) {
				const json = JSON.parse(readFileSync(p, "utf8"));
				const value = json?.compaction?.enabled;
				cached = { mtime, enabled: typeof value === "boolean" ? value : undefined };
				settingsCache.set(p, cached);
			}
			if (cached.enabled !== undefined) enabled = cached.enabled;
		} catch {
			settingsCache.delete(p);
		}
	}
	return enabled;
}

export default function (pi: ExtensionAPI) {
	let installed = false;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || installed) return;
		installed = true;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsub();
				},
				invalidate() {},
				render(width: number): string[] {
					const extensionStatuses = footerData.getExtensionStatuses();

					// ---- auto-compact setting (global + project settings.json, project wins) ----
					const settingsAutoCompact = readCompactionEnabled([
						join(homedir(), ".pi", "agent", "settings.json"),
						join(ctx.cwd, ".pi", "settings.json"),
					]);

					// ---- usage totals from ALL session entries ----
					// Cache read/write are deliberately not totalled: they are per-request
					// magnitudes that only mean something as a hit rate, so the footer shows
					// the latest request's rate instead of two ever-growing counters.
					let input = 0,
						output = 0,
						cost = 0;
					let latestCacheHitRate: number | undefined;
					let latestHadCacheTraffic = false;
					const addUsage = (u: {
						input: number;
						output: number;
						cost: { total: number };
					}) => {
						input += u.input;
						output += u.output;
						cost += u.cost.total;
					};
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const u = (entry.message as AssistantMessage).usage;
							addUsage(u);
							const latestPromptTokens = u.input + u.cacheRead + u.cacheWrite;
							latestHadCacheTraffic = u.cacheRead > 0 || u.cacheWrite > 0;
							latestCacheHitRate =
								latestPromptTokens > 0 ? (u.cacheRead / latestPromptTokens) * 100 : undefined;
						} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
							addUsage(entry.message.usage);
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
							addUsage(entry.usage);
						}
					}

					// ---- context usage ----
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					// Colour thresholds still read the raw value, so 70.4% warns even though
					// it renders as "70%".
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent =
						contextUsage?.percent == null ? "?" : String(Math.round(contextUsage.percent));

					// ---- pwd line ----
					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// ---- stats line (left) ----
					const statsParts: string[] = [];
					if (input) statsParts.push(`↑${formatTokens(input)}`);
					if (output) statsParts.push(`↓${formatTokens(output)}`);
					if (latestHadCacheTraffic && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${Math.round(latestCacheHitRate)}%`);
					}
					// Kimi Coding is subscription-backed despite using API-key auth.
					const usingSubscription = ctx.model
						? ctx.model.provider === "kimi-coding" ||
							(ctx.modelRegistry.isUsingOAuth(ctx.model) &&
								ctx.modelRegistry.getProvider(ctx.model.provider)?.auth?.oauth?.isSubscription === true)
						: false;
					if (cost || usingSubscription) {
						statsParts.push(`${formatCost(cost)}${usingSubscription ? " (sub)" : ""}`);
					}

					let contextPercentStr: string;
					// Context-usage parentheses: the auto-compact flag plus smart-compaction's
					// idle threshold, e.g. "(auto, idle≥24.0h)".
					const compactionNotes = [
						settingsAutoCompact ? "auto" : undefined,
						idleThresholdLabel(extensionStatuses),
					].filter((note): note is string => note !== undefined);
					const compactionIndicator =
						compactionNotes.length > 0 ? ` (${compactionNotes.join(", ")})` : "";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokensWhole(contextWindow)}${compactionIndicator}`
							: `${contextPercent}%/${formatTokensWhole(contextWindow)}${compactionIndicator}`;
					if (contextPercentValue > 90) {
						contextPercentStr = theme.fg("error", contextPercentDisplay);
					} else if (contextPercentValue > 70) {
						contextPercentStr = theme.fg("warning", contextPercentDisplay);
					} else {
						contextPercentStr = contextPercentDisplay;
					}
					statsParts.push(contextPercentStr);

					if (process.env.PI_EXPERIMENTAL === "1") {
						statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
					}

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// ---- model on the right: abbreviated display name instead of ID ----
					const modelName = footerModelLabel(ctx.model);
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = ctx.thinkingLevel || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off"
								? `${modelName} • thinking off`
								: `${modelName} • ${thinkingLevel}`;
					}
					// A virtual model routes each request; show where the latest response
					// went, e.g. "Fusion/Standard → GPT-6 Luna". The transcript records
					// the physical model on each assistant message.
					if (ctx.model?.api === "pi-virtual") {
						const latest = ctx.sessionManager
							.getBranch()
							.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
						if (latest?.type === "message" && latest.message.role === "assistant") {
							const physical = ctx.modelRegistry.find(latest.message.provider, latest.message.model);
							rightSideWithoutProvider += ` → ${routedModelLabel(
								ctx.modelRegistry,
								physical,
								latest.message.model,
							)}`;
						}
					}
					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}

					// ---- deepseek peak/off-peak indicator, after the model name ----
					const deepseekStatus = footerData.getExtensionStatuses().get("deepseek-pricing");
					if (deepseekStatus) {
						rightSide = `${rightSide} • ${deepseekStatus}`;
					}

					const minPadding = 2;
					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
					let statsLine: string;
					if (totalNeeded <= width) {
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);

					const pwdLine = composePwdLine(
						pwd,
						normalizeStatusText(extensionStatuses.get(LOOP_STATUS)),
						width,
						(text) => theme.fg("dim", text),
					);

					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							// Rendered elsewhere: deepseek after the model name, smart-compaction
							// inside the context-usage parentheses, loop on the path line.
							.filter(([key]) => !STATUSES_RENDERED_ELSEWHERE.has(key))
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => normalizeStatusText(text));
						const statusLine = sortedStatuses.filter(Boolean).join(" ");
						// A status line that filtered down to nothing must not leave a blank row.
						if (statusLine) lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
