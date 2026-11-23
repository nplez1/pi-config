#!/usr/bin/env node
/**
 * prune-stale.mjs — remove package entries whose source this clone no longer has.
 *
 * `dot-pi/agent/settings.json` is seeded once and machine-owned from then on, so
 * a package entry outlives the thing it names. Removing the rpiv-advisor plugin
 * from this repo (2026-11-23) left `plugins/pi-advisor-subagent` and
 * `pi-bolt-bundles/pi-bolt-advisor-subagent` in every machine's live settings,
 * and pi then failed to load an extension at every launch and refused to compile
 * at all: a bundle entry whose `package.json` is gone stops `pi-bolt compile`
 * with "Could not resolve", not with a warning.
 *
 * Only an entry that CANNOT resolve here is removed:
 *
 *   plugins/<name>          nothing on disk under it and nothing git still
 *                           carries — a registered submodule or a tracked
 *                           directory counts even when it is not checked out
 *                           yet — or git says the clone dropped it: unregistered
 *                           and untracked, which is what a deleted submodule's
 *                           checkout looks like when `git submodule update`
 *                           cannot rmdir it over the node_modules inside
 *   pi-bolt-bundles/<name>  neither the live directory nor `pi-bolt/<name>` has a
 *                           package.json, and that file is tracked, so its
 *                           absence means the bundle source was deleted and only
 *                           ignored build output is left
 *
 * Never touched: `npm:` and URL entries (nothing local to check), a negative
 * (`-plugins/x`, which removes a package another list added), and the resource
 * filters of an object-form entry.
 *
 * Usage:
 *   node scripts/prune-stale.mjs --repo <repo> --home <home> [--dry-run]
 *   node scripts/prune-stale.mjs --repo <repo> --home <home> --mode dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LIVE_PATH = ".pi/agent/settings.json";
export const LIVE_PLUGINS = ".pi/agent/plugins";
// The settings entry prefix and the live directory it resolves under: the same
// name, so they are derived rather than restated.
export const BUNDLE_ENTRY = "pi-bolt-bundles";
export const LIVE_BUNDLES = `.pi/agent/${BUNDLE_ENTRY}`;
export const REPO_PLUGINS = "plugins";
export const REPO_BUNDLES = "pi-bolt";

const exists = (file) => {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
};

/** Run git in the clone. `null` when it cannot answer, never a throw. */
export function gitRunner(repo) {
  return (...args) => {
    try {
      return execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };
}

/**
 * The submodule paths this clone registers, or `null` when git cannot say (no
 * git, no `.gitmodules`): the caller then prunes nothing rather than guessing.
 */
export function registeredSubmodules(git) {
  const out = git("config", "-f", ".gitmodules", "--get-regexp", "\\.path$");
  if (out === null) return null;
  return new Set(
    out
      .split("\n")
      .map((line) => line.trim().split(/\s+/).slice(1).join(" "))
      .filter(Boolean),
  );
}

/**
 * Why `source` cannot resolve here, or `null` when it does.
 *
 * `git` is injectable so the rules can be tested without a checkout, and so a
 * machine without git degrades to the filesystem rules instead of failing.
 */
export function staleReason(source, { repo, home, git, submodules }) {
  const name = source.replace(/^[^/]+\//, "");
  // Live first, then the clone: on a first run `~/.pi/agent/plugins` and
  // `~/.pi/agent/pi-bolt-bundles` are linked by install.sh, but the seeded
  // settings.json names entries under them either way.
  const found = (...dirs) => dirs.map((dir) => path.join(dir, name)).filter((dir) => exists(dir));

  if (source.startsWith(`${REPO_PLUGINS}/`)) {
    const dirs = found(path.join(home, LIVE_PLUGINS), path.join(repo, REPO_PLUGINS));
    // Which plugins the clone carries is git's answer, not the filesystem's: a
    // registered submodule or a tracked directory counts even with nothing on
    // disk, because a clone whose submodules have not been fetched yet has empty
    // (or absent) directories and install.sh fetches them after this runs.
    const registered = Boolean(submodules?.has(source));
    const tracked = registered ? null : git("ls-files", "--", source);
    if (submodules && !registered && tracked === "") {
      return dirs.length > 0
        ? "not part of this clone any more"
        : "the directory is gone";
    }
    if (registered || (tracked !== null && tracked !== "")) return null;
    // Nothing on disk and nothing in git's index: only the filesystem is left,
    // which is all a machine without git has anyway.
    return dirs.length === 0 ? "the directory is gone" : null;
  }

  if (source.startsWith(`${BUNDLE_ENTRY}/`)) {
    const dirs = found(path.join(home, LIVE_BUNDLES), path.join(repo, REPO_BUNDLES));
    if (dirs.some((dir) => exists(path.join(dir, "package.json")))) return null;
    return dirs.length > 0 ? "no package.json in it" : "the directory is gone";
  }

  return null;
}

/**
 * Prune `settings.packages` and `settings.piBolt.packages`.
 *
 * Returns the pruned settings plus what was removed, because a file rewritten in
 * silence is a file nobody can debug — the same reason settings-overlay reports
 * its changes.
 */
export function pruneStalePackages(settings, { repo, home, git = gitRunner(repo) } = {}) {
  const submodules = registeredSubmodules(git);
  const pruned = [];
  const prune = (list, where) =>
    list.filter((entry) => {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof source !== "string" || source.startsWith("-")) return true;
      const reason = staleReason(source, { repo, home, git, submodules });
      if (!reason) return true;
      pruned.push({ where, source, reason });
      return false;
    });

  const next = { ...settings };
  if (Array.isArray(settings?.packages)) next.packages = prune(settings.packages, "packages");
  if (Array.isArray(settings?.piBolt?.packages)) {
    next.piBolt = { ...settings.piBolt, packages: prune(settings.piBolt.packages, "piBolt.packages") };
  }
  return { settings: next, pruned };
}

function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const repo = flag("repo");
  const home = flag("home");
  const dryRun = argv.includes("--dry-run") || flag("mode") === "dry-run";
  if (!repo) {
    console.error("prune-stale: --repo is required");
    return 2;
  }

  const livePath = path.join(home ?? "", LIVE_PATH);
  if (!exists(livePath)) {
    console.log(`  skip     ${livePath} (missing)`);
    return 0;
  }

  const live = JSON.parse(fs.readFileSync(livePath, "utf8"));
  const { settings, pruned } = pruneStalePackages(live, { repo, home });
  if (pruned.length === 0) {
    console.log("  ok       every entry resolves");
    return 0;
  }
  for (const { where, source, reason } of pruned) {
    console.log(`  ${dryRun ? "would prune" : "prune   "} ${where}: ${source} (${reason})`);
  }
  if (!dryRun) fs.writeFileSync(livePath, JSON.stringify(settings, null, 2) + "\n");
  return 0;
}

// Realpath on both sides: macOS reaches a temp directory as /var/folders/... and
// /private/var/folders/..., and a plain href comparison then decides the script
// was imported and silently does nothing.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
