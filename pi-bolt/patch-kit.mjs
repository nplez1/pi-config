#!/usr/bin/env node
/**
 * Rebuild Pi-Bolt with a compile kit that keeps compiled-in extensions' own resource paths working.
 *
 *   node patch-kit.mjs                          prepare the patched kit and print the compile command
 *   node patch-kit.mjs --run                    prepare it and compile
 *   node patch-kit.mjs --run -- --only pi-system-one
 *   node patch-kit.mjs --check                  prepare/verify, but build nothing
 *
 * `pi-bolt update` compiles the release kit, and so does `pi-bolt compile`, so run this again after
 * either one: they put the extension back to being compiled by the unpatched kit. Only the kit is
 * replaced; `~/.pi-bolt/cache` keeps the signed archives it comes from.
 *
 * Why this exists
 * ---------------
 * `gen-plugin-manifest.mjs` stages each extension next to its own resources and then bundles the lot
 * into one file. Bundling resolves `import.meta.url` once, to the *output* file, so after compilation
 * it names the executable's virtual entry -- `file:///$bunfs/root/pi-bin` -- for every extension.
 * Anything that locates a resource relative to itself therefore lands outside the extension:
 *
 *   join(dirname(fileURLToPath(import.meta.url)), "..", "skills")   ->   /$bunfs/skills
 *
 * which no embedded file can satisfy. Pi reports it at startup and moves on:
 *
 *   [Skill conflicts]
 *     /$bunfs/skills
 *       skill path does not exist
 *
 * and the resources are silently absent -- with pi-system-one compiled in you lose the `system-one`
 * skill and the `/judge` prompt. Nothing else notices, which is why it is worth fixing rather than
 * accepting: the extension looks loaded (it answers `/so`) while its resources are gone.
 *
 * The patch pins `import.meta.url` in each staged script to that script's real on-disk URL, before
 * bundling can flatten it. Resources then resolve against the installed extension, which is exactly
 * what the compiled copy is used for -- Pi-Bolt only uses a compiled-in extension while its installed
 * copy is unchanged, and loads the files again as soon as it changes.
 *
 * The patch is applied with anchor assertions: a kit whose generator no longer matches fails loudly
 * here instead of producing a binary with the bug still in it. Upstream fix wanted -- see README.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CACHE = join(homedir(), ".pi-bolt", "cache");
const PATCHED = join(homedir(), ".pi-bolt", "kit-patched");
const GENERATOR = "gen-plugin-manifest.mjs";

const die = (message) => {
	process.stderr.write(`patch-kit: ${message}\n`);
	process.exit(1);
};

// --- the archive pair ----------------------------------------------------------------------------------------------

/** The newest kit/runtime pair in the cache, matched on platform so a stale download cannot pair up. */
function cachedArchives() {
	const entries = readdirSync(CACHE)
		.filter((name) => name.endsWith(".tar.gz"))
		.map((name) => ({ name, path: join(CACHE, name), mtime: statSync(join(CACHE, name)).mtimeMs }));
	const kits = entries
		.map((entry) => ({ ...entry, match: /-pi-bolt-kit-(.+)\.tar\.gz$/.exec(entry.name) }))
		.filter((entry) => entry.match)
		.sort((a, b) => b.mtime - a.mtime);
	if (kits.length === 0) die(`no pi-bolt kit archive in ${CACHE} (run pi-bolt compile once to fetch it)`);
	for (const kit of kits) {
		const platform = kit.match[1];
		const runtime = entries.find((entry) => entry.name.endsWith(`-pi-bolt-runtime-${platform}.tar.gz`));
		if (runtime) return { kit, runtime, platform };
	}
	die(`the newest kit archive has no matching runtime archive in ${CACHE}`);
}

// --- the patch ------------------------------------------------------------------------------------------------------

const ANCHOR_HELPER = `
const IMPORT_META_URL = /\\bimport\\.meta\\.url\\b/g;
const SCRIPT_FILE = /\\.(?:[cm]?[jt]s)$/;

/**
 * Pin \`import.meta.url\` to the file's real URL in a staged copy. See pi-config/pi-bolt/patch-kit.mjs.
 */
function anchorImportMetaUrl(staged, stagedRoot, originalRoot) {
	let entries;
	try {
		entries = readdirSync(staged, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const stagedPath = join(staged, entry.name);
		if (entry.isDirectory()) {
			anchorImportMetaUrl(stagedPath, stagedRoot, originalRoot);
			continue;
		}
		if (!SCRIPT_FILE.test(entry.name)) continue;
		let source;
		try {
			source = readFileSync(stagedPath, "utf8");
		} catch {
			continue;
		}
		if (!source.includes("import.meta.url")) continue;
		const originalPath = join(originalRoot, relative(stagedRoot, stagedPath));
		writeFileSync(stagedPath, source.replace(IMPORT_META_URL, JSON.stringify(pathToFileURL(originalPath).href)));
	}
}
`;

const substitutions = (source) => [
	[
		'import { fileURLToPath } from "node:url";',
		'import { fileURLToPath, pathToFileURL } from "node:url";',
		"url import",
	],
	[
		"\nfunction copyRoot(from, to) {",
		`${ANCHOR_HELPER}\nfunction copyRoot(from, to) {`,
		"copyRoot anchor",
	],
	[
		"\tfor (const root of plan.roots) copyRoot(root.root, join(out, root.stageDir));",
		"\tfor (const root of plan.roots) {\n" +
			"\t\tconst staged = join(out, root.stageDir);\n" +
			"\t\tcopyRoot(root.root, staged);\n" +
			"\t\tanchorImportMetaUrl(staged, staged, root.root);\n" +
			"\t}",
		"root staging",
	],
	[
		'\t\tcopyRoot(dependency.from, join(out, "node_modules", ...dependency.name.split("/")));',
		'\t\tconst staged = join(out, "node_modules", ...dependency.name.split("/"));\n' +
			"\t\tcopyRoot(dependency.from, staged);\n" +
			"\t\tanchorImportMetaUrl(staged, staged, dependency.from);",
		"dependency staging",
	],
].map(([find, replace, label]) => ({ find, replace, label, source }));

/** True when the generator already pins `import.meta.url`. */
const isPatched = (source) => source.includes("anchorImportMetaUrl");

function patchGenerator(path) {
	const source = readFileSync(path, "utf8");
	if (isPatched(source)) return "already patched";
	let patched = source;
	for (const { find, replace, label } of substitutions()) {
		if (!patched.includes(find)) {
			die(
				`the kit's ${GENERATOR} no longer matches this patch (${label} anchor missing).\n` +
					"Pi-Bolt changed the staging step: check whether it now pins import.meta.url itself, " +
					"and drop this script if it does.",
			);
		}
		patched = patched.replace(find, replace);
	}
	writeFileSync(path, patched);
	return "patched";
}

// --- prepare, prove, then build --------------------------------------------------------------------------------------

function extract(archive, into) {
	execFileSync("tar", ["-xzf", archive, "-C", into], { stdio: "inherit" });
	const [root] = readdirSync(into);
	if (!root) die(`${archive} extracted nothing`);
	return realpathSync(join(into, root));
}

/**
 * Stage one extension with the generator and require every `import.meta.url` in the staged copy to be
 * gone. This is the patch doing its job, checked before an expensive build rather than after it.
 */
function prove(generatorPath) {
	const out = mkdtempSync(join(tmpdir(), "patch-kit-prove-"));
	try {
		// The generator only runs as a command when argv[1] is its real path, so hand it the real one.
		execFileSync(process.execPath, [generatorPath, "--out", out, "--only", "pi-system-one"], {
			stdio: "ignore",
		});
		const staged = join(out, "package-pi-system-one", "src", "extension.ts");
		if (!existsSync(staged)) return "skipped (nothing staged: pi-system-one is not installed)";
		const text = readFileSync(staged, "utf8");
		if (text.includes("import.meta.url")) die(`${GENERATOR} still leaves import.meta.url in staged code`);
		const url = /file:\/\/[^"]*pi-system-one\/src\/extension\.ts/.exec(text);
		if (!url) return "skipped (pi-system-one does not build resource paths from import.meta.url)";
		if (!existsSync(join(dirname(new URL(url[0]).pathname), "..", "skills"))) {
			die(`pinned URL ${url[0]} does not resolve to an installed skills/ directory`);
		}
		return `pinned to ${url[0]}`;
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

function prepare() {
	const { kit, runtime, platform } = cachedArchives();
	const work = mkdtempSync(join(tmpdir(), "patch-kit-"));
	const unpacked = extract(kit.path, work);
	const state = patchGenerator(join(unpacked, GENERATOR));
	rmSync(PATCHED, { recursive: true, force: true });
	renameSync(unpacked, PATCHED);
	rmSync(work, { recursive: true, force: true });
	const proof = prove(join(PATCHED, GENERATOR));
	process.stderr.write(`patch-kit: ${platform} kit -> ${PATCHED} (${state}; ${proof})\n`);
	return { runtime: runtime.path };
}

const argv = process.argv.slice(2);
const run = argv.includes("--run");
const check = argv.includes("--check");
const passthrough = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
const { runtime } = prepare();

const command = ["compile", "--kit", PATCHED, "--runtime", runtime, ...passthrough];
if (check) process.exit(0);
if (!run) {
	process.stdout.write(`pi-bolt ${command.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ")}\n`);
	process.exit(0);
}
// `pi-bolt`, not `pi`: `compile` is a Pi-Bolt command, and `pi` may be the swap shim or the real pi.
execFileSync("pi-bolt", command, { stdio: "inherit" });
