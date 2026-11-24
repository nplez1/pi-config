// Peer transport: tar over ssh, both directions, with nothing installed on the
// far end. Merge always happens locally on the machine you are typing on, so a
// host only ever needs sshd and tar.
//
// The remote side is driven by one small POSIX sh script rather than by a
// sequence of quoted commands: extraction, pruning and permission fixes are
// easier to audit in one place, and no path or id has to survive shell quoting.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_REMOTE_ROOT, validId } from './config.mjs';

const SSH_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'LogLevel=ERROR',
];

// Paths we send into a remote shell are validated, never escaped blindly.
const SAFE_PATH = /^[A-Za-z0-9._~/-]+$/;
const REMOTE_TIMEOUT_MS = 120_000;

let sshRunner = null;

/** Test seam: replace the ssh runner (returning {status, stdout, stderr}). */
export function setSshRunner(fn) {
  sshRunner = fn;
}

function ssh(alias, command, { input, timeoutMs = REMOTE_TIMEOUT_MS } = {}) {
  if (sshRunner) return sshRunner(alias, command, { input, timeoutMs });
  const options = { encoding: 'buffer', timeout: timeoutMs };
  if (input !== undefined) options.input = input;
  // `--` ends option parsing: an alias beginning with '-' would otherwise be
  // read as an ssh flag (ProxyCommand and friends), not as a host.
  return spawnSync('ssh', [...SSH_OPTIONS, '--', alias, command], options);
}

export function remoteRoot(host) {
  const raw = host.path || DEFAULT_REMOTE_ROOT;
  if (typeof raw !== 'string' || !SAFE_PATH.test(raw)) {
    throw new Error(`host ${host.name}: unsafe path ${JSON.stringify(raw)}`);
  }
  // Normalise before judging: '/etc/', '//etc', '/tmp/./' and '/private/etc' are
  // all the same directory the checks below are meant to reject. normalize keeps
  // a trailing slash, so it is stripped explicitly — otherwise '/etc/' walks past
  // every one of them.
  const strip = (value) => (value.length > 1 ? value.replace(/\/+$/, '') || '/' : value);
  const resolved = strip(
    raw.startsWith('~/')
      ? `$HOME/${strip(path.posix.normalize(raw.slice(2)))}`
      : raw === '~'
        ? '$HOME'
        : path.posix.normalize(raw),
  );
  // The remote script runs `chmod 700` on this root and writes state into it, so
  // a root that is not a dedicated directory would lock down or litter $HOME.
  const bare = resolved.replace(/^\$HOME\/?/, '').replace(/\/$/, '');
  if (!bare || bare === '.' || bare === '/' || resolved === '$HOME' || raw.includes('..') || raw.startsWith('-')) {
    throw new Error(`host ${host.name}: refusing path ${JSON.stringify(raw)} — use a dedicated directory such as ~/.config/pat`);
  }
  if (raw !== '~' && !raw.startsWith('~/') && !raw.startsWith('/')) {
    throw new Error(`host ${host.name}: path must be absolute or start with ~/ (got ${JSON.stringify(raw)})`);
  }
  const SYSTEM_ROOTS = new Set([
    '/root', '/etc', '/tmp', '/var', '/usr', '/bin', '/sbin', '/opt',
    '/home', '/Users', '/Library', '/System', '/Applications', '/Volumes',
    '/private/etc', '/private/tmp', '/private/var', '/private', '/dev', '/proc',
  ]);
  // A home directory would be chmod'd to 700 and have state/ and secrets.env
  // written into it, so an absolute path pointing at one is refused too.
  const SYSTEM_PREFIXES = ['/etc/', '/usr/', '/bin/', '/sbin/', '/System/', '/Library/', '/private/', '/dev/', '/proc/'];
  if (
    SYSTEM_ROOTS.has(resolved) ||
    /^\/(Users|home)\/[^/]+$/.test(resolved) ||
    SYSTEM_PREFIXES.some((prefix) => resolved.startsWith(prefix))
  ) {
    throw new Error(`host ${host.name}: refusing path ${JSON.stringify(raw)} — use a dedicated directory such as ~/.config/pat`);
  }
  return resolved;
}

function buffer(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
}

function text(value) {
  return buffer(value).toString('utf8');
}

function describeFailure(result) {
  const stderr = text(result.stderr).trim();
  if (result.status === 255) return `unreachable (ssh exit 255)${stderr ? `: ${stderr}` : ''}`;
  if (result.error) return result.error.message;
  return stderr || `exit ${result.status}`;
}

/** Reachability and writability, checked before a host is ever recorded. */
export function probeHost(host, run = ssh) {
  const root = remoteRoot(host);
  const steps = [];
  const add = (name, ok, detail, advisory = false) => steps.push({ name, ok, detail, advisory });

  const reach = run(host.ssh, 'true', { timeoutMs: 20_000 });
  const reachable = reach.status === 0;
  add('reachable', reachable, reachable ? 'ssh ok' : describeFailure(reach));
  if (!reachable) return { ok: false, steps, root };

  const tools = run(host.ssh, 'command -v tar >/dev/null 2>&1 && command -v sh >/dev/null 2>&1 && echo ok', {
    timeoutMs: 20_000,
  });
  const hasTools = tools.status === 0 && text(tools.stdout).includes('ok');
  add('has tar and sh', hasTools, hasTools ? 'ok' : 'missing tar or sh');

  const writable = run(
    host.ssh,
    `umask 077; mkdir -p "${root}/state" && test -d "${root}/state" && test -w "${root}/state" && echo ok`,
    { timeoutMs: 20_000 },
  );
  const canWrite = writable.status === 0 && text(writable.stdout).includes('ok');
  add('writable', canWrite, canWrite ? root : describeFailure(writable));
  const modes = run(host.ssh, `stat -f %Lp "${root}" 2>/dev/null || stat -c %a "${root}" 2>/dev/null || echo unknown`, {
    timeoutMs: 20_000,
  });
  const mode = text(modes.stdout).trim() || 'unknown';
  // Advisory: the push script chmods the root and every file it writes, so a
  // directory left at 755 is fixed on the first sync rather than blocking it.
  add('permissions', mode === '700' || mode === 'unknown', `${root} is ${mode}${mode === 'unknown' || mode === '700' ? '' : ' — tightened on first push'}`, true);

  const existing = run(
    host.ssh,
    `ls -1 "${root}/state" 2>/dev/null | grep -c '\\.meta\\.json$' 2>/dev/null || echo 0`,
    { timeoutMs: 20_000 },
  );
  const count = Number.parseInt(text(existing.stdout).trim(), 10) || 0;
  add('existing state', true, count ? `${count} token${count === 1 ? '' : 's'} already there` : 'empty');

  return { ok: steps.every((step) => step.advisory || step.ok), steps, root };
}

/** Read a peer's metas without ever moving a secret value. */
export function readRemoteMetas(host, run = ssh, { timeoutMs = 60_000 } = {}) {
  const root = remoteRoot(host);
  // Anchored to end-of-line so a meta followed by other output still parses.
  const result = run(host.ssh, `cd "${root}" 2>/dev/null && cat state/*.meta.json 2>/dev/null || true`, { timeoutMs });
  if (result.status !== 0) return { ok: false, error: describeFailure(result), metas: new Map() };

  const metas = new Map();
  for (const line of text(result.stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const meta = JSON.parse(trimmed);
      // Ids from a peer are untrusted: anything that is not a plain id is
      // dropped here rather than becoming a filename later.
      if (meta && typeof meta.id === 'string' && validId(meta.id)) metas.set(meta.id, meta);
    } catch {
      /* a peer's stray file must not abort the read */
    }
  }
  return { ok: true, metas };
}

/** Pull a peer's whole state into a staging directory (still unmerged). */
export function pullState(host, stagingDir, run = ssh) {
  const root = remoteRoot(host);
  // `if` with no else exits 0, so a host that has never been synced reads as
  // "empty state" instead of an unreachable failure.
  const archive = run(host.ssh, `if cd "${root}" 2>/dev/null && [ -d state ]; then tar cf - state; fi`, {
    timeoutMs: REMOTE_TIMEOUT_MS,
  });
  if (archive.status !== 0) return { ok: false, error: describeFailure(archive) };

  const bytes = buffer(archive.stdout);
  const stateDir = path.join(stagingDir, 'state');
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (!bytes.length) {
    fs.mkdirSync(stateDir, { recursive: true });
    return { ok: true, empty: true };
  }

  const tarFile = path.join(stagingDir, '.incoming.tar');
  fs.writeFileSync(tarFile, bytes, { mode: 0o600 });
  const extract = spawnSync('tar', ['xf', tarFile, '-C', stagingDir], { encoding: 'utf8' });
  fs.rmSync(tarFile, { force: true });
  if (extract.status !== 0) return { ok: false, error: `tar extract failed: ${extract.stderr.trim()}` };
  fs.mkdirSync(stateDir, { recursive: true });
  return { ok: true };
}

/**
 * Push a prepared state directory (state/, secrets.env, .allowed) to a peer.
 *
 * The peer prunes every id it is not allowed to hold, so a work token cannot
 * survive on a home machine even if an earlier push put one there.
 */
export function pushState(host, sourceDir, run = ssh) {
  const root = remoteRoot(host);
  const tarFile = path.join(sourceDir, '..', `.outgoing-${process.pid}.tar`);
  const entries = ['state', 'secrets.env', '.allowed'].filter((entry) => fs.existsSync(path.join(sourceDir, entry)));
  const pack = spawnSync('tar', ['cf', tarFile, '-C', sourceDir, ...entries], { encoding: 'utf8' });
  if (pack.status !== 0) return { ok: false, error: `tar create failed: ${pack.stderr.trim()}` };
  const payload = fs.readFileSync(tarFile);
  fs.rmSync(tarFile, { force: true });

  const upload = run(host.ssh, `umask 077; mkdir -p "${root}" && cat > "${root}/.incoming.tar"`, {
    input: payload,
    timeoutMs: REMOTE_TIMEOUT_MS,
  });
  if (upload.status !== 0) return { ok: false, error: describeFailure(upload) };

  const apply = run(host.ssh, 'sh -s', { input: Buffer.from(applyScript(root), 'utf8'), timeoutMs: REMOTE_TIMEOUT_MS });
  // 75 is the remote script reporting that this peer is mid-write itself.
  if (apply.status === 75) return { ok: false, error: 'peer is busy (its own pat holds the lock) — retry when it finishes' };
  if (apply.status !== 0) return { ok: false, error: describeFailure(apply) };
  return { ok: true, entries };
}

function applyScript(root) {
  return `set -eu
root="${root}"
# The peer's own \`pat set\`/\`pat sync\` takes this lock with an exclusive
# create; honour it rather than overwriting a rotation in progress. The check
# and the extract are not one atomic step, so a true race is still possible —
# but a machine that is actively writing says so instead of being clobbered.
if [ -f "$root/.lock" ]; then
  holder=$(cat "$root/.lock" 2>/dev/null || echo '')
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    rm -f "$root/.incoming.tar"
    echo "peer busy: $root/.lock held by pid $holder" >&2
    exit 75
  fi
  # A dead pid means a crashed pat left the lock behind: clear it and proceed.
  rm -f "$root/.lock"
fi
umask 077
mkdir -p "$root/state"
tar xf "$root/.incoming.tar" -C "$root"
rm -f "$root/.incoming.tar"
# Drop anything this host is not allowed to hold. .allowed lists the ids whose
# state travels here; a token that never appears is removed, value and all.
if [ -f "$root/.allowed" ]; then
  for f in "$root"/state/*.secret "$root"/state/*.meta.json; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    id=\${base%.secret}
    id=\${id%.meta.json}
    grep -qxF -- "$id" "$root/.allowed" || rm -f "$f"
  done
  rm -f "$root/.allowed"
fi
# A tombstone travels as a meta with no value, so drop any value still beside it.
for f in "$root"/state/*.secret; do
  [ -e "$f" ] || continue
  id=$(basename "$f" .secret)
  meta="$root/state/$id.meta.json"
  if [ ! -f "$meta" ] || grep -q '"removed":true' "$meta"; then rm -f "$f"; fi
done
chmod 700 "$root" "$root/state" 2>/dev/null || true
chmod 600 "$root"/state/* "$root"/secrets.env 2>/dev/null || true
`;
}

export function makeStaging() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pat-stage-'));
}

export function describeTransportError(host, error) {
  return `host ${host.name}: ${error}`;
}
