#!/usr/bin/env bun
/**
 * Keep the prebuilt pi-bolt bundles in step with the sources they were built
 * from. See lib/bundle-info.mjs for what "in step" means.
 *
 *   rebuild.mjs            rebuild whatever is stale; block until done
 *   rebuild.mjs --check    report staleness, rebuild nothing; exit 1 if stale
 *   rebuild.mjs --force    rebuild every bundle unconditionally
 *
 * The default is what the shell hook in ~/.zshrc runs before every pi-bolt
 * launch. A check costs about 5 ms (bun's own start-up dominates), so paying it
 * on every launch is cheaper than the alternative of finding out later that a
 * bundle went stale.
 *
 * Exit codes for the default mode: 0 if everything is fresh or was rebuilt
 * successfully. A *failed* rebuild also exits 0 — deliberately. The usual cause
 * is broken source mid-edit, and refusing to start pi-bolt exactly when you want
 * it to help you fix that would be its own bug; the failure is printed, and the
 * previous (working) bundle is used. `--check` is the mode that reports an exit
 * code for gating.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { staleness } from "./lib/bundle-info.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER = join("scripts", "build.mjs");

const mode = process.argv.includes("--force")
  ? "force"
  : process.argv.includes("--check")
    ? "check"
    : "if-stale";

/** Every pi-bolt-* directory that carries a builder, so adding one needs no edit here. */
function findBundles() {
  return readdirSync(HERE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("pi-bolt-"))
    .map((e) => ({ name: e.name, dir: join(HERE, e.name), builder: join(HERE, e.name, BUILDER) }))
    .filter((b) => existsSync(b.builder))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const bundles = findBundles();
if (bundles.length === 0) {
  console.error(`no bundles found under ${HERE} (expected pi-bolt-*/${BUILDER})`);
  process.exit(1);
}

const states = bundles.map((b) => ({ ...b, ...staleness(b.dir) }));

if (mode === "check") {
  const stale = states.filter((s) => s.stale);
  if (stale.length === 0) {
    console.log(`${bundles.length} pi-bolt bundle(s) up to date`);
    process.exit(0);
  }
  for (const s of stale) console.log(`stale  ${s.name}: ${s.reason}`);
  process.exit(1);
}

const todo = mode === "force" ? states : states.filter((s) => s.stale);
if (todo.length === 0) process.exit(0);

// The hook runs this in front of an interactive launch, so a successful rebuild
// reports one line rather than the builder's whole log. --verbose streams it.
const verbose = process.argv.includes("--verbose");
let failed = false;
for (const b of todo) {
  const why = b.stale ? b.reason : "--force";
  console.error(`pi-bolt bundles: rebuilding ${b.name} (${why})…`);
  // process.execPath is the bun running this script, so the rebuild does not
  // depend on bun being on PATH.
  const run = spawnSync(process.execPath, [b.builder], {
    cwd: b.dir,
    encoding: "utf8",
    stdio: verbose ? "inherit" : "pipe",
  });
  if (run.status !== 0) {
    failed = true;
    if (!verbose) {
      if (run.stdout) process.stderr.write(run.stdout);
      if (run.stderr) process.stderr.write(run.stderr);
    }
    console.error(
      `pi-bolt bundles: ${b.name} FAILED to rebuild (exit ${run.status ?? "signal"}); ` +
        `continuing with the previous bundle, which is now stale`,
    );
  } else {
    // The builder's first line is `built <name> from <source>@<version>`.
    const done = (run.stdout ?? "").split("\n").find((l) => l.startsWith("built ")) ?? "";
    console.error(`pi-bolt bundles: rebuilt ${b.name}${done ? ` — ${done.trim()}` : ""}`);
  }
}

// See the note above on exit codes: a failed rebuild still lets pi-bolt start.
process.exit(0);
