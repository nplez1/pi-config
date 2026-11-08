import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertNativeVersion,
  CannotProveParityError,
  createNativeFilter,
  MAX_RULE_FILE_BYTES,
  nativeGlobMatches,
  NATIVE_COMPAT_VERSIONS,
} from "../builtin-native-compat.mjs";

const roots = [];
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "native-compat-"));
  roots.push(base);
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
    const index = roots.indexOf(base);
    if (index !== -1) roots.splice(index, 1);
  });
  const home = path.join(base, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  // node:os homedir() reads USERPROFILE on Windows, so HOME alone would leave the
  // filter reading the real user's ~/.gitconfig instead of this fixture's.
  const previousProfile = process.env.USERPROFILE;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  t.after(() => {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  });
  return { base, home };
}

async function touch(file, contents = "") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function gitRepo(dir) {
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await mkdir(path.join(dir, ".git", "info"), { recursive: true });
}

test("nativeGlobMatches preserves native basename, prefix, anchor, braces and glob rules", () => {
  assert.equal(nativeGlobMatches("*.txt", "deep/a.txt"), true);
  assert.equal(nativeGlobMatches("src/*.js", "src/file.js"), true);
  assert.equal(nativeGlobMatches("src/*.js", "deep/src/file.js"), true, "slash patterns are implicitly prefixed with **/");
  assert.equal(nativeGlobMatches("/src/*.js", "src/file.js"), true, "leading slash anchors at requested root");
  assert.equal(nativeGlobMatches("/src/*.js", "deep/src/file.js"), false);
  assert.equal(nativeGlobMatches("**/src/*.js", "src/file.js"), true);
  assert.equal(nativeGlobMatches("**/{a,{b,c}}.txt", "b.txt"), true);
  assert.equal(nativeGlobMatches("**/{a,{b,c}}.txt", "x/c.txt"), true);
  assert.equal(nativeGlobMatches("file[0-2]?.txt", "file2x.txt"), true);
  assert.equal(nativeGlobMatches("file[!0-2].txt", "file9.txt"), true);
  assert.equal(nativeGlobMatches("literal\\*.txt", "literal*.txt"), true);
  assert.equal(nativeGlobMatches("**", ".hidden"), true);
  assert.equal(nativeGlobMatches("*.txt", "folder/.hidden.txt"), true);
});

test("assertNativeVersion is an explicit conservative version gate", () => {
  assert.deepEqual(NATIVE_COMPAT_VERSIONS, ["1.4.0", "1.5.0"]);
  assert.equal(assertNativeVersion("1.4.0"), true);
  assert.equal(assertNativeVersion("1.5.0"), true);
  assert.throws(() => assertNativeVersion("1.5"), (error) => error instanceof CannotProveParityError && /cannot prove parity/.test(error.message));
  assert.throws(() => assertNativeVersion("1.5.1"), /cannot prove parity/);
  assert.throws(() => assertNativeVersion(undefined), /cannot prove parity/);
});

test("filter inherits nested git/non-git rules, honors native negation, skips .git and ignores .fdignore", async (t) => {
  const { base } = await fixture(t);
  const root = path.join(base, "repo");
  await gitRepo(root);
  await touch(path.join(root, ".gitignore"), [
    "ignored.txt",
    "negated.txt",
    "!negated.txt",
    "nested/from-outer-git.txt",
    "secret-dir/",
    "!secret-dir/keep.txt",
    "secret-link",
  ].join("\n") + "\n");
  await touch(path.join(root, ".ignore"), "from-ignore.txt\nnested/preserved-ignore.txt\n");
  await touch(path.join(root, ".fdignore"), "fdskip.txt\n");
  await touch(path.join(root, "ignored.txt"));
  await touch(path.join(root, "negated.txt"));
  await touch(path.join(root, "from-ignore.txt"));
  await touch(path.join(root, "fdskip.txt"));
  await touch(path.join(root, ".hidden"));
  await touch(path.join(root, ".git", "config"));
  await touch(path.join(root, "secret-dir", "keep.txt"));
  await touch(path.join(root, "nested", ".git", "info", "exclude"), "excluded.txt\n");
  await touch(path.join(root, "nested", ".gitignore"), "nested-git.txt\n");
  await touch(path.join(root, "nested", ".ignore"), "nested-ignore.txt\n");
  for (const name of ["from-outer-git.txt", "preserved-ignore.txt", "excluded.txt", "nested-git.txt", "nested-ignore.txt", "ordinary.txt"]) {
    await touch(path.join(root, "nested", name));
  }
  await touch(path.join(root, "nested", "nested-repo", ".git", "info", "exclude"));

  const include = createNativeFilter(root, { requireGit: false });
  assert.equal(await include("ignored.txt", "file"), false);
  assert.equal(await include("negated.txt", "file"), true, "matching negation restores an ignored file");
  assert.equal(await include("from-ignore.txt", "file"), false);
  assert.equal(await include("fdskip.txt", "file"), true, ".fdignore is not read by native walker");
  assert.equal(await include(".hidden", "file"), true, "hidden entries are not excluded by default");
  assert.equal(await include(".git", "dir"), false);
  assert.equal(await include("secret-dir", "dir"), false);
  assert.equal(await include("secret-dir/keep.txt", "file"), false, "walk cannot reach a negated child of an excluded directory");
  assert.equal(await include("nested/from-outer-git.txt", "file"), true, "nested .git resets inherited git rules");
  assert.equal(await include("nested/preserved-ignore.txt", "file"), false, "nested .git retains inherited .ignore rules");
  assert.equal(await include("nested/excluded.txt", "file"), false, "nested repository info/exclude applies");
  assert.equal(await include("nested/nested-git.txt", "file"), false);
  assert.equal(await include("nested/nested-ignore.txt", "file"), false);
  assert.equal(await include("nested/ordinary.txt", "file"), true);

  const positive = createNativeFilter(root, { requireGit: false, override: "*.txt" });
  assert.equal(await positive("ignored.txt", "file"), true, "positive grep glob bypasses ignore for matching files");
  assert.equal(await positive("secret-dir", "dir"), false, "positive glob does not bypass ignored directories");
  assert.equal(await positive("secret-dir/keep.txt", "file"), false, "a bypass does not make an excluded parent traversable");
  const negative = createNativeFilter(root, { requireGit: false, override: "!ignored.txt" });
  assert.equal(await negative("ignored.txt", "file"), false, "negative grep glob has no ignore override");
});

test("outside-git requireGit controls .gitignore but .ignore remains active", async (t) => {
  const { base } = await fixture(t);
  const root = path.join(base, "outside");
  await touch(path.join(root, ".gitignore"), "git-only.txt\n");
  await touch(path.join(root, ".ignore"), "always.txt\n");
  await touch(path.join(root, "git-only.txt"));
  await touch(path.join(root, "always.txt"));
  const grepFilter = createNativeFilter(root, { requireGit: true });
  const findFilter = createNativeFilter(root, { requireGit: false });
  assert.equal(await grepFilter("git-only.txt", "file"), true);
  assert.equal(await grepFilter("always.txt", "file"), false);
  assert.equal(await findFilter("git-only.txt", "file"), false);
  assert.equal(await findFilter("always.txt", "file"), false);
});

test("starting below a repository inherits ancestor rules but reads the root's own rules", async (t) => {
  const { base } = await fixture(t);
  const repo = path.join(base, "repo");
  const root = path.join(repo, "project");
  await gitRepo(repo);
  await touch(path.join(repo, ".gitignore"), "project/ancestor-git.txt\n");
  await touch(path.join(repo, ".ignore"), "project/ancestor-ignore.txt\n");
  await touch(path.join(root, ".gitignore"), "root-git.txt\n");
  await touch(path.join(root, ".ignore"), "root-ignore.txt\n");
  for (const name of ["ancestor-git.txt", "ancestor-ignore.txt", "root-git.txt", "root-ignore.txt", "visible.txt"]) {
    await touch(path.join(root, name));
  }
  const include = createNativeFilter(root, { requireGit: true });
  assert.equal(await include("ancestor-git.txt", "file"), false);
  assert.equal(await include("ancestor-ignore.txt", "file"), false);
  assert.equal(await include("root-git.txt", "file"), false);
  assert.equal(await include("root-ignore.txt", "file"), false);
  assert.equal(await include("visible.txt", "file"), true);
});

test("nested repository below outside-git root enables git rules but retains outer .ignore", async (t) => {
  const { base } = await fixture(t);
  const root = path.join(base, "outside");
  await touch(path.join(root, ".gitignore"), "outer-git.txt\n");
  await touch(path.join(root, ".ignore"), "nested/outer-ignore.txt\n");
  await gitRepo(path.join(root, "nested"));
  await touch(path.join(root, "nested", ".gitignore"), "inner-git.txt\n");
  await touch(path.join(root, "nested", "outer-git.txt"));
  await touch(path.join(root, "nested", "outer-ignore.txt"));
  await touch(path.join(root, "nested", "inner-git.txt"));
  const include = createNativeFilter(root, { requireGit: true });
  assert.equal(await include("nested/outer-git.txt", "file"), true, "outside-git .gitignore was not loaded");
  assert.equal(await include("nested/outer-ignore.txt", "file"), false, "inherited non-git ignore is retained");
  assert.equal(await include("nested/inner-git.txt", "file"), false, "nested repository starts applying gitignore rules");
});

test("worktree commondir, global excludes and repository excludes are applied", async (t) => {
  const { base, home } = await fixture(t);
  const global = path.join(base, "global-excludes");
  await touch(global, "global.txt\n");
  await touch(path.join(home, ".gitconfig"), ` [core]\n excludesfile = ${global}\n`);
  const root = path.join(base, "worktree");
  const gitDir = path.join(base, "git-admin", "worktrees", "wt");
  const common = path.join(base, "git-admin");
  await touch(path.join(root, ".git"), `gitdir: ${gitDir}\n`);
  await touch(path.join(gitDir, "commondir"), "../..\n");
  await touch(path.join(common, "info", "exclude"), "common-exclude.txt\n");
  await touch(path.join(gitDir, "info", "exclude"), "worktree-exclude.txt\n");
  await touch(path.join(root, "global.txt"));
  await touch(path.join(root, "common-exclude.txt"));
  await touch(path.join(root, "worktree-exclude.txt"));
  const include = createNativeFilter(root, { requireGit: true });
  assert.equal(await include("global.txt", "file"), false);
  assert.equal(await include("common-exclude.txt", "file"), false);
  assert.equal(await include("worktree-exclude.txt", "file"), true, "commondir redirects exclude lookup to common git dir");
});

test("symlink entries are not traversed and directory-only rules match actual directories only", async (t) => {
  const { base } = await fixture(t);
  const root = path.join(base, "repo");
  await gitRepo(root);
  await touch(path.join(root, ".gitignore"), "linked-dir/\nsecret-link\n");
  const target = path.join(base, "target");
  await touch(path.join(target, "child.txt"));
  await symlink(target, path.join(root, "linked-dir"));
  await symlink(target, path.join(root, "secret-link"));
  const ordinaryLink = path.join(root, "ordinary-link");
  await symlink(path.join(target, "child.txt"), ordinaryLink);
  const include = createNativeFilter(root, { requireGit: false });
  assert.equal(await include("linked-dir", "symlink"), true, "dir-only rule does not match symlink kind");
  assert.equal(await include("linked-dir/child.txt", "file"), false, "native walker does not recurse into symlink directories");
  assert.equal(await include("secret-link", "symlink"), false);
  assert.equal(await createNativeFilter(root, { requireGit: false, override: "secret-link" })("secret-link", "symlink"), true);
  assert.equal(await include("ordinary-link", "symlink"), true);
});

test("unsupported complexity and bounded rule reads fail explicitly for native fallback", async (t) => {
  assert.throws(() => nativeGlobMatches(`{${Array(1025).fill("x").join(",")}}`, "x"), (error) => error instanceof CannotProveParityError && /brace/.test(error.message));

  const { base } = await fixture(t);
  const oversized = path.join(base, "oversized");
  await mkdir(oversized, { recursive: true });
  await touch(path.join(oversized, ".ignore"), Buffer.alloc(MAX_RULE_FILE_BYTES + 1, 0x78));
  const tooLarge = createNativeFilter(oversized, { requireGit: true });
  await assert.rejects(tooLarge("candidate.txt", "file"), (error) => error instanceof CannotProveParityError && /4 MiB|4194304/.test(error.message));

  const fifoRoot = path.join(base, "fifo");
  await mkdir(fifoRoot, { recursive: true });
  // A non-regular rule file. mkfifo is POSIX-only, so Windows uses a directory:
  // the same isFile() guard has to refuse it, and opening one fails there with
  // EPERM rather than reporting the kind — both are the explicit refusal this
  // asserts, so either message is accepted.
  if (process.platform === "win32") await mkdir(path.join(fifoRoot, ".ignore"), { recursive: true });
  else execFileSync("mkfifo", [path.join(fifoRoot, ".ignore")]);
  const fifo = createNativeFilter(fifoRoot, { requireGit: true });
  await assert.rejects(fifo("candidate.txt", "file"), (error) => error instanceof CannotProveParityError && /regular file|could not safely open/.test(error.message));
});

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
