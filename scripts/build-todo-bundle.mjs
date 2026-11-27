#!/usr/bin/env bun
/**
 * build-todo-bundle.mjs — build `plugins/pi-todo` into `plugins/pi-todo-bundle/dist`.
 *
 * Why a bundle at all: the todo extension is TypeScript spread over ~20 modules,
 * and Pi-Bolt compiles every installed extension into its executable on install.
 * A prebuilt bundle loads in ~0 ms instead of paying a compile per install, which
 * is the reason `npm:opensec-pi-todo` existed. This replaces it with a build of
 * *our* fork, so the fixes and the settle reminder travel with it.
 *
 * Format is deliberately `--target=node --format=cjs`, not Bun's own CJS bundle:
 * the `// @bun @bun-cjs` wrapper is an uncalled function expression that only
 * Bun's loader executes, so `require()` of it under Node returns `{}` (verified
 * 2026-11-26; it is why opensec's entry throws unless `process.versions.bun`).
 * Ordinary CJS runs unchanged on Node 26 and Bun 1.4, so one artifact serves both
 * stock pi (Node) and Pi-Bolt (Bun).
 *
 * Two build transforms, both because a CJS bundle cannot contain top-level await:
 *
 *  1. `index.ts` registers the optional i18n SDK with a top-level
 *     `await import("@juicesharp/rpiv-i18n/loader")`. It becomes an exported
 *     `registerLocales(packageUrl)` that `dist/index.js` calls, because only the
 *     ESM entry has a valid `import.meta.url`. opensec-pi-todo's build does the
 *     identical thing, which is why its `index.js` calls `core.registerLocales`.
 *  2. `state/i18n-bridge.ts` resolves the SDK's scope the same way, and the
 *     comment there explains the await is only needed because ESM module loading
 *     awaited it before any importer ran. In a CJS bundle `require` is already
 *     synchronous, so the same statement without `await` keeps the contract:
 *     installed -> that scope, absent -> the English fallback closure.
 *
 * `@juicesharp/rpiv-i18n` is an optional peer and the build settles it statically:
 * installed alongside the fork -> inlined; absent (the normal case) -> the same
 * English fallback the source's own `catch` produced. Either way the artifact
 * carries no bare `require` for the runtime to resolve.
 *
 * The host modules (pi-ai, pi-tui, typebox) can never be bundled — a second copy
 * would be a different class identity than the running host's. They are routed
 * through a global this entry installs before requiring the bundle, keyed by
 * package name and version so a /reload cannot hand the old core the new hosts.
 *
 * Usage:
 *   bun scripts/build-todo-bundle.mjs            # write dist/ and locales/
 *   bun scripts/build-todo-bundle.mjs --check    # rebuild elsewhere, diff, exit 1 on drift
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(REPO, "plugins/pi-todo");
const PKG = join(REPO, "plugins/pi-todo-bundle");

if (typeof Bun === "undefined") {
  console.error("build-todo-bundle: needs bun (bun scripts/build-todo-bundle.mjs); nothing else here requires it");
  process.exit(2);
}

// Bun writes its module comments (and therefore the artifact) relative to the
// working directory, so a build from anywhere else produced different bytes and
// leaked the caller's path into the repo. One canonical cwd fixes both.
process.chdir(REPO);

/** What produced the artifact. `--check` compares these before it compares bytes:
 *  a different Bun or rpiv-config version changes the output on its own, and the
 *  drift it would report is the toolchain's, not the fork's. */
function toolchain() {
  const configPath = join(SRC, "node_modules/@juicesharp/rpiv-config/package.json");
  const rpivConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")).version : "missing";
  return { bun: Bun.version, rpivConfig };
}

const { name, version } = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const HOST_KEY = `${name}@${version}:host-modules`;

/** Host-provided modules the bundle must not copy. */
const HOSTS = /^(typebox|typebox\/value|@earendil-works\/pi-ai|@earendil-works\/pi-tui)$/;

/**
 * Is the optional i18n SDK installed alongside the fork?
 *
 * Checked on disk rather than with a resolver, because a resolver answers the
 * wrong question: under Bun `require("@juicesharp/rpiv-i18n")` resolves out of
 * `~/.bun/install/cache` (2.16.0 here) and costs ~45 ms to transpile (measured
 * 2026-11-26). That is both a load-time regression and machine-dependent
 * behaviour — the same artifact would register locales on Bun and be English-only
 * on Node. So the build decides once, from what the fork's own node_modules
 * holds, and the artifact carries no bare require it cannot satisfy.
 */
const I18N_SDK = existsSync(join(SRC, "node_modules/@juicesharp/rpiv-i18n/package.json"));

/**
 * The two top-level awaits, with the transform that removes each. Anchors are
 * matched literally so a fork-sync that changes them fails the build instead of
 * producing a bundle that silently lost i18n registration.
 */
const TRANSFORMS = [
  {
    file: join(SRC, "index.ts"),
    from: `try {
	const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-todo" });
} catch {
	// SDK absent — extension still loads with English-only UI.
}`,
    to: I18N_SDK
      ? `export function registerLocales(packageUrl: string): void {
	try {
		const sdk = require("@juicesharp/rpiv-i18n/loader") as I18nLoader;
		sdk.registerLocalesFromDir(I18N_NAMESPACE, packageUrl, { label: "rpiv-todo" });
	} catch {
		// SDK absent — extension still loads with English-only UI.
	}
}`
      : `export function registerLocales(_packageUrl: string): void {
	// Built without @juicesharp/rpiv-i18n installed: English-only UI, and no bare
	// require left for the runtime to resolve (see scripts/build-todo-bundle.mjs).
}`,
  },
  {
    file: join(SRC, "state/i18n-bridge.ts"),
    // Built from explicit lines rather than a template literal: the anchor now
    // matches the source indentation exactly, tab for tab.
    from: [
      "let scopeImpl: ScopeFn;",
      "try {",
      '\tconst sdk = (await import("@juicesharp/rpiv-i18n")) as I18nSDK;',
      "\tscopeImpl = sdk.scope(I18N_NAMESPACE);",
      "} catch {",
      "\tscopeImpl = (_key, fallback) => fallback;",
      "}",
    ].join("\n"),
    to: (I18N_SDK
      ? [
          "let scopeImpl: ScopeFn;",
          "try {",
          '\tconst sdk = require("@juicesharp/rpiv-i18n") as I18nSDK;',
          "\tscopeImpl = sdk.scope(I18N_NAMESPACE);",
          "} catch {",
          "\tscopeImpl = (_key, fallback) => fallback;",
          "}",
        ]
      : ["const scopeImpl: ScopeFn = (_key, fallback) => fallback;"]
    ).join("\n"),
  },
];

const hostShim = {
  name: "pi-host-modules",
  setup(build) {
    build.onResolve({ filter: HOSTS }, (args) => ({ path: args.path, namespace: "pi-host" }));
    build.onLoad({ filter: /.*/, namespace: "pi-host" }, (args) => ({
      contents: `module.exports = globalThis[Symbol.for(${JSON.stringify(HOST_KEY)})](${JSON.stringify(args.path)});`,
      loader: "js",
    }));
  },
};

const cjsTransforms = {
  name: "cjs-transforms",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      const transform = TRANSFORMS.find((t) => t.file === args.path);
      if (transform === undefined) return undefined;
      const source = readFileSync(args.path, "utf8");
      if (!source.includes(transform.from)) {
        throw new Error(
          `${relative(REPO, args.path)}: build transform anchor not found — the fork source changed, update TRANSFORMS`,
        );
      }
      return { contents: source.replace(transform.from, transform.to), loader: "ts" };
    });
  },
};

/** The ESM entry Pi loads. It only wires hosts and hands over to `core.cjs`. */
function entrySource() {
  return `// Generated by scripts/build-todo-bundle.mjs — do not edit; rebuild instead.
//
// Pi evaluates this file (jiti under stock pi on Node, Bun inside Pi-Bolt) and
// the extension itself is dist/core.cjs. The host modules it needs are imported
// here and handed over on a global keyed to this package and version: they must
// be the running host's own copies, and a /reload must not hand the new core the
// previous generation's.
import { createRequire } from "node:module";
import * as host_pi_ai from "@earendil-works/pi-ai";
import * as host_pi_tui from "@earendil-works/pi-tui";
import * as host_typebox from "typebox";
import * as host_typebox_value from "typebox/value";

const HOST_KEY = Symbol.for(${JSON.stringify(HOST_KEY)});
const hostModules = {
	"@earendil-works/pi-ai": host_pi_ai,
	"@earendil-works/pi-tui": host_pi_tui,
	typebox: host_typebox,
	"typebox/value": host_typebox_value,
};
const nativeRequire = createRequire(import.meta.url);

export default function piTodo(pi) {
	globalThis[HOST_KEY] = (id) => {
		const mod = hostModules[id];
		if (mod === undefined) throw new Error(${JSON.stringify(`${name}: host module `)} + id + " is not available");
		return mod;
	};
	const corePath = nativeRequire.resolve("./core.cjs");
	// Re-evaluated per factory call so /reload and an upgrade pick up the new core
	// without a restart; same contract as the unbundled TypeScript entry.
	delete nativeRequire.cache[corePath];
	const core = nativeRequire(corePath);
	// locales/ ships next to dist/, so the package root is the base to register from.
	core.registerLocales(new URL("../", import.meta.url).href);
	return core.default(pi);
}
`;
}

/** Build the whole package (dist/ + locales/) into `outDir`. */
async function build(outDir) {
  const dist = join(outDir, "dist");
  mkdirSync(dist, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(SRC, "index.ts")],
    outdir: dist,
    format: "cjs",
    target: "node",
    plugins: [hostShim, cjsTransforms],
    naming: "core.cjs",
    external: ["node:*", ...(I18N_SDK ? [] : ["@juicesharp/rpiv-i18n", "@juicesharp/rpiv-i18n/*"])],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error("bun build failed");
  }

  writeFileSync(join(dist, "index.js"), entrySource());
  writeFileSync(join(dist, "build.json"), JSON.stringify(toolchain(), null, 2) + "\n");
  cpSync(join(SRC, "locales"), join(outDir, "locales"), { recursive: true });
  return readdirSync(dist).map((file) => `${file} ${statSync(join(dist, file)).size}b`);
}

/** Every file under a directory, as paths relative to it. */
function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [relative(base, full)];
  });
}

/** Diff the generated halves of a package (dist/ and locales/); hand-written files are not ours. */
function compare(builtRoot, committedRoot) {
  const drift = [];
  const built = join(builtRoot, "");
  const committed = join(committedRoot, "");
  const filesBuilt = new Set(walk(built));
  const filesCommitted = new Set(walk(committed));
  for (const file of filesBuilt) {
    if (!filesCommitted.has(file)) drift.push(`missing in git: ${file}`);
    else if (!readFileSync(join(built, file)).equals(readFileSync(join(committed, file)))) drift.push(`stale: ${file}`);
  }
  for (const file of filesCommitted) if (!filesBuilt.has(file)) drift.push(`no longer generated: ${file}`);
  return drift;
}

const check = process.argv.includes("--check");

if (!check) {
  const outputs = await build(PKG);
  console.log(`built ${name}@${version} -> plugins/pi-todo-bundle/ (${outputs.join(", ")}; i18n: ${I18N_SDK ? "inlined" : "absent"})`);
} else {
  // A mismatch here is not drift: `install.sh` resolves rpiv-config as ^2.15.0
  // with --no-package-lock, and Bun's own output moves between versions. Report
  // it as a skip so the guard never cries wolf on another machine.
  const committedMeta = JSON.parse(readFileSync(join(PKG, "dist/build.json"), "utf8"));
  const current = toolchain();
  const differs = Object.keys(current).filter((key) => committedMeta[key] !== current[key]);
  if (differs.length > 0) {
    const shown = differs.map((key) => `${key} ${committedMeta[key]} -> ${current[key]}`).join(", ");
    console.log(`skip     built by a different toolchain (${shown}); rebuild to compare this machine`);
    process.exit(0);
  }

  // Outside the clone: an interrupted check must not leave an untracked directory
  // behind for `git status` to explain.
  const tmp = mkdtempSync(join(tmpdir(), "pi-todo-bundle-check-"));
  try {
    await build(tmp);
    const drift = [...compare(join(tmp, "dist"), join(PKG, "dist")), ...compare(join(tmp, "locales"), join(PKG, "locales"))];
    if (drift.length === 0) {
      console.log(`ok       plugins/pi-todo-bundle matches plugins/pi-todo (${name}@${version})`);
    } else {
      console.error("stale    plugins/pi-todo-bundle is out of date; run: bun scripts/build-todo-bundle.mjs");
      for (const line of drift) console.error(`         ${line}`);
      process.exit(1);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
