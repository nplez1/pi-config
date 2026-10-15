#!/usr/bin/env node
/**
 * test-find-pi-dir.mjs — where model-picker.mjs looks for the pi bundle.
 *
 * The applier patches the *installed* pi, so its discovery has to survive pi
 * changing how it is installed. It broke once when pi moved from a global npm
 * install to the managed `releases-v1` layout (pi 1.1+), which the applier did
 * not know about: "could not find an installed pi".
 *
 * Each case builds a throwaway install in a temp dir and runs the real applier
 * against it with a deliberately narrow environment, so the assertions are
 * about the *order* of the candidates and not about this machine's pi.
 *
 *   node ~/Code/pi-config/patches/test-find-pi-dir.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLIER = path.join(HERE, "model-picker.mjs");
const PACKAGE_DIR = path.join("node_modules", "@earendil-works", "pi-coding-agent");
/** findChunk identifies the picker chunk by this string, so fixtures carry it. */
const CHUNK_MARKER = "Only showing models from configured providers";

// realpath so the fixture paths match what the applier resolves (/var → /private/var on macOS).
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-picker-find-pi-")));

/** A minimal shape-only install: the applier only needs the chunk directory. */
function makeRelease(managedRoot, version) {
  const pkg = path.join(managedRoot, "releases", version, PACKAGE_DIR);
  const chunks = path.join(pkg, "dist", "bundle", "chunks");
  fs.mkdirSync(chunks, { recursive: true });
  fs.writeFileSync(path.join(chunks, `chunk-${version.replace(/\W/g, "")}.js`), `// ${CHUNK_MARKER}\n`);
  return pkg;
}

function makeManagedRoot(managedRoot, versions, active) {
  for (const version of versions) makeRelease(managedRoot, version);
  if (active) fs.writeFileSync(path.join(managedRoot, "current-version"), `${active}\n`);
  return managedRoot;
}

/** The applier exits 1 when the install is unpatched; the JSON is still printed. */
function resolve(env, args = []) {
  const argv = [APPLIER, "--check", "--json", "--no-write", ...args];
  try {
    return { ...JSON.parse(execFileSync(process.execPath, argv, { encoding: "utf8", env })), code: 0 };
  } catch (error) {
    const stdout = error.stdout?.toString() ?? "";
    if (!stdout) throw error;
    return { ...JSON.parse(stdout), code: error.status ?? 1 };
  }
}

/** Only the shells and coreutils the applier needs; no npm, no real pi. */
function barePath(binDir) {
  return binDir ? `${binDir}:/usr/bin:/bin` : "/usr/bin:/bin";
}

const cases = [];

// 1. The guard extension runs inside pi, which inherits PI_MANAGED_INSTALL_ROOT
//    from the launcher — the case that used to fail.
{
  const managedRoot = makeManagedRoot(path.join(root, "env-root"), ["1.0.0", "2.0.0"], "1.0.0");
  const report = resolve(
    { HOME: path.join(root, "env-home"), PATH: barePath(), PI_MANAGED_INSTALL_ROOT: managedRoot },
  );
  cases.push({
    name: "PI_MANAGED_INSTALL_ROOT resolves the managed install the launcher execs",
    ok: report.piDir === path.join(managedRoot, "releases", "1.0.0", PACKAGE_DIR),
    detail: report.piDir,
    report,
  });
}

// 2. A plain `node model-picker.mjs` from a shell has no such env var, but the
//    managed `pi` on PATH is the launcher script that exports it: read it back.
{
  const agentDir = path.join(root, "launcher-agent");
  makeManagedRoot(path.join(agentDir, "install"), ["3.0.0"], "3.0.0");
  const binDir = path.join(agentDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "pi"),
    '#!/bin/sh\nPI_MANAGED_INSTALL_ROOT=$prefix/install\nexport PI_MANAGED_INSTALL_ROOT\nexec pi "$@"\n',
    { mode: 0o755 },
  );
  const report = resolve({ HOME: path.join(root, "launcher-home"), PATH: barePath(binDir) });
  cases.push({
    name: "the managed launcher on PATH is read back for its install root",
    ok: report.piDir === path.join(agentDir, "install", "releases", "3.0.0", PACKAGE_DIR),
    detail: report.piDir,
    report,
  });
}

// 3. No env var and no pi on PATH: fall back to the well-known managed location.
{
  const home = path.join(root, "default-home");
  makeManagedRoot(path.join(home, ".pi", "agent", "install"), ["4.0.0"], "4.0.0");
  const report = resolve({ HOME: home, PATH: barePath() });
  cases.push({
    name: "~/.pi/agent/install is the fallback for a bare environment",
    ok: report.piDir === path.join(home, ".pi", "agent", "install", "releases", "4.0.0", PACKAGE_DIR),
    detail: report.piDir,
    report,
  });
}

// 4. current-version is authoritative; a newer release on disk must not win.
{
  const managedRoot = makeManagedRoot(path.join(root, "stale-root"), ["1.0.0", "2.0.0"], "1.0.0");
  const report = resolve(
    { HOME: path.join(root, "stale-home"), PATH: barePath(), PI_MANAGED_INSTALL_ROOT: managedRoot },
  );
  cases.push({
    name: "current-version beats a newer release directory",
    ok: report.piDir === path.join(managedRoot, "releases", "1.0.0", PACKAGE_DIR),
    detail: report.piDir,
    report,
  });
}

// 5. Half-written install (no current-version): newest release first, not the
//    alphabetical or readdir order.
{
  const managedRoot = makeManagedRoot(path.join(root, "partial-root"), ["1.0.0", "2.0.0"]);
  const report = resolve(
    { HOME: path.join(root, "partial-home"), PATH: barePath(), PI_MANAGED_INSTALL_ROOT: managedRoot },
  );
  cases.push({
    name: "a missing current-version falls back to the newest release",
    ok: report.piDir === path.join(managedRoot, "releases", "2.0.0", PACKAGE_DIR),
    detail: report.piDir,
    report,
  });
}

// 6. --pi-dir is an explicit instruction: it outranks every guess, and the
//    shapes a user can actually see all work (the error message suggests it).
{
  const managedRoot = makeManagedRoot(path.join(root, "explicit-root"), ["5.0.0"], "5.0.0");
  const releaseDir = path.join(managedRoot, "releases", "5.0.0");
  const explicitPiDir = path.join(releaseDir, PACKAGE_DIR);
  const env = {
    HOME: path.join(root, "explicit-home"),
    PATH: barePath(),
    PI_MANAGED_INSTALL_ROOT: managedRoot,
  };
  const shapes = [
    ["the package directory", explicitPiDir],
    ["the release directory", releaseDir],
    ["the managed root", managedRoot],
  ];
  for (const [label, value] of shapes) {
    const report = resolve(env, ["--pi-dir", value]);
    cases.push({
      name: `--pi-dir accepts ${label}`,
      ok: report.piDir === explicitPiDir,
      detail: report.piDir,
      report,
    });
  }
}

// 7. A --pi-dir that holds no install must fail loudly: patching some *other*
//    pi, or the real one, would be worse than an error.
{
  const report = resolve(
    { HOME: path.join(root, "bogus-home"), PATH: barePath() },
    ["--pi-dir", path.join(root, "not-an-install")],
  );
  cases.push({
    name: "--pi-dir that holds no install fails with exit 2",
    ok: report.code === 2 && /holds no pi install/.test(report.error ?? ""),
    detail: `${report.error} (exit ${report.code})`,
    report,
    // The failure is the point: this run is supposed to find no bundle.
    skipChunkCheck: true,
  });
}

// The last case aside, a resolved directory with no bundle is not usable.
for (const testCase of cases) {
  if (testCase.skipChunkCheck) continue;
  testCase.ok = testCase.ok && testCase.report.error === null && typeof testCase.report.chunk === "string";
}

const failed = cases.filter((testCase) => !testCase.ok);
for (const testCase of cases) {
  console.log(`${testCase.ok ? "ok  " : "FAIL"} ${testCase.name}\n       piDir: ${testCase.detail ?? "(none)"}`);
}
fs.rmSync(root, { recursive: true, force: true });

assert.equal(failed.length, 0, `${failed.length} of ${cases.length} discovery cases failed`);
console.log(`test-find-pi-dir: ok — ${cases.length} discovery cases`);
