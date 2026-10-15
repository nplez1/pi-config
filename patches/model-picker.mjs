#!/usr/bin/env node
/**
 * model-picker.mjs — re-apply pi-config's model-picker patches to installed pi.
 *
 * Why this exists
 * ---------------
 * pi's interactive `/model` picker is `ModelSelectorComponent` inside the
 * bundled chunk `dist/bundle/chunks/chunk-*.js` (the bundle is what `pi` runs,
 * not `dist/modes/...`). Two things we want are not upstream:
 *
 *   1. friendly model names in the pickers (from model-manager's
 *      models.json `modelOverrides.<id>.name`) instead of raw model ids;
 *   2. a reasoning/thinking level you can change with ←/→ right inside the
 *      picker and commit with the same Enter that picks the model.
 *
 * pi's extension API cannot do (2): `/model` is intercepted by interactive
 * mode before extension commands are dispatched, and an extension cannot
 * replace the component the built-in picker uses. So we patch the chunk.
 *
 * The patch is deliberately a *pure append* plus two unique string swaps, and
 * every step is idempotent. Re-run after any pi install/update:
 *
 *   node ~/Code/pi-config/patches/model-picker.mjs            # apply what is missing
 *   node ~/Code/pi-config/patches/model-picker.mjs --check    # exit 1 if anything is missing
 *
 * The `pi-picker-patch-guard` extension runs `--check` at the start of TUI
 * sessions and auto-applies, so an update is normally healed the next time you
 * open pi (restart once for it to take effect).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLOCK_PATH = path.join(HERE, "model-picker-block.js");
const STATE_PATH = path.join(HERE, ".state.json");

/** Present in exactly one chunk: the one that defines ModelSelectorComponent. */
const CHUNK_MARKER = "Only showing models from configured providers";
const BLOCK_MARKER = "/* pi-picker-patch:start";
const BLOCK_END = "/* pi-picker-patch:end */";
/** Holds the chunk exactly as it was before the last apply, for one-step reverts. */
const BACKUP_SUFFIX = ".pi-patch-backup";

/**
 * String swaps against minified upstream code. `from` must occur exactly once
 * in a pristine chunk; if upstream renames things the swap reports a failure
 * instead of corrupting the file.
 */
const EDITS = [
  {
    id: "model-picker-name",
    description: "/model lists friendly names from models.json instead of raw ids",
    from: 'modelText=isSelected?theme.fg("accent",item.id):item.id',
    to: 'modelText=isSelected?theme.fg("accent",item.model?.name??item.id):item.model?.name??item.id',
  },
  {
    id: "scoped-models-name",
    description: "/scoped-models lists friendly names from models.json instead of raw ids",
    from: "id=item.model?.id??item.fullId,styledId=item.model?id:theme.strikethrough(id)",
    to: "id=(item.model?.name||item.model?.id)??item.fullId,styledId=item.model?id:theme.strikethrough(id)",
  },
];

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const options = {
  check: argv.includes("--check"),
  quiet: argv.includes("--quiet") || argv.includes("-q"),
  json: argv.includes("--json"),
  verify: !argv.includes("--no-verify"),
  writeState: !argv.includes("--no-write"),
  piDir: valueOf("--pi-dir"),
};

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function log(...args) {
  if (!options.quiet && !options.json) console.log(...args);
}

/** Result object shared by every exit path, so --json callers can rely on it. */
const report = {
  ok: false,
  changed: false,
  piDir: null,
  chunk: null,
  /** Edits whose pattern is present in the chunk after planning. */
  applied: [],
  /** Edits the applier had to swap in memory, i.e. what writing this run changes. */
  pending: [],
  block: null,
  missing: [],
  restored: false,
  error: null,
  verifyOutput: null,
};

function finish(code) {
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(code);
}

function fail(message) {
  report.error = message;
  report.ok = false;
  if (options.json) report.missing = EDITS.map((edit) => edit.id).concat("thinking-levels");
  if (!options.json) console.error(`model-picker: ${message}`);
  finish(2);
}

// ------------------------------------------------------------ locate pi

const PI_PACKAGE_DIR = path.join("node_modules", "@earendil-works", "pi-coding-agent");

/** A pi install is whatever directory holds the bundle `pi` executes. */
function isPiDir(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, "dist/bundle/chunks"));
}

function realPath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

/** The `pi` binary on PATH: either a symlink into <pkg>/dist/bundle/cli.js (npm
 * install) or the managed launcher script at `<agent dir>/bin/pi`. */
function piBinaryOnPath() {
  try {
    return execFileSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Nearest enclosing directory that holds a bundle, starting at `target`. */
function piDirAncestorOf(target) {
  if (!target) return undefined;
  for (let dir = target; ; ) {
    if (isPiDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Managed installs (`releases-v1`, pi 1.1+) keep the package one level down:
 * `<root>/releases/<version>/node_modules/@earendil-works/pi-coding-agent`.
 * `current-version` names the release the launcher will exec, so it wins; the
 * remaining releases are a fallback for a half-written install, newest first.
 */
function managedInstallPiDirs(root) {
  const managedRoot = path.resolve(root);
  const releasesDir = path.join(managedRoot, "releases");
  let releases = [];
  try {
    releases = fs
      .readdirSync(releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(releasesDir, entry.name)).mtimeMs;
        } catch {}
        return { name: entry.name, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((entry) => entry.name);
  } catch {}
  let active = "";
  try {
    active = fs.readFileSync(path.join(managedRoot, "current-version"), "utf8").trim();
  } catch {}
  const ordered = active ? [active, ...releases.filter((name) => name !== active)] : releases;
  return ordered.map((name) => path.join(releasesDir, name, PI_PACKAGE_DIR));
}

/**
 * The managed launcher exports PI_MANAGED_INSTALL_ROOT for its children, so the
 * guard (which runs inside pi) inherits it — but a plain shell run of this
 * script does not. Read the root back out of the launcher itself.
 */
function managedRootFromLauncher(launcher) {
  let text;
  try {
    text = fs.readFileSync(launcher, "utf8");
  } catch {
    return undefined;
  }
  if (!text.includes("PI_MANAGED_INSTALL_ROOT")) return undefined;
  return path.join(path.dirname(path.dirname(launcher)), "install");
}

function npmRootGlobal() {
  try {
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * `--pi-dir` is an explicit instruction, so it accepts any shape a user can see:
 * the package directory, a release directory, or the managed root itself. A path
 * that resolves to none of them is an error — silently patching some *other* pi
 * would be worse than failing.
 */
function piDirFromExplicit(value) {
  if (!value) return undefined;
  const target = path.resolve(value);
  if (isPiDir(target)) return target;
  const nested = [path.join(target, PI_PACKAGE_DIR), ...managedInstallPiDirs(target)];
  const found = nested.find(isPiDir);
  if (found) return found;
  fail(`--pi-dir ${value} holds no pi install (no dist/bundle/chunks beneath it)`);
}

function findPiDir() {
  const binary = piBinaryOnPath();
  const resolvedBinary = realPath(binary);
  const home = process.env.HOME ?? "";
  // Environment first (the guard inherits the launcher's), then the launcher's
  // own text, then the default managed root.
  const managedRoots = [
    process.env.PI_MANAGED_INSTALL_ROOT,
    managedRootFromLauncher(resolvedBinary),
    path.join(home, ".pi", "agent", "install"),
  ].filter(Boolean);

  const candidates = [
    piDirFromExplicit(options.piDir),
    process.env.PI_AGENT_PACKAGE_DIR,
    piDirAncestorOf(resolvedBinary),
    ...managedRoots.flatMap(managedInstallPiDirs),
    npmRootGlobal() && path.join(npmRootGlobal(), "@earendil-works/pi-coding-agent"),
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
    path.join(home, ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent"),
  ].filter(Boolean);

  return candidates.find(isPiDir);
}

/** Biggest chunk first: the one we want is the largest file in the bundle. */
function findChunk(piDir) {
  const chunksDir = path.join(piDir, "dist/bundle/chunks");
  const files = fs
    .readdirSync(chunksDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(chunksDir, name))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  for (const file of files) {
    if (fs.readFileSync(file, "utf8").includes(CHUNK_MARKER)) return file;
  }
  return undefined;
}

// ---------------------------------------------------------------- patching

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function planEdits(content) {
  const pending = [];
  const present = [];
  const missing = [];
  const problems = [];
  let patched = content;
  for (const edit of EDITS) {
    if (patched.includes(edit.to)) {
      present.push(edit.id);
      continue;
    }
    const occurrences = count(patched, edit.from);
    if (occurrences !== 1) {
      problems.push(
        `${edit.id}: expected exactly 1 occurrence of its upstream pattern, found ${occurrences}. ` +
          "pi's bundle changed; update " +
          path.relative(process.env.HOME ?? "", HERE) +
          "/model-picker.mjs",
      );
      missing.push(edit.id);
      continue;
    }
    patched = patched.replace(edit.from, edit.to);
    pending.push(edit.id);
    present.push(edit.id);
    report.changed = true;
  }
  const hasBlock = patched.includes(BLOCK_MARKER);
  let blockState = hasBlock ? "current" : "missing";
  const blockFile = fs.existsSync(BLOCK_PATH) ? fs.readFileSync(BLOCK_PATH, "utf8").trimEnd() : undefined;
  if (!blockFile) {
    problems.push(`missing patch block file: ${BLOCK_PATH}`);
    missing.push("thinking-levels");
  } else {
    const start = hasBlock ? patched.indexOf(BLOCK_MARKER) : -1;
    const end = start === -1 ? -1 : patched.indexOf(BLOCK_END, start);
    if (start === -1) {
      patched = `${patched.trimEnd()}\n\n${blockFile}\n`;
      report.changed = true;
      blockState = "appended";
      missing.push("thinking-levels");
    } else if (end === -1) {
      problems.push("thinking-levels: block start marker without its end marker");
      blockState = "broken";
      missing.push("thinking-levels");
    } else {
      // Keep the appended block in step with model-picker-block.js.
      const current = patched.slice(start, end + BLOCK_END.length);
      if (current.trim() !== blockFile.trim()) {
        patched = patched.slice(0, start) + blockFile + patched.slice(end + BLOCK_END.length);
        report.changed = true;
        blockState = "updated";
        missing.push("thinking-levels (outdated)");
      }
    }
  }
  report.block = blockState;
  return { patched, pending, present, missing, problems };
}

function verifyLoads(piDir) {
  const cli = path.join(piDir, "dist/bundle/cli.js");
  try {
    return execFileSync(process.execPath, [cli, "--version"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PI_MODEL_PICKER_VERIFY: "1" },
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`patched bundle failed to load: ${detail.split("\n").slice(0, 4).join(" | ")}`);
  }
}

function writeState(piDir, chunk, applied) {
  if (!options.writeState) return;
  const stat = fs.statSync(chunk);
  fs.writeFileSync(
    STATE_PATH,
    `${JSON.stringify(
      {
        piDir,
        chunk,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        applied,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

// -------------------------------------------------------------------- main

const piDir = findPiDir();
if (!piDir)
  fail(
    "could not find an installed pi (looked for dist/bundle/chunks, including the managed " +
      "PI_MANAGED_INSTALL_ROOT). Pass --pi-dir <path>.",
  );
report.piDir = piDir;

const chunk = findChunk(piDir);
if (!chunk) fail(`no bundle chunk in ${piDir}/dist/bundle/chunks contains the model selector`);
report.chunk = chunk;

const original = fs.readFileSync(chunk, "utf8");
const { patched, pending, present, missing, problems } = planEdits(original);
report.applied = present;
report.pending = pending;
report.missing = [...pending, ...missing];
/** Everything this run would still have to write. */
const outstanding = [...pending, ...missing];

if (options.check) {
  report.ok = problems.length === 0 && outstanding.length === 0;
  if (report.ok) writeState(piDir, chunk, present);
  if (!options.json) {
    const relative = path.relative(process.env.HOME ?? "", chunk);
    if (report.ok) log(`model-picker: patched (${present.join(", ")}, thinking-levels) — ${relative}`);
    else
      console.error(
        `model-picker: NOT patched — missing: ${outstanding.join(", ")}${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`,
      );
  }
  finish(report.ok ? 0 : 1);
}

if (problems.length > 0) {
  // A swap whose anchor vanished: still worth appending what we can, but never
  // silently pretend the install is patched.
  console.error(`model-picker: cannot apply all patches\n  ${problems.join("\n  ")}`);
}

if (!report.changed) {
  report.ok = missing.length === 0;
  if (report.ok) writeState(piDir, chunk, present);
  log(`model-picker: already applied (${present.join(", ")}, thinking-levels)`);
  finish(report.ok ? 0 : 1);
}

// Refresh the pre-patch copy every time we change the file: after a pi update
// the previous backup belongs to a different pi version, and restoring it would
// install a stale bundle.
const backup = `${chunk}${BACKUP_SUFFIX}`;
fs.writeFileSync(backup, original);
const temporary = `${chunk}.pi-patch-tmp`;
fs.writeFileSync(temporary, patched);
fs.renameSync(temporary, chunk);

if (options.verify) {
  try {
    report.verifyOutput = verifyLoads(piDir);
  } catch (error) {
    // Broken patch: put the file back exactly as it was.
    if (fs.existsSync(backup)) fs.copyFileSync(backup, chunk);
    report.restored = true;
    fail(error.message);
  }
}

report.ok = true;
writeState(piDir, chunk, present);
const relative = path.relative(process.env.HOME ?? "", chunk);
log(`model-picker: applied to ${relative}`);
log(`  model picker names: ${pending.includes("model-picker-name") ? "written" : "already ok"}`);
log(`  scoped picker names: ${pending.includes("scoped-models-name") ? "written" : "already ok"}`);
log(`  reasoning levels: ${report.block}`);
if (report.verifyOutput) log(`model-picker: bundle loads — ${report.verifyOutput}`);
log("model-picker: restart pi if it is already running");
finish(0);
