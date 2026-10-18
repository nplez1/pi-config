/**
 * Build pi-web-access into the "dist-bun" shape Pi-Bolt loads natively.
 *
 * pi-web-access ships `dist/index.js`: a 1 MB, already-esbuild-bundled ESM file.
 * Pi evaluates a package extension's entry through jiti, so that file is
 * transpiled from scratch on every cold start — 958 ms, the single largest cost
 * in this setup. The published file is otherwise ideal for us: self-contained,
 * one literal dynamic import per provider, no workers, no `__dirname`, and its
 * only `import.meta.url` use is a try/catch'd feature-detect for an optional
 * package that is not installed here.
 *
 * So we re-wrap it the way OpenSec wraps its own bundles:
 *
 *   dist-bun/index.js   the jiti shim: imports Pi's modules, publishes them on a
 *                       global, then require()s core.cjs
 *   dist-bun/core.cjs   the extension, re-emitted as CommonJS and required
 *                       natively by Bun, so jiti never touches it
 *
 * The bundle cannot `require` Pi's modules directly — it loads outside jiti's
 * module graph, where Pi's aliases do not resolve — so the host imports are
 * rewritten to a lookup on the global the shim sets.
 *
 * Nothing here writes to the installed package: it is read as input only.
 *
 * Run:  bun scripts/build.mjs
 *       PI_WEB_ACCESS_DIR=/path/to/pi-web-access bun scripts/build.mjs
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freshnessSnippet, writeBuildInfo } from "../../lib/bundle-info.mjs";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

/** The installed package we wrap. Read-only input. */
const SOURCE =
  process.env.PI_WEB_ACCESS_DIR ??
  join(process.env.HOME ?? "", ".pi/agent/npm/node_modules/pi-web-access");
const ENTRY = join(SOURCE, "dist/index.js");
const OUT = join(HERE, "dist-bun");

/** Read once: the host scan below needs it before the bundle is built. */
const sourceText = readFileSync(ENTRY, "utf8");

const pkg = JSON.parse(readFileSync(join(SOURCE, "package.json"), "utf8"));
const NAME = "@nplez1/pi-bolt-web-access";
const KEY = `${NAME}@${pkg.version}:host-modules`;

/**
 * What this bundle is a snapshot of. Only the published entry and the version
 * matter: the nine runtime dependencies stay external (see externalSpecs), so
 * they are resolved live and cannot make the bundle stale.
 */
const VERSION_FILE = join(SOURCE, "package.json");
const INPUTS = [ENTRY, VERSION_FILE];
const REBUILD_COMMAND = join(dirname(HERE), "rebuild.sh");

/**
 * The packages Pi provides to extensions. A specifier is a host module when it
 * is one of these or a subpath of one — pi-web-access reaches into
 * `@earendil-works/pi-ai/compat`, which a hand-written list misses.
 *
 * `@sinclair/typebox` is aliased to the bare `typebox` package, which is what Pi
 * exposes to extensions (the same alias OpenSec's bundles use).
 */
const HOST_ROOTS = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "typebox",
  "@sinclair/typebox",
];

const LOGICAL_ALIAS = [["@sinclair/typebox", "typebox"]];

/** The specifier to actually import from the shim, after aliasing. */
function importSpecifier(spec) {
  for (const [from, to] of LOGICAL_ALIAS) {
    if (spec === from) return to;
    if (spec.startsWith(`${from}/`)) return to + spec.slice(from.length);
  }
  return spec;
}

function isHostSpecifier(spec) {
  return HOST_ROOTS.some((root) => spec === root || spec.startsWith(`${root}/`));
}

/**
 * Every module the source pulls in, static or dynamic. Only the ones this picks
 * up are rewritten; anything else stays for the bundler to inline, and a
 * specifier it cannot resolve fails the build loudly (which is how the
 * `pi-ai/compat` subpath above was caught).
 */
function scanSpecifiers(source) {
  const found = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    if (!m[1].startsWith(".") && !m[1].startsWith("node:") && !m[1].startsWith("data:")) {
      found.add(m[1]);
    }
  }
  return found;
}

const hostSpecs = [...scanSpecifiers(sourceText)].filter(isHostSpecifier).sort();
if (hostSpecs.length === 0) {
  console.error("no Pi host modules found — refusing to bundle a second copy of Pi");
  process.exit(1);
}

/**
 * Everything else the source imports stays external, exactly as the published
 * bundle had it. Inlining these was a mistake worth recording: it produced a
 * 6.8 MB file out of a 1 MB one, and two of the inlined dependencies use
 * `import.meta` (`import.meta.resolve("pdfjs-dist/package.json")` in unpdf),
 * which throws "import.meta is only valid inside modules" once the output is
 * CommonJS. Rewriting a third party's `import.meta` correctly would be
 * guesswork. Leaving them out means Bun `require`s them natively from the same
 * hoisted copy Pi uses, so nothing about their behaviour changes.
 *
 * That requires `node_modules` beside this package (see ensureNodeModules).
 */
const externalSpecs = [...scanSpecifiers(sourceText)].filter(
  (s) => !isHostSpecifier(s) && !s.startsWith("node:") && !s.startsWith("."),
);

/**
 * Make the external dependencies resolvable from this package. They live in the
 * flat `node_modules` Pi installed them into, next to pi-web-access itself, so a
 * symlink gives core.cjs the same resolution it would have had in place.
 */
function ensureNodeModules() {
  // SOURCE is <npm root>/node_modules/pi-web-access, so its dirname *is* the flat node_modules.
  const target = process.env.PI_NPM_NODE_MODULES ?? dirname(SOURCE);
  const link = join(HERE, "node_modules");
  if (!existsSync(target)) {
    console.error(`cannot find the node_modules holding the dependencies: ${target}`);
    process.exit(1);
  }
  try {
    if (lstatSync(link).isSymbolicLink()) return target;
    rmSync(link, { recursive: true, force: true });
  } catch {
    // not there yet
  }
  symlinkSync(target, link, "dir");
  return target;
}

const hostPlugin = {
  name: "pi-host-modules",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!isHostSpecifier(args.path)) return undefined;
      return { path: `pi-host:${args.path}`, namespace: "pi-host" };
    });
    build.onLoad({ filter: /.*/, namespace: "pi-host" }, (args) => {
      const spec = args.path.slice("pi-host:".length);
      return {
        contents: `module.exports = globalThis[Symbol.for(${JSON.stringify(KEY)})](${JSON.stringify(spec)});\n`,
        loader: "js",
      };
    });
  },
};

/**
 * The names the package exports, so the shim can re-export them.
 *
 * pi-web-access exports a default (the extension factory) plus three helpers
 * that other extensions may import (nothing loads them here today). A hardcoded
 * list would silently rot on the next release, so read them off the source: it
 * is esbuild output, so the names are in one `export { ... }` block.
 */
function detectExports(source) {
  const names = new Set();
  let hasDefault = false;
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const [, alias] = piece.split(/\s+as\s+/);
      const exported = (alias ?? piece).trim();
      if (!exported) continue;
      if (exported === "default") hasDefault = true;
      else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exported)) names.add(exported);
    }
  }
  // `export default fn` / `export const x = ...` forms, should esbuild ever emit them.
  if (/^\s*export\s+default\s/m.test(source)) hasDefault = true;
  for (const m of source.matchAll(/^\s*export\s+(?:const|let|var|function|async function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
    names.add(m[1]);
  }
  return { names: [...names].sort(), hasDefault };
}

const { names, hasDefault } = detectExports(sourceText);
if (!hasDefault) {
  console.error(`no default export found in ${ENTRY} — is this a Pi extension entry?`);
  process.exit(1);
}

/**
 * `import.meta` is not valid in CommonJS, and the source uses `import.meta.url`
 * once — `createRequire(import.meta.url)` to feature-detect the optional
 * `glimpseui` package, inside a try/catch. Substitute the original file's real
 * URL, so that lookup resolves from the same directory it does today and the
 * behaviour is unchanged rather than merely still-working-by-accident.
 *
 * Only the entry is rewritten. Modules bun inlines keep their own meaning, and
 * any of those that also reach for `import.meta.url` is reported below by name.
 */
const ENTRY_URL = pathToFileURL(ENTRY).href;
const entryFilter = new RegExp(
  `^${ENTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
);
const entryRewrites = sourceText.split("import.meta.url").length - 1;

const entryPlugin = {
  name: "pi-web-access-entry",
  setup(build) {
    build.onLoad({ filter: entryFilter }, () => ({
      contents: sourceText.split("import.meta.url").join(JSON.stringify(ENTRY_URL)),
      loader: "js",
    }));
  },
};

const result = await Bun.build({
  entrypoints: [ENTRY],
  target: "bun",
  format: "cjs",
  plugins: [entryPlugin, hostPlugin],
  external: externalSpecs,
  minify: false,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const outputs = result.outputs.filter((o) => o.kind === "entry-point");
if (outputs.length !== 1) {
  console.error(`expected 1 entry point output, got ${outputs.length}`);
  process.exit(1);
}

const coreTextRaw = await outputs[0].text();

/**
 * Drop the `isNodeMode` flag bun passes to its CJS/ESM interop helper.
 *
 * Bun emits `__toESM(require("p-limit"), 1)` for a default import of an external
 * module, and its `__toESM` is:
 *
 *   const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default")
 *     ? __defProp(target, "default", { value: mod, enumerable: true })
 *     : target;
 *
 * With `isNodeMode` set that branch is taken unconditionally, so `default` is
 * bound to the whole namespace — and because `to` now already owns `default`,
 * the module's real default export is never copied over it. At runtime that
 * throws `import_p_limit.default is not a function`. The right value depends on
 * the module, so the flag has to go:
 *
 *   - ESM external (p-limit): Bun's `require` sets `__esModule` and exposes the
 *     real `default`, so without the flag the namespace passes through intact.
 *   - CJS external (turndown, undici, linkedom): `!mod.__esModule` is true, so
 *     the branch is still taken and `default` is still the whole export — which
 *     is what a CJS default import means.
 *
 * So dropping it is a no-op for CJS and a fix for ESM. Asserted, so that if bun
 * changes its output the fix cannot silently stop applying.
 */
const interopFixes = (coreTextRaw.match(/__toESM\(require\([^)]*\), 1\)/g) ?? []).length;
const coreText = coreTextRaw.replace(/__toESM\(require\(([^)]*)\), 1\)/g, "__toESM(require($1))");

// Any `import.meta` left in the output is a module bun inlined that would throw
// "import.meta is only valid inside modules" at require() time. Fail before
// writing, so a broken core.cjs is never left in place.
const leftovers = coreText.split("\n").filter((l) => l.includes("import.meta"));
if (leftovers.length) {
  console.error(`\n${leftovers.length} line(s) in the bundle still use import.meta:`);
  for (const l of leftovers.slice(0, 5)) console.error(`  ${l.trim().slice(0, 160)}`);
  console.error("These come from inlined dependencies, which need their own handling.");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "core.cjs"), coreText);
const nodeModulesTarget = ensureNodeModules();

/** The shim, in the shape Pi-Bolt's own bundles use. */
const reexports = names.map((n) => `export const ${n} = core.${n};`).join("\n");

/**
 * The shim imports one module per distinct specifier the bundle needs, and hands
 * them over on a global keyed by the logical (pre-alias) name the bundle asks
 * for. Several logical names can share one import, so key and binding differ.
 */
const identifierFor = (spec) =>
  "host" +
  importSpecifier(spec)
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
    .replace(/^./, (c) => c.toUpperCase());

const imports = [];
const bindings = new Map();
for (const spec of hostSpecs) {
  const target = importSpecifier(spec);
  if (!bindings.has(target)) {
    const id = identifierFor(spec);
    bindings.set(target, id);
    imports.push({ id, target });
  }
}

const shim = `// Generated by scripts/build.mjs — the Pi entry point of the Bun build of ${pkg.name} ${pkg.version}.
//
// Pi evaluates this file through jiti (which transforms it); the extension
// itself is core.cjs, loaded with Bun's native require so it is never
// transformed. The host-provided modules core.cjs needs are only reachable
// through jiti, so they are imported here and handed over on a global.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
${freshnessSnippet()}
${imports.map((i) => `import * as ${i.id} from ${JSON.stringify(i.target)};`).join("\n")}

const hostModules = {
${hostSpecs.map((s) => `  ${JSON.stringify(s)}: ${bindings.get(importSpecifier(s))},`).join("\n")}
};
globalThis[Symbol.for(${JSON.stringify(KEY)})] = (id) => {
  const mod = hostModules[id];
  if (mod === undefined) throw new Error(${JSON.stringify(`${NAME}: host module `)} + id + " is not available");
  return mod;
};

const nativeRequire = createRequire(import.meta.url);
const corePath = nativeRequire.resolve("./core.cjs");
// A fresh evaluation per load, as jiti gives every other extension (/reload).
delete nativeRequire.cache[corePath];
const core = nativeRequire(corePath);

export default core.default;
${reexports}
`;
writeFileSync(join(OUT, "index.js"), shim);

const info = writeBuildInfo({
  bundleDir: HERE,
  name: NAME,
  version: `${pkg.version}-pibolt.1`,
  sourceDescription: `${pkg.name}@${pkg.version} (${SOURCE})`,
  inputs: INPUTS,
  sourceVersion: pkg.version,
  versionFile: VERSION_FILE,
  rebuildCommand: REBUILD_COMMAND,
});

const kb = (n) => (n / 1024).toFixed(0);
console.log(`built ${NAME} from ${pkg.name}@${pkg.version}`);
console.log(`  recorded ${JSON.stringify(info.fingerprint)} in build-info.json`);
console.log(`  source   ${SOURCE}`);
console.log(`  core.cjs ${kb(Buffer.byteLength(coreText))} KB (source ${kb(Buffer.byteLength(sourceText))} KB)`);
console.log(`  host modules: ${hostSpecs.join(", ")}`);
console.log(`  re-exported named: ${names.join(", ") || "(none)"}`);
console.log(`  import.meta.url rewritten to ${ENTRY_URL} (${entryRewrites}x in the entry)`);
console.log(`  external deps: ${externalSpecs.join(", ")}`);
console.log(`  CJS/ESM interop: dropped isNodeMode on ${interopFixes} __toESM(require(...)) call(s)`);
if (interopFixes === 0 && externalSpecs.length > 0) {
  console.error(
    "  WARNING: bun emitted no `__toESM(require(...), 1)` — its interop output may have\n" +
      "  changed, so the default-import fix above is no longer applying. Re-check a\n" +
      "  tool that default-imports an ESM dependency (web fetch uses p-limit).",
  );
}
console.log(`  node_modules -> ${nodeModulesTarget}`);
