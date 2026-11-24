#!/usr/bin/env node
// pat — one inventory for every PAT this machine holds, peer sync with no
// central authority, and expiry that is watched instead of discovered.
//
// Values live in ~/.config/pat/state/ (mode 600) and secrets.env is rendered
// from them. Nothing here is safe to commit: the inventory it reads carries
// internal hostnames and renewal URLs.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_REMOTE_ROOT,
  DEFAULT_WARN_DAYS,
  appendTokenStanza,
  ensureHome,
  resolveHome,
  today,
} from './config.mjs';
import * as store from './store.mjs';
import * as commands from './commands.mjs';
import * as setup from './setup.mjs';
import { probeHost } from './transport.mjs';

const VERSION = '0.1.0';
const EXIT = { ok: 0, error: 1, usage: 2, attention: 3 };
const VALUE_FLAGS = new Set([
  'value',
  'from-env',
  'out',
  'tag',
  'tags',
  'ssh',
  'path',
  'mode',
  'host',
  'warn-days',
  'self',
  'preferred-source',
  'passphrase',
  'ssh-config',
  'also',
  'from',
]);

async function main(argv) {
  const [command = 'help', ...rest] = argv;

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return EXIT.ok;
  }
  if (command === 'version' || command === '--version') {
    console.log(`pat ${VERSION}`);
    return EXIT.ok;
  }
  if (command === 'run') return cmdRun(rest);
  if (command === 'setup') return cmdSetup(rest);

  const { flags, positional } = parseArgs(rest);

  switch (command) {
    case 'set':
      return cmdSet(positional, flags);
    case 'get':
      return cmdGet(positional, flags);
    case 'rm':
    case 'remove':
      return cmdRemove(positional, flags);
    case 'env':
      return cmdEnv(positional, flags);
    case 'check':
      return cmdCheck(positional, flags);
    case 'status':
      return cmdStatus(positional, flags);
    case 'sync':
      return cmdSync(positional, flags, 'sync');
    case 'push':
      return cmdSync(positional, flags, 'push');
    case 'pull':
      return cmdSync(positional, flags, 'pull');
    case 'take':
      return cmdTake(positional, flags);
    case 'doctor':
      return cmdDoctor(positional, flags);
    case 'backup':
      return cmdBackup(positional, flags);
    case 'restore':
      return cmdRestore(positional, flags);
    default:
      console.error(`pat: unknown command ${JSON.stringify(command)}`);
      printHelp();
      return EXIT.usage;
  }
}

// --- argument parsing -------------------------------------------------------

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        setFlag(flags, arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      if (VALUE_FLAGS.has(name) && i + 1 < args.length) {
        setFlag(flags, name, args[i + 1]);
        i += 1;
        continue;
      }
      setFlag(flags, name, true);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const letter of arg.slice(1)) setFlag(flags, letter, true);
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

function setFlag(flags, name, value) {
  if (flags[name] === undefined) flags[name] = value;
  else if (Array.isArray(flags[name])) flags[name].push(value);
  else flags[name] = [flags[name], value];
}

function asList(value) {
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function splitTags(value) {
  return asList(value)
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// --- output -----------------------------------------------------------------

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

const MARK = { ok: green('ok'), expiring: yellow('expiring'), expired: red('expired'), invalid: red('invalid'), warn: yellow('warn'), unknown: dim('unknown'), skipped: dim('-'), missing: red('missing'), removed: dim('removed'), orphan: yellow('orphan') };

function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)));
  const render = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ').trimEnd();
  console.log(dim(render(headers)));
  console.log(dim(widths.map((width) => '-'.repeat(width)).join('  ')));
  for (const row of rows) console.log(render(row));
}

function printHelp() {
  console.log(`pat ${VERSION} — manage, verify and distribute personal access tokens

Usage: pat <command> [options]

Setup
  setup                        Create ~/.config/pat, wire shell startup, show status
    --self <name>              Name this machine (default: hostname)
    --tag <tag>                Tag this machine (repeatable); tags gate which tokens render
    --preferred-source <host>  Default peer for bootstrapping a new machine
    --no-rc                    Skip editing ~/.zprofile and ~/.zshrc
    --dry-run                  Print what would change
  setup host add <alias>       Probe a machine and record it as a sync peer
    --ssh <alias> --tags a,b --path ~/.config/pat --mode both|push|pull
  setup host list | rm <alias> | tags <alias> <tags…> | probe <alias>
  setup hosts                  Suggest machines from ~/.ssh/config
  setup import-env             Find PAT-shaped env vars and add inventory rows
    --yes                      Write the rows   --apply  Also store their values

Tokens
  set <id>                     Store a rotated value (reads stdin, or prompts hidden)
    --from-env <VAR> --no-verify --force
  get <id>                     Print the value (use with $(…))
    --previous                 Print the value the last rotation displaced
  rm <id>                      Retire a token here; the delete propagates on sync
  env [id…]                    Print export lines for eval
  run <id> [--also id] -- cmd  Run one command with only that token in its env
  check [id…]                  Expiry + live canary per token
    --warn-days <n> (default ${DEFAULT_WARN_DAYS}) --json
  status [--all] [--json]      Local state, and per-peer versions with --all
    peer cells: vN same · vN⚠ behind · vN↑ ahead · vN≠ conflict · gone removed

Distribution
  sync [host|--all]            Push to and pull from every peer (pull first, then send)
  push [host|--all]            Pull, merge, then send what that host may hold
  pull [host|--all]            Pull and merge only
  take <host> <id>             Adopt a peer's version of one token to resolve a conflict
    --verify                   Re-read the peer's state after pushing

Diagnostics
  doctor [--hosts] [--json]    File modes, orphans, stale env, tag targeting, peers
  backup [--out <file>]        Passphrase-encrypted tar of state + config
  restore <file>               Restore a backup

Exit codes: 0 ok · 1 error · 2 usage · 3 attention needed (expiring, expired, conflict)
`);
}

// --- set / get / env --------------------------------------------------------

async function cmdSet(positional, flags) {
  if (flags.value !== undefined) {
    return fail('--value is not supported: a token on the command line lands in your shell history and in `ps` — pipe it on stdin or let pat prompt');
  }
  const [id] = positional;
  if (!id) return usage('pat set <id>');

  const home = resolveHome();
  ensureHome(home);
  const lock = store.acquireLock(home);
  if (!lock) return fail('another pat is writing state (lock held)');

  try {
    const ctx = commands.context(home);
    let value;
    if (typeof flags.value === 'string') {
      value = flags.value;
    } else if (typeof flags['from-env'] === 'string') {
      value = process.env[flags['from-env']];
      if (!value) return fail(`environment variable ${flags['from-env']} is empty or unset`);
    } else if (process.stdin.isTTY) {
      value = await promptHidden(`value for ${id} (not echoed): `);
    } else {
      value = readStdin();
    }

    const result = await commands.setToken({
      ctx,
      id,
      value,
      verify: !flags['no-verify'],
      force: Boolean(flags.force),
    });
    if (!result.ok) return fail(result.error);

    console.log(`${green('stored')} ${id} (v${result.version})${result.created ? dim(' — new inventory row, fill in renew_url/ttl_days') : ''}`);
    if (result.unprobed?.length) {
      console.log(
        yellow('note') +
          `   could not read ${result.unprobed.join(', ')} — if one holds a newer version, \`pat sync\` will adopt it and archive this one (\`pat get ${id} --previous\`)`,
      );
    }
    if (result.rendered?.skipped?.length) {
      for (const entry of result.rendered.skipped) console.log(`${dim('skip')}   ${entry.id}: ${entry.reason}`);
    }
    if (result.token && !result.token.renewUrl) {
      console.log(`${yellow('next')}   set renew_url in ~/.config/pat/inventory.toml so an expiry is a lookup, not a hunt`);
    }
    console.log(dim(`run \`pat sync\` to distribute it to ${Object.keys(ctx.config.hosts).length} peer(s)`));
    return EXIT.ok;
  } finally {
    store.releaseLock(lock);
  }
}

function cmdGet(positional, flags) {
  const [id] = positional;
  if (!id) return usage('pat get <id>');
  const ctx = commands.context();
  // --previous reads the value this rotation displaced, so a mis-paste caught
  // after the fact is recoverable instead of re-requested from the provider.
  const result = commands.getToken({ ctx, id, previous: Boolean(flags.previous) });
  if (!result.ok) return fail(result.error);
  process.stdout.write(result.value.endsWith('\n') ? result.value : `${result.value}\n`);
  return EXIT.ok;
}

function cmdRemove(positional, flags) {
  const [id] = positional;
  if (!id) return usage('pat rm <id>');
  const home = resolveHome();
  ensureHome(home);
  const lock = store.acquireLock(home);
  if (!lock) return fail('another pat is writing state (lock held)');
  try {
    const ctx = commands.context(home);
    const result = commands.removeToken({ ctx, id, dryRun: Boolean(flags['dry-run']) });
    if (!result.ok) return fail(result.error);
    if (result.already) {
      console.log(`${dim('already removed')} ${id}`);
      return EXIT.ok;
    }
    console.log(`${green(flags['dry-run'] ? 'would retire' : 'retired')} ${id} (v${result.version})`);
    if (!flags['dry-run']) console.log(dim(`run \`pat sync\` to propagate the retirement to ${Object.keys(ctx.config.hosts).length} peer(s)`));
    return EXIT.ok;
  } finally {
    store.releaseLock(lock);
  }
}

function cmdEnv(positional, flags) {
  const ctx = commands.context();
  const result = commands.envLines(ctx, positional);
  if (flags.json) {
    const out = {};
    for (const id of result.included) {
      const token = commands.getToken({ ctx, id });
      if (token.ok) out[token.varName] = token.value;
    }
    console.log(JSON.stringify(out, null, 2));
    return EXIT.ok;
  }
  for (const line of result.lines) console.log(line);
  for (const id of result.missing) console.error(dim(`# no value stored for ${id}`));
  return result.included.length ? EXIT.ok : EXIT.error;
}

function cmdRun(rest) {
  const separator = rest.indexOf('--');
  const head = separator === -1 ? rest : rest.slice(0, separator);
  const tail = separator === -1 ? [] : rest.slice(separator + 1);
  const { flags, positional } = parseArgs(head);
  const id = positional[0];
  if (!id) return usage('pat run <id> -- <command> [args…]');

  const command = separator === -1 ? positional[1] : tail[0];
  const args = separator === -1 ? positional.slice(2) : tail.slice(1);
  if (!command) return usage('pat run <id> -- <command> [args…]');

  const ctx = commands.context();
  const result = commands.runWithToken({ ctx, id, command, args, extraEnv: asList(flags.also) });
  if (!result.ok && result.error) return fail(result.error);
  return result.status;
}

// --- check / status ---------------------------------------------------------

async function cmdCheck(positional, flags) {
  const ctx = commands.context();
  const warnDays = flags['warn-days'] ? Number.parseInt(flags['warn-days'], 10) : DEFAULT_WARN_DAYS;
  const rows = await commands.checkTokens({ ctx, ids: positional, warnDays });

  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    table(
      ['id', 'var', 'days', 'canary', 'state'],
      rows.map((row) => [row.id, row.var, row.days, row.canary === 'skipped' ? dim('-') : row.canary, MARK[row.state] ?? row.state]),
    );
    const flagged = commands.attention(rows);
    if (flagged.length) {
      console.log('');
      for (const row of flagged) {
        const where = row.renewUrl ? `→ ${row.renewUrl}` : '→ no renew_url in inventory.toml';
        const who = row.owner ? ` owner ${row.owner}` : '';
        const what = row.consumers.length ? ` · breaks: ${row.consumers.join(', ')}` : '';
        console.log(`${yellow('!')} ${row.id}: ${row.state}${who}${what} ${where}`);
        console.log(dim(`  renew, then: pat set ${row.id} && pat sync`));
      }
    }
  }
  return commands.attention(rows).length ? EXIT.attention : EXIT.ok;
}

function cmdStatus(positional, flags) {
  const ctx = commands.context();
  const rows = commands.statusRows(ctx);

  const peers = flags.all ? commands.hostsFor(ctx.config, 'pull') : [];
  const peerMetas = new Map();
  for (const host of peers) {
    const result = commands.peerState(host);
    peerMetas.set(host.name, result.ok ? result.metas : null);
  }

  if (flags.json) {
    const payload = {
      self: ctx.selfName,
      tags: ctx.tags,
      tokens: rows,
      peers: Object.fromEntries(
        [...peerMetas.entries()].map(([name, metas]) => [name, metas ? Object.fromEntries(metas) : null]),
      ),
    };
    console.log(JSON.stringify(payload, null, 2));
    return EXIT.ok;
  }

  const headers = ['id', 'var', 'ver', 'days', 'state', 'updated'];
  if (peers.length) headers.push(...peers.map((host) => host.name));
  table(
    headers,
    rows.map((row) => {
      const cells = [
        row.id,
        row.var,
        row.version === null ? dim('—') : `v${row.version}`,
        row.days,
        MARK[row.state] ?? row.state,
        row.updatedAt ? `${row.updatedAt.slice(0, 10)} ${dim(row.updatedBy)}` : dim('—'),
      ];
      for (const host of peers) {
        const metas = peerMetas.get(host.name);
        if (!metas) {
          cells.push(red('unreachable'));
          continue;
        }
        cells.push(peerCell(metas.get(row.id), row));
      }
      return cells;
    }),
  );

  if (peers.length) {
    console.log('');
    console.log(dim('peer column: vN = same version · vN⚠ = peer behind · vN↑ = peer ahead · vN≠ = same version, different value · gone = removed there · – = absent'));
  }
  const missing = rows.filter((row) => row.state === 'missing');
  if (missing.length) console.log(dim(`${missing.length} token(s) with no value: ${missing.map((row) => row.id).join(', ')}`));
  return EXIT.ok;
}

function peerCell(peerMeta, localRow) {
  if (!peerMeta) return dim('–');
  if (peerMeta.removed) return dim('gone');
  const version = `v${peerMeta.version}`;
  if (localRow.version === null) return version;
  if (peerMeta.version > localRow.version) return yellow(`${version}↑`);
  if (peerMeta.version < localRow.version) return yellow(`${version}⚠`);
  // Same version, different bytes means the two sides disagree about what that
  // version is — a conflict the merge will refuse to apply.
  if (peerMeta.sha && localRow.sha && peerMeta.sha !== localRow.sha) return yellow(`${version}≠`);
  return green(version);
}

// --- sync / push / pull -----------------------------------------------------

async function cmdSync(positional, flags, mode) {
  const home = resolveHome();
  ensureHome(home);
  const lock = store.acquireLock(home);
  if (!lock) return fail('another pat is writing state (lock held)');

  try {
    const ctx = commands.context(home);
    const targets = selectHosts(ctx, positional, flags, mode);
    if (!targets.length) {
      console.error('pat: no peer hosts configured — run `pat setup host add <alias>`');
      return EXIT.error;
    }

    let conflicts = 0;
    let failures = 0;
    for (const host of targets) {
      // pushHost is pull-merge-then-send, so it covers both directions; a peer
      // whose mode is "pull" must never be written to, whatever was asked.
      const writable = commands.shouldPushTo(host, mode);
      const result = writable
        ? await commands.pushHost({ ctx, host, dryRun: Boolean(flags['dry-run']), verify: Boolean(flags.verify) })
        : await commands.pullHost({ ctx, host, dryRun: Boolean(flags['dry-run']) });
      reportPeer(result, writable ? (mode === 'push' ? 'push' : 'sync') : 'pull');
      if (!result.ok) failures += 1;
      if (result.conflicts?.length) conflicts += result.conflicts.length;
    }
    if (!flags['dry-run']) commands.renderLocal(ctx);
    if (conflicts) return EXIT.attention;
    // Every peer unreachable is a failure, not a quiet no-op: a schedule that
    // only reads the exit code has to notice that nothing converged.
    if (failures && failures === targets.length) return EXIT.error;
    return EXIT.ok;
  } finally {
    store.releaseLock(lock);
  }
}

function selectHosts(ctx, positional, flags, mode) {
  const hosts = commands.hostsFor(ctx.config, mode === 'push' ? 'push' : 'pull');
  const wanted = positional.length ? positional : asList(flags.host).filter((name) => name !== true);
  const all = flags.all || !wanted.length;
  if (all) return hosts;
  return wanted
    .map((name) => hosts.find((host) => host.name === name || host.ssh === name))
    .filter(Boolean);
}

function reportPeer(result, verb) {
  if (!result.ok) {
    console.log(`${red('fail')} ${result.host}: ${result.error}`);
    return;
  }
  const bits = [];
  if (result.dryRun) bits.push(dim('dry run'));
  if (result.adopted?.length) bits.push(`adopted ${result.adopted.join(', ')}`);
  if (result.pushed?.length) bits.push(`sent ${result.pushed.length}`);
  if (result.omitted?.length) bits.push(dim(`held back ${result.omitted.join(', ')}`));
  if (result.pruned?.length) bits.push(dim(`pruned ${result.pruned.join(', ')}`));
  if (result.unreadable?.length) bits.push(yellow(`left alone (unreadable metadata) ${result.unreadable.join(', ')}`));
  if (result.ignored?.length) bits.push(dim(`peer behind ${result.ignored.join(', ')}`));
  if (result.verify) bits.push(result.verify.ok ? green(`verified ${result.verify.detail}`) : red(`verify failed: ${result.verify.detail}`));
  console.log(`${green(verb)} ${result.host}${bits.length ? `  ${bits.join(' · ')}` : ''}`);
  for (const entry of result.rejected ?? []) {
    console.log(`${yellow('skip')} ${entry.id}: ${entry.reason}`);
  }
  for (const conflict of result.conflicts ?? []) {
    console.log(`${yellow('conflict')} ${conflict.id}: local v${conflict.local.version} ≠ ${result.host} v${conflict.remote.version}`);
    console.log(dim(`  resolve: pat take ${result.host} ${conflict.id}   (or pat set ${conflict.id} here to outrank both)`));
  }
}

async function cmdTake(positional) {
  const [hostName, id] = positional;
  if (!hostName || !id) return usage('pat take <host> <id>');
  const home = resolveHome();
  const lock = store.acquireLock(home);
  if (!lock) return fail('another pat is writing state (lock held)');
  try {
    const ctx = commands.context(home);
    const host = ctx.config.hosts[hostName] ?? Object.values(ctx.config.hosts).find((entry) => entry.ssh === hostName);
    if (!host) return fail(`no such host: ${hostName}`);
    const result = await commands.takeFrom({ ctx, host, id });
    if (!result.ok) return fail(result.error);
    console.log(`${green('took')} ${id} v${result.version} from ${host.name}`);
    return EXIT.ok;
  } finally {
    store.releaseLock(lock);
  }
}

// --- setup ------------------------------------------------------------------

async function cmdSetup(rest) {
  const hasSub = rest.length > 0 && !rest[0].startsWith('-');
  const sub = hasSub ? rest[0] : '';

  if (!sub) {
    const { flags } = parseArgs(rest);
    const home = resolveHome();
    const wantedTags = splitTags(flags.tag ?? flags.tags);
    const result = setup.runSetup({
      home,
      selfName: typeof flags.self === 'string' ? flags.self : undefined,
      tags: wantedTags,
      preferredSource: typeof flags['preferred-source'] === 'string' ? flags['preferred-source'] : undefined,
      dryRun: Boolean(flags['dry-run']),
      wire: !flags['no-rc'],
    });

    console.log(`${bold('pat setup')} ${result.home}`);
    for (const name of result.created) console.log(`  ${green('created')} ${name}`);
    for (const entry of result.actions) console.log(`  ${green(entry.action.padEnd(8))} ${entry.file}`);

    const ctx = commands.context(home);
    // A dry run writes nothing, so report what the flags would produce rather
    // than the pre-existing value.
    const shownSelf = typeof flags.self === 'string' ? flags.self : ctx.selfName;
    const shownTags = wantedTags.length ? wantedTags : ctx.tags;
    console.log('');
    console.log(`  self      ${bold(shownSelf)}${shownTags.length ? `  tags: ${shownTags.join(', ')}` : dim('  (no tags declared)')}`);
    console.log(`  tokens    ${ctx.inventory.tokens.length} in inventory, ${store.readMetas(home).size} with state`);
    console.log(`  hosts     ${Object.keys(ctx.config.hosts).join(', ') || dim('none — `pat setup host add <alias>`')}`);

    const suggestions = setup.discoverSshAliases({ config: ctx.config }).filter((alias) => alias !== 'localhost');
    if (suggestions.length) {
      console.log('');
      console.log(dim(`ssh aliases not managed yet: ${suggestions.join(', ')}`));
      console.log(dim(`add one: pat setup host add ${suggestions[0]} --tags work`));
    }

    if (flags['dry-run']) console.log(dim('\ndry run: nothing written'));
    else {
      console.log('');
      console.log(`next: ${dim('pat setup import-env')}  ${dim('pat setup host add <alias>')}  ${dim('pat check')}`);
    }
    return EXIT.ok;
  }

  if (sub === 'hosts') {
    const { flags } = parseArgs(rest.slice(1));
    return cmdSetupHosts(flags);
  }

  if (sub === 'host') {
    const action = rest[1] ?? '';
    if (!action) return usage('pat setup host add|list|rm|tags|probe');
    const { flags, positional } = parseArgs(rest.slice(2));
    return cmdSetupHost(action, positional, flags);
  }

  if (sub === 'import-env') {
    const { flags } = parseArgs(rest.slice(1));
    return cmdImportEnv(flags);
  }

  return usage(`pat setup [host|hosts|import-env]`);
}

function cmdSetupHosts(flags) {
  const ctx = commands.context();
  const aliases = setup.discoverSshAliases({
    config: ctx.config,
    sshConfigFile: typeof flags['ssh-config'] === 'string' ? flags['ssh-config'] : undefined,
  });
  const orca = flags.from === 'orca' ? orcaHostNames() : [];
  const names = [...new Set([...aliases, ...orca.filter((name) => !Object.hasOwn(ctx.config.hosts, name))])];

  if (!names.length) {
    console.log(dim('no unmanaged ssh aliases found in ~/.ssh/config'));
    return EXIT.ok;
  }
  table(['suggestion'], names.map((name) => [name]));
  console.log('');
  console.log(dim(`add: pat setup host add <alias> --tags work`));
  return EXIT.ok;
}

function orcaHostNames() {
  const result = spawnSync('orca-np', ['host', 'list'], { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) return [];
  const names = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*ssh target\s+(\S+)/.exec(line);
    if (match && match[1] !== 'github.com') names.push(match[1]);
  }
  return names;
}

function cmdSetupHost(action, positional, flags) {
  const home = resolveHome();
  const ctx = commands.context(home);

  if (action === 'list') {
    const hosts = Object.values(ctx.config.hosts);
    if (!hosts.length) {
      console.log(dim('no hosts configured — run `pat setup host add <alias>`'));
      return EXIT.ok;
    }
    table(
      ['host', 'ssh', 'tags', 'path', 'mode', 'enabled'],
      hosts.map((host) => [host.name, host.ssh, host.tags.join(',') || dim('-'), host.path, host.mode, host.enabled ? 'yes' : 'no']),
    );
    return EXIT.ok;
  }

  if (action === 'probe') {
    const alias = positional[0];
    if (!alias) return usage('pat setup host probe <alias>');
    const host = ctx.config.hosts[alias] ?? setup.hostEntry({ name: alias });
    const result = probeHost(host);
    for (const step of result.steps) {
      const mark = step.ok ? green('ok') : step.advisory ? yellow('warn') : red('fail');
      console.log(`${mark.padEnd(4)}  ${step.name.padEnd(16)} ${dim(step.detail)}`);
    }
    return result.ok ? EXIT.ok : EXIT.error;
  }

  if (action === 'add') {
    const alias = positional[0];
    if (!alias) return usage('pat setup host add <alias> [--tags a,b] [--ssh alias]');
    const host = setup.hostEntry({
      name: alias,
      ssh: typeof flags.ssh === 'string' ? flags.ssh : alias,
      tags: splitTags(flags.tag ?? flags.tags),
      hostPath: typeof flags.path === 'string' ? flags.path : DEFAULT_REMOTE_ROOT,
      mode: typeof flags.mode === 'string' ? flags.mode : 'both',
    });
    const result = setup.addHost({
      home,
      config: ctx.config,
      host,
      force: Boolean(flags.force),
      dryRun: Boolean(flags['dry-run']),
    });
    for (const step of result.probe.steps) {
      const mark = step.ok ? green('ok') : step.advisory ? yellow('warn') : red('fail');
      console.log(`${mark.padEnd(4)}  ${step.name.padEnd(16)} ${dim(step.detail)}`);
    }
    if (!result.ok) {
      console.error(red(`not added: ${alias} failed the probe (use --force to record it anyway)`));
      return EXIT.error;
    }
    console.log(`${green(result.probe.ok ? 'added' : 'added (unverified)')} ${alias}${host.tags.length ? ` tags: ${host.tags.join(', ')}` : ''}`);
    if (!host.tags.length) {
      console.log(
        yellow('note') +
          '   no tags on this peer: it will receive every token, including ones restricted to other tags. Re-run with --tags to filter.',
      );
    }
    console.log(dim(`distribute with: pat sync ${alias}`));
    return EXIT.ok;
  }

  if (action === 'rm') {
    const alias = positional[0];
    if (!alias) return usage('pat setup host rm <alias>');
    const result = setup.removeHost({ home, name: alias, dryRun: Boolean(flags['dry-run']) });
    if (!result.ok) return fail(result.error);
    console.log(`${green('removed')} ${alias}`);
    return EXIT.ok;
  }

  if (action === 'tags') {
    const [alias, ...tags] = positional;
    if (!alias) return usage('pat setup host tags <alias> <tags…>');
    const many = tags.length ? tags : splitTags(flags.tag ?? flags.tags);
    const result = setup.tagHost({ home, name: alias, tags: many, dryRun: Boolean(flags['dry-run']) });
    if (!result.ok) return fail(result.error);
    console.log(`${green('tagged')} ${alias}: ${many.join(', ') || '(none)'}`);
    return EXIT.ok;
  }

  return usage('pat setup host add|list|rm|tags|probe');
}

async function cmdImportEnv(flags) {
  const home = resolveHome();
  const ctx = commands.context(home);
  const candidates = setup.findEnvCandidates({ inventory: ctx.inventory });

  if (!candidates.length) {
    console.log(dim('no PAT-shaped environment variables outside the inventory'));
    return EXIT.ok;
  }
  table(['id', 'variable', 'length'], candidates.map((entry) => [entry.id, entry.var, `${entry.length} chars`]));
  console.log('');

  if (!flags.yes) {
    console.log(dim('add these rows: pat setup import-env --yes [--apply]'));
    return EXIT.ok;
  }

  ensureHome(home);
  const lock = store.acquireLock(home);
  if (!lock) return fail('another pat is writing state (lock held)');
  try {
    for (const entry of candidates) {
      appendTokenStanza(home, {
        id: entry.id,
        var: entry.var,
        system: '',
        owner: '',
        renewUrl: '',
        how: '',
        ttlDays: 30,
        issued: today(),
        onlyOn: [],
        consumers: [],
        check: { kind: 'none' },
      });
      console.log(`${green('added')} ${entry.id} (${entry.var})`);
    }
    commands.reload(ctx);

    if (flags.apply) {
      for (const entry of candidates) {
        const value = process.env[entry.var];
        if (!value) continue;
        const result = await commands.setToken({ ctx, id: entry.id, value, verify: false });
        console.log(result.ok ? `${green('stored')} ${entry.id} (v${result.version})` : `${red('failed')} ${entry.id}: ${result.error}`);
      }
      commands.renderLocal(ctx);
    } else {
      for (const entry of candidates) console.log(dim(`  pat set ${entry.id} --from-env ${entry.var}`));
    }
    console.log(dim('fill in renew_url + ttl_days so expiry checks are meaningful'));
    return EXIT.ok;
  } finally {
    store.releaseLock(lock);
  }
}

// --- doctor / backup --------------------------------------------------------

function cmdDoctor(positional, flags) {
  const ctx = commands.context();
  const result = commands.doctor(ctx, { probe: Boolean(flags.hosts) });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.worst === 'error' ? EXIT.error : result.worst === 'warn' ? EXIT.attention : EXIT.ok;
  }
  for (const finding of result.findings) {
    const mark = finding.status === 'ok' ? green('ok') : finding.status === 'warn' ? yellow('warn') : red('fail');
    console.log(`${mark.padEnd(4)} ${finding.name.padEnd(20)} ${dim(finding.detail)}`);
  }
  console.log('');
  console.log(result.worst === 'ok' ? green('healthy') : result.worst === 'warn' ? yellow('warnings only') : red('problems found'));
  return result.worst === 'error' ? EXIT.error : result.worst === 'warn' ? EXIT.attention : EXIT.ok;
}

async function cmdBackup(positional, flags) {
  if (flags.passphrase !== undefined) {
    return fail('--passphrase is not supported: it would appear in your shell history and in `ps` — set PAT_BACKUP_PASSPHRASE or let pat prompt');
  }
  const home = resolveHome();
  const out = typeof flags.out === 'string' ? flags.out : path.join(os.homedir(), `pat-backup-${today()}.tar.enc`);
  const passphrase =
    process.env.PAT_BACKUP_PASSPHRASE ?? (process.stdin.isTTY ? await promptHidden('backup passphrase: ') : '');
  if (!passphrase) return fail('a passphrase is required (or set PAT_BACKUP_PASSPHRASE)');
  const result = commands.backup({ home, out, passphrase });
  if (!result.ok) return fail(result.error);
  console.log(`${green('wrote')} ${result.out}`);
  console.log(dim('this is the only copy that survives losing every machine — keep it off-machine'));
  return EXIT.ok;
}

async function cmdRestore(positional, flags) {
  const [from] = positional;
  if (!from) return usage('pat restore <file>');
  if (flags.passphrase !== undefined) {
    return fail('--passphrase is not supported: it would appear in your shell history and in `ps` — set PAT_BACKUP_PASSPHRASE or let pat prompt');
  }
  const home = resolveHome();
  const passphrase =
    process.env.PAT_BACKUP_PASSPHRASE ?? (process.stdin.isTTY ? await promptHidden('backup passphrase: ') : '');
  if (!passphrase) return fail('a passphrase is required (or set PAT_BACKUP_PASSPHRASE)');
  const result = commands.restore({ home, from, passphrase });
  if (!result.ok) return fail(result.error);
  commands.renderLocal(commands.context(home));
  console.log(`${green('restored')} ${home}${result.restored?.length ? dim(` (${result.restored.join(', ')})`) : ''}`);
  if (result.kept?.length) {
    console.log(dim(`kept this machine's ${result.kept.join(', ')} — a backup carries state, not another machine's identity`));
  }
  return EXIT.ok;
}

// --- helpers ----------------------------------------------------------------

function usage(text) {
  console.error(`usage: ${text}`);
  return EXIT.usage;
}

function fail(message) {
  console.error(`${red('pat:')} ${message}`);
  return EXIT.error;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    stderr.write(question);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';

    const finish = (result) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stderr.write('\n');
      resolve(result);
    };

    function onData(chunk) {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          finish(value);
          return;
        }
        if (character === '\u0003') {
          finish('');
          process.exit(130);
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    }

    stdin.on('data', onData);
  });
}

export { EXIT };

// Entry point last: every module-level const above must be initialised before
// the first command runs, or a command would touch one in its temporal dead zone.
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`pat: ${error instanceof Error ? (process.env.PAT_DEBUG ? error.stack : error.message) : String(error)}`);
    process.exit(EXIT.error);
  },
);
