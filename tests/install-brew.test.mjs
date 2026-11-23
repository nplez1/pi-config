import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));

// install.sh is POSIX: it needs bash and the system utilities the fixture links.
// Windows has neither, so those cases report as skipped instead of failing under
// a `node --test tests/*.test.mjs` run.
const bash = ['/bin/bash', '/usr/bin/bash'].find((candidate) => fs.existsSync(candidate));
const posix = (name, fn) => test(name,
  { skip: bash ? false : 'install.sh is POSIX: this test needs /bin/bash and its system utilities' }, fn);

// The submodule-leftover prune asks git what this clone still carries, so those
// cases need git on the fixture's PATH as well.
const gitBinary = ['/usr/bin/git', '/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
  .find((candidate) => fs.existsSync(candidate)) ?? null;
const posixGit = (name, fn) => test(name, {
  skip: !bash ? 'install.sh is POSIX: this test needs /bin/bash and its system utilities'
    : !gitBinary ? 'these prunes read git, which is not installed here'
      : false,
}, fn);

// Run the entire installer against a disposable repo and HOME. PATH contains
// only explicitly linked system utilities and the commands each test supplies.
function fixture(t, { brew = true, fd = false, rg = false, failure = false, noInstall = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-brew-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo with spaces');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'brew.log');
  for (const dir of [repo, home, bin, path.join(repo, 'patches'), path.join(repo, 'dot-pi/agent')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.copyFileSync(installer, path.join(repo, 'install.sh'));
  fs.writeFileSync(path.join(repo, 'patches/model-picker.mjs'), '');
  // The stale-package prune install.sh calls by path; without it every run prints
  // the fallback skip instead of pruning.
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../scripts/prune-stale.mjs', import.meta.url)),
    path.join(repo, 'scripts/prune-stale.mjs'));
  for (const name of ['settings.json', 'subagents.json']) {
    fs.writeFileSync(path.join(repo, 'dot-pi/agent', name), '{}\n');
  }
  // A plugin this clone carries, so a `plugins/<name>` entry in settings.json is
  // not pruned as stale by the fixture being empty.
  fs.mkdirSync(path.join(repo, 'plugins/pi-codex-goal'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'plugins/pi-codex-goal/package.json'), '{}\n');
  for (const name of ['date', 'dirname', 'basename', 'mkdir', 'cp', 'ln', 'readlink', 'rm', 'ls', 'head', 'sed', 'cat']) {
    const source = ['/usr/bin', '/bin'].map(dir => path.join(dir, name)).find(fs.existsSync);
    assert.ok(source, `system utility ${name} is needed for this test`);
    fs.symlinkSync(source, path.join(bin, name));
  }
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  if (gitBinary) fs.symlinkSync(gitBinary, path.join(bin, 'git'));
  for (const [name, present] of [['fd', fd], ['rg', rg]]) {
    if (present) fs.symlinkSync('/usr/bin/true', path.join(bin, name));
  }
  if (brew) {
    fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/bash
printf '%s\n' "$*" >> "$BREW_LOG"
[ "\${HOMEBREW_NO_AUTO_UPDATE:-0}" = 1 ] || exit 3
[ "\${HOMEBREW_NO_INSTALL_UPGRADE:-0}" = 1 ] || exit 3
[ "\${HOMEBREW_NO_INSTALL_CLEANUP:-0}" = 1 ] || exit 3
[ "\${BREW_FAIL:-0}" != 1 ] || exit 1
[ "\${BREW_NO_INSTALL:-0}" != 1 ] || exit 0
[ "$1" = install ] || exit 2
shift
for formula in "$@"; do
  case "$formula" in
    fd) /bin/ln -s /usr/bin/true "$FAKE_BIN/fd" ;;
    ripgrep) /bin/ln -s /usr/bin/true "$FAKE_BIN/rg" ;;
    *) exit 2 ;;
  esac
done
`, { mode: 0o755 });
  }
  const env = {
    HOME: home, PATH: bin, FAKE_BIN: bin, BREW_LOG: log,
    BREW_FAIL: failure ? '1' : '0', BREW_NO_INSTALL: noInstall ? '1' : '0',
    PI_CONFIG_SKIP_PLUGINS: '1', PI_CONFIG_SKIP_PIBOLT: '1',
  };
  return {
    home, bin, log, env, repo,
    run: (...args) => execFileSync('/bin/bash', [path.join(repo, 'install.sh'), ...args], { env, encoding: 'utf8' }),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [],
  };
}

posix('installs both missing commands in one brew invocation and is idempotent', t => {
  const f = fixture(t);
  assert.match(f.run(), /ok\s+fd and rg are on PATH/);
  assert.deepEqual(f.calls(), ['install fd ripgrep']);
  assert.match(f.run(), /ok\s+fd and rg are on PATH/);
  assert.deepEqual(f.calls(), ['install fd ripgrep']);
});

for (const [present, expected] of [['fd', 'install ripgrep'], ['rg', 'install fd']]) {
  posix(`installs only the missing formula when ${present} exists`, t => {
    const f = fixture(t, { [present]: true });
    f.run();
    assert.deepEqual(f.calls(), [expected]);
  });
}

posix('does not call brew when both commands already exist', t => {
  const f = fixture(t, { fd: true, rg: true });
  assert.match(f.run(), /ok\s+fd and rg are on PATH/);
  assert.deepEqual(f.calls(), []);
});

posix('missing Homebrew is nonfatal and gives actionable instructions', t => {
  const f = fixture(t, { brew: false, fd: true });
  const out = f.run();
  assert.match(out, /SKIP\s+Homebrew not on PATH/);
  assert.match(out, /brew install ripgrep/);
  assert.match(out, /falls back to native/);
  assert.match(out, /Done \(/);
});

posix('Homebrew failure is nonfatal and includes a retry', t => {
  const f = fixture(t, { failure: true });
  const out = f.run();
  assert.deepEqual(f.calls(), ['install fd ripgrep']);
  assert.match(out, /SKIP\s+Homebrew install failed; retry: brew install fd ripgrep/);
  assert.match(out, /falls back to native/);
  assert.match(out, /Done \(/);
});

posix('reports commands still missing from PATH after brew succeeds', t => {
  const f = fixture(t, { noInstall: true });
  assert.match(f.run(), /SKIP\s+fd rg still unavailable on PATH/);
  assert.deepEqual(f.calls(), ['install fd ripgrep']);
});

posix('dry-run prints only missing formula without calling brew or changing HOME', t => {
  const f = fixture(t, { fd: true });
  assert.match(f.run('--dry-run'), /would\s+brew install ripgrep/);
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.equal(fs.existsSync(path.join(f.bin, 'rg')), false);
});

posix('dry-run without Homebrew reports how to install without changes', t => {
  const f = fixture(t, { brew: false });
  assert.match(f.run('--dry-run'), /SKIP\s+Homebrew not on PATH.*brew install fd ripgrep/);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

posix('offline brew skip prevents installation', t => {
  const f = fixture(t);
  f.env.PI_CONFIG_SKIP_BREW = '1';
  assert.match(f.run(), /skip\s+PI_CONFIG_SKIP_BREW=1/);
  assert.deepEqual(f.calls(), []);
});

posix('migrates the goal package while preserving filters and machine settings', t => {
  const f = fixture(t, { fd: true, rg: true });
  const seed = path.join(f.repo, 'dot-pi/agent/settings.json');
  const live = path.join(f.home, '.pi/agent/settings.json');
  fs.writeFileSync(seed, JSON.stringify({ packages: ['plugins/pi-codex-goal', 'npm:new-package'] }));
  fs.mkdirSync(path.dirname(live), { recursive: true });
  const original = { defaultModel: 'local-model', packages: [
    { source: 'npm:pi-codex-goal@0.7.7', prompts: [] },
    { source: 'npm:existing', extensions: [] },
  ] };
  fs.writeFileSync(live, JSON.stringify(original));
  assert.match(f.run('--dry-run'), /npm:pi-codex-goal@0\.7\.7 -> plugins\/pi-codex-goal/);
  assert.deepEqual(JSON.parse(fs.readFileSync(live)), original);
  f.run();
  const result = JSON.parse(fs.readFileSync(live));
  assert.equal(result.defaultModel, 'local-model');
  assert.deepEqual(result.packages, [
    { source: 'plugins/pi-codex-goal', prompts: [] },
    { source: 'npm:existing', extensions: [] },
    'npm:new-package',
  ]);
  f.run();
  assert.deepEqual(JSON.parse(fs.readFileSync(live)), result);
});

posix('removes an old npm goal entry when the local package already exists', t => {
  const f = fixture(t, { fd: true, rg: true });
  fs.writeFileSync(path.join(f.repo, 'dot-pi/agent/settings.json'), JSON.stringify({ packages: ['plugins/pi-codex-goal'] }));
  const live = path.join(f.home, '.pi/agent/settings.json');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, JSON.stringify({ packages: ['npm:pi-codex-goal', 'plugins/pi-codex-goal'] }));
  f.run();
  assert.deepEqual(JSON.parse(fs.readFileSync(live)).packages, ['plugins/pi-codex-goal']);
});

posix('capture and uninstall never invoke brew, even with missing commands', t => {
  const f = fixture(t);
  assert.match(f.run('capture'), /Publishing shared settings/);
  assert.deepEqual(f.calls(), []);
  // Supply every fixed portable target. The existing uninstall implementation
  // returns a failure for absent targets, independently of this brew setup.
  for (const relative of [
    '.pi/agent/models.json', '.pi/agent/AGENTS.md', '.local/bin/pi-auto-project-skills',
    '.pi/web-search.json', '.config/rpiv-todo/config.json',
    '.config/pi-smart-compaction/config.json', '.pi/agent/plugins', '.pi/agent/pi-bolt-bundles',
  ]) {
    const target = path.join(f.home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(f.repo, 'fixture-target'), target);
  }
  assert.match(f.run('uninstall'), /Removing symlinks/);
  assert.deepEqual(f.calls(), []);
});

// ---- pruning -----------------------------------------------------------------
//
// Linking only ever adds, so a file this repo stops carrying leaves its symlink
// behind, and the machine-owned settings.json keeps naming a plugin or bundle
// that is gone. Both are load errors on every launch, and a bundle that no longer
// resolves stops `pi-bolt compile` outright (2026-11-23, rpiv-advisor).

posix('prunes a link whose file this clone dropped, and never one that is not ours', t => {
  const f = fixture(t, { fd: true, rg: true });
  const agentSource = path.join(f.repo, 'dot-pi/agent/agents/helper.md');
  fs.mkdirSync(path.dirname(agentSource), { recursive: true });
  fs.writeFileSync(agentSource, '# helper\n');
  f.run();
  const linked = path.join(f.home, '.pi/agent/agents/helper.md');
  assert.ok(fs.lstatSync(linked).isSymbolicLink(), 'a repo agent is linked');
  // Dangling for someone else's reason: not pointing into this clone, so it stays.
  const foreign = path.join(f.home, '.pi/agent/agents/foreign.md');
  fs.symlinkSync(path.join(f.home, 'missing.md'), foreign);

  fs.rmSync(agentSource);
  const out = f.run();
  assert.match(out, /prune\s+\S*helper\.md \(target gone: dot-pi\/agent\/agents\/helper\.md\)/);
  assert.equal(fs.existsSync(linked), false, 'the dangling link is gone');
  assert.ok(fs.lstatSync(foreign).isSymbolicLink(), 'a link that points elsewhere is kept');
  // Nothing left to prune, so a second run says so instead of repeating itself.
  assert.match(f.run(), /ok\s+nothing dangling/);
});

posix('--dry-run reports a dangling link without removing it', t => {
  const f = fixture(t, { fd: true, rg: true });
  const agentSource = path.join(f.repo, 'dot-pi/agent/agents/helper.md');
  fs.mkdirSync(path.dirname(agentSource), { recursive: true });
  fs.writeFileSync(agentSource, '# helper\n');
  f.run();
  fs.rmSync(agentSource);
  const out = f.run('--dry-run');
  assert.match(out, /would prune\s+\S*helper\.md \(target gone: dot-pi\/agent\/agents\/helper\.md\)/);
  assert.ok(fs.lstatSync(path.join(f.home, '.pi/agent/agents/helper.md')).isSymbolicLink(),
    'a dry run changes nothing');
});

posix('prunes package entries this clone no longer has, and only those', t => {
  const f = fixture(t, { fd: true, rg: true });
  // A plugin and a bundle this clone still carries, one of each it dropped.
  for (const [rel, body] of [
    ['plugins/pi-todo/package.json', '{}\n'],
    ['pi-bolt/pi-bolt-subagents/package.json', '{}\n'],
    ['pi-bolt/pi-bolt-half-built/README', 'only ignored output is left\n'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(f.repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(f.repo, rel), body);
  }
  const live = path.join(f.home, '.pi/agent/settings.json');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, JSON.stringify({
    packages: ['plugins/pi-todo', 'plugins/pi-advisor-subagent', 'npm:pi-web-access', '-plugins/pi-todo'],
    piBolt: {
      packages: [
        'pi-bolt-bundles/pi-bolt-subagents',
        'pi-bolt-bundles/pi-bolt-advisor-subagent',
        'pi-bolt-bundles/pi-bolt-half-built',
        '-plugins/pi-todo',
      ],
    },
  }, null, 2) + '\n');

  const out = f.run();
  assert.match(out, /prune\s+packages: plugins\/pi-advisor-subagent \(the directory is gone\)/);
  assert.match(out, /prune\s+piBolt\.packages: pi-bolt-bundles\/pi-bolt-advisor-subagent \(the directory is gone\)/);
  assert.match(out, /prune\s+piBolt\.packages: pi-bolt-bundles\/pi-bolt-half-built \(no package\.json in it\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(live, 'utf8')), {
    packages: ['plugins/pi-todo', 'npm:pi-web-access', '-plugins/pi-todo'],
    piBolt: { packages: ['pi-bolt-bundles/pi-bolt-subagents', '-plugins/pi-todo'] },
  });
  // Removing nothing must not rewrite the file, so an unchanged machine is a
  // byte-for-byte no-op.
  const before = fs.readFileSync(live, 'utf8');
  f.run();
  assert.equal(fs.readFileSync(live, 'utf8'), before);
});

posixGit('prunes a checkout git no longer carries as a submodule of this clone', t => {
  const f = fixture(t, { fd: true, rg: true });
  execFileSync(gitBinary, ['init', '-q'], { cwd: f.repo });
  fs.writeFileSync(path.join(f.repo, '.gitmodules'),
    '[submodule "plugins/pi-todo"]\n\tpath = plugins/pi-todo\n');
  // Both directories exist with a package.json: only the submodule registration
  // tells the plugin this clone still carries from a deleted one's leftover,
  // which `git submodule update` cannot rmdir while node_modules sits inside it.
  for (const name of ['pi-todo', 'pi-advisor-subagent']) {
    fs.mkdirSync(path.join(f.repo, 'plugins', name), { recursive: true });
    fs.writeFileSync(path.join(f.repo, 'plugins', name, 'package.json'), '{}\n');
  }
  const live = path.join(f.home, '.pi/agent/settings.json');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, JSON.stringify({
    packages: ['plugins/pi-todo', 'plugins/pi-advisor-subagent'],
  }, null, 2) + '\n');

  assert.match(f.run(),
    /prune\s+packages: plugins\/pi-advisor-subagent \(not part of this clone any more\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(live, 'utf8')).packages, ['plugins/pi-todo']);
});
