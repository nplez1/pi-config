// Tests for the Windows port (install.ps1, pi-bolt/rebuild.ps1, pi-bolt/pi-swap.ps1).
//
// Each test builds a disposable repo and a disposable %USERPROFILE%, and runs the
// real script through Windows PowerShell with a PATH containing only this
// fixture's bin directory, node, and System32. Nothing here may touch the real
// machine: no winget, no npm, no user PATH, no ~/.pi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const skip = process.platform === 'win32' ? false : 'the Windows port only runs on Windows';
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const nodeBin = path.dirname(process.execPath);
const system32 = path.join(systemRoot, 'System32');
// install.cmd calls `powershell` by name; stock Windows has this directory on
// PATH, so a hermetic PATH has to include it too.
const powershellDir = path.dirname(powershell);

if (process.platform === 'win32') {
  assert.ok(fs.existsSync(powershell), `Windows PowerShell is needed for these tests: ${powershell}`);
}

const scripts = [
  'install.cmd',
  'install.ps1',
  'pi-bolt/rebuild.ps1',
  'pi-bolt/rebuild.cmd',
  'pi-bolt/after-update.ps1',
  'pi-bolt/after-update.cmd',
  'pi-bolt/pi-swap.ps1',
];

// A repo skeleton with one file per install.sh target, and a home to install into.
// `repo with spaces` is deliberate: the scripts quote paths, and a temp path with
// a space is what catches a missing quote.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-win-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo with spaces');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const temp = path.join(root, 'temp');
  for (const dir of [repo, home, bin, temp]) fs.mkdirSync(dir, { recursive: true });

  for (const rel of scripts) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(source, rel), path.join(repo, rel));
  }
  // rebuild.ps1 refuses to run without its entry point; the argument plumbing is
  // what these tests assert, so a stub is enough.
  fs.writeFileSync(path.join(repo, 'pi-bolt/rebuild.mjs'), '// stub for the tests\n');

  // npm.cmd lives beside node.exe, so putting node's directory on PATH also puts
  // the *real* npm on it — and after-update.ps1 repairs the pi-web-access build
  // input with `npm install`. A stub that fails closed keeps this suite off the
  // network; a test that needs a working npm writes its own into f.bin.
  fs.writeFileSync(path.join(bin, 'npm.cmd'), [
    '@echo off',
    'if defined FAKE_NPM_LOG echo npm %* >> "%FAKE_NPM_LOG%"',
    'exit /b 1',
    '',
  ].join('\r\n'));

  const files = {
    'dot-pi/agent/models.json': '{}\n',
    'dot-pi/agent/AGENTS.md': '# agents\n',
    'dot-pi/agent/settings.json': JSON.stringify({ theme: 'dark', packages: ['plugins/pi-todo'] }, null, 2) + '\n',
    'dot-pi/agent/subagents.json': '{}\n',
    'dot-pi/agent/pi-system-one.json': '{}\n',
    'dot-pi/agent/agents/helper.md': '# helper\n',
    'dot-pi/agent/extensions/fast-search/index.js': '// stub\n',
    'dot-pi/web-search.json': '{}\n',
    'dot-agents/skills/find-skills/SKILL.md': '# skill\n',
    'dot-config/rpiv-todo/config.json': '{}\n',
    'dot-config/pi-smart-compaction/config.json': '{}\n',
    'dot-config/pi-config/model-roles.json': '{ "opus": null }\n',
    'dot-config/rpiv-advisor/advisor.json': '{ "guidance": "shared" }\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  fs.mkdirSync(path.join(repo, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'pi-bolt'), { recursive: true });

  const env = {
    ...process.env,
    USERPROFILE: home,
    TEMP: temp,
    TMP: temp,
    PATH: [bin, nodeBin, system32, powershellDir].join(';'),
    // Nothing in these tests may install anything or reach the network.
    PI_CONFIG_SKIP_PLUGINS: '1',
    PI_CONFIG_SKIP_PIBOLT: '1',
    PI_CONFIG_SKIP_TOOLS: '1',
    PI_CONFIG_SKIP_BUNDLES: '1',
  };
  delete env.PIBOLT_BUN;
  // after-update.ps1 honours PI_AGENT_DIR; a developer with it set would point
  // these cases at a real agent dir, which is the one thing the fixture forbids.
  delete env.PI_AGENT_DIR;

  const spawn = (script, args, extra = {}) => spawnSync(powershell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, script), ...args],
    { cwd: root, encoding: 'utf8', env: { ...env, ...extra } });
  return {
    root, repo, home, bin, temp, env,
    install: (args = [], extra) => spawn('install.ps1', args, extra),
    rebuild: (args = [], extra) => spawn('pi-bolt/rebuild.ps1', args, extra),
    afterUpdate: (args = [], extra) => spawn('pi-bolt/after-update.ps1', args, extra),
    swap: (args = [], extra) => spawn('pi-bolt/pi-swap.ps1', args, extra),
    // Convenience for the happy path, where a non-zero exit is a test failure.
    ok: (result, label) => {
      assert.equal(result.status, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    },
    backups: () => {
      const dir = path.join(home, '.pi-config-backups');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).flatMap((stamp) =>
        fs.readdirSync(path.join(dir, stamp)).map((name) => path.join(dir, stamp, name)));
    },
  };
}

// True when `target` is the same file as `src` by any mechanism New-ConfigLink
// can use: symlink/junction (realpath) or hardlink (same file id).
function linkedTo(target, src) {
  if (!fs.existsSync(target)) return false;
  const a = fs.statSync(target);
  const b = fs.statSync(src);
  if (a.ino !== 0 && a.ino === b.ino && a.dev === b.dev) return true;
  return fs.realpathSync(target).toLowerCase() === fs.realpathSync(src).toLowerCase();
}

test('every Windows script is pure ASCII', () => {
  // cmd parses a .cmd byte-wise against the console codepage, so one UTF-8
  // em-dash desyncs the parser under any codepage but the ANSI one and the tail
  // of a `rem` line then runs as a command: `'m' is not recognized as an
  // internal or external command`. A BOM breaks the first line outright.
  // PowerShell 5.1 reads a BOM-less file as ANSI too, so keep all of them ASCII
  // rather than depending on the BOM or on this machine's codepage.
  const files = [
    'install.cmd', 'install.ps1',
    'pi-bolt/rebuild.cmd', 'pi-bolt/rebuild.ps1',
    'pi-bolt/after-update.cmd', 'pi-bolt/after-update.ps1',
    'pi-bolt/pi-swap.ps1',
  ];
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(source, rel));
    const offending = [...bytes].filter((byte) => byte >= 0x80);
    assert.equal(offending.length, 0,
      `${rel} has ${offending.length} non-ASCII byte(s); a non-ANSI console codepage will desync cmd`);
  }
});

test('install.ps1 -DryRun reports every action and writes nothing', { skip }, (t) => {
  const f = fixture(t);
  const out = f.ok(f.install(['-DryRun']), 'dry run');
  assert.match(out, /mode: dry-run/);
  assert.match(out, /^would\s+link .*models\.json/m);
  assert.match(out, /^would\s+seed .*settings\.json/m);
  // PowerShell itself materialises %USERPROFILE%\AppData, so assert on the
  // installer's own targets rather than on an empty directory.
  for (const rel of ['.pi', '.config', '.agents', '.pi-config-backups']) {
    assert.equal(fs.existsSync(path.join(f.home, rel)), false, `dry run created ${rel}`);
  }
});

test('install.ps1 links portable files and seeds machine-owned ones', { skip }, (t) => {
  const f = fixture(t);
  const out = f.ok(f.install(), 'install');
  assert.match(out, /^link\s+.*models\.json/m);
  assert.match(out, /^seed\s+.*settings\.json/m);
  assert.match(out, /Done\. \d+ change\(s\)/);

  const models = path.join(f.home, '.pi/agent/models.json');
  assert.ok(linkedTo(models, path.join(f.repo, 'dot-pi/agent/models.json')),
    'a portable file must resolve to the repo, not to a copy');
  const skills = path.join(f.home, '.agents/skills/find-skills');
  assert.ok(linkedTo(skills, path.join(f.repo, 'dot-agents/skills/find-skills')));

  const settings = path.join(f.home, '.pi/agent/settings.json');
  assert.equal(linkedTo(settings, path.join(f.repo, 'dot-pi/agent/settings.json')), false,
    'a machine-owned file must be a private copy, never a link into the repo');
  assert.equal(fs.readFileSync(settings, 'utf8'), fs.readFileSync(path.join(f.repo, 'dot-pi/agent/settings.json'), 'utf8'));
});

test('a second run is a no-op that keeps a machine-owned edit', { skip }, (t) => {
  const f = fixture(t);
  const settings = path.join(f.home, '.pi/agent/settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{"defaultModel":"chosen-on-this-machine"}\n');
  f.ok(f.install(), 'first install');

  const out = f.ok(f.install(), 'second install');
  assert.match(out, /^keep\s+.*settings\.json/m);
  assert.match(fs.readFileSync(settings, 'utf8'), /chosen-on-this-machine/,
    'a machine-owned file must survive a re-run');

  // A machine-owned file is kept in place, so it is never moved to a backup and
  // never replaced: the run is idempotent, not merely non-fatal.
  assert.deepEqual(f.backups().filter((p) => p.endsWith('settings.json')), [],
    'a machine-owned file must be kept, not backed up and replaced');
});

test('a pre-existing real file is moved aside, never deleted', { skip }, (t) => {
  const f = fixture(t);
  const models = path.join(f.home, '.pi/agent/models.json');
  fs.mkdirSync(path.dirname(models), { recursive: true });
  fs.writeFileSync(models, '{"mine":true}\n');

  const out = f.ok(f.install(), 'install over a real file');
  assert.match(out, /^backup\s+.*models\.json/m);
  const saved = f.backups().find((p) => p.endsWith('models.json'));
  assert.ok(saved, 'the replaced file was not backed up');
  assert.match(fs.readFileSync(saved, 'utf8'), /"mine":\s*true/);
  assert.ok(linkedTo(models, path.join(f.repo, 'dot-pi/agent/models.json')));
});

test('uninstall removes the links into the repo and leaves machine-owned files', { skip }, (t) => {
  const f = fixture(t);
  f.ok(f.install(), 'install');
  const models = path.join(f.home, '.pi/agent/models.json');
  assert.ok(fs.existsSync(models));

  const out = f.ok(f.install(['uninstall']), 'uninstall');
  assert.match(out, /^unlink\s+.*models\.json/m);
  assert.equal(fs.existsSync(models), false, 'a link into the repo must be removed');
  assert.ok(fs.existsSync(path.join(f.home, '.pi/agent/settings.json')), 'a machine-owned file must be left alone');
  assert.match(out, /Machine-owned files .* left in place/);
  // Removing a link must never reach through it.
  assert.ok(fs.existsSync(path.join(f.repo, 'dot-pi/agent/models.json')), 'uninstall must not touch the repo file');
  assert.ok(fs.existsSync(path.join(f.repo, 'plugins')), 'uninstall must not delete the repo plugins');
  assert.ok(fs.existsSync(path.join(f.repo, 'dot-pi/agent/extensions/fast-search/index.js')),
    'uninstall must not delete a linked directory\'s contents');
  assert.equal(fs.existsSync(path.join(f.home, '.pi/agent/extensions/fast-search')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.pi/agent/plugins')), false, 'the plugins link is removed');
});

test('a machine-owned file hardlinked outside the repo is kept, not overwritten', { skip }, (t) => {
  const f = fixture(t);
  // A hardlink to a file the user owns elsewhere: shared bytes, no path back into
  // this repo. Converting it would delete the values it holds.
  const outside = path.join(f.root, 'my-settings.json');
  fs.writeFileSync(outside, '{"defaultModel":"mine"}\n');
  const live = path.join(f.home, '.pi/agent/settings.json');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.linkSync(outside, live);

  const out = f.ok(f.install(), 'install over a foreign hardlink');
  assert.match(out, /^keep\s+.*settings\.json/m);
  assert.match(fs.readFileSync(live, 'utf8'), /mine/, 'machine values must survive');
  assert.deepEqual(f.backups(), [], 'nothing should be backed up or replaced');
});

test('capture publishes shared keys and strips the account-owned ones', { skip }, (t) => {
  const f = fixture(t);
  f.ok(f.install(), 'install');

  const settings = path.join(f.home, '.pi/agent/settings.json');
  const live = JSON.parse(fs.readFileSync(settings, 'utf8'));
  fs.writeFileSync(settings, JSON.stringify({
    ...live, defaultProvider: 'deepseek', defaultModel: 'deepseek-flash', enabledModels: ['deepseek/*'],
  }, null, 2));
  const subagents = path.join(f.home, '.pi/agent/subagents.json');
  fs.writeFileSync(subagents, JSON.stringify({ agentOverrides: { explore: { model: 'a/b', thinking: 'low' } } }, null, 2));

  f.ok(f.install(['capture']), 'capture');

  const seed = JSON.parse(fs.readFileSync(path.join(f.repo, 'dot-pi/agent/settings.json'), 'utf8'));
  assert.equal(seed.theme, 'dark', 'a shared key must travel back');
  for (const key of ['defaultProvider', 'defaultModel', 'enabledModels', 'lastChangelogVersion']) {
    assert.equal(key in seed, false, `${key} is machine-owned and must not be published`);
  }
  const subSeed = JSON.parse(fs.readFileSync(path.join(f.repo, 'dot-pi/agent/subagents.json'), 'utf8'));
  assert.deepEqual(subSeed.agentOverrides, {}, 'a per-machine model choice must not be published');
  const roles = JSON.parse(fs.readFileSync(path.join(f.repo, 'dot-config/pi-config/model-roles.json'), 'utf8'));
  for (const [key, value] of Object.entries(roles)) {
    assert.deepEqual(value, Array.isArray(value) ? [] : null, `model-roles.${key} must be published empty`);
  }
});

test('capture strips the advisor model keys and rewrites bundle paths portably', { skip }, (t) => {
  const f = fixture(t);
  f.ok(f.install(), 'install');

  const advisor = path.join(f.home, '.config/rpiv-advisor/advisor.json');
  fs.writeFileSync(advisor, JSON.stringify({
    guidance: 'live guidance', modelKey: 'a/b', compressorModelKey: 'c/d', effort: 'high',
    disabledForModels: ['x/y'],
  }, null, 2));
  const settings = path.join(f.home, '.pi/agent/settings.json');
  const live = JSON.parse(fs.readFileSync(settings, 'utf8'));
  fs.writeFileSync(settings, JSON.stringify({
    ...live, piBolt: { packages: [path.join(f.repo, 'pi-bolt/pi-bolt-subagents')] },
  }, null, 2));

  f.ok(f.install(['capture']), 'capture');

  const advisorSeed = JSON.parse(fs.readFileSync(path.join(f.repo, 'dot-config/rpiv-advisor/advisor.json'), 'utf8'));
  assert.equal(advisorSeed.guidance, 'live guidance', 'shared guidance travels back');
  for (const key of ['modelKey', 'compressorModelKey', 'effort', 'compressorEffort', 'disabledForModels']) {
    assert.equal(key in advisorSeed, false, `${key} is machine-owned and must not be published`);
  }
  const settingsSeed = JSON.parse(fs.readFileSync(path.join(f.repo, 'dot-pi/agent/settings.json'), 'utf8'));
  assert.deepEqual(settingsSeed.piBolt.packages, ['pi-bolt-bundles/pi-bolt-subagents'],
    'an absolute bundle path must be published relative to the checkout');
});

// PI_CONFIG_LINK_MODE pins the tier so the fallbacks that only run on a machine
// without symlink privilege are actually exercised.
for (const mode of ['symlink', 'hardlink']) {
  test(`a re-run changes nothing on the ${mode} tier`, { skip }, (t) => {
    const f = fixture(t);
    const extra = { PI_CONFIG_LINK_MODE: mode };
    f.ok(f.install([], extra), `first install (${mode})`);
    const out = f.ok(f.install([], extra), `second install (${mode})`);
    assert.match(out, /Done\. 0 change\(s\)/, `a re-run on the ${mode} tier must change nothing:\n${out}`);
    assert.deepEqual(f.backups(), [], `a re-run on the ${mode} tier must not back anything up`);
    assert.ok(linkedTo(path.join(f.home, '.pi/agent/models.json'), path.join(f.repo, 'dot-pi/agent/models.json')),
      `a ${mode} tier must keep edits reaching the repo`);
  });
}

test('the hardlink tier warns that a pull breaks it', { skip }, (t) => {
  const f = fixture(t);
  const out = f.ok(f.install([], { PI_CONFIG_LINK_MODE: 'hardlink' }), 'hardlink install');
  assert.match(out, /hardlinked because this process cannot create symlinks/);
  assert.match(out, /re-run install\.cmd after a pull/);
});

test('the copy tier copies and says edits will not reach the repo', { skip }, (t) => {
  const f = fixture(t);
  const out = f.ok(f.install([], { PI_CONFIG_LINK_MODE: 'copy' }), 'copy install');
  assert.match(out, /copy \(edits will NOT reach the repo\)/);
  const models = path.join(f.home, '.pi/agent/models.json');
  const src = path.join(f.repo, 'dot-pi/agent/models.json');
  assert.equal(linkedTo(models, src), false, 'the copy tier must not pretend to be a link');
  assert.equal(fs.readFileSync(models, 'utf8'), fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(src, '{"changed":true}\n');
  assert.notEqual(fs.readFileSync(models, 'utf8'), fs.readFileSync(src, 'utf8'),
    'a copy is a copy: the repo edit must not appear');
});

test('rebuild.ps1 forwards -Check, -Force and -Verbose to rebuild.mjs', { skip }, (t) => {
  const f = fixture(t);
  const log = path.join(f.temp, 'bun.log');
  const bun = path.join(f.bin, 'bun.cmd');
  fs.writeFileSync(bun, '@echo off\r\necho %* > "%FAKE_BUN_LOG%"\r\nexit /b 0\r\n');
  const extra = { PIBOLT_BUN: bun, FAKE_BUN_LOG: log };

  const read = () => fs.readFileSync(log, 'utf8');
  f.ok(f.rebuild(['-Check'], extra), 'rebuild -Check');
  assert.match(read(), /rebuild\.mjs"? --check/);
  f.ok(f.rebuild(['-Force'], extra), 'rebuild -Force');
  assert.match(read(), /rebuild\.mjs"? --force/);
  f.ok(f.rebuild(['-Force', '-Verbose'], extra), 'rebuild -Force -Verbose');
  assert.match(read(), /rebuild\.mjs"? --force --verbose/);
});

test('rebuild.ps1 fails loudly when bun is missing instead of building nothing', { skip }, (t) => {
  const f = fixture(t);
  const result = f.rebuild(['-Check']);
  assert.equal(result.status, 1);
  // Write-Error wraps its message across lines, so compare on one line.
  assert.match(`${result.stderr} ${result.stdout}`.replace(/\s+/g, ' '), /bun is required/);
});

test('the .cmd wrappers run the scripts under the default execution policy', { skip }, (t) => {
  const f = fixture(t);
  // Run them by explicit relative path with cwd set, so neither the repo path
  // nor the wrapper's path has to survive cmd's argument quoting. The leading
  // `.\` matters: a bare name needs the current directory in the lookup, which
  // NoDefaultCurrentDirectoryInExePath disables.
  const viaCmd = (dir, name, args) => spawnSync('cmd.exe', ['/c', `.\\${name}`, ...args],
    { cwd: dir, env: f.env, encoding: 'utf8' });

  const dry = viaCmd(f.repo, 'install.cmd', ['-DryRun']);
  assert.equal(dry.status, 0, `install.cmd failed:\n${dry.stdout}\n${dry.stderr}`);
  assert.match(dry.stdout, /mode: dry-run/);

  // -Check with no bun on PATH is the wrapper forwarding to rebuild.ps1.
  const rebuild = viaCmd(path.join(f.repo, 'pi-bolt'), 'rebuild.cmd', ['-Check']);
  assert.equal(rebuild.status, 1, `rebuild.cmd should surface the failure:\n${rebuild.stdout}\n${rebuild.stderr}`);
  assert.match(`${rebuild.stdout}${rebuild.stderr}`.replace(/\s+/g, ' '), /bun is required/);
});

test('pi-swap.ps1 status is safe on a machine with no pi-bolt and no shim', { skip }, (t) => {
  const f = fixture(t);
  const out = f.ok(f.swap(['status']), 'status');
  assert.match(out, /swap:\s+not applied/);
  assert.match(out, /previous launcher preserved:\s+no/);
  assert.match(out, /pi-bolt --version:\s+\(not installed\)/);
});

test('pi-swap.ps1 apply refuses without pi-bolt on PATH', { skip }, (t) => {
  const f = fixture(t);
  const result = f.swap(['apply']);
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /pi-bolt is not on PATH/);
  assert.equal(fs.existsSync(path.join(f.home, '.pi/agent/bin/pi.cmd')), false,
    'nothing may be written when there is nothing to swap in');
});

test('pi-swap.ps1 apply writes the shim and remove takes it away', { skip }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bin, 'pi-bolt.cmd'), '@echo off\r\nexit /b 0\r\n');
  // PI_SWAP_SKIP_PATH keeps the real user PATH out of it; the shim is still written.
  const extra = { PI_SWAP_SKIP_PATH: '1' };

  const applied = f.ok(f.swap(['apply'], extra), 'apply');
  assert.match(applied, /PI_SWAP_SKIP_PATH=1 - left your user PATH alone/);
  const shim = fs.readFileSync(path.join(f.home, '.pi/agent/bin/pi.cmd'), 'utf8');
  assert.match(shim, /pi-swap-shim/, 'the shim must be identifiable');
  assert.match(shim, /if "%PI_REAL%"=="1"/, 'the shim must keep the escape hatch');
  assert.match(shim, /pi-bolt %\*/, 'the shim must run pi-bolt with the original arguments');
  assert.equal(fs.existsSync(path.join(f.repo, 'pi-bolt/.pi-swap-state')), false,
    'a skipped PATH edit must not be recorded as one');

  assert.match(f.ok(f.swap(['status'], extra), 'status after apply'), /swap:\s+APPLIED/);
  f.ok(f.swap(['remove'], extra), 'remove');
  assert.equal(fs.existsSync(path.join(f.home, '.pi/agent/bin/pi.cmd')), false);
});

test('pi-swap.ps1 writes a POSIX shim for git-bash', { skip }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bin, 'pi-bolt.cmd'), '@echo off\r\nexit /b 0\r\n');
  const extra = { PI_SWAP_SKIP_PATH: '1' };
  f.ok(f.swap(['apply'], extra), 'apply');

  const posixPath = path.join(f.home, '.pi/agent/bin/pi');
  const bytes = fs.readFileSync(posixPath);
  assert.equal(bytes.subarray(0, 10).toString('latin1'), '#!/bin/sh\n', 'a POSIX shim needs a LF shebang');
  assert.equal(bytes.includes(13), false, 'a CR in the file makes the shebang a bad interpreter');
  const text = bytes.toString('utf8');
  assert.match(text, /pi-swap-shim/, 'the POSIX shim must be identifiable too');
  assert.match(text, /command -v pi-bolt/);
  assert.match(text, /after-update\.ps1/, 'update must route through the sync from bash as well');

  const real = fs.readFileSync(path.join(f.home, '.pi/agent/bin/pi-real'), 'utf8');
  assert.match(real, /pi-swap-real-wrapper/);
  assert.match(real, /pi-real\.cmd/, 'the POSIX pi-real runs the preserved .cmd');

  f.ok(f.swap(['remove'], extra), 'remove');
  assert.equal(fs.existsSync(posixPath), false, 'remove must take the POSIX shim too');
  assert.equal(fs.existsSync(path.join(f.home, '.pi/agent/bin/pi-real')), false);
});

test('the POSIX shim runs under git-bash and routes update through the sync', { skip }, (t) => {
  // Resolve bash once, by absolute path: Node searches the *child's* PATH for the
  // executable, and an MSYS-style PATH is meaningless to CreateProcess.
  const which = spawnSync('where', ['bash'], { encoding: 'utf8' });
  const bash = which.status === 0 ? which.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : null;
  if (!bash) return t.skip('git-bash/MSYS is not installed');

  const f = fixture(t);
  const marker = path.join(f.temp, 'synced.txt');
  // An extensionless POSIX stub: git-bash resolves `pi-bolt` to a script or an
  // .exe, never to a .cmd (the real one is pi-bolt.exe).
  fs.writeFileSync(path.join(f.bin, 'pi-bolt'), '#!/bin/sh\necho STUB-PI-BOLT "$@"\n');
  // A stub sync that only records being run: the real one would npm/rebuild.
  fs.writeFileSync(path.join(f.repo, 'pi-bolt/after-update.ps1'),
    `Set-Content -LiteralPath '${marker.replace(/\\/g, '\\\\')}' -Value synced\n`);
  f.ok(f.swap(['apply'], { PI_SWAP_SKIP_PATH: '1' }), 'apply');

  // A Windows PATH is what bash expects to inherit: MSYS converts it to its own
  // form on startup, which is also how a real git-bash session sees AgentBin.
  const env = {
    ...f.env,
    PATH: [path.join(f.home, '.pi/agent/bin'), f.env.PATH].join(';'),
  };

  // A bare `pi`, resolved through PATH, which is what git-bash could not do before.
  const version = spawnSync(bash, ['-c', 'pi --version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0, `pi was not found or failed in bash:\n${version.stdout}${version.stderr}`);
  assert.match(version.stdout, /STUB-PI-BOLT --version/);

  const updated = spawnSync(bash, ['-c', 'pi update'], { env, encoding: 'utf8' });
  assert.match(updated.stdout, /STUB-PI-BOLT update/);
  assert.ok(fs.existsSync(marker),
    `update from bash must run after-update.ps1 too:\n${updated.stdout}${updated.stderr}`);
});

test('pi-swap.ps1 keeps an existing launcher and restores it byte for byte', { skip }, (t) => {
  const f = fixture(t);
  const binDir = path.join(f.home, '.pi/agent/bin');
  fs.mkdirSync(binDir, { recursive: true });
  const original = '@echo off\r\necho stock pi\r\n';
  fs.writeFileSync(path.join(binDir, 'pi.cmd'), original);
  fs.writeFileSync(path.join(f.bin, 'pi-bolt.cmd'), '@echo off\r\nexit /b 0\r\n');
  const extra = { PI_SWAP_SKIP_PATH: '1' };

  const applied = f.ok(f.swap(['apply'], extra), 'apply over a real launcher');
  assert.match(applied, /preserved the existing launcher/);
  assert.equal(fs.readFileSync(path.join(binDir, 'pi-real.cmd'), 'utf8'), original);
  assert.match(fs.readFileSync(path.join(binDir, 'pi.cmd'), 'utf8'), /pi-swap-shim/);

  f.ok(f.swap(['remove'], extra), 'remove');
  assert.equal(fs.readFileSync(path.join(binDir, 'pi.cmd'), 'utf8'), original,
    'remove must restore the preserved launcher byte for byte');
});

test('pi-swap.ps1 preserves a stock pi that lives elsewhere on PATH', { skip }, (t) => {
  const f = fixture(t);
  const stock = path.join(f.root, 'npm');
  fs.mkdirSync(stock, { recursive: true });
  // npm drops all three names side by side, and PowerShell resolves the .ps1
  // first — wrapping that one opens it in an editor instead of running pi.
  fs.writeFileSync(path.join(stock, 'pi.cmd'), '@echo off\r\necho stock pi\r\nexit /b 0\r\n');
  fs.writeFileSync(path.join(stock, 'pi.ps1'), 'Write-Output "stock pi ps1"\n');
  fs.writeFileSync(path.join(stock, 'pi'), '#!/bin/sh\necho stock pi sh\n');
  fs.writeFileSync(path.join(f.bin, 'pi-bolt.cmd'), '@echo off\r\nexit /b 0\r\n');
  const extra = {
    PI_SWAP_SKIP_PATH: '1',
    PATH: [f.bin, stock, nodeBin, system32, powershellDir].join(';'),
  };

  const applied = f.ok(f.swap(['apply'], extra), 'apply with a stock pi on PATH');
  assert.match(applied, /preserved .*pi\.cmd as/);
  const realPath = path.join(f.home, '.pi/agent/bin/pi-real.cmd');
  const real = fs.readFileSync(realPath, 'utf8');
  assert.ok(real.includes(path.join(stock, 'pi.cmd')), `pi-real must wrap pi.cmd: ${real}`);
  assert.equal(real.includes('pi.ps1'), false, 'a .ps1 is not a launcher to wrap');

  // PI_REAL=1 through the shim has to reach the stock launcher.
  const viaShim = spawnSync('cmd.exe', ['/c', path.join(f.home, '.pi/agent/bin/pi.cmd')],
    { env: { ...f.env, ...extra, PI_REAL: '1' }, encoding: 'utf8' });
  assert.equal(viaShim.status, 0, `PI_REAL=1 failed:\n${viaShim.stdout}${viaShim.stderr}`);
  assert.match(viaShim.stdout, /stock pi/, `PI_REAL=1 must run the stock pi: ${viaShim.stdout}`);

  // remove drops both: the stock pi never moved, so there is nothing to restore,
  // and a wrapper left behind would make the next apply skip preservation.
  f.ok(f.swap(['remove'], extra), 'remove');
  assert.equal(fs.existsSync(realPath), false, 'the wrapper must not outlive remove');
  assert.equal(fs.existsSync(path.join(f.home, '.pi/agent/bin/pi.cmd')), false);
  assert.ok(fs.existsSync(path.join(stock, 'pi.cmd')), 'the stock launcher is untouched');
});

test('the shim propagates pi-bolt exit codes and reports a missing pi-bolt', { skip }, (t) => {
  const f = fixture(t);
  const shim = path.join(f.home, '.pi/agent/bin/pi.cmd');
  const bolt = path.join(f.bin, 'pi-bolt.cmd');
  fs.writeFileSync(bolt, '@echo off\r\nexit /b 3\r\n');
  f.ok(f.swap(['apply'], { PI_SWAP_SKIP_PATH: '1' }), 'apply');

  const propagated = spawnSync('cmd.exe', ['/c', shim], { env: f.env, encoding: 'utf8' });
  assert.equal(propagated.status, 3, `the shim must return pi-bolt's code:\n${propagated.stdout}${propagated.stderr}`);

  // Without pi-bolt on PATH the shim has to say so and fail, not fall through.
  fs.rmSync(bolt);
  const missing = spawnSync('cmd.exe', ['/c', shim], { env: f.env, encoding: 'utf8' });
  assert.equal(missing.status, 127, `a missing pi-bolt must exit 127:\n${missing.stdout}${missing.stderr}`);
  assert.match(`${missing.stdout}${missing.stderr}`, /pi-bolt is not on PATH/);
});

test('pi update runs the post-update sync, and update --models does not', { skip }, (t) => {
  const f = fixture(t);
  const log = path.join(f.temp, 'sync.log');
  // A fake bun that reports "stale" for --check, clean otherwise, and records
  // every build it was asked for.
  fs.writeFileSync(path.join(f.bin, 'bun.cmd'), [
    '@echo off',
    'echo %* >> "%FAKE_BUN_LOG%"',
    'echo %* | findstr /c:"--check" >nul && exit /b 1',
    'exit /b 0',
    '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(f.bin, 'pi-bolt.cmd'),
    '@echo off\r\necho pi-bolt %* >> "%FAKE_BUN_LOG%"\r\nexit /b 4\r\n');
  const env = { ...f.env, PIBOLT_BUN: path.join(f.bin, 'bun.cmd'), FAKE_BUN_LOG: log, FAKE_NPM_LOG: log };
  f.ok(f.swap(['apply'], { ...env, PI_SWAP_SKIP_PATH: '1' }), 'apply');
  const shim = path.join(f.home, '.pi/agent/bin/pi.cmd');
  const run = (args) => spawnSync('cmd.exe', ['/c', shim, ...args], { env, encoding: 'utf8' });

  const updated = run(['update', '--extensions']);
  const syncLog = fs.readFileSync(log, 'utf8');
  assert.match(syncLog, /pi-bolt update --extensions/, 'the shim must still run pi-bolt update');
  // The old shim ran `rebuild.cmd -Check` inline and nothing else, so a
  // regression to it would still pass the bundle assertions below. Only
  // after-update.ps1 reaches for the build input, and it is the one that runs it.
  assert.match(syncLog, /npm install --prefix .*pi-web-access/,
    `the shim must run the whole post-update sync, not just the bundle half:\n${syncLog}`);
  assert.match(syncLog, /rebuild\.mjs"? --check/, 'a stale bundle has to be detected');
  assert.match(syncLog, /rebuild\.mjs"?[ \t]*\r?\n/, 'and rebuilt without --force (stale only)');
  assert.equal(updated.status, 4, `pi-bolt's exit code must survive the sync:\n${updated.stdout}${updated.stderr}`);
  // The sync reports problems on stderr, as after-update.sh does; the shim hands
  // both streams through untouched. (The fixture's npm stub fails closed, so the
  // build-input repair is reported as failed too — this test is about the bundle.)
  assert.match(updated.stdout + updated.stderr, /pi sync: a bundle is (still )?stale/);

  // `update --models` only rewrites the catalog: nothing may be re-synced.
  fs.writeFileSync(log, '');
  const models = run(['update', '--models']);
  assert.equal(fs.readFileSync(log, 'utf8').includes('rebuild.mjs'), false,
    '--models must not trigger a bundle rebuild');
  assert.equal(models.status, 4);
});

test('after-update.ps1 -Check reports a stale bundle and builds nothing', { skip }, (t) => {
  const f = fixture(t);
  const log = path.join(f.temp, 'check.log');
  fs.writeFileSync(path.join(f.bin, 'bun.cmd'), [
    '@echo off',
    'echo %* >> "%FAKE_BUN_LOG%"',
    'echo %* | findstr /c:"--check" >nul && exit /b 1',
    'exit /b 0',
    '',
  ].join('\r\n'));

  const result = f.afterUpdate(['-Check'], { PIBOLT_BUN: path.join(f.bin, 'bun.cmd'), FAKE_BUN_LOG: log });
  assert.equal(result.status, 1, `-Check must gate on staleness:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /pi sync: a bundle is stale/);
  assert.match(result.stderr, /rebuild\.cmd/, 'the report must name the command that fixes it');
  const calls = fs.readFileSync(log, 'utf8');
  assert.equal(calls.replace(/--check/g, '').trim().split(/\r?\n/).length, 1,
    `-Check must not rebuild anything:\n${calls}`);
});

test('after-update.ps1 is silent and exits 0 when everything is in step', { skip }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bin, 'bun.cmd'), '@echo off\r\nexit /b 0\r\n');
  // npm on PATH with the build input present and saved: nothing to repair.
  fs.writeFileSync(path.join(f.bin, 'npm.cmd'), '@echo off\r\nif /i "%~1"=="pkg" echo "1.2.3"\r\nexit /b 0\r\n');
  const npmRoot = path.join(f.home, '.pi/agent/npm');
  fs.mkdirSync(path.join(npmRoot, 'node_modules/pi-web-access/dist'), { recursive: true });
  fs.writeFileSync(path.join(npmRoot, 'node_modules/pi-web-access/dist/index.js'), '// built\n');
  fs.writeFileSync(path.join(npmRoot, 'package.json'), '{ "dependencies": { "pi-web-access": "1.2.3" } }\n');

  const result = f.afterUpdate([], { PIBOLT_BUN: path.join(f.bin, 'bun.cmd') });
  assert.equal(result.status, 0, `a clean machine must exit 0:\n${result.stdout}${result.stderr}`);
  assert.equal(result.stdout.trim(), '', 'a healthy sync prints nothing');
  assert.equal(result.stderr.trim(), '');
});

test('after-update.ps1 restores a pruned pi-web-access build input', { skip }, (t) => {
  const f = fixture(t);
  const log = path.join(f.temp, 'npm.log');
  const npmRoot = path.join(f.home, '.pi/agent/npm');
  const entry = path.join(npmRoot, 'node_modules/pi-web-access/dist/index.js');
  const marker = path.join(f.temp, 'saved');
  fs.mkdirSync(npmRoot, { recursive: true });
  fs.writeFileSync(path.join(npmRoot, 'package.json'), '{ "dependencies": {} }\n');
  // A fake npm: `pkg get` reports the key absent until `install` has run, and the
  // install is what puts the entry point the bundle is built from back.
  fs.writeFileSync(path.join(f.bin, 'npm.cmd'), [
    '@echo off',
    'echo npm %* >> "%FAKE_NPM_LOG%"',
    'if /i "%~1"=="pkg" (',
    '  if exist "%FAKE_NPM_MARKER%" (echo "1.2.3") else (echo {})',
    '  exit /b 0',
    ')',
    'if /i "%~1"=="install" (',
    '  mkdir "%FAKE_NPM_ENTRY_DIR%" 2>nul',
    '  echo // restored> "%FAKE_NPM_ENTRY%"',
    '  echo saved> "%FAKE_NPM_MARKER%"',
    '  exit /b 0',
    ')',
    'exit /b 0',
    '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(f.bin, 'bun.cmd'), '@echo off\r\nexit /b 0\r\n');

  const env = {
    PIBOLT_BUN: path.join(f.bin, 'bun.cmd'),
    FAKE_NPM_LOG: log,
    FAKE_NPM_MARKER: marker,
    FAKE_NPM_ENTRY: entry,
    FAKE_NPM_ENTRY_DIR: path.dirname(entry),
  };
  const restored = f.afterUpdate([], env);
  assert.equal(restored.status, 0, `restoring the input must exit 0:\n${restored.stdout}${restored.stderr}`);
  assert.match(restored.stdout, /pi sync: restoring the pi-web-access build input/);
  assert.match(restored.stdout, /pi sync: pi-web-access build input restored/);
  assert.ok(fs.existsSync(entry), 'the build input has to be back on disk');
  const npmCalls = fs.readFileSync(log, 'utf8');
  assert.match(npmCalls, /npm install --prefix .*--save .*pi-web-access/,
    `the input must be saved, not installed --no-save:\n${npmCalls}`);

  // Second pass: it is saved now, so there is nothing left to do.
  const after = f.afterUpdate(['-Check'], env);
  assert.equal(after.status, 0, `a repaired machine must be in step:\n${after.stdout}${after.stderr}`);
  assert.equal(after.stdout.trim(), '');
});

test('pi-swap.ps1 keeps an unexpanded user PATH and its value kind', { skip }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bin, 'pi-bolt.cmd'), '@echo off\r\nexit /b 0\r\n');
  // A scratch registry key stands in for HKCU:\Environment, so the real user
  // PATH is never read or written by a test.
  const key = `HKCU:\\Software\\pi-config-test-${process.pid}`;
  const ps = (command) => execFileSync(powershell, ['-NoProfile', '-Command', command],
    { encoding: 'utf8', env: f.env });
  ps(`New-Item -Path '${key}' -Force | Out-Null`);
  t.after(() => {
    try { ps(`Remove-Item -LiteralPath '${key}' -Recurse -Force -ErrorAction SilentlyContinue`) } catch {}
  });
  const raw = () => ps(`(Get-Item -LiteralPath '${key}').GetValue('Path', $null, ` +
    `[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`).trim();
  const kind = () => ps(`(Get-Item -LiteralPath '${key}').GetValueKind('Path')`).trim();
  const extra = { PI_SWAP_PATH_KEY: key };

  // An expandable value: %VAR% must survive, and the kind must stay expandable —
  // DoNotExpandEnvironmentNames also returns a literal %VAR% from REG_SZ, so the
  // text alone would not prove the write kept it expandable.
  ps(`Set-ItemProperty -LiteralPath '${key}' -Name 'Path' -Value '%USERPROFILE%\\bin' -Type ExpandString`);
  f.ok(f.swap(['apply'], extra), 'apply');
  assert.ok(raw().startsWith(path.join(f.home, '.pi/agent/bin')), `apply must prepend the agent bin: ${raw()}`);
  assert.ok(raw().includes('%USERPROFILE%\\bin'),
    `apply must not expand an existing %VAR% entry (it would become a fixed path): ${raw()}`);
  assert.equal(kind(), 'ExpandString');
  f.ok(f.swap(['remove'], extra), 'remove');
  assert.equal(raw(), '%USERPROFILE%\\bin', 'remove must restore the original value exactly');

  // A plain REG_SZ value round-trips unchanged, with no separator drift.
  ps(`Set-ItemProperty -LiteralPath '${key}' -Name 'Path' -Value 'C:\\tools\\bin;D:\\other' -Type String`);
  f.ok(f.swap(['apply'], extra), 'apply over REG_SZ');
  assert.equal(raw(), `${path.join(f.home, '.pi/agent/bin')};C:\\tools\\bin;D:\\other`);
  f.ok(f.swap(['remove'], extra), 'remove over REG_SZ');
  assert.equal(raw(), 'C:\\tools\\bin;D:\\other');
});

test('the shim fails loudly when PI_REAL=1 has nothing to restore', { skip }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bin, 'pi-bolt.cmd'), '@echo off\r\nexit /b 0\r\n');
  f.ok(f.swap(['apply'], { PI_SWAP_SKIP_PATH: '1' }), 'apply');
  const shim = path.join(f.home, '.pi/agent/bin/pi.cmd');
  // Pass the shim as its own argument (its path has no spaces) and set PI_REAL in
  // the environment: an inline `set "PI_REAL=1" && "<path>"` cannot survive
  // Node's Windows argument quoting, which escapes the inner quotes for cmd.
  const run = spawnSync('cmd.exe', ['/c', shim], { env: { ...f.env, PI_REAL: '1' }, encoding: 'utf8' });
  assert.equal(run.status, 127, `the shim must exit 127 rather than silently run pi-bolt:\n${run.stdout}${run.stderr}`);
  assert.match(`${run.stdout}${run.stderr}`, /no preserved launcher/);
});
