#!/usr/bin/env node
/**
 * settings-overlay.mjs — merge one machine's own settings over the shared seed.
 *
 * `dot-pi/agent/settings.json` is shared config: it is seeded onto every machine
 * and published back by `./install.sh capture`. So the keys that are *not* shared
 * — a package this machine can run and another cannot, a provider that is behind a
 * work account — had nowhere to live. Editing the seed published the difference to
 * every other machine; leaving the live file divergent meant the next capture
 * published it anyway.
 *
 * `dot-pi/agent/settings.local.json` is that home. It is gitignored, so it never
 * travels, and it is applied after the shared-key sync in `install.sh`, so it wins.
 *
 * The rules are chosen so the file reads like the answer to "what is different on
 * this machine?":
 *   - a plain object merges key by key, so `{ "piBolt": { "x": 1 } }` need not
 *     restate the rest of `piBolt`;
 *   - anything else — a scalar, an array — replaces what the seed had, because a
 *     list that silently merged would be impossible to shorten;
 *   - `packages` is the exception: it unions by package name, so a machine adds
 *     without restating the baseline, and `packagesRemove` subtracts, because
 *     "this machine cannot run X" is the case that started this.
 *
 * Usage:
 *   node scripts/settings-overlay.mjs --repo <repo> --home <home> [--dry-run]
 *   node scripts/settings-overlay.mjs --repo <repo> --json
 *
 * `--json` reports what this machine's overlay adds and removes without touching
 * anything, which is what `capture` needs to keep machine-only choices out of the
 * published seed.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OVERLAY_PATH = "dot-pi/agent/settings.local.json";
export const LIVE_PATH = ".pi/agent/settings.json";

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** `{ source: "npm:x@1" }` and `"npm:x@1"` both name the same package. */
export const sourceOf = (entry) => (typeof entry === "string" ? entry : entry?.source);
export const pkgName = (entry) =>
  (sourceOf(entry) ?? "")
    .replace(/^-/, "")
    .replace(/@[^/@]+$/, "");

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/**
 * Apply an overlay to a settings object.
 *
 * Returns the merged object plus what it changed, because a machine-local file
 * that is silently applied is a machine-local file nobody can debug.
 */
export function applyOverlay(settings, overlay) {
  if (!isPlainObject(overlay)) return { settings, changes: [], added: [], removed: [] };

  // `packagesRemove` is a directive, not a setting; it must never be written out.
  const { packages, packagesRemove, ...rest } = overlay;
  const base = isPlainObject(settings) ? settings : {};
  const changes = [];
  let next = deepMerge(base, rest);

  for (const key of Object.keys(rest)) {
    if (!(key in base)) changes.push(`${key} (from overlay)`);
    else if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) changes.push(`${key} (overlay)`);
  }

  const removed = [];
  const added = [];
  if (Array.isArray(packages) || Array.isArray(packagesRemove)) {
    const current = Array.isArray(base.packages) ? base.packages : [];
    const requested = (Array.isArray(packagesRemove) ? packagesRemove : []).map(pkgName);
    const drop = new Set(requested);
    const kept = current.filter((entry) => {
      if (!drop.has(pkgName(entry))) return true;
      changes.push(`packages -= ${sourceOf(entry)}`);
      return false;
    });
    // Report what the overlay *asks* to drop, not only what happened to be in the
    // base: capture needs the intent even when the live file no longer holds it,
    // which is exactly the case where the removal already worked.
    removed.push(...new Set(requested));
    const have = new Set(kept.map(pkgName));
    const additions = (Array.isArray(packages) ? packages : []).filter((entry) => !have.has(pkgName(entry)));
    for (const entry of additions) {
      added.push(pkgName(entry));
      changes.push(`packages += ${sourceOf(entry)}`);
    }
    next.packages = [...kept, ...additions];
  }

  return { settings: next, changes, added, removed };
}

/** Read and parse a JSON file, or `undefined` when it is not there. */
export function readJson(file) {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Keep a machine's own package choices out of the seed that `capture` publishes.
 *
 * Both directions matter: a package this machine *added* must not enter the seed,
 * and one it *removed* must not leave it — otherwise the same local edit that
 * prompted this file would still travel to every other machine on the next
 * capture, just one step later.
 */
export function stripOwnChoices(packages, overlayReport, seedPackages = []) {
  if (!Array.isArray(packages)) return { packages, changes: [] };
  const { added = [], removed = [] } = overlayReport ?? {};
  const changes = [];
  const kept = packages.filter((entry) => {
    if (!added.includes(pkgName(entry))) return true;
    changes.push(`packages -= ${sourceOf(entry)} (this machine's overlay)`);
    return false;
  });
  const have = new Set(kept.map(pkgName));
  const seed = Array.isArray(seedPackages) ? seedPackages : [];
  for (const name of removed) {
    if (have.has(name)) continue;
    // Restore the seed's own entry when it has one, so a machine-local removal
    // cannot quietly drop a version the shared config had pinned.
    const original = seed.find((entry) => pkgName(entry) === name);
    // Only restore what the seed actually has. A machine removing a package the
    // shared config never carried is a local preference, not a reason to publish it.
    if (original === undefined) continue;
    changes.push(`packages += ${sourceOf(original)} (this machine's overlay)`);
    have.add(name);
    kept.push(original);
  }
  return { packages: kept, changes };
}

function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const repo = flag("repo");
  const home = flag("home");
  const json = argv.includes("--json");
  const dryRun = json || argv.includes("--dry-run") || flag("mode") === "dry-run";
  if (!repo) {
    console.error("settings-overlay: --repo is required");
    return 2;
  }

  // Capture's side: it hands over the packages it is about to publish plus the
  // seed's own list, and gets back the list with this machine's choices undone.
  if (argv.includes("--strip")) {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    const overlay = readJson(path.join(repo, OVERLAY_PATH));
    const report = overlay === undefined ? {} : applyOverlay({}, overlay);
    const result = stripOwnChoices(
      input.packages,
      { added: report.added, removed: report.removed },
      input.seed,
    );
    console.log(JSON.stringify(result));
    return 0;
  }

  const overlay = readJson(path.join(repo, OVERLAY_PATH));
  if (overlay === undefined) {
    if (json) console.log(JSON.stringify({ added: [], removed: [] }));
    else console.log("  skip     no settings.local.json on this machine");
    return 0;
  }

  const livePath = path.join(home ?? "", LIVE_PATH);
  const live = json ? (readJson(livePath) ?? {}) : readJson(livePath);
  if (live === undefined) {
    if (json) console.log(JSON.stringify({ added: [], removed: [] }));
    else console.log(`  skip     ${livePath} (missing)`);
    return 0;
  }

  const { settings, changes, added, removed } = applyOverlay(live, overlay);
  if (json) {
    console.log(JSON.stringify({ added, removed }));
    return 0;
  }
  if (changes.length === 0) {
    console.log("  ok       already carries this machine's overlay");
    return 0;
  }
  for (const change of changes) console.log(`  ${dryRun ? "would apply" : "applied  "} ${change}`);
  if (!dryRun) fs.writeFileSync(livePath, JSON.stringify(settings, null, 2) + "\n");
  return 0;
}

// Compare as URLs: a temp path can contain characters a bare `file://` concat
// would encode differently, and then the CLI silently does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
