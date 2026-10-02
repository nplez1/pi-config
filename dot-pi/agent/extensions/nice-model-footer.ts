/**
 * Nice Model Footer — identical to the built-in footer, except the model ID on
 * the right (e.g. "anthropic/claude-opus-4-5") is replaced by the model's
 * display name (e.g. "Claude Opus 4.5"). Nothing else is changed.
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

function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
	return cwd;
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
					// ---- auto-compact setting (global + project settings.json, project wins) ----
					const settingsAutoCompact = readCompactionEnabled([
						join(homedir(), ".pi", "agent", "settings.json"),
						join(ctx.cwd, ".pi", "settings.json"),
					]);

					// ---- usage totals from ALL session entries ----
					let input = 0,
						output = 0,
						cacheRead = 0,
						cacheWrite = 0,
						cost = 0;
					let latestCacheHitRate: number | undefined;
					const addUsage = (u: {
						input: number;
						output: number;
						cacheRead: number;
						cacheWrite: number;
						cost: { total: number };
					}) => {
						input += u.input;
						output += u.output;
						cacheRead += u.cacheRead;
						cacheWrite += u.cacheWrite;
						cost += u.cost.total;
					};
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const u = (entry.message as AssistantMessage).usage;
							addUsage(u);
							const latestPromptTokens = u.input + u.cacheRead + u.cacheWrite;
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
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent =
						contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

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
					if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
					if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);
					if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					// Kimi Coding is subscription-backed despite using API-key auth.
					const usingSubscription = ctx.model
						? ctx.model.provider === "kimi-coding" ||
							(ctx.modelRegistry.isUsingOAuth(ctx.model) &&
								ctx.modelRegistry.getProvider(ctx.model.provider)?.auth?.oauth?.isSubscription === true)
						: false;
					if (cost || usingSubscription) {
						statsParts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					let contextPercentStr: string;
					const autoIndicator = settingsAutoCompact ? " (auto)" : "";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
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

					// ---- model on the right: display name instead of ID (the only change) ----
					const modelName = ctx.model?.name || ctx.model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = ctx.thinkingLevel || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off"
								? `${modelName} • thinking off`
								: `${modelName} • ${thinkingLevel}`;
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

					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.filter(([key]) => key !== "deepseek-pricing") // rendered after the model name instead
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) =>
								text
									.replace(/[\r\n\t]/g, " ")
									.replace(/ +/g, " ")
									.trim(),
							);
						const statusLine = sortedStatuses.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
