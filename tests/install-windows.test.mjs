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

  const spawn = (script, args, extra = {}) => spawnSync(powershell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, script), ...args],
    { cwd: root, encoding: 'utf8', env: { ...env, ...extra } });
  return {
    root, repo, home, bin, temp, env,
    install: (args = [], extra) => spawn('install.ps1', args, extra),
    rebuild: (args = [], extra) => spawn('pi-bolt/rebuild.ps1', args, extra),
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
  assert.equal(fs.existsSync(path.join(f.home, '.pi/agent/plugins')), false, 'the plugins link is removed');
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
  fs.writeFileSync(path.join(stock, 'pi.cmd'), '@echo off\r\necho stock\r\n');
  fs.writeFileSync(path.join(f.bin, 'pi-bolt.cmd'), '@echo off\r\nexit /b 0\r\n');
  const extra = {
    PI_SWAP_SKIP_PATH: '1',
    PATH: [f.bin, stock, nodeBin, system32].join(';'),
  };

  const applied = f.ok(f.swap(['apply'], extra), 'apply with a stock pi on PATH');
  assert.match(applied, /preserved .*pi\.cmd as/);
  const real = fs.readFileSync(path.join(f.home, '.pi/agent/bin/pi-real.cmd'), 'utf8');
  assert.ok(real.includes(path.join(stock, 'pi.cmd')), 'pi-real must point at the stock launcher by absolute path');
});

test('pi-swap.ps1 keeps an unexpanded REG_EXPAND_SZ user PATH', { skip }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bin, 'pi-bolt.cmd'), '@echo off\r\nexit /b 0\r\n');
  // A scratch registry key stands in for HKCU:\Environment, so the real user
  // PATH is never read or written by a test.
  const key = `HKCU:\\Software\\pi-config-test-${process.pid}`;
  const ps = (command) => execFileSync(powershell, ['-NoProfile', '-Command', command],
    { encoding: 'utf8', env: f.env });
  ps(`New-Item -Path '${key}' -Force | Out-Null; ` +
     `Set-ItemProperty -LiteralPath '${key}' -Name 'Path' -Value '%USERPROFILE%\\bin' -Type ExpandString`);
  t.after(() => {
    try { ps(`Remove-Item -LiteralPath '${key}' -Recurse -Force -ErrorAction SilentlyContinue`) } catch {}
  });
  const read = () => ps(`(Get-Item -LiteralPath '${key}').GetValue('Path', $null, ` +
    `[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`).trim();
  const extra = { PI_SWAP_PATH_KEY: key };

  f.ok(f.swap(['apply'], extra), 'apply');
  assert.ok(read().startsWith(path.join(f.home, '.pi/agent/bin')), `apply must prepend the agent bin: ${read()}`);
  assert.ok(read().includes('%USERPROFILE%\\bin'),
    `apply must not expand an existing %VAR% entry (it would become a fixed path): ${read()}`);

  f.ok(f.swap(['remove'], extra), 'remove');
  assert.equal(read(), '%USERPROFILE%\\bin', 'remove must restore the original value exactly');
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
