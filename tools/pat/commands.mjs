// Command implementations. Everything that writes state goes through the lock,
// and every mutating command can be asked for a dry run.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALLOWED_FILE,
  DEFAULT_WARN_DAYS,
  ENV_FILE,
  appendTokenStanza,
  autoVar,
  ensureHome,
  loadConfig,
  loadInventory,
  localTags,
  resolveHome,
  tighten,
  today,
} from './config.mjs';
import { canary, describeDaysLeft, expiryState, needsAttention, overallState } from './checks.mjs';
import * as store from './store.mjs';
import * as transport from './transport.mjs';

export function context(home = resolveHome()) {
  const config = loadConfig(home);
  const inventory = loadInventory(home);
  return { home, config, inventory, selfName: config.self.name, tags: localTags(config) };
}

export function reload(ctx) {
  ctx.config = loadConfig(ctx.home);
  ctx.inventory = loadInventory(ctx.home);
  ctx.selfName = ctx.config.self.name;
  ctx.tags = localTags(ctx.config);
  return ctx;
}

/**
 * Tag targeting decides what a host may hold. Recomputed from the token's own
 * metadata as well, so a pull onto a machine with no inventory row for a work
 * token is still refused (see store.tokenAllowedOn).
 */
export const tokenAllowedOn = store.tokenAllowedOn;

export function renderLocal(ctx) {
  const metas = store.readMetas(ctx.home);
  const rendered = store.renderEnv({
    home: ctx.home,
    config: ctx.config,
    inventory: ctx.inventory,
    metas,
    tags: ctx.tags,
    hostName: ctx.selfName,
  });
  store.writeEnv(ctx.home, rendered.text);
  return rendered;
}

// --- set / get / run / env --------------------------------------------------

/**
 * The version this machine must beat. A rotation written while this machine is
 * behind a peer would otherwise be adopted away on the next sync — the fresh
 * value would lose to an older, higher-numbered one. Unreachable peers are
 * skipped silently: `pat set` must work offline, and the archive below is the
 * safety net for that case.
 */
async function highestVersionSeen({ ctx, id, floor }) {
  let max = floor;
  let onlyOn = [];
  const unprobed = [];
  // Bounded in total so `pat set` cannot turn into a minute of waiting on a
  // sleeping laptop, but every host gets a real chance first: a shared deadline
  // that one slow peer eats would silently miss a higher version on the next.
  const deadline = Date.now() + 6_000;
  for (const host of hostsFor(ctx.config, 'pull')) {
    const budget = Math.min(2_000, deadline - Date.now());
    if (budget < 150) {
      unprobed.push(host.name);
      continue;
    }
    let remote;
    try {
      remote = transport.readRemoteMetas(host, undefined, { timeoutMs: budget });
    } catch {
      unprobed.push(host.name);
      continue;
    }
    const meta = remote.ok ? remote.metas.get(id) : null;
    if (meta && Number.isInteger(meta.version) && meta.version >= max && Array.isArray(meta.only_on)) {
      onlyOn = meta.only_on;
      max = Math.max(max, meta.version);
    } else if (meta && Number.isInteger(meta.version)) {
      max = Math.max(max, meta.version);
    }
    if (!remote.ok) unprobed.push(host.name);
  }
  return { max, unprobed, onlyOn };
}

export async function setToken({ ctx, id, value, verify = true, force = false }) {
  if (!store.validId(id)) return { ok: false, error: `invalid token id ${JSON.stringify(id)}` };
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, error: 'empty value; nothing written' };

  const trimmed = value.replace(/\r?\n$/, '');
  let token = ctx.inventory.byId.get(id);
  let created = false;
  if (!token) {
    const stub = {
      id,
      var: autoVar(id),
      system: '',
      owner: '',
      renewUrl: '',
      how: '',
      ttlDays: 30,
      issued: today(),
      onlyOn: [],
      consumers: [],
      check: { kind: 'none' },
    };
    appendTokenStanza(ctx.home, stub);
    reload(ctx);
    token = ctx.inventory.byId.get(id);
    created = true;
  }

  const previousMeta = store.readMetas(ctx.home).get(id);
  const inherited = token.onlyOn.length
    ? token.onlyOn
    : (previousMeta?.only_on?.length ? previousMeta.only_on : []);
  // Storing a value this machine's own tags exclude would be undone by the very
  // next sync — the fresh credential would exist nowhere. Refuse instead.
  if (!tokenAllowedOn(token, ctx.tags, inherited)) {
    const where = inherited.length ? `hosts tagged ${inherited.join('/')}` : 'another host';
    return {
      ok: false,
      error: `${id} is restricted to ${where} and ${ctx.selfName} is not one of them — rotate it on a host whose tags cover it, then pull`,
    };
  }

  if (verify && token.check.kind !== 'none') {
    const probe = await canary(token, trimmed);
    if (probe.state === 'invalid' && !force) {
      return {
        ok: false,
        error: `canary rejected the new ${id} value (${probe.detail}) — nothing written, nothing distributed`,
        probe,
      };
    }
  }

  const previous = store.readMetas(ctx.home).get(id);
  // A machine with no inventory row for this token (the normal case on a second
  // machine) must not widen the restriction by rotating it: inherit what the
  // token already declares.
  const seen = await highestVersionSeen({ ctx, id, floor: previous?.version ?? 0 });
  const onlyOn = token.onlyOn.length
    ? token.onlyOn
    : (previous?.only_on?.length ? previous.only_on : (seen.onlyOn ?? []));
  // The restriction can come from a peer we just consulted, so the gate has to
  // run again with the final answer: writing a value we would prune on the very
  // next sync destroys the credential the user just issued.
  if (!tokenAllowedOn(token, ctx.tags, onlyOn)) {
    const where = onlyOn.length ? `hosts tagged ${onlyOn.join('/')}` : 'another host';
    return {
      ok: false,
      error: `${id} belongs to ${where} and ${ctx.selfName} is not one of them — rotate it on such a host and pull, or add one of this machine's tags to only_on in inventory.toml if it really belongs here`,
    };
  }
  const version = seen.max + 1;
  // Archive whatever this rotation displaces: a token that is overwritten is
  // gone from every machine on the next sync, and "recoverable" beats "lost".
  if (previous && !previous.removed) {
    const displaced = store.readSecret(ctx.home, id);
    if (displaced !== null) store.writeArchive(ctx.home, id, displaced);
  }
  store.writeSecret(ctx.home, id, trimmed);
  store.writeMeta(
    ctx.home,
    store.makeMeta({ id, varName: token.var, version, value: trimmed, updatedBy: ctx.selfName, onlyOn }),
  );
  const rendered = renderLocal(ctx);
  return { ok: true, id, version, created, rendered, token, unprobed: seen.unprobed };
}

/**
 * Retire a token. The delete travels as a tombstone — a normal versioned meta
 * with no value — so it propagates, and a peer that still holds the token
 * cannot resurrect it by pushing an older version back.
 */
export function removeToken({ ctx, id, dryRun = false }) {
  if (!store.validId(id)) return { ok: false, error: `invalid token id ${JSON.stringify(id)}` };
  const meta = store.readMetas(ctx.home).get(id);
  if (!meta) return { ok: false, error: `no stored state for ${id} — nothing to remove` };
  if (meta.removed) return { ok: true, id, version: meta.version, already: true, dryRun };

  const version = (meta.version ?? 0) + 1;
  if (!dryRun) {
    const displaced = store.readSecret(ctx.home, id);
    if (displaced !== null) store.writeArchive(ctx.home, id, displaced);
    store.deleteSecret(ctx.home, id);
    store.writeMeta(
      ctx.home,
      store.makeMeta({
        id,
        varName: ctx.inventory.byId.get(id)?.var ?? meta.var,
        version,
        value: undefined,
        updatedBy: ctx.selfName,
        removed: true,
        onlyOn: ctx.inventory.byId.get(id)?.onlyOn?.length ? ctx.inventory.byId.get(id).onlyOn : meta.only_on,
      }),
    );
    renderLocal(ctx);
  }
  return { ok: true, id, version, dryRun };
}

export function getToken({ ctx, id, previous = false }) {
  const meta = store.readMetas(ctx.home).get(id);
  if (!previous && meta?.removed) return { ok: false, error: `${id} is marked removed` };
  const value = previous ? store.readArchive(ctx.home, id) : store.readSecret(ctx.home, id);
  if (value === null) {
    return {
      ok: false,
      error: previous
        ? `no archived value for ${id} — it is only kept across a rotation or removal`
        : `no value stored for ${id} — run: pat set ${id}`,
    };
  }
  const varName = store.varNameFor({ id, token: ctx.inventory.byId.get(id), meta });
  return { ok: true, value, varName, previous };
}

/** `pat run <id> -- cmd`: a token in one child's environment, nothing else. */
export function runWithToken({ ctx, id, command, args = [], extraEnv = [] }) {
  const env = { ...process.env };
  const ids = id === '--all' ? ctx.inventory.tokens.map((token) => token.id) : [id];
  for (const each of [...ids, ...extraEnv]) {
    const result = getToken({ ctx, id: each });
    if (!result.ok) return { ok: false, error: result.error, status: 2 };
    env[result.varName] = result.value;
  }
  const child = spawnSync(command, args, { stdio: 'inherit', env });
  const status = child.status ?? 1;
  return { ok: status === 0, status };
}

export function envLines(ctx, ids = []) {
  const metas = store.readMetas(ctx.home);
  const targets = ids.length ? ids : ctx.inventory.tokens.map((token) => token.id);
  const lines = [];
  const included = [];
  const missing = [];
  for (const id of targets) {
    const meta = metas.get(id);
    if (!meta || meta.removed) {
      missing.push(id);
      continue;
    }
    const value = store.readSecret(ctx.home, id);
    if (value === null) {
      missing.push(id);
      continue;
    }
    lines.push(`export ${store.varNameFor({ id, token: ctx.inventory.byId.get(id), meta })}=${store.shellQuote(value)}`);
    included.push(id);
  }
  return { lines, included, missing };
}

// --- check ------------------------------------------------------------------

export async function checkTokens({ ctx, ids = [], warnDays = DEFAULT_WARN_DAYS, now = new Date() }) {
  const metas = store.readMetas(ctx.home);
  const selected = ids.length
    ? ids.map((id) => ctx.inventory.byId.get(id) ?? { id, var: autoVar(id), onlyOn: [], check: { kind: 'none' }, ttlDays: null, issued: null })
    : ctx.inventory.tokens;

  const rows = [];
  for (const token of selected) {
    const meta = metas.get(token.id);
    const expiry = expiryState(token, { warnDays, now });
    let probe = { state: 'skipped', detail: 'no value stored' };
    if (meta && !meta.removed) {
      const value = store.readSecret(ctx.home, token.id);
      if (value !== null) probe = await canary(token, value);
    }
    const state = !meta ? 'missing' : meta.removed ? 'missing' : overallState(expiry, probe);
    rows.push({
      id: token.id,
      var: meta?.var || token.var,
      expires: expiry.known ? expiry.expires.toISOString().slice(0, 10) : null,
      daysLeft: expiry.known ? expiry.daysLeft : null,
      days: describeDaysLeft(expiry),
      canary: probe.state,
      canaryDetail: probe.detail ?? '',
      state,
      version: meta?.version ?? null,
      renewUrl: token.renewUrl ?? '',
      owner: token.owner ?? '',
      consumers: token.consumers ?? [],
    });
  }
  return rows;
}

export function attention(rows) {
  return rows.filter((row) => needsAttention(row.state) || row.state === 'missing');
}

// --- peers ------------------------------------------------------------------

export function hostsFor(config, direction) {
  return Object.values(config.hosts).filter((host) => {
    if (!host.enabled) return false;
    if (host.name === config.self.name) return false;
    if (direction === 'push' && host.mode === 'pull') return false;
    if (direction === 'pull' && host.mode === 'push') return true;
    return true;
  });
}

export function shouldPushTo(host, mode) {
  if (mode === 'pull') return false;
  return host.mode !== 'pull';
}

function materialize(buildDir, ctx, metas, allowed) {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(buildDir, 'state'), { recursive: true, mode: 0o700 });
  const pushed = [];
  for (const id of allowed) {
    const meta = metas.get(id);
    if (!meta) continue;
    // The registry is the authority on where a token belongs, so editing
    // `only_on` in inventory.toml takes effect on the next push instead of
    // waiting for someone to rotate the token.
    const declared = ctx.inventory.byId.get(id)?.onlyOn ?? [];
    const outgoing = declared.length ? store.normalizeMeta({ ...meta, only_on: declared }) : store.normalizeMeta(meta);
    fs.writeFileSync(
      path.join(buildDir, 'state', `${id}.meta.json`),
      `${JSON.stringify(outgoing)}\n`,
      { mode: 0o600 },
    );
    if (!meta.removed) {
      const value = store.readSecret(ctx.home, id);
      if (value !== null) fs.writeFileSync(path.join(buildDir, 'state', `${id}.secret`), value, { mode: 0o600 });
    }
    pushed.push(id);
  }
  return pushed;
}

function adoptFrom({ ctx, staging, merged }) {
  const adopted = [];
  const rejected = [];
  for (const { id, meta } of merged.adopt) {
    // A pull is not a loophole: a work token must not land on a machine whose
    // tags do not cover it, however it got to the peer. The token's own
    // metadata carries the restriction, so a machine with no inventory row
    // (the normal case — the inventory never syncs) still refuses it.
    if (!tokenAllowedOn(ctx.inventory.byId.get(id), ctx.tags, meta.only_on)) {
      rejected.push({ id, reason: `not tagged for ${ctx.selfName}` });
      continue;
    }
    if (meta.removed) {
      store.deleteSecret(ctx.home, id);
      store.writeMeta(ctx.home, meta);
      adopted.push(id);
      continue;
    }
    const value = store.readSecret(staging, id);
    if (value === null) {
      rejected.push({ id, reason: 'peer has metadata but no value' });
      continue;
    }
    // The peer's meta arrives over the wire, so its hash is checked against the
    // bytes it claims to describe before those bytes become our live token. A
    // meta with no hash cannot be checked, so it is not adopted.
    if (!meta.sha || store.sha256(value) !== meta.sha) {
      rejected.push({ id, reason: 'value does not match its metadata hash' });
      continue;
    }
    // Adopting overwrites whatever this machine held. A rotation made here
    // while the peer was ahead would otherwise vanish with no trace.
    const displaced = store.readSecret(ctx.home, id);
    if (displaced !== null && displaced !== value) store.writeArchive(ctx.home, id, displaced);
    store.writeSecret(ctx.home, id, value);
    store.writeMeta(ctx.home, meta);
    adopted.push(id);
  }
  return { adopted, rejected };
}

/**
 * Drop any token this machine is not tagged for — but only when a peer provably
 * holds the identical value. Deleting the last copy because a tag was typo'd, or
 * because this was the only machine tagged for it, destroys a credential that
 * exists nowhere else; keeping it unrendered costs nothing, since `renderEnv`
 * already refuses to render it. `pat doctor` reports both situations.
 */
function pruneDisallowed(ctx, remoteMetas = new Map()) {
  const pruned = [];
  const kept = [];
  for (const [id, meta] of store.readMetas(ctx.home)) {
    if (meta.removed) continue;
    if (tokenAllowedOn(ctx.inventory.byId.get(id), ctx.tags, meta.only_on)) continue;
    const remote = remoteMetas.get(id);
    // Safe to delete here when a peer holds this exact value, or a newer one:
    // either way the token outlives this copy. A peer we cannot read, or that
    // holds nothing, is not evidence of anything.
    const survivesElsewhere = Boolean(
      remote && !remote.corrupt && !remote.removed && ((meta.sha && remote.sha === meta.sha) || remote.version > meta.version),
    );
    if (!survivesElsewhere) {
      kept.push({ id, reason: 'not tagged here, but no peer holds this value — kept so it is not lost' });
      continue;
    }
    store.deleteSecret(ctx.home, id);
    store.deleteMeta(ctx.home, id);
    // The archive is a copy of the same credential; leaving it behind would undo
    // the prune and let `pat get <id> --previous` print a work value here.
    fs.rmSync(store.archivePath(ctx.home, id), { force: true });
    pruned.push(id);
  }
  return { pruned, kept };
}

/**
 * Push = pull, merge, then send what this host may hold. The pull comes first
 * on purpose: without it, pushing a whole state would silently clobber a token
 * a peer rotated since our last sync.
 */
export async function pushHost({ ctx, host, dryRun = false, verify = false }) {
  const staging = transport.makeStaging();
  try {
    const pulled = transport.pullState(host, staging);
    if (!pulled.ok) return { ok: false, host: host.name, error: pulled.error };

    const remoteMetas = store.readMetas(staging);
    const merged = store.mergeStates(store.readMetas(ctx.home), remoteMetas);
    const adoption = dryRun
      ? { adopted: merged.adopt.map((entry) => entry.id), rejected: [] }
      : adoptFrom({ ctx, staging, merged });
    const pruning = dryRun ? { pruned: [], kept: [] } : pruneDisallowed(ctx, remoteMetas);
    const pruned = pruning.pruned;
    const current = dryRun ? merged.next : store.readMetas(ctx.home);

    // A conflicting id keeps the peer's copy: it stays in .allowed so the prune
    // spares it, and it is kept out of the tar so our value never overwrites
    // the rotation we just told the user to resolve.
    const conflicts = new Set(merged.conflicts.map((entry) => entry.id));
    // An adopt we refused (bad hash, missing value) means the peer holds
    // something newer we cannot accept. Sending our older copy would roll the
    // peer back and destroy the very value we declined to trust.
    const blockedAdopt = new Set(adoption.rejected.map((entry) => entry.id));
    // A meta we could not parse is not evidence that the peer may not hold the
    // token, so it is spared the prune too (we simply ship nothing for it).
    const unreadable = new Set([...remoteMetas].filter(([, meta]) => meta.corrupt).map(([id]) => id));

    // .allowed answers "what may this peer keep", which is a question about the
    // peer's tags, not about our state. Building it from local ids alone meant a
    // home machine's push deleted the work tokens from the work peer — the very
    // leak it was meant to prevent, inverted into data loss. The universe is
    // therefore both sides; only what we actually ship depends on `current`.
    const allowed = [];
    const send = [];
    const omitted = [];
    for (const id of new Set([...current.keys(), ...remoteMetas.keys(), ...unreadable])) {
      const local = current.get(id);
      const remote = remoteMetas.get(id);
      // Only judge ids we actually hold state for. A token that exists solely on
      // the peer is not ours to delete: our idea of that peer's tags may be stale
      // or simply wrong, and a tag rename on one side must not destroy the
      // other side's only copy.
      // Ids we hold are judged by tags. Ids we do not hold, cannot parse, or
      // will not touch (conflict / refused adopt) are never deleted: we do not
      // know enough about them to take a value that may exist nowhere else.
      const untouchable = !local || conflicts.has(id) || blockedAdopt.has(id) || unreadable.has(id);
      const permitted = untouchable || tokenAllowedOn(ctx.inventory.byId.get(id), host.tags, (local ?? remote)?.only_on);
      if (!permitted) {
        omitted.push(id);
        continue;
      }
      allowed.push(id);
      // Never ship something we could not stand behind: a conflict, an id whose
      // adoption we just rejected (the peer's copy is newer and ours is not an
      // answer to it), or a meta we cannot read.
      // A meta we cannot read might describe a version above ours, so shipping
      // our copy would be a blind overwrite. Leave the peer's bytes alone.
      if (conflicts.has(id) || blockedAdopt.has(id) || unreadable.has(id) || !local || local.corrupt) continue;
      send.push(id);
    }

    const buildDir = path.join(staging, 'out');
    const pushed = materialize(buildDir, ctx, current, send);
    fs.writeFileSync(path.join(buildDir, ALLOWED_FILE), `${allowed.join('\n')}\n`, { mode: 0o600 });

    // The peer's env must describe the peer's state after this push, not ours:
    // what we sent, plus what it already had for everything we did not send.
    // Rendering from local state is what let a home machine's push strip the
    // work peer's own tokens out of its secrets.env.
    const renderMetas = new Map();
    const overrides = new Map();
    for (const id of allowed) {
      const local = current.get(id);
      const remote = remoteMetas.get(id);
      if (send.includes(id) && local) {
        renderMetas.set(id, local);
        continue;
      }
      if (remote && !remote.corrupt) {
        renderMetas.set(id, remote);
        const peerValue = store.readSecret(staging, id);
        if (peerValue !== null) overrides.set(id, peerValue);
      }
    }
    const rendered = store.renderEnv({
      home: ctx.home,
      // `.allowed` already decided what this peer may keep, so the renderer must
      // not re-apply this machine's idea of the peer's tags on top of it.
      config: { ...ctx.config, ignoreTags: new Set(send) },
      inventory: ctx.inventory,
      metas: renderMetas,
      tags: host.tags,
      hostName: host.name,
      readValue: (id) =>
        send.includes(id) ? store.readSecret(ctx.home, id) : (overrides.get(id) ?? null),
    });
    fs.writeFileSync(path.join(buildDir, ENV_FILE), rendered.text, { mode: 0o600 });

    const summary = {
      ok: true,
      host: host.name,
      adopted: adoption.adopted,
      rejected: adoption.rejected,
      pruned,
      kept: pruning.kept,
      conflicts: merged.conflicts,
      pushed,
      omitted,
      unreadable: [...unreadable],
      dropped: rendered.skipped.map((entry) => `${entry.id} (${entry.reason})`),
      dryRun,
    };
    if (dryRun) return summary;

    const result = transport.pushState(host, buildDir);
    if (!result.ok) return { ...summary, ok: false, error: result.error };

    if (verify) {
      const after = transport.readRemoteMetas(host);
      const mismatch = after.ok
        ? pushed.filter((id) => {
            const sent = current.get(id);
            const got = after.metas.get(id);
            return !got || !sent || got.version !== sent.version || got.sha !== sent.sha;
          })
        : pushed;
      summary.verify = { ok: after.ok && mismatch.length === 0, detail: after.ok ? `${pushed.length - mismatch.length}/${pushed.length} match` : after.error, mismatch };
    }
    return summary;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function pullHost({ ctx, host, dryRun = false }) {
  const staging = transport.makeStaging();
  try {
    const pulled = transport.pullState(host, staging);
    if (!pulled.ok) return { ok: false, host: host.name, error: pulled.error };
    const merged = store.mergeStates(store.readMetas(ctx.home), store.readMetas(staging));
    const adoption = dryRun
      ? { adopted: merged.adopt.map((entry) => entry.id), rejected: [] }
      : adoptFrom({ ctx, staging, merged });
    const remoteMetas = store.readMetas(staging);
    const pruning = dryRun ? { pruned: [], kept: [] } : pruneDisallowed(ctx, remoteMetas);
    const pruned = pruning.pruned;
    if (!dryRun) renderLocal(ctx);
    return {
      ok: true,
      host: host.name,
      adopted: adoption.adopted,
      rejected: adoption.rejected,
      pruned,
      kept: pruning.kept,
      conflicts: merged.conflicts,
      ignored: merged.ignore.map((entry) => entry.id),
      dryRun,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function takeFrom({ ctx, host, id }) {
  if (!store.validId(id)) return { ok: false, error: `invalid token id ${JSON.stringify(id)}` };
  const staging = transport.makeStaging();
  try {
    const pulled = transport.pullState(host, staging);
    if (!pulled.ok) return { ok: false, error: pulled.error };
    const remote = store.readMetas(staging).get(id);
    if (!remote) return { ok: false, error: `host ${host.name} has no state for ${id}` };
    // `take` is the manual override for a conflict, not an exemption from the
    // rules: the peer's value is still a value from the wire, and this machine
    // still must not end up holding a token it is not tagged for.
    if (!tokenAllowedOn(ctx.inventory.byId.get(id), ctx.tags, remote.only_on)) {
      return { ok: false, error: `not tagged for ${ctx.selfName} — ${id} belongs on hosts tagged ${remote.only_on.join('/')}` };
    }

    const localMeta = store.readMetas(ctx.home).get(id);
    const localVersion = localMeta?.version ?? 0;
    const version = Math.max(remote.version, localVersion) + 1;
    if (remote.removed) {
      store.deleteSecret(ctx.home, id);
    } else {
      const value = store.readSecret(staging, id);
      if (value === null) return { ok: false, error: `host ${host.name} has no value for ${id}` };
      if (!remote.sha || store.sha256(value) !== remote.sha) {
        return { ok: false, error: `${host.name}'s value does not match its metadata hash — not adopted` };
      }
      // The value being replaced is recoverable, exactly as with `pat set`.
      const displaced = store.readSecret(ctx.home, id);
      if (displaced !== null) store.writeArchive(ctx.home, id, displaced);
      store.writeSecret(ctx.home, id, value);
    }
    store.writeMeta(ctx.home, {
      ...store.normalizeMeta(remote),
      version,
      updated_at: new Date().toISOString(),
      updated_by: ctx.selfName,
    });
    renderLocal(ctx);
    return { ok: true, id, version, host: host.name };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Read a peer's metas for status. Never moves a value. */
export function peerState(host) {
  return transport.readRemoteMetas(host);
}

// --- status / doctor --------------------------------------------------------

export function statusRows(ctx) {
  const metas = store.readMetas(ctx.home);
  const rows = [];
  for (const token of ctx.inventory.tokens) {
    const meta = metas.get(token.id);
    const expiry = expiryState(token);
    rows.push({
      id: token.id,
      var: store.varNameFor({ id: token.id, token, meta }),
      version: meta?.version ?? null,
      sha: meta?.sha ?? '',
      removed: Boolean(meta?.removed),
      updatedBy: meta?.updated_at ? meta.updated_by || '?' : '',
      updatedAt: meta?.updated_at ?? '',
      days: describeDaysLeft(expiry),
      expires: expiry.known ? expiry.expires.toISOString().slice(0, 10) : null,
      state: meta ? (meta.removed ? 'removed' : expiry.state) : 'missing',
      renewUrl: token.renewUrl ?? '',
    });
  }
  const known = new Set(ctx.inventory.tokens.map((token) => token.id));
  for (const [id, meta] of metas) {
    if (known.has(id)) continue;
    rows.push({
      id,
      var: store.varNameFor({ id, token: undefined, meta }),
      version: meta.version,
      sha: meta.sha ?? '',
      removed: Boolean(meta.removed),
      updatedBy: meta.updated_by,
      updatedAt: meta.updated_at,
      days: 'unknown',
      expires: null,
      state: 'orphan',
      renewUrl: '',
    });
  }
  return rows;
}

export function doctor(ctx, { probe = false } = {}) {
  const findings = [];
  const add = (name, status, detail) => findings.push({ name, status, detail });
  const modeOf = (target) => {
    try {
      return (fs.statSync(target).mode & 0o777).toString(8);
    } catch {
      return null;
    }
  };

  add('home', fs.existsSync(ctx.home) ? 'ok' : 'error', ctx.home);
  const homeMode = modeOf(ctx.home);
  add('home permissions', homeMode === null ? 'error' : homeMode === '700' ? 'ok' : 'warn', `${ctx.home} is ${homeMode ?? 'missing'}`);

  const stateMode = modeOf(store.stateDir(ctx.home));
  add('state permissions', stateMode === '700' ? 'ok' : 'warn', `${store.stateDir(ctx.home)} is ${stateMode ?? 'missing'}`);

  const metas = store.readMetas(ctx.home);
  const loose = [];
  const corrupt = [];
  for (const [id, meta] of metas) {
    const secretFile = store.secretPath(ctx.home, id);
    let kind = null;
    try {
      kind = fs.lstatSync(secretFile);
    } catch {
      kind = null;
    }
    const secretMode = modeOf(secretFile);
    if (kind && !kind.isFile()) loose.push(`${id} is not a regular file`);
    else if (secretMode && secretMode !== '600') loose.push(`${id} is ${secretMode}`);
    if (meta.removed) continue;
    const value = store.readSecret(ctx.home, id);
    if (value === null) continue;
    if (meta.sha && store.sha256(value) !== meta.sha) corrupt.push(id);
  }
  add('secret permissions', loose.length ? 'warn' : 'ok', loose.length ? loose.join(', ') : 'all 600');
  add(
    'state integrity',
    corrupt.length ? 'warn' : 'ok',
    corrupt.length ? `hash does not match the stored value: ${corrupt.join(', ')}` : 'hashes match the stored values',
  );

  const orphans = [...metas.keys()].filter((id) => !ctx.inventory.byId.has(id));
  add('inventory coverage', orphans.length ? 'warn' : 'ok', orphans.length ? `no inventory row: ${orphans.join(', ')}` : `${ctx.inventory.tokens.length} token(s) registered`);

  const withoutValue = ctx.inventory.tokens.filter((token) => {
    const meta = metas.get(token.id);
    return !meta || meta.removed;
  });
  add('values stored', withoutValue.length ? 'warn' : 'ok', withoutValue.length ? `no value yet: ${withoutValue.map((t) => t.id).join(', ')}` : 'every token has a value');

  const incomplete = ctx.inventory.tokens.filter((token) => !token.renewUrl || !token.ttlDays || !token.issued);
  add('renewal metadata', incomplete.length ? 'warn' : 'ok', incomplete.length ? `missing renew_url/ttl_days/issued: ${incomplete.map((t) => t.id).join(', ')}` : 'renew_url + ttl + issued recorded');

  const tagged = ctx.inventory.tokens.filter((token) => token.onlyOn.length);
  const tagWarn = tagged.length && !ctx.tags.length;
  // Holdings matter as well as registry rows: a token adopted before a tag
  // change (or written by an older pat) is exactly what a tag check must catch.
  const heldElsewhere = ctx.tags.length
    ? [...metas.values()]
        .filter((meta) => !meta.corrupt && !meta.removed && meta.only_on?.length && !meta.only_on.some((tag) => ctx.tags.includes(tag)))
        .map((meta) => meta.id)
    : [];
  add(
    'tag targeting',
    tagWarn || heldElsewhere.length ? 'warn' : 'ok',
    tagWarn
      ? `${ctx.selfName} declares no tags, so ${tagged.length} restricted token(s) would render everywhere`
      : heldElsewhere.length
        ? `holds token(s) not tagged for ${ctx.selfName}: ${heldElsewhere.join(', ')} — run \`pat sync\``
        : `local tags: ${ctx.tags.join(', ') || '(none)'}`,
  );

  const broken = [...metas.values()].filter((meta) => meta.corrupt).map((meta) => meta.id);
  add('state metadata', broken.length ? 'warn' : 'ok', broken.length ? `unreadable metadata: ${broken.join(', ')} — fix on this machine, or re-pull from a peer that has a good copy` : 'every meta parses');

  const names = new Map();
  for (const token of ctx.inventory.tokens) {
    if (!names.has(token.var)) names.set(token.var, []);
    names.get(token.var).push(token.id);
  }
  // Effective names, so a pulled token without a row cannot silently take a
  // registered token's variable.
  for (const meta of metas.values()) {
    if (meta.corrupt || ctx.inventory.byId.has(meta.id)) continue;
    const name = store.credentialVar(meta.var) ? meta.var : autoVar(meta.id);
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(meta.id);
  }
  const clashes = [...names].filter(([, ids]) => ids.length > 1).map(([name, ids]) => `${name}: ${ids.join(', ')}`);
  add('variable names', clashes.length ? 'warn' : 'ok', clashes.length ? `same variable, one will be skipped: ${clashes.join(' · ')}` : 'every token has its own variable');

  const envFile = path.join(ctx.home, ENV_FILE);
  if (!fs.existsSync(envFile)) {
    add('secrets.env', 'warn', 'not rendered yet — run `pat set <id>` or `pat sync`');
  } else {
    const envMode = modeOf(envFile);
    const current = fs.readFileSync(envFile, 'utf8');
    const expected = store.renderEnv({ home: ctx.home, config: ctx.config, inventory: ctx.inventory, metas, tags: ctx.tags, hostName: ctx.selfName }).text;
    add('secrets.env', envMode === '600' ? (current === expected ? 'ok' : 'warn') : 'warn', envMode !== '600' ? `mode ${envMode}` : current === expected ? 'up to date' : 'stale — run `pat sync` or `pat set <id>`');
  }

  const preferred = ctx.config.preferredSource;
  if (preferred && !ctx.config.hosts[preferred]) add('preferred_source', 'warn', `${preferred} is not in [hosts]`);
  add('hosts', 'ok', `${Object.keys(ctx.config.hosts).length} configured`);

  if (probe) {
    for (const host of hostsFor(ctx.config, 'push')) {
      const result = transport.probeHost(host);
      add(`host ${host.name}`, result.ok ? 'ok' : 'error', result.steps.map((step) => `${step.name}: ${step.ok ? 'ok' : step.detail}`).join(' · '));
    }
  }

  const worst = findings.some((finding) => finding.status === 'error')
    ? 'error'
    : findings.some((finding) => finding.status === 'warn')
      ? 'warn'
      : 'ok';
  return { findings, worst };
}

// --- backup -----------------------------------------------------------------

export function backup({ home, out, passphrase }) {
  if (!passphrase) return { ok: false, error: 'no passphrase' };
  ensureHome(home);
  // mkdtemp is 700, so the plaintext tar is never readable on a shared /tmp.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-backup-'));
  const tarFile = path.join(tmp, 'state.tar');
  try {
    const packed = spawnSync('tar', ['cf', tarFile, '-C', home, 'state', 'config.toml', 'inventory.toml'], { encoding: 'utf8' });
    if (packed.status !== 0) return { ok: false, error: `tar failed: ${packed.stderr.trim()}` };
    fs.chmodSync(tarFile, 0o600);

    // Passphrase on stdin, so it never appears in the process list.
    const encrypted = spawnSync(
      'openssl',
      ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-md', 'sha256', '-pass', 'stdin', '-in', tarFile, '-out', out],
      { input: `${passphrase}\n`, encoding: 'utf8' },
    );
    if (encrypted.status !== 0) return { ok: false, error: `openssl failed: ${(encrypted.stderr || '').trim()}` };
    fs.chmodSync(out, 0o600);
    return { ok: true, out };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function restore({ home, from, passphrase }) {
  if (!passphrase) return { ok: false, error: 'no passphrase' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-restore-'));
  const tarFile = path.join(tmp, 'state.tar');
  const unpackDir = path.join(tmp, 'unpacked');
  try {
    const decrypted = spawnSync(
      'openssl',
      ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-md', 'sha256', '-pass', 'stdin', '-in', from, '-out', tarFile],
      { input: `${passphrase}\n`, encoding: 'utf8' },
    );
    if (decrypted.status !== 0) return { ok: false, error: 'could not decrypt (wrong passphrase or not a pat backup)' };

    fs.mkdirSync(unpackDir, { mode: 0o700 });
    const unpacked = spawnSync('tar', ['xf', tarFile, '-C', unpackDir], { encoding: 'utf8' });
    if (unpacked.status !== 0) return { ok: false, error: `tar failed: ${unpacked.stderr.trim()}` };

    ensureHome(home);
    const restored = [];
    const kept = [];
    for (const entry of ['state', 'inventory.toml', 'config.toml']) {
      const source = path.join(unpackDir, entry);
      if (!fs.existsSync(source)) continue;
      // This machine's identity and peer list are local facts; a restore brings
      // back state and the registry, not another machine's [self] name.
      if (entry === 'config.toml' && fs.existsSync(path.join(home, entry))) {
        kept.push(entry);
        continue;
      }
      fs.cpSync(source, path.join(home, entry), { recursive: true, force: true });
      restored.push(entry);
    }

    for (const file of ['config.toml', 'inventory.toml']) tighten(path.join(home, file), 0o600);
    tighten(path.join(home, 'state'), 0o700);
    for (const entry of fs.readdirSync(path.join(home, 'state'))) tighten(path.join(home, 'state', entry), 0o600);
    return { ok: true, restored, kept };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
