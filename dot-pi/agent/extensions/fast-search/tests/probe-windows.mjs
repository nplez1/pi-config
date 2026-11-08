// Drive the in-Pi search harnesses (executables.mjs, routes.mjs) inside the real
// Pi-Bolt runtime — what executables.py and routes.py do, without python (Windows
// ships none). Proves fd/rg are actually used and that results equal native.
//
//   node probe-windows.mjs            # uses pi-bolt from PATH
//   PI_BOLT=C:\path\pi-bolt.exe node probe-windows.mjs
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExecutable } from '../builtin-fast-candidates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function which(name) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch { return null; }
}

const PI = process.env.PI_BOLT ?? which('pi-bolt');
const FD = process.env.PI_FD ?? resolveExecutable('fd');
const RG = process.env.PI_RG ?? resolveExecutable('rg');
if (!PI) { console.error('probe: pi-bolt is not on PATH (set PI_BOLT)'); process.exit(2); }
if (!FD || !RG) { console.error('probe: fd and rg must be resolvable on PATH'); process.exit(2); }
if (process.platform !== 'win32') {
  console.error('probe: this driver builds its PATH cases for Windows; use executables.py/routes.py elsewhere');
  process.exit(2);
}

const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-search-probe-'));
const failures = [];
const pass = (m) => console.log('  PASS ' + m);
const fail = (m) => { console.log('  FAIL ' + m); failures.push(m); };

function runPi(harness, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(PI, ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills',
      '--no-context-files', '--no-prompt-templates', '--offline', '--tools', 'find,grep',
      '-e', path.join(HERE, harness)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

function env(extra) {
  const base = { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', ...extra };
  delete base.PI_FAST_SEARCH_BACKEND;
  delete base.PI_FAST_SEARCH_TRACE;
  return base;
}

// A PATH holding only what a case supplies, so "unavailable" means unavailable.
function binWith(entries) {
  const dir = fs.mkdtempSync(path.join(tmp, 'bin-'));
  for (const [name, source] of entries) fs.copyFileSync(source, path.join(dir, name));
  return dir;
}

const root = path.join(tmp, 'exec-root');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'example.txt'), 'needle\n');

const cases = [
  // Both binaries resolvable as fd.exe / rg.exe: this is the PATHEXT fix.
  { name: 'real-path', path: [system32, path.dirname(FD)], expect: 'fd,rg' },
  { name: 'missing-fd', path: [system32, binWith([['rg.exe', RG]])], expect: 'native,native' },
  { name: 'missing-rg', path: [system32, binWith([['fd.exe', FD]])], expect: 'fd,native' },
];

console.log('executables.mjs (find/grep parity, and which backend ran)');
for (const c of cases) {
  const out = path.join(tmp, `exec-${c.name}.json`);
  const { code, stderr } = await runPi('executables.mjs',
    env({ PATH: c.path.join(';'), FAST_EXEC_ROOT: root, FAST_EXEC_OUT: out }), root);
  if (!fs.existsSync(out)) { fail(`${c.name}: no probe output (exit ${code}) ${stderr.slice(-400)}`); continue; }
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  if (result.error) { fail(`${c.name}: ${String(result.error).slice(0, 400)}`); continue; }
  const backends = result.decisions.map((d) => d.backend).join(',');
  const label = `${c.name}: findEqual=${result.findEqual} grepEqual=${result.grepEqual} backends=${backends}`;
  if (!result.findEqual || !result.grepEqual) fail(label);
  else if (backends !== c.expect) fail(`${label} (expected ${c.expect})`);
  else pass(label);
}

console.log('routes.mjs (auto-routing on small, git and broad roots)');
const routeRoot = path.join(tmp, 'route-root');
fs.mkdirSync(routeRoot, { recursive: true });
const routeOut = path.join(tmp, 'routes.json');
const routeRun = await runPi('routes.mjs',
  env({ PATH: [system32, path.dirname(FD)].join(';'), FAST_ROUTE_ROOT: routeRoot, FAST_ROUTE_OUT: routeOut }), routeRoot);
if (!fs.existsSync(routeOut)) {
  fail(`routes: no probe output (exit ${routeRun.code}) ${routeRun.stderr.slice(-400)}`);
} else {
  const result = JSON.parse(fs.readFileSync(routeOut, 'utf8'));
  if (result.error) fail('routes: ' + String(result.error).slice(0, 400));
  else for (const row of result.results) {
    const expected = row.kind === 'find' ? 'fd' : 'rg';
    const label = `routes ${row.name}/${row.kind}: equal=${row.equal} attempted=${row.attempted.join(',')} decision=${row.decision?.backend}`;
    if (!row.equal) fail(label);
    else if (!row.attempted.includes(expected)) fail(`${label} (expected ${expected} attempted)`);
    else if (!['native', expected].includes(row.decision?.backend)) fail(label);
    else pass(label);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall end-to-end probes passed');
process.exit(failures.length ? 1 : 0);
