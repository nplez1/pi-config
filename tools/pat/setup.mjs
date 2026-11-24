// `pat setup` and its host subcommands: the only place that writes config.toml.
//
// Hosts are ours to manage here. Orca's host list is app state (it also carries
// paired servers and plain ssh aliases that are not sync targets), so pat keeps
// its own list and offers a one-time import instead of depending on it.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_REMOTE_ROOT,
  appendHostSection,
  ensureHome,
  ensureScaffold,
  loadInventory,
  removeHostSection,
  renderConfig,
  upsertTableKey,
  upsertTopLevelKey,
  writeFileAtomic,
  ENV_FILE,
} from './config.mjs';
import { shellQuote } from './store.mjs';
import { probeHost } from './transport.mjs';
import { tomlArray, tomlString } from './toml.mjs';

export const RC_MARKERS = { start: '# >>> pat >>>', end: '# <<< pat <<<' };

export function rcFiles() {
  if (process.platform === 'win32') return [];
  const home = os.homedir();
  return [path.join(home, '.zprofile'), path.join(home, '.zshrc')];
}

export function sourceBlock(home) {
  const envFile = path.join(home, ENV_FILE);
  const quoted = shellQuote(envFile);
  return [
    RC_MARKERS.start,
    '# Managed by `pat setup`. Rotate with `pat set <id>`, distribute with `pat sync`.',
    `[ -r ${quoted} ] && . ${quoted}`,
    RC_MARKERS.end,
  ].join('\n');
}

/**
 * Append the source block where a login/interactive shell will read it.
 *
 * Deliberately no `pat sync` here: shell startup must never block on ssh. Sync
 * is an explicit command, or a scheduled job (Orca automation) — not something
 * that makes a new terminal hang when a peer is asleep.
 */
export function wireShell({ home, dryRun = false, files = rcFiles() }) {
  const block = sourceBlock(home);
  const actions = [];
  for (const file of files) {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (existing.includes(RC_MARKERS.start)) {
      actions.push({ file, action: 'already wired' });
      continue;
    }
    const prefix = existing.trim() ? `${existing.replace(/\s*$/, '\n')}\n` : '';
    if (!dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${prefix}${block}\n`, { mode: 0o644 });
    }
    actions.push({ file, action: dryRun ? 'would append' : 'appended' });
  }
  return actions;
}

export function runSetup({ home, selfName, tags, preferredSource, dryRun = false, wire = true }) {
  if (!dryRun) ensureHome(home);
  const created = dryRun ? [] : ensureScaffold(home);

  const configFile = path.join(home, 'config.toml');
  if (!dryRun && fs.existsSync(configFile)) {
    const original = fs.readFileSync(configFile, 'utf8');
    let next = original;
    if (selfName) next = upsertTableKey(next, 'self', 'name', tomlString(selfName));
    if (tags?.length) next = upsertTableKey(next, 'self', 'tags', tomlArray(tags));
    if (preferredSource !== undefined && preferredSource !== null) {
      next = upsertTopLevelKey(next, 'preferred_source', tomlString(preferredSource));
    }
    if (next !== original) writeFileAtomic(configFile, next);
  }

  const actions = wire ? wireShell({ home, dryRun }) : [];
  return { home, created, actions };
}

export function hostEntry({ name, ssh, tags = [], hostPath, mode = 'both', enabled = true }) {
  return {
    name,
    ssh: ssh ?? name,
    tags,
    path: hostPath ?? DEFAULT_REMOTE_ROOT,
    mode,
    enabled,
  };
}

export function addHost({ home, config, host, force = false, dryRun = false, probe = probeHost }) {
  const result = probe(host);
  if (!result.ok && !force) return { ok: false, host, probe: result };

  if (!dryRun) {
    const file = path.join(home, 'config.toml');
    const base = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : renderConfig({ self: config.self });
    writeFileAtomic(file, appendHostSection(removeHostSection(base, host.name), host));
  }
  return { ok: true, host, probe: result };
}

export function removeHost({ home, name, dryRun = false }) {
  const file = path.join(home, 'config.toml');
  if (!fs.existsSync(file)) return { ok: false, error: 'no config.toml' };
  const text = fs.readFileSync(file, 'utf8');
  if (!new RegExp(`^\\s*\\[hosts\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm').test(text)) {
    return { ok: false, error: `no such host: ${name}` };
  }
  if (!dryRun) writeFileAtomic(file, removeHostSection(text, name));
  return { ok: true };
}

export function tagHost({ home, name, tags, dryRun = false }) {
  const file = path.join(home, 'config.toml');
  if (!fs.existsSync(file)) return { ok: false, error: 'no config.toml' };
  const text = fs.readFileSync(file, 'utf8');
  if (!new RegExp(`^\\s*\\[hosts\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm').test(text)) {
    return { ok: false, error: `no such host: ${name}` };
  }
  if (!dryRun) writeFileAtomic(file, upsertTableKey(text, `hosts.${name}`, 'tags', tomlArray(tags)));
  return { ok: true };
}

// --- import existing environment --------------------------------------------

const ENV_CANDIDATE = /(^|_)(TOKEN|PAT|API_?KEY|APIKEY|SECRET|PASSWORD|PASSWD)$/i;
const ENV_EXCLUDE = new Set(['PAT_HOME', 'SSH_AUTH_SOCK', 'GITHUB_ACTIONS', 'HOMEBREW_GITHUB_API_TOKEN']);

/**
 * Find PAT-shaped variables already exported on this machine, so the first run
 * migrates values it already has instead of asking for new ones.
 */
export function findEnvCandidates({ env = process.env, inventory }) {
  const found = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_CANDIDATE.test(key) || ENV_EXCLUDE.has(key)) continue;
    if (typeof value !== 'string' || value.trim().length < 8) continue;
    const id = key
      .toLowerCase()
      .replace(/_(token|pat|api_?key|secret|password|passwd)$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!id || inventory.byId.has(id)) continue;
    found.push({ id, var: key, length: value.length });
  }
  return found;
}

// --- ssh alias discovery ----------------------------------------------------

/** Suggest machines from ~/.ssh/config that pat does not manage yet. */
export function discoverSshAliases({ config, sshConfigFile = path.join(os.homedir(), '.ssh', 'config') }) {
  if (!fs.existsSync(sshConfigFile)) return [];
  const managed = new Set(Object.values(config.hosts).flatMap((host) => [host.name, host.ssh]));
  const aliases = [];
  for (const line of fs.readFileSync(sshConfigFile, 'utf8').split('\n')) {
    const match = /^\s*Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const alias of match[1].trim().split(/\s+/)) {
      if (!alias || alias.includes('*') || alias.includes('?')) continue;
      if (alias === 'github.com' || managed.has(alias)) continue;
      if (!aliases.includes(alias)) aliases.push(alias);
    }
  }
  return aliases;
}

export function describeSetup({ home, config }) {
  const inventory = loadInventory(home);
  return {
    home,
    self: config.self.name,
    tags: config.self.tags,
    hosts: Object.keys(config.hosts),
    tokens: inventory.tokens.length,
  };
}
