// Per-token state and the peer merge rules.
//
// The unit of sync is the token, not the file. Each id carries a version
// counter, a hash, a writer and a tombstone flag, so two machines that rotated
// different tokens merge without clobbering each other and no machine has to be
// "the" source of truth.
//
// Version, not wall clock: NTP skew across four machines must never decide
// which credential is live.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR, autoVar, validId, validVar, writeFileAtomic } from './config.mjs';

export { validId, validVar };

const META_SUFFIX = '.meta.json';
const SECRET_SUFFIX = '.secret';
const LOCK_FILE = '.lock';
const ARCHIVE_DIR = 'archive';

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function stateDir(home) {
  return path.join(home, STATE_DIR);
}

export function metaPath(home, id) {
  return path.join(stateDir(home), `${id}${META_SUFFIX}`);
}

export function secretPath(home, id) {
  return path.join(stateDir(home), `${id}${SECRET_SUFFIX}`);
}

export function readMetas(home) {
  const dir = stateDir(home);
  const metas = new Map();
  if (!fs.existsSync(dir)) return metas;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(META_SUFFIX)) continue;
    const stem = entry.slice(0, -META_SUFFIX.length);
    const file = path.join(dir, entry);
    // The filename is the authority on an id, never the JSON inside it: a meta
    // claiming "../../x" would otherwise write outside state/ and delete
    // secrets it never owned.
    if (!validId(stem)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!meta || typeof meta.id !== 'string' || meta.id !== stem) throw new Error('id does not match its filename');
      metas.set(stem, normalizeMeta({ ...meta, id: stem }));
    } catch {
      // A corrupt meta becomes a doctor finding, not a crash that takes every
      // other token down with it — and it stays in .allowed so a push never
      // prunes the peer's only copy of a token we merely failed to parse.
      metas.set(stem, { id: stem, corrupt: true });
    }
  }
  return metas;
}

export function normalizeMeta(meta) {
  return {
    id: meta.id,
    var: validVar(meta.var) ? meta.var : '',
    version: Number.isInteger(meta.version) ? meta.version : 0,
    sha: typeof meta.sha === 'string' ? meta.sha : '',
    updated_at: typeof meta.updated_at === 'string' ? meta.updated_at : '',
    updated_by: typeof meta.updated_by === 'string' ? meta.updated_by : '',
    removed: meta.removed === true,
    // The restriction travels with the token. inventory.toml is local and never
    // synced, so a machine with no row for a work token would otherwise have
    // nothing to gate adoption on and would happily adopt it.
    only_on: Array.isArray(meta.only_on) ? meta.only_on.filter((tag) => typeof tag === 'string') : [],
    ...(meta.corrupt ? { corrupt: true } : {}),
  };
}

export function writeMeta(home, meta) {
  if (!validId(meta?.id)) throw new Error(`refusing to write meta for invalid id ${JSON.stringify(meta?.id)}`);
  // Compact JSON: transport reads one meta per line, and a compact file has no
  // embedded newlines to trip over.
  return writeFileAtomic(metaPath(home, meta.id), `${JSON.stringify(normalizeMeta(meta))}\n`);
}

export function deleteMeta(home, id) {
  if (!validId(id)) return;
  fs.rmSync(metaPath(home, id), { force: true });
}

function readRegular(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  // lstat, so a symlink is never followed: a value must be a value, not a
  // pointer at some other file that we would then distribute to every peer.
  if (!stat.isFile()) return null;
  return fs.readFileSync(file, 'utf8');
}

/**
 * The value a rotation or a removal displaced. Kept outside state/, so it is
 * never distributed and never backed up — it is a local undo, not a replica.
 */
export function archivePath(home, id) {
  return path.join(home, ARCHIVE_DIR, `${id}${SECRET_SUFFIX}`);
}

export function writeArchive(home, id, value) {
  if (!validId(id)) throw new Error(`refusing to archive invalid id ${JSON.stringify(id)}`);
  return writeFileAtomic(archivePath(home, id), value, 0o600);
}

export function readArchive(home, id) {
  if (!validId(id)) return null;
  return readRegular(archivePath(home, id));
}

export function readSecret(home, id) {
  if (!validId(id)) return null;
  return readRegular(secretPath(home, id));
}

export function writeSecret(home, id, value) {
  if (!validId(id)) throw new Error(`refusing to write secret for invalid id ${JSON.stringify(id)}`);
  return writeFileAtomic(secretPath(home, id), value, 0o600);
}

export function deleteSecret(home, id) {
  if (!validId(id)) return;
  fs.rmSync(secretPath(home, id), { force: true });
}

export function makeMeta({ id, varName, version, value, updatedBy, removed = false, onlyOn = [], at = new Date().toISOString() }) {
  return {
    id,
    var: varName,
    version,
    sha: value === undefined ? '' : sha256(value),
    updated_at: at,
    updated_by: updatedBy,
    removed,
    only_on: onlyOn,
  };
}

/**
 * Tag targeting decides what a host may hold. The local inventory row and the
 * token's own metadata are both considered, and either restriction applies: a
 * machine that has no row for the token (the normal case, since the inventory
 * never syncs) still knows the token belongs somewhere else.
 */
export function tokenAllowedOn(token, tags, metaOnlyOn = []) {
  // A local registry row is a deliberate statement about this fleet, so it wins;
  // the token's own metadata is the fallback for machines that have no row —
  // which is the normal case, since inventory.toml never syncs.
  const declared = token?.onlyOn?.length ? token.onlyOn : (metaOnlyOn ?? []);
  if (!declared.length) return true;
  if (!tags.length) return true;
  return declared.some((tag) => tags.includes(tag));
}

// --- merge ------------------------------------------------------------------

/**
 * Merge a peer's metas into ours. Pure: returns what changed and lets the caller
 * copy the secret bytes for adopted ids (this module never reads the peer).
 *
 * - higher version wins
 * - equal version, equal hash: converged
 * - equal version, different hash: CONFLICT, surfaced; neither side is applied
 * - tombstone (removed) is a normal versioned value, so a delete propagates and
 *   cannot be resurrected by a peer that still holds the value
 */
export function mergeStates(local, remote) {
  const next = new Map(local);
  const adopt = [];
  const ignore = [];
  const conflicts = [];
  const converged = [];

  for (const [id, remoteMeta] of remote) {
    if (remoteMeta.corrupt) continue;
    const localMeta = local.get(id);

    if (!localMeta) {
      next.set(id, remoteMeta);
      adopt.push({ id, meta: remoteMeta });
      continue;
    }
    if (remoteMeta.version > localMeta.version) {
      next.set(id, remoteMeta);
      adopt.push({ id, meta: remoteMeta });
      continue;
    }
    if (remoteMeta.version < localMeta.version) {
      ignore.push({ id, meta: remoteMeta });
      continue;
    }
    if (Boolean(localMeta.removed) === Boolean(remoteMeta.removed) && localMeta.sha === remoteMeta.sha) {
      converged.push({ id });
      continue;
    }
    if (localMeta.removed && remoteMeta.removed) {
      converged.push({ id });
      continue;
    }
    conflicts.push({ id, local: localMeta, remote: remoteMeta });
  }

  return { next, adopt, ignore, conflicts, converged };
}

// --- rendering --------------------------------------------------------------

/**
 * A variable name a peer may supply. Valid identifiers are not enough:
 * PROMPT_COMMAND and BASH_ENV are valid identifiers, and this line runs in every
 * shell on this machine. A credential-shaped name is the only shape a peer gets
 * to choose, because no shell interprets those.
 */
export function credentialVar(name) {
  return (
    validVar(name) &&
    name === name.toUpperCase() &&
    /_(TOKEN|TOKENS|KEY|API_KEY|PAT|SECRET|PASSWORD|CREDENTIALS?)$/.test(name)
  );
}

/**
 * The one place a token's variable name is decided, so `secrets.env`, `pat get`,
 * `pat env`, `pat run` and `pat status` cannot disagree about it. Registry wins;
 * a peer's metadata may supply it only when credential-shaped; otherwise it is
 * derived from the id.
 */
export function varNameFor({ id, token, meta }) {
  if (validVar(token?.var)) return token.var;
  if (credentialVar(meta?.var)) return meta.var;
  return autoVar(id);
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Render secrets.env for one host's tags. This is an artifact: state/ is the
 * source of truth, and a host only ever receives the tokens its tags allow.
 */
export function renderEnv({ home, config, inventory, metas, tags, hostName, readValue }) {
  const lines = [
    '# Generated by `pat` — do not edit.',
    '# Rotate with `pat set <id>` on a host its tags cover, then `pat sync`.',
  ];
  const included = [];
  const skipped = [];
  const valueOf = readValue ?? ((id) => readSecret(home, id));

  // Driven by state, not by the registry: a machine renders every token it
  // holds state for. The inventory supplies the variable name and its tags when
  // it has a row — which is often not the case for a peer's own tokens, since
  // inventory.toml is local and never syncs.
  const all = [...new Set([...metas.keys(), ...inventory.tokens.map((token) => token.id)])].sort();
  // Registered tokens claim their variable first, so a pulled token with no row
  // cannot take a name that a registry row already uses.
  const ids = [...all.filter((id) => inventory.byId.has(id)), ...all.filter((id) => !inventory.byId.has(id))];
  // One variable, one value. Two ids mapping to the same name would otherwise
  // resolve by sort order, silently — and the loser would be whichever token
  // happened to sort later.
  const claimed = new Map();

  for (const id of ids) {
    const token = inventory.byId.get(id);
    const meta = metas.get(id);
    if (!meta) {
      skipped.push({ id, reason: 'no value yet' });
      continue;
    }
    if (meta.corrupt) {
      skipped.push({ id, reason: 'metadata unreadable' });
      continue;
    }
    if (meta.removed) {
      skipped.push({ id, reason: 'removed' });
      continue;
    }
    const ignoreTags = config?.ignoreTags instanceof Set ? config.ignoreTags.has(id) : Boolean(config?.ignoreTags);
    if (!ignoreTags && !tokenAllowedOn(token, tags, meta.only_on)) {
      skipped.push({ id, reason: `not tagged for ${hostName}` });
      continue;
    }
    const value = valueOf(id);
    if (value === null) {
      skipped.push({ id, reason: 'value missing' });
      continue;
    }
    // The registry owns the name. A peer's metadata may supply it only when it
    // is credential-shaped, so a machine with no row for a token keeps the name
    // its consumers already use instead of flip-flopping to a derived one.
    const varName = varNameFor({ id, token, meta });
    if (claimed.has(varName)) {
      skipped.push({ id, reason: `variable ${varName} already used by ${claimed.get(varName)}` });
      continue;
    }
    claimed.set(varName, id);
    lines.push(`export ${varName}=${shellQuote(value)}`);
    included.push(id);
  }

  return { text: `${lines.join('\n')}\n`, included, skipped };
}

export function writeEnv(home, text) {
  return writeFileAtomic(path.join(home, 'secrets.env'), text, 0o600);
}


// --- lock -------------------------------------------------------------------

export function acquireLock(home) {
  const file = path.join(home, LOCK_FILE);
  // Bounded retries rather than recursion: if two runners both decide the lock
  // is stale, exactly one wins the exclusive create and the other gives up
  // instead of unlinking the winner's fresh lock.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = 0;
      try {
        holder = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10) || 0;
      } catch {
        holder = 0;
      }
      if (holder && isAlive(holder)) return null;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* another runner broke it first */
      }
    }
  }
  return null;
}

export function releaseLock(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing to release */
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
