/**
 * Shared bookkeeping for the two prebuilt pi-bolt bundles.
 *
 * A bundle is a *snapshot*: `dist-bun/core.cjs` is built from a source tree, and
 * nothing notices when that source moves on — an extension update, or an edit to
 * the subagents fork, leaves pi-bolt quietly running old code. So each builder
 * records what it built from in `<bundle>/build-info.json`, and three things
 * check it: `rebuild.mjs`, the shell hook in ~/.zshrc, and the generated shim
 * itself.
 *
 * `fingerprint` is deliberately not a content hash. It runs on every pi-bolt
 * launch, so it is mtime+size+count — the heuristic make uses — and it only has
 * to answer "did anything change?". A content hash would be authoritative but
 * would cost more than the bundle it guards.
 *
 * Both functions below are inlined verbatim into the generated shims (see
 * `freshnessSnippet`), so they must stay self-contained: no closures over module
 * scope, and only these three imports — `statSync`, `readdirSync` and `join`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** @returns {{files: number, bytes: number, maxMtimeMs: number}} */
export function fingerprint(inputs, skip) {
  const SKIP = new Set(skip ?? ["node_modules", ".git", "dist", "dist-bun"]);
  let files = 0;
  let bytes = 0;
  let maxMtimeMs = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = readdirSync(p);
      } catch {
        return;
      }
      for (const entry of entries) if (!SKIP.has(entry)) walk(join(p, entry));
      return;
    }
    files += 1;
    bytes += st.size;
    if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
  };
  for (const p of inputs) walk(p);
  // Rounded so that the value survives a JSON round trip unchanged.
  return { files, bytes, maxMtimeMs: Math.round(maxMtimeMs) };
}

export function fingerprintMatches(recorded, current) {
  return (
    !!recorded &&
    !!current &&
    recorded.files === current.files &&
    recorded.bytes === current.bytes &&
    recorded.maxMtimeMs === current.maxMtimeMs
  );
}

export const BUILD_INFO = "build-info.json";
export const buildInfoPath = (bundleDir) => join(bundleDir, BUILD_INFO);

/**
 * Record what this build was made from. Called by each builder right after a
 * successful build.
 *
 * `versionFile` matters as much as the fingerprint: an mtime walk cannot see a
 * source that changed to *older* content (a git checkout of an earlier revision,
 * a downgrade), whereas the version string catches it outright.
 */
export function writeBuildInfo({
  bundleDir,
  name,
  version,
  sourceDescription,
  inputs,
  skip,
  sourceVersion,
  versionFile,
  rebuildCommand,
}) {
  const info = {
    name,
    version,
    builtAt: new Date().toISOString(),
    source: {
      description: sourceDescription,
      inputs,
      // Directories under `inputs` that are NOT part of the bundle. The advisor
      // plugin reads its prompts live from them (see its builder), so an edit
      // there changes behaviour without a rebuild and must not read as stale.
      ...(skip ? { skip } : {}),
      version: sourceVersion,
      versionFile,
    },
    fingerprint: fingerprint(inputs, skip),
    rebuildCommand,
  };
  writeFileSync(buildInfoPath(bundleDir), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

/** The recorded source version, or undefined if it cannot be read. */
export function readSourceVersion(versionFile) {
  try {
    return JSON.parse(readFileSync(versionFile, "utf8")).version;
  } catch {
    return undefined;
  }
}

/**
 * Is this bundle out of date with its source? Used by `rebuild.mjs` and by the
 * shell hook.
 *
 * A missing or unreadable build-info.json counts as stale: rebuilding once is
 * cheap, and silently trusting a bundle of unknown provenance is not.
 */
export function staleness(bundleDir) {
  let info;
  try {
    info = JSON.parse(readFileSync(buildInfoPath(bundleDir), "utf8"));
  } catch (err) {
    return { stale: true, reason: `no readable ${BUILD_INFO} (${err.code ?? err.message})` };
  }
  const current = fingerprint(info.source?.inputs ?? [], info.source?.skip);
  const versionNow = readSourceVersion(info.source?.versionFile);
  const reasons = [];
  if (!fingerprintMatches(info.fingerprint, current)) {
    const was = info.fingerprint ?? {};
    reasons.push(
      `source changed (files ${was.files}->${current.files}, bytes ${was.bytes}->${current.bytes})`,
    );
  }
  if (versionNow !== info.source?.version) {
    reasons.push(`source version ${info.source?.version} -> ${versionNow}`);
  }
  return { stale: reasons.length > 0, reason: reasons.join("; ") };
}

/**
 * The freshness check as source text, for the builders to inline into the shim
 * they generate.
 *
 * The shell hook rebuilds *before* pi-bolt starts, so in the normal path this
 * finds nothing and stays quiet. It exists for the invocations that bypass the
 * hook — a script, or another tool starting pi-bolt directly — which would
 * otherwise run a stale bundle with no sign of it.
 */
export function freshnessSnippet() {
  return `
// ---- freshness safety net -------------------------------------------------
// This shim is a snapshot of the source recorded in ../${BUILD_INFO}. The shell
// hook in ~/.zshrc rebuilds before launching, so this normally finds nothing and
// says nothing; it speaks up only when pi-bolt was started some way that skipped
// the hook, which would otherwise run a stale bundle silently.
const __fingerprint = ${fingerprint.toString()};
const __fingerprintMatches = ${fingerprintMatches.toString()};
try {
  const __info = JSON.parse(readFileSync(fileURLToPath(new URL("../${BUILD_INFO}", import.meta.url)), "utf8"));
  const __current = __fingerprint(__info.source?.inputs ?? [], __info.source?.skip);
  const __versionNow = JSON.parse(readFileSync(__info.source.versionFile, "utf8")).version;
  if (!__fingerprintMatches(__info.fingerprint, __current) || __versionNow !== __info.source.version) {
    console.warn(
      "[" + ${JSON.stringify("@nplez1/pi-bolt-bundles")} + "] stale bundle: " + __info.name + " was built from " +
      (__info.source.description ?? "its source") + " at version " + __info.source.version +
      ", which has changed since. Rebuild with: " + (__info.rebuildCommand ?? "rebuild.sh"),
    );
  }
} catch {
  // A missing or unreadable record is the shell hook's business, not ours.
}`;
}
