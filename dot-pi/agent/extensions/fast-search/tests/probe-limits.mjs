// Drive limits.mjs inside the real Pi-Bolt runtime on any platform.
//
//   node probe-limits.mjs
//   PI_BOLT=/path/to/pi-bolt node probe-limits.mjs
//
// Asserts that the fast find path returns byte-identical output to native for
// every limit/tree combination, that the result-limit notice appears exactly
// when more than `limit` files match, and that the accelerated path — not a
// native fallback — produced each result.
import { spawn, execFileSync } from 'node:child_process';
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
if (!PI) { console.error('probe: pi-bolt is not on PATH (set PI_BOLT)'); process.exit(2); }
if (!resolveExecutable('fd')) { console.error('probe: fd must be resolvable on PATH'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-search-limits-'));
const out = path.join(tmp, 'limits.json');
const root = path.join(tmp, 'root');
fs.mkdirSync(root, { recursive: true });

const env = { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
  FAST_LIMIT_ROOT: root, FAST_LIMIT_OUT: out };
delete env.PI_FAST_SEARCH_BACKEND;
delete env.PI_FAST_SEARCH_TRACE;

const code = await new Promise((resolve) => {
  const child = spawn(PI, ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills',
    '--no-context-files', '--no-prompt-templates', '--offline', '--tools', 'find,grep',
    '-e', path.join(HERE, 'limits.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill(), 120_000);
  child.on('close', (exitCode) => {
    clearTimeout(timer);
    if (!fs.existsSync(out)) {
      console.error(`probe: no output (exit ${exitCode})\n${stderr.slice(-1000)}`);
      resolve(null);
    } else resolve(exitCode);
  });
});

if (code === null) { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); }

const result = JSON.parse(fs.readFileSync(out, 'utf8'));
fs.rmSync(tmp, { recursive: true, force: true });

if (result.rows?.[0]?.error) { console.error('probe: ' + result.rows[0].error); process.exit(1); }

const failures = [];
for (const row of result.rows) {
  const label = `${row.count} files, limit ${row.limit}`;
  // A limit below 1 is not provable, so the fast path must defer to native.
  const wanted = row.limit < 1 ? 'native' : 'fd';
  if (!row.equal) failures.push(`${label}: output differs from native (${JSON.stringify(row.text)})`);
  else if (row.fastNotice !== row.nativeNotice) failures.push(`${label}: notice fast=${row.fastNotice} native=${row.nativeNotice}`);
  else if (row.nativeNotice !== row.expectNotice) failures.push(`${label}: notice=${row.nativeNotice} but expected ${row.expectNotice}`);
  else if (row.winner !== wanted) failures.push(`${label}: winner=${row.winner}, expected ${wanted}`);
  else console.log(`  PASS ${label}: equal, notice=${row.nativeNotice}, winner=${row.winner}`);
}

const accelerated = result.rows.filter((row) => row.winner === 'fd').length;
if (accelerated === 0) failures.push('the fast path never ran, so nothing was compared');

console.log(failures.length ? `\n${failures.length} failure(s)\n  ` + failures.join('\n  ')
  : `\nall ${result.rows.length} limit cases passed (${accelerated} on the fast path)`);
process.exit(failures.length ? 1 : 0);
