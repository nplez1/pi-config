// Machine-local configuration: ~/.config/pat/{config.toml,inventory.toml}.
//
// Nothing here ever holds a secret value. config.toml knows which machines pat
// may sync with and which tags this machine carries; inventory.toml is the
// registry that makes an expired token a lookup instead of an investigation.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseToml, tomlArray, tomlString } from './toml.mjs';

export const STATE_DIR = 'state';
export const ENV_FILE = 'secrets.env';
export const ALLOWED_FILE = '.allowed';
export const DEFAULT_REMOTE_ROOT = '~/.config/pat';
export const DEFAULT_WARN_DAYS = 14;

/**
 * An id becomes a filename inside state/ and a word in the peer prune script.
 * Both are reasons to keep it boring: if it cannot be a filename component, it
 * is not an id.
 */
export function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
}

/**
 * A variable name becomes `export <var>=…` in a file every shell sources, so it
 * is validated on the way in and again on the way out. A peer's meta can claim
 * any string; nothing that is not an identifier may reach secrets.env.
 */
export function validVar(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function resolveHome(env = process.env) {
  if (env.PAT_HOME) return path.resolve(env.PAT_HOME);
  return path.join(os.homedir(), '.config', 'pat');
}

export function shortHostname() {
  return os.hostname().split('.')[0].toLowerCase();
}

export function expandTilde(value, home = os.homedir()) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

export function tighten(target, mode) {
  try {
    const stat = fs.statSync(target);
    if ((stat.mode & 0o777) !== mode) fs.chmodSync(target, mode);
  } catch {
    /* missing target: nothing to tighten */
  }
}

export function writeFileAtomic(file, content, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}`);
  // fsync before the rename: a crash between write and rename must not leave a
  // meta whose sha describes bytes that never reached the disk.
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return file;
}

export function ensureHome(home) {
  fs.mkdirSync(path.join(home, STATE_DIR), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(home, STATE_DIR), 0o700);
  tighten(home, 0o700);
  return home;
}

const CONFIG_TEMPLATE = `# pat — this machine's sync config. No secret values live in this file.
#
# preferred_source is only a convenience for bringing a brand-new machine
# online: any reachable host can be pushed or pulled from.

preferred_source = ""

[self]
# Empty name = this machine's hostname. Tags decide which tokens render here.
name = ""
tags = []

# One [hosts.<name>] per machine pat may sync with. \`ssh\` is an alias from
# ~/.ssh/config (or user@host). pat needs nothing installed on the far end —
# a POSIX login shell, sshd, tar, grep and stat.
#
# [hosts.example-host]
# ssh  = "example-host"
# tags = ["work", "homelab"]
# path = "~/.config/pat"     # where that host keeps its copy
# mode = "both"              # both | push | pull  (pull = read-only peer)
# enabled = true
`;

const INVENTORY_TEMPLATE = `# pat — token inventory: metadata only, never values.
#
# One [[token]] row per PAT. It is the answer to "which token is this, where do
# I renew it, and what breaks when it expires". \`pat set <id>\` stores the value.

# [[token]]
# id        = "github"
# var       = "GITHUB_TOKEN"
# system    = "GitHub Enterprise"
# owner     = ""
# renew_url = "https://…"
# how       = "Fine-grained PAT · scopes repo, read:org · 2FA prompt"
# ttl_days  = 60
# issued    = "2026-10-14"
# only_on   = ["work"]        # host tags allowed to hold it; empty = everywhere
# consumers = ["orca worktree env", "skill:pr-review"]
# check     = { kind = "http", method = "GET", url = "https://api.github.com/user" }
`;

export function loadConfig(home) {
  const file = path.join(home, 'config.toml');
  const raw = fs.existsSync(file) ? parseToml(fs.readFileSync(file, 'utf8'), 'config.toml') : {};
  const self = isPlain(raw.self) ? raw.self : {};
  const hosts = {};

  for (const [name, value] of Object.entries(isPlain(raw.hosts) ? raw.hosts : {})) {
    if (!isPlain(value)) continue;
    hosts[name] = {
      name,
      ssh: nonEmptyString(value.ssh) ?? name,
      tags: stringList(value.tags),
      path: nonEmptyString(value.path) ?? DEFAULT_REMOTE_ROOT,
      mode: ['both', 'push', 'pull'].includes(value.mode) ? value.mode : 'both',
      enabled: value.enabled !== false,
    };
  }

  const selfName = nonEmptyString(self.name) ?? shortHostname();
  return {
    file,
    raw,
    self: { name: selfName, tags: stringList(self.tags) },
    preferredSource: typeof raw.preferred_source === 'string' ? raw.preferred_source : '',
    hosts,
  };
}

// Tags decide which tokens this machine renders. A host section wins over the
// [self] section, so one file can describe this machine's role for every copy.
export function localTags(config) {
  const own = config.hosts[config.self.name];
  return own ? own.tags : config.self.tags;
}

export function localHost(config) {
  const own = config.hosts[config.self.name];
  return own ?? { name: config.self.name, ssh: config.self.name, tags: config.self.tags, path: '~', mode: 'both', enabled: true };
}

export function loadInventory(home) {
  const file = path.join(home, 'inventory.toml');
  const raw = fs.existsSync(file) ? parseToml(fs.readFileSync(file, 'utf8'), 'inventory.toml') : {};
  const rows = Array.isArray(raw.token) ? raw.token : [];
  const tokens = [];
  const seen = new Set();

  for (const row of rows) {
    if (!isPlain(row) || !nonEmptyString(row.id)) continue;
    const id = row.id.trim();
    // Loud failure, because a silently dropped or renamed row means pat hands
    // you the wrong credential under a plausible-looking name.
    if (!validId(id)) {
      throw new Error(`inventory.toml: invalid token id ${JSON.stringify(id)} — letters, digits, '.', '_' and '-' only`);
    }
    if (seen.has(id)) throw new Error(`inventory.toml: token ${id} is defined more than once`);
    seen.add(id);
    const declaredVar = nonEmptyString(row.var);
    if (declaredVar && !validVar(declaredVar)) {
      throw new Error(`inventory.toml: token ${id} has invalid var ${JSON.stringify(declaredVar)} — must be a shell identifier`);
    }
    tokens.push({
      id,
      var: declaredVar ?? autoVar(id),
      system: nonEmptyString(row.system) ?? '',
      owner: nonEmptyString(row.owner) ?? '',
      renewUrl: nonEmptyString(row.renew_url) ?? '',
      how: nonEmptyString(row.how) ?? '',
      ttlDays: Number.isFinite(row.ttl_days) ? row.ttl_days : null,
      issued: nonEmptyString(row.issued) ?? null,
      onlyOn: stringList(row.only_on),
      consumers: stringList(row.consumers),
      check: normalizeCheck(row.check, id),
    });
  }

  return { file, tokens, byId: new Map(tokens.map((token) => [token.id, token])) };
}

export function autoVar(id) {
  const base = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return base.endsWith('_TOKEN') ? base : `${base}_TOKEN`;
}

function normalizeCheck(check, id = '?') {
  if (!isPlain(check)) return { kind: 'none' };
  const kind = ['http', 'command', 'none'].includes(check.kind) ? check.kind : 'none';
  if (kind === 'http') {
    if (!nonEmptyString(check.url)) return { kind: 'none' };
    // A token is about to be sent to this URL, so plaintext is never acceptable
    // and a redirect to another origin would hand the token to that origin.
    let url;
    try {
      url = new URL(check.url);
    } catch {
      throw new Error(`inventory.toml: token ${id} has an unparseable check url ${JSON.stringify(check.url)}`);
    }
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error(`inventory.toml: token ${id} check url must be https (got ${url.protocol}//…)`);
    }
    return {
      kind,
      method: (nonEmptyString(check.method) ?? 'GET').toUpperCase(),
      url: url.toString(),
      header: nonEmptyString(check.header) ?? null,
      headers: isPlain(check.headers) ? check.headers : {},
    };
  }
  if (kind === 'command') {
    if (!nonEmptyString(check.command)) return { kind: 'none' };
    return { kind, command: check.command };
  }
  return { kind: 'none' };
}

export function renderConfig({ self, preferredSource = '', hosts = {} }) {
  const lines = [
    "# pat — this machine's sync config. No secret values live in this file.",
    '#',
    '# preferred_source is only a convenience for bringing a brand-new machine',
    '# online: any reachable host can be pushed or pulled from.',
    '',
    `preferred_source = ${tomlString(preferredSource)}`,
    '',
    '[self]',
    `name = ${tomlString(self.name)}`,
    `tags = ${tomlArray(self.tags)}`,
  ];

  for (const host of Object.values(hosts)) {
    if (!host || host.name === self.name) continue;
    lines.push('', `[hosts.${host.name}]`, `ssh = ${tomlString(host.ssh)}`, `tags = ${tomlArray(host.tags)}`);
    if (host.path && host.path !== DEFAULT_REMOTE_ROOT) lines.push(`path = ${tomlString(host.path)}`);
    if (host.mode && host.mode !== 'both') lines.push(`mode = ${tomlString(host.mode)}`);
    if (host.enabled === false) lines.push('enabled = false');
  }

  return `${lines.join('\n')}\n`;
}

export function renderTokenStanza(token) {
  const lines = [
    '',
    '[[token]]',
    `id        = ${tomlString(token.id)}`,
    `var       = ${tomlString(token.var ?? autoVar(token.id))}`,
    `system    = ${tomlString(token.system ?? '')}`,
    `owner     = ${tomlString(token.owner ?? '')}`,
    `renew_url = ${tomlString(token.renewUrl ?? '')}`,
    `how       = ${tomlString(token.how ?? '')}`,
    `ttl_days  = ${token.ttlDays ?? 30}`,
    `issued    = ${tomlString(token.issued ?? today())}`,
  ];
  if (token.onlyOn?.length) lines.push(`only_on   = ${tomlArray(token.onlyOn)}`);
  if (token.consumers?.length) lines.push(`consumers = ${tomlArray(token.consumers)}`);
  return `${lines.join('\n')}\n`;
}

export function appendTokenStanza(home, token) {
  const file = path.join(home, 'inventory.toml');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\s*$/, '\n') : '';
  writeFileAtomic(file, `${existing}${renderTokenStanza(token)}`);
  return file;
}

export function ensureScaffold(home) {
  const created = [];
  for (const [name, template] of [
    ['config.toml', CONFIG_TEMPLATE],
    ['inventory.toml', INVENTORY_TEMPLATE],
  ]) {
    const file = path.join(home, name);
    if (fs.existsSync(file)) continue;
    writeFileAtomic(file, template);
    created.push(name);
  }
  return created;
}

// Targeted text edits, so `pat setup --tag` and `setup host add` rewrite one
// key instead of regenerating the file and discarding the user's comments.
export function upsertTopLevelKey(text, key, literal) {
  const lines = text.split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < limit; i += 1) {
    if (pattern.test(lines[i])) {
      lines[i] = `${key} = ${literal}`;
      return lines.join('\n');
    }
  }
  lines.splice(limit, 0, `${key} = ${literal}`);
  return lines.join('\n');
}

export function upsertTableKey(text, table, key, literal) {
  const lines = text.split('\n');
  const header = new RegExp(`^\\s*\\[${escapeRegex(table)}\\]\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  const pattern = new RegExp(`^\\s*${key}\\s*=`);

  if (start < 0) {
    const trimmed = text.replace(/\s*$/, '\n');
    return `${trimmed}\n[${table}]\n${key} = ${literal}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  for (let i = start + 1; i < end; i += 1) {
    if (pattern.test(lines[i])) {
      lines[i] = `${key} = ${literal}`;
      return lines.join('\n');
    }
  }
  lines.splice(start + 1, 0, `${key} = ${literal}`);
  return lines.join('\n');
}

export function appendHostSection(text, host) {
  const lines = [
    text.replace(/\s*$/, '\n'),
    '',
    `[hosts.${host.name}]`,
    `ssh = ${tomlString(host.ssh)}`,
    `tags = ${tomlArray(host.tags ?? [])}`,
  ];
  if (host.path && host.path !== DEFAULT_REMOTE_ROOT) lines.push(`path = ${tomlString(host.path)}`);
  if (host.mode && host.mode !== 'both') lines.push(`mode = ${tomlString(host.mode)}`);
  return `${lines.join('\n')}\n`;
}

export function removeHostSection(text, name) {
  const lines = text.split('\n');
  const header = new RegExp(`^\\s*\\[hosts\\.${escapeRegex(name)}\\]\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry !== '').map((entry) => entry.trim());
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
