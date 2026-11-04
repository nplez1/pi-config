import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));

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
  for (const name of ['settings.json', 'subagents.json']) {
    fs.writeFileSync(path.join(repo, 'dot-pi/agent', name), '{}\n');
  }
  for (const name of ['date', 'dirname', 'basename', 'mkdir', 'cp', 'ln', 'readlink', 'rm', 'ls', 'head', 'sed', 'cat']) {
    const source = ['/usr/bin', '/bin'].map(dir => path.join(dir, name)).find(fs.existsSync);
    assert.ok(source, `system utility ${name} is needed for this test`);
    fs.symlinkSync(source, path.join(bin, name));
  }
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
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

test('installs both missing commands in one brew invocation and is idempotent', t => {
  const f = fixture(t);
  assert.match(f.run(), /ok\s+fd and rg are on PATH/);
  assert.deepEqual(f.calls(), ['install fd ripgrep']);
  assert.match(f.run(), /ok\s+fd and rg are on PATH/);
  assert.deepEqual(f.calls(), ['install fd ripgrep']);
});

for (const [present, expected] of [['fd', 'install ripgrep'], ['rg', 'install fd']]) {
  test(`installs only the missing formula when ${present} exists`, t => {
    const f = fixture(t, { [present]: true });
    f.run();
    assert.deepEqual(f.calls(), [expected]);
  });
}

test('does not call brew when both commands already exist', t => {
  const f = fixture(t, { fd: true, rg: true });
  assert.match(f.run(), /ok\s+fd and rg are on PATH/);
  assert.deepEqual(f.calls(), []);
});

test('missing Homebrew is nonfatal and gives actionable instructions', t => {
  const f = fixture(t, { brew: false, fd: true });
  const out = f.run();
  assert.match(out, /SKIP\s+Homebrew not on PATH/);
  assert.match(out, /brew install ripgrep/);
  assert.match(out, /falls back to native/);
  assert.match(out, /Done \(/);
});

test('Homebrew failure is nonfatal and includes a retry', t => {
  const f = fixture(t, { failure: true });
  const out = f.run();
  assert.deepEqual(f.calls(), ['install fd ripgrep']);
  assert.match(out, /SKIP\s+Homebrew install failed; retry: brew install fd ripgrep/);
  assert.match(out, /falls back to native/);
  assert.match(out, /Done \(/);
});

test('reports commands still missing from PATH after brew succeeds', t => {
  const f = fixture(t, { noInstall: true });
  assert.match(f.run(), /SKIP\s+fd rg still unavailable on PATH/);
  assert.deepEqual(f.calls(), ['install fd ripgrep']);
});

test('dry-run prints only missing formula without calling brew or changing HOME', t => {
  const f = fixture(t, { fd: true });
  assert.match(f.run('--dry-run'), /would\s+brew install ripgrep/);
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.equal(fs.existsSync(path.join(f.bin, 'rg')), false);
});

test('dry-run without Homebrew reports how to install without changes', t => {
  const f = fixture(t, { brew: false });
  assert.match(f.run('--dry-run'), /SKIP\s+Homebrew not on PATH.*brew install fd ripgrep/);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('offline brew skip prevents installation', t => {
  const f = fixture(t);
  f.env.PI_CONFIG_SKIP_BREW = '1';
  assert.match(f.run(), /skip\s+PI_CONFIG_SKIP_BREW=1/);
  assert.deepEqual(f.calls(), []);
});

test('migrates the goal package while preserving filters and machine settings', t => {
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

test('removes an old npm goal entry when the local package already exists', t => {
  const f = fixture(t, { fd: true, rg: true });
  fs.writeFileSync(path.join(f.repo, 'dot-pi/agent/settings.json'), JSON.stringify({ packages: ['plugins/pi-codex-goal'] }));
  const live = path.join(f.home, '.pi/agent/settings.json');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, JSON.stringify({ packages: ['npm:pi-codex-goal', 'plugins/pi-codex-goal'] }));
  f.run();
  assert.deepEqual(JSON.parse(fs.readFileSync(live)).packages, ['plugins/pi-codex-goal']);
});

test('capture and uninstall never invoke brew, even with missing commands', t => {
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
