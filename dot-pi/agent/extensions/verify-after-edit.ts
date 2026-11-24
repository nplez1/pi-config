/**
 * verify-after-edit.ts — run the project's check yourself, so the agent does not spend a
 * turn asking for it.
 *
 * Every edit in a checked project is followed by the same command. Measured across this
 * machine's sessions: 6,478 verification commands in 62.8k turns (9.9% of all turns), with
 * `edit -> bash:typecheck` at 1,118 and `edit -> bash:test` at 1,401 in the transition
 * graph. Running `pnpm tc` alone was issued 120 times verbatim. The model is not confused;
 * it is doing the only thing it can, which is to end a turn with an edit and start the next
 * one issuing the check.
 *
 * This handler closes that seam. When a turn edits files, the configured command runs at
 * the boundary and its result is appended as a message, so the very next request already
 * contains the outcome. Three turns (edit / issue check / read result) become two.
 *
 * Deliberate limits, because a check that runs when it is not wanted is worse than none:
 *
 *   - Opt-in. With no config there are no commands and this file does nothing.
 *   - The check the model already ran this turn is not run again.
 *   - An identical (command, file-set) pair is not re-run within DEBOUNCE_MS.
 *   - `continue` is never set: a tool result already forces the next request, and forcing
 *     one unconditionally is how a boundary handler becomes an infinite loop.
 *   - A message says plainly that the extension ran it, so the model does not think it
 *     issued the command itself and try to reconcile that with what it remembers doing.
 *
 * Config: `~/.pi/agent/verify.json`, plus an optional `<project>/.pi/verify.json` override.
 *
 *   {
 *     "byName": {
 *       "orca": {
 *         "commands": ["pnpm tc"],
 *         "requires": ["node_modules"]
 *       }
 *     },
 *     "default": { "commands": [] }
 *   }
 *
 * `requires` names paths that must exist in the directory the command runs in. A worktree
 * that has not been installed yet is the case it exists for: the check stays inert there
 * instead of failing on a missing dependency and reading as a broken edit.
 *
 * Pure helpers over (turn, config) so `node --test` can exercise them; the only import is
 * type-only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Resolved per call so a test (or a user) can point the extension at another file. */
export function globalConfigPath(): string {
  return process.env.PI_VERIFY_CONFIG || join(homedir(), ".pi", "agent", "verify.json");
}

/** An identical (command, files) run inside this window is skipped. */
export const DEBOUNCE_MS = 10_000;
/** Output lines kept from the front of a check's output. */
const MAX_OUTPUT_LINES = 100;
/** Hard cap on the appended message. */
const MAX_MESSAGE_CHARS = 8000;

export interface VerifyConfig {
  commands: string[];
  timeoutSeconds: number;
  /** Command prefix; `sh` on POSIX, overridable for a different shell. */
  shell?: string;
  /** File extensions that count as an edit worth checking. Empty means any. */
  extensions?: string[];
  /** Path fragments to skip, e.g. "node_modules" or "dist". */
  ignorePaths?: string[];
  /**
   * Paths that must exist before the checks mean anything, resolved against the `runIn`
   * directory. A fresh worktree has no `node_modules`, so `pnpm tc` there fails for
   * reasons that have nothing to do with the edit; naming the requirement skips the run
   * until it is installed instead of reporting a guaranteed failure every turn.
   */
  requires?: string[];
  /** Upper bound on automatic runs per session. */
  maxPerSession?: number;
  /**
   * Where the command runs. Project-level checks (`pnpm tc`) are root-relative, so the
   * default runs them at the project root even when the session opened in a subdirectory.
   */
  runIn?: "project-root" | "cwd";
}

export interface VerifyConfigFile {
  /** Absolute path prefixes or glob patterns, longest/most literal match wins. */
  projects?: Record<string, Partial<VerifyConfig>>;
  /** Keyed by the repo's `package.json` name, so a checkout works wherever it lives. */
  byName?: Record<string, Partial<VerifyConfig>>;
  default?: Partial<VerifyConfig>;
}

const DEFAULTS: VerifyConfig = { commands: [], timeoutSeconds: 180, runIn: "project-root" };

/** Merge a partial config over the base, normalising the list fields. */
export function withDefaults(base: VerifyConfig, partial: Partial<VerifyConfig> | undefined): VerifyConfig {
  if (!partial) return base;
  return {
    commands: Array.isArray(partial.commands) ? partial.commands.filter((c) => typeof c === "string" && c.trim()) : base.commands,
    timeoutSeconds:
      typeof partial.timeoutSeconds === "number" && partial.timeoutSeconds > 0 ? partial.timeoutSeconds : base.timeoutSeconds,
    shell: typeof partial.shell === "string" && partial.shell ? partial.shell : base.shell,
    extensions: Array.isArray(partial.extensions) ? partial.extensions : base.extensions,
    ignorePaths: Array.isArray(partial.ignorePaths) ? partial.ignorePaths : base.ignorePaths,
    requires: Array.isArray(partial.requires)
      ? partial.requires.filter((r) => typeof r === "string" && r.trim())
      : base.requires,
    maxPerSession: typeof partial.maxPerSession === "number" ? partial.maxPerSession : base.maxPerSession,
    runIn: partial.runIn === "cwd" || partial.runIn === "project-root" ? partial.runIn : base.runIn,
  };
}

/** Boundary-aware prefix match: `/a/b` matches `/a/b` and `/a/b/c`, never `/a/bc`. */
export function matchesProject(cwd: string, prefix: string): boolean {
  if (!prefix) return false;
  const clean = prefix.replace(/\/+$/, "");
  return cwd === clean || cwd.startsWith(`${clean}/`);
}

/**
 * Requirements absent from `dir`, as written in the config.
 *
 * A dependency install is the common case: `pnpm tc` in a worktree with no `node_modules`
 * fails on the first import, which reads as a broken edit rather than a missing install.
 * Skipping keeps the check honest — it reports real failures only.
 */
export function missingRequirements(
  requires: string[] | undefined,
  dir: string,
  exists: (path: string) => boolean,
): string[] {
  if (!requires || requires.length === 0) return [];
  return requires.filter((req) => !exists(isAbsolute(req) ? req : join(dir, req)));
}

/**
 * Match a cwd against a path pattern, which may be a plain prefix or contain `*` / `**`.
 * Globs let one entry cover every worktree root a tool invents, without listing them.
 */
export function matchesPathPattern(cwd: string, pattern: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes("*")) return matchesProject(cwd, pattern);
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\/+$/, "");
  // The pattern may name a directory the cwd sits inside, so accept a trailing segment too.
  return new RegExp(`^${source}$`).test(cwd) || new RegExp(`^${source}/`).test(cwd);
}

/** How specific a pattern is: literal characters it pins down. Longest literal wins. */
export function patternSpecificity(pattern: string): number {
  return pattern.replace(/\*/g, "").length;
}

/** The most specific matching path entry, by literal length, so nested projects win. */
export function pickProject(
  cwd: string,
  projects: Record<string, Partial<VerifyConfig>> | undefined,
): { pattern: string; config: Partial<VerifyConfig> } | null {
  if (!projects) return null;
  let best: { pattern: string; config: Partial<VerifyConfig>; specificity: number } | null = null;
  for (const [pattern, config] of Object.entries(projects)) {
    if (!matchesPathPattern(cwd, pattern)) continue;
    const specificity = patternSpecificity(pattern);
    if (!best || specificity > best.specificity) best = { pattern, config, specificity };
  }
  return best ? { pattern: best.pattern, config: best.config } : null;
}

export type ConfigSource =
  | { kind: "project-file"; path: string }
  | { kind: "path-pattern"; pattern: string }
  | { kind: "repo-name"; name: string }
  | { kind: "default" }
  | { kind: "none" };

/** One line explaining which config applied, for `/verify` and for support questions. */
export function describeSource(source: ConfigSource): string {
  switch (source.kind) {
    case "project-file":
      return `the tracked config at ${source.path}`;
    case "path-pattern":
      return `the "projects" entry \`${source.pattern}\``;
    case "repo-name":
      return `the "byName" entry for package.json name \`${source.name}\``;
    case "default":
      return "the \"default\" entry";
    default:
      return "no config (verify-after-edit is inert)";
  }
}

export interface ResolveInput {
  cwd: string;
  globalFile: VerifyConfigFile | null;
  /** Contents of the nearest `.pi/verify.json`, found by walking up from the cwd. */
  localFile?: Partial<VerifyConfig> | null;
  /** Where that file was found, for reporting. */
  localPath?: string | null;
  /** `package.json` name at the project root, when one exists. */
  repoName?: string | null;
}

/**
 * Resolve the effective config, most specific source first:
 *
 *   1. the tracked `.pi/verify.json` in the repo — it travels into every worktree,
 *      fork and clone, which is why it outranks everything machine-local;
 *   2. a matching `projects` path prefix or glob (most literal characters wins);
 *   3. a `byName` entry for the repo's package.json name, so a checkout works
 *      wherever it happens to live;
 *   4. `default`.
 *
 * Each step refines the previous one, so a path entry can set a timeout that the
 * repo's own file leaves alone.
 */
export function resolveConfig(input: ResolveInput): { config: VerifyConfig; source: ConfigSource } {
  const { cwd, globalFile, localFile, localPath, repoName } = input;
  let config = withDefaults(DEFAULTS, globalFile?.default);
  let source: ConfigSource = globalFile?.default ? { kind: "default" } : { kind: "none" };

  if (repoName && globalFile?.byName?.[repoName]) {
    config = withDefaults(config, globalFile.byName[repoName]);
    source = { kind: "repo-name", name: repoName };
  }

  const picked = pickProject(cwd, globalFile?.projects);
  if (picked) {
    config = withDefaults(config, picked.config);
    source = { kind: "path-pattern", pattern: picked.pattern };
  }

  if (localFile) {
    config = withDefaults(config, localFile);
    source = { kind: "project-file", path: localPath ?? `${cwd}/.pi/verify.json` };
  }

  return { config, source };
}

export interface TurnMessage {
  content?: unknown;
}

export interface TurnToolResult {
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface ToolCallBlock {
  type: "toolCall";
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

function toolCalls(message: TurnMessage | undefined): ToolCallBlock[] {
  const blocks = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
  return blocks.filter((b) => b?.type === "toolCall") as unknown as ToolCallBlock[];
}

/**
 * Files this turn actually changed: an `edit`/`write` call whose result is not an error.
 * A failed edit wrote nothing, so checking for it would be checking the previous state.
 */
export function collectEditedPaths(message: TurnMessage | undefined, toolResults: TurnToolResult[]): string[] {
  const failed = new Set(toolResults.filter((r) => r?.isError).map((r) => r?.toolCallId));
  const paths = new Set<string>();
  for (const call of toolCalls(message)) {
    if (call.name !== "edit" && call.name !== "write") continue;
    if (call.id && failed.has(call.id)) continue;
    const path = call.arguments?.path;
    if (typeof path === "string" && path.length > 0) paths.add(path);
  }
  return [...paths];
}

/** Bash commands the model issued itself this turn, so the check is not run twice. */
export function collectBashCommands(message: TurnMessage | undefined): string[] {
  return toolCalls(message)
    .filter((call) => call.name === "bash")
    .map((call) => call.arguments?.command)
    .filter((command): command is string => typeof command === "string");
}

/** True when the model itself issued this exact check in the turn just ended. */
export function alreadyRan(command: string, turnCommands: string[]): boolean {
  const needle = command.trim();
  return needle.length > 0 && turnCommands.some((issued) => issued.includes(needle));
}

/** The configured checks still worth running: those the turn did not already issue. */
export function commandsToRun(commands: string[], turnCommands: string[]): string[] {
  return commands.filter((command) => !alreadyRan(command, turnCommands));
}

/**
 * Apply the extension and ignore filters to the edited paths.
 *
 * An ignore entry names a whole path segment, so `dist` skips `src/dist/x.ts` without also
 * skipping `src/distribution.ts`. Substring matching would do the opposite on both counts.
 */
export function filterPaths(paths: string[], config: VerifyConfig): string[] {
  const extensions = (config.extensions ?? []).map((e) => (e.startsWith(".") ? e : `.${e}`)).map((e) => e.toLowerCase());
  const ignores = (config.ignorePaths ?? [])
    .filter((i): i is string => typeof i === "string")
    .map((entry) => entry.replace(/^\/+|\/+$/g, "").toLowerCase())
    .filter((entry) => entry.length > 0);
  return paths.filter((path) => {
    const lower = path.toLowerCase();
    if (ignores.length > 0 && lower.split("/").some((segment) => ignores.includes(segment))) return false;
    if (extensions.length === 0) return true;
    return extensions.some((extension) => lower.endsWith(extension));
  });
}

export interface RenderedRun {
  command: string;
  code: number;
  killed: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Trim a run's output to something a model can act on without flooding the context. */
export function trimOutput(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  if (lines.length <= MAX_OUTPUT_LINES) return lines.join("\n");
  return `${lines.slice(0, MAX_OUTPUT_LINES).join("\n")}\n… [${lines.length - MAX_OUTPUT_LINES} more line(s) omitted — rerun the command directly if you need the rest]`;
}

/** The message appended at the boundary. */
export function renderVerifyMessage(files: string[], runs: RenderedRun[], failed: boolean): string {
  const head = runs
    .map((run) => {
      const status = run.killed ? "timed out" : run.code === 0 ? "passed" : `exit ${run.code}`;
      return `\`${run.command}\` — ${status} (${(run.durationMs / 1000).toFixed(1)}s)`;
    })
    .join("; ");
  const list = files.length === 1 ? files[0] : `${files.length} files (${files.slice(0, 6).join(", ")}${files.length > 6 ? ", …" : ""})`;
  const parts = [
    `[verify-after-edit] The extension ran the project check itself after your edit to ${list}. Do not run it again this turn.`,
    head,
  ];
  for (const run of runs) {
    const body = trimOutput([run.stdout, run.stderr].filter((s) => s && s.trim()).join("\n"));
    if (!body) continue;
    parts.push(`\n--- ${run.command} ---\n${body}`);
  }
  if (failed) parts.push(`\nFix what this reports before moving on.`);
  let text = parts.join("\n");
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}\n… [verify output truncated]`;
  return text;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface ProjectDiscovery {
  /** Nearest ancestor holding `.git`, or the cwd when there is none. */
  root: string;
  /** The nearest `.pi/verify.json`, wherever it lives in the tree. */
  verifyFile: string | null;
}

/**
 * Find the project a cwd belongs to, walking upward.
 *
 * A worktree's root is not always the cwd: an agent launched in a subdirectory, or a tool
 * that points a session at `packages/app`, must still find the config the repo tracks. The
 * walk also copes with a worktree whose `.git` is a file rather than a directory, which is
 * what `git worktree add` produces.
 *
 * `exists` is injected so the walk is testable without a filesystem.
 */
export function discoverProject(cwd: string, exists: (path: string) => boolean, maxDepth = 40): ProjectDiscovery {
  const configPath = (dir: string) => join(dir, ".pi", "verify.json");
  let verifyFile: string | null = null;
  let gitRoot: string | null = null;

  // Check the cwd's own directory first, then each ancestor up to the git root.
  if (exists(configPath(cwd))) verifyFile = configPath(cwd);
  let dir = cwd;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (exists(join(dir, ".git"))) {
      gitRoot = dir;
      if (!verifyFile && exists(configPath(dir))) verifyFile = configPath(dir);
      break;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
    if (!verifyFile && exists(configPath(dir))) verifyFile = configPath(dir);
  }

  // The root is where package.json should be read from. Prefer the git root; without one,
  // the directory that declared the config is the closest thing to a project boundary.
  // Falling back to the filesystem root would look for /package.json, which is never right.
  const configDir = verifyFile ? resolve(verifyFile, "..", "..") : null;
  return { root: gitRoot ?? configDir ?? cwd, verifyFile };
}

/** `package.json` name at a project root, used for `byName` matching. */
async function readRepoName(root: string): Promise<string | null> {
  const pkg = await readJson<{ name?: unknown }>(join(root, "package.json"));
  return typeof pkg?.name === "string" && pkg.name.trim() ? pkg.name.trim() : null;
}

export default function (pi: ExtensionAPI) {
  let config: VerifyConfig = { ...DEFAULTS };
  let source: ConfigSource = { kind: "none" };
  let loadedFor: string | undefined;
  let projectRoot: string | undefined;
  let runsThisSession = 0;
  let inFlight = false;
  let lastRun: { key: string; at: number } | null = null;
  let warned = false;

  const load = async (cwd: string) => {
    const globalFile = await readJson<VerifyConfigFile>(globalConfigPath());
    // Resolved per cwd, so a session that changes directory picks up that project.
    const found = discoverProject(cwd, existsSync);
    const localFile = found.verifyFile ? await readJson<Partial<VerifyConfig>>(found.verifyFile) : null;
    const repoName = await readRepoName(found.root);
    const resolved = resolveConfig({
      cwd,
      globalFile,
      localFile,
      localPath: found.verifyFile,
      repoName,
    });
    config = resolved.config;
    source = resolved.source;
    projectRoot = found.root;
    loadedFor = cwd;
  };

  pi.on("session_start", async (_event, ctx) => {
    runsThisSession = 0;
    inFlight = false;
    lastRun = null;
    warned = false;
    await load(ctx.cwd);
  });

  pi.on("turn_end", async (event, ctx) => {
    if (event.outcome !== "completed") return undefined;
    if (inFlight) return undefined;

    const edited = collectEditedPaths(event.message as TurnMessage, event.toolResults as TurnToolResult[]);
    if (edited.length === 0) return undefined;

    if (loadedFor !== ctx.cwd) await load(ctx.cwd);
    if (config.commands.length === 0) return undefined;
    if (config.maxPerSession !== undefined && runsThisSession >= config.maxPerSession) return undefined;

    const runDir = config.runIn === "cwd" ? ctx.cwd : (projectRoot ?? ctx.cwd);
    // Missing prerequisites (a worktree with no install) would fail for reasons unrelated
    // to the edit, so stay inert rather than teach the model to ignore this message.
    if (missingRequirements(config.requires, runDir, existsSync).length > 0) return undefined;

    const relevant = filterPaths(edited, config);
    if (relevant.length === 0) return undefined;

    const commands = commandsToRun(config.commands, collectBashCommands(event.message as TurnMessage));
    // Every configured command was already run by the model in this turn: the result it
    // needs is already in the transcript, so appending another would be noise.
    if (commands.length === 0) return undefined;

    const key = `${commands.join("\u0000")}\u0001${[...relevant].sort().join("\u0000")}`;
    if (lastRun && lastRun.key === key && Date.now() - lastRun.at < DEBOUNCE_MS) return undefined;

    if (ctx.signal?.aborted) return undefined;

    inFlight = true;
    const runs: RenderedRun[] = [];
    try {
      for (const command of commands) {
        const started = Date.now();
        // A shell string, not argv: these configs are the same commands the model types,
        // and they routinely use env prefixes, pipes, and `&&`.
        const result = await pi.exec(config.shell ?? "sh", ["-c", command], {
          cwd: runDir,
          timeout: (config.timeoutSeconds ?? DEFAULTS.timeoutSeconds) * 1000,
          signal: ctx.signal,
          maxBuffer: 4 * 1024 * 1024,
        });
        runs.push({
          command,
          code: result.code,
          killed: result.killed,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - started,
        });
        // Stop at the first failure: a later check usually depends on the earlier one.
        if (result.code !== 0 || result.killed) break;
        if (ctx.signal?.aborted) break;
      }
    } catch (error) {
      if (!warned && ctx.hasUI) {
        warned = true;
        ctx.ui.notify(`verify-after-edit could not run: ${(error as Error).message}`, "warning");
      }
      inFlight = false;
      return undefined;
    }
    inFlight = false;

    if (runs.length === 0) return undefined;
    runsThisSession += 1;
    lastRun = { key, at: Date.now() };

    const failed = runs.some((run) => run.code !== 0 || run.killed);
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: "verify-after-edit",
          content: renderVerifyMessage(relevant, runs, failed),
          display: true,
        },
      ],
    };
  });

  pi.registerCommand("verify", {
    description: "Show the verify-after-edit config and why it applied, or reload it",
    handler: async (args, ctx) => {
      await load(ctx.cwd);
      const why = describeSource(source);
      if (!config.commands.length) {
        ctx.ui.notify(
          `verify-after-edit: no commands for ${ctx.cwd} — resolved from ${why}. ` +
            `Add \`<repo>/.pi/verify.json\` (it carries into every worktree) or a "projects" / "byName" entry in ${globalConfigPath()}.`,
          "info",
        );
        return;
      }
      const where = args.trim() === "reload" ? "reloaded" : "active";
      const verifyDir = config.runIn === "cwd" ? ctx.cwd : (projectRoot ?? ctx.cwd);
      const missing = missingRequirements(config.requires, verifyDir, existsSync);
      if (missing.length > 0) {
        ctx.ui.notify(
          `verify-after-edit ${where} for ${ctx.cwd} from ${why}, but inert: waiting for ` +
            `${missing.join(", ")} in ${verifyDir} (\`requires\` in the config). ` +
            `Commands would be: ${config.commands.join(" && ")}`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `verify-after-edit ${where} for ${ctx.cwd} from ${why}: ${config.commands.join(" && ")} ` +
          `(timeout ${config.timeoutSeconds}s, ran ${runsThisSession} time(s) this session)`,
        "info",
      );
    },
  });
}
