/**
 * Build plugins/pi-advisor-subagent into the "dist-bun" shape Pi-Bolt loads
 * natively.
 *
 * This plugin is 22 TypeScript modules. Pi loads each one through jiti, and the
 * cost is per *module*, not per byte: a 62 KB single-module extension in the same
 * config loads in 0 ms, while these 22 modules cost 41 ms on Pi-Bolt and 64 ms on
 * Node. Bundling collapses them into one CommonJS file that Bun `require`s
 * natively, so jiti never sees them.
 *
 * Two things need care beyond the other two bundles:
 *
 *  - `advisor/prompt.ts` reads `../prompts/<name>` relative to `import.meta.url`,
 *    at module init (`export const ADVISOR_SYSTEM_PROMPT = load(...)`), so a wrong
 *    base URL throws on load rather than degrading quietly. `import.meta` is also
 *    invalid in CommonJS. Each module's `import.meta.url` is therefore replaced
 *    with that module's own original file URL — which keeps the prompt paths
 *    resolving to the live `plugins/pi-advisor-subagent/prompts/`, so prompt edits
 *    take effect with no rebuild. That is also why `prompts/` and `agents/` are
 *    excluded from the staleness fingerprint: they are not in the bundle.
 *
 *  - The one runtime dependency, `@juicesharp/rpiv-config`, is small, has no
 *    `import.meta` of its own, and is inlined rather than left external — so this
 *    bundle needs no `node_modules` beside it.
 *
 * Run:  bun scripts/build.mjs
 *       ADVISOR_SOURCE=/path/to/plugin bun scripts/build.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freshnessSnippet, writeBuildInfo } from "../../lib/bundle-info.mjs";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

/** The plugin checkout. Read-only input. */
const SOURCE =
  process.env.ADVISOR_SOURCE ??
  resolve(HERE, "../../plugins/pi-advisor-subagent");
const ENTRY = join(SOURCE, "index.ts");
const OUT = join(HERE, "dist-bun");

const pkg = JSON.parse(readFileSync(join(SOURCE, "package.json"), "utf8"));
const NAME = "@nplez1/pi-bolt-advisor-subagent";
const KEY = `${NAME}@${pkg.version}:host-modules`;

const VERSION_FILE = join(SOURCE, "package.json");
/** The whole plugin, minus the directories that only feed the live-read paths. */
const INPUTS = [SOURCE];
const SKIP = ["node_modules", ".git", "dist", "dist-bun", "test", "docs", "prompts", "agents"];
const REBUILD_COMMAND = join(dirname(HERE), "rebuild.sh");

const sourceText = readFileSync(ENTRY, "utf8");

/**
 * The packages Pi provides to extensions. Anything here is left out of the bundle
 * and looked up on the global the shim publishes; a subpath counts too
 * (`@earendil-works/pi-ai/compat`, as pi-web-access needs).
 *
 * `@sinclair/typebox` is aliased to the bare `typebox` package, which is what Pi
 * exposes to extensions.
 */
const HOST_ROOTS = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "typebox",
  "@sinclair/typebox",
];
const LOGICAL_ALIAS = [["@sinclair/typebox", "typebox"]];

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
 * Host specifiers actually reached during the build, collected as bun resolves
 * them. Pre-scanning the entry file is not enough here: unlike pi-web-access,
 * whose entry is one already-bundled file, this plugin's imports are spread
 * across 22 modules plus an inlined dependency. Scanning only the entry found
 * one of the four host packages and would have bundled duplicate copies of Pi.
 */
const seenHosts = new Set();

const hostPlugin = {
  name: "pi-host-modules",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!isHostSpecifier(args.path)) return undefined;
      seenHosts.add(args.path);
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
 * `import.meta` is invalid in CommonJS, and `advisor/prompt.ts` needs its own
 * module URL to find `../prompts/`. Substitute each module's real file URL, so
 * those reads resolve exactly as they do today rather than merely not crashing.
 *
 * Runs for every real file bun inlines; the host stubs have their own namespace
 * and are skipped.
 */
let esmUrlRewrites = 0;
const esmUrlPlugin = {
  name: "pi-esm-url",
  setup(build) {
    build.onLoad({ filter: /.*/ }, (args) => {
      if (args.namespace !== "file" || !existsSync(args.path)) return undefined;
      let text;
      try {
        text = readFileSync(args.path, "utf8");
      } catch {
        return undefined;
      }
      if (!text.includes("import.meta")) return undefined;
      const count = text.split("import.meta.url").length - 1;
      esmUrlRewrites += count;
      return {
        contents: text.split("import.meta.url").join(JSON.stringify(pathToFileURL(args.path).href)),
        loader: args.path.endsWith(".ts") ? "ts" : "js",
      };
    });
  },
};

const result = await Bun.build({
  entrypoints: [ENTRY],
  target: "bun",
  format: "cjs",
  plugins: [esmUrlPlugin, hostPlugin],
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

// See the pi-web-access builder for the full note. In short: bun emits
// `__toESM(require(x), 1)` for a default import of an external module, and that
// flag binds `default` to the whole namespace, breaking ESM deps. Dropping it is
// a no-op for CJS and a fix for ESM. Asserted below so it cannot silently lapse.
const interopFixes = (coreTextRaw.match(/__toESM\(require\([^)]*\), 1\)/g) ?? []).length;
const coreText = coreTextRaw.replace(/__toESM\(require\(([^)]*)\), 1\)/g, "__toESM(require($1))");

const hostSpecs = [...seenHosts].sort();
if (hostSpecs.length === 0) {
  console.error("no Pi host modules were reached — refusing to bundle a second copy of Pi");
  process.exit(1);
}
// A host import that survived as a real require would resolve against whatever
// copy sits on disk rather than Pi's own — the duplicate-instance bug.
const leaked = [
  ...coreText.matchAll(/require\("((?:@earendil-works\/|typebox|@sinclair\/typebox)[^"]*)"\)/g),
].map((m) => m[1]);
if (leaked.length) {
  console.error(`bundle still requires ${[...new Set(leaked)].join(", ")} — the host rewrite missed it`);
  process.exit(1);
}

// Any `import.meta` left is a module that would throw on require().
const leftovers = coreText.split("\n").filter((l) => l.includes("import.meta"));
if (leftovers.length) {
  console.error(`\n${leftovers.length} line(s) in the bundle still use import.meta:`);
  for (const l of leftovers.slice(0, 5)) console.error(`  ${l.trim().slice(0, 160)}`);
  console.error("These come from inlined dependencies, which need their own handling.");
  process.exit(1);
}

/** The recorded fingerprint is taken over the source exactly as the builder read it. */
const info = {
  bundleDir: HERE,
  name: NAME,
  version: `${pkg.version}-pibolt.1`,
  sourceDescription: `${pkg.name}@${pkg.version} (${SOURCE})`,
  inputs: INPUTS,
  skip: SKIP,
  sourceVersion: pkg.version,
  versionFile: VERSION_FILE,
  rebuildCommand: REBUILD_COMMAND,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "core.cjs"), coreText);
writeBuildInfo(info);

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
${imports.map((i) => `import * as ${i.id} from ${JSON.stringify(i.target)};`).join("\n")}
${freshnessSnippet()}

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
`;
writeFileSync(join(OUT, "index.js"), shim);

const written = writeBuildInfo(info);
const kb = (n) => (n / 1024).toFixed(0);
console.log(`built ${NAME} from ${pkg.name}@${pkg.version}`);
console.log(`  source   ${SOURCE}`);
console.log(`  core.cjs ${kb(Buffer.byteLength(coreText))} KB (source ${kb(Buffer.byteLength(sourceText))} KB, entry only)`);
console.log(`  host modules: ${hostSpecs.join(", ")}`);
console.log(`  import.meta.url rewritten to each module's own URL (${esmUrlRewrites}x)`);
console.log(`  CJS/ESM interop: dropped isNodeMode on ${interopFixes} call(s)`);
console.log(`  recorded ${JSON.stringify(written.fingerprint)} in build-info.json`);
