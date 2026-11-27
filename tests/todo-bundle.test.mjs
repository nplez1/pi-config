import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The committed artifact in plugins/pi-todo-bundle/dist is what every session
// actually loads, so it is tested as an artifact: built from plugins/pi-todo, and
// loaded here the way Pi loads it (an ESM entry that wires host modules and
// requires core.cjs). tests/todo-settle-reminder.test.mjs covers the source; this
// file covers the thing that ships.
const REPO = fileURLToPath(new URL('../', import.meta.url));
const PKG = join(REPO, 'plugins/pi-todo-bundle');
const CORE = join(PKG, 'dist/core.cjs');
const HOSTS = join(REPO, 'plugins/pi-todo/node_modules');

// Host modules come from the fork's devDependencies — they are what pi provides at
// runtime, and a clone that ran `npm install` in plugins/pi-todo has them. Nothing
// to test without them, so skip rather than fail.
const hostsAvailable = ['@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox'].every((name) =>
  existsSync(join(HOSTS, name)),
);
const skip = hostsAvailable ? false : 'plugins/pi-todo devDependencies are not installed';

// The freshness gate needs neither the host modules (the build shim intercepts
// them) nor Bun as a *runtime* — only the bun binary and the fork's one production
// dependency. It must NOT share the gate above: `install.sh` runs
// `npm install --omit=dev` in plugins/pi-todo, which removes the devDependencies,
// and a shared gate would silently retire this check on every installed machine.
const bunAvailable = (() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const driftSkip = !bunAvailable
  ? 'bun is not on PATH, and Node cannot run Bun.build'
  : !existsSync(join(HOSTS, '@juicesharp/rpiv-config/package.json'))
    ? 'plugins/pi-todo production dependencies are not installed'
    : false;

// A copy of dist/ beside a node_modules symlink, because the entry imports the
// host packages by bare specifier and Pi is what resolves them in a real session.
const fixture = hostsAvailable ? mkdtempSync(join(tmpdir(), 'pi-todo-bundle-')) : undefined;
after(() => {
  if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true });
});
if (fixture !== undefined) {
  cpSync(join(PKG, 'dist'), join(fixture, 'dist'), { recursive: true });
  cpSync(join(PKG, 'locales'), join(fixture, 'locales'), { recursive: true });
  symlinkSync(HOSTS, join(fixture, 'node_modules'), 'dir');
}

/** A Pi API just wide enough for the extension to register itself. */
function fakePi() {
  const tools = {};
  const handlers = {};
  const entries = [];
  const pi = {
    registerTool: (tool) => (tools[tool.name] = tool),
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    appendEntry: (type, data) => entries.push({ type, data }),
    on: (name, handler) => {
      (handlers[name] ??= []).push(handler);
      return () => {};
    },
    events: { on: () => () => {}, emit: () => {}, off: () => {} },
  };
  const call = async (name, event, ctx) => {
    let result;
    for (const handler of handlers[name] ?? []) result = await handler(event, ctx);
    return result;
  };
  return { pi, tools, handlers, entries, call };
}

/** A session context scoped to one session id, so tests cannot share task state. */
const ctxFor = (sessionId) => ({
  sessionManager: { getSessionId: () => sessionId },
  hasPendingMessages: () => false,
});

const settle = (h, sessionId, overrides = {}) =>
  h.call(
    'agent_before_settle',
    { type: 'agent_before_settle', entries: [], continue: false, outcome: 'completed', ...overrides },
    ctxFor(sessionId),
  );

async function load() {
  const { default: factory } = await import(pathToFileURL(join(fixture, 'dist/index.js')).href);
  const h = fakePi();
  factory(h.pi);
  return h;
}

test('the bundle is plain CommonJS, not Bun-only bundle format', { skip }, () => {
  // Bun's format wraps the module in an uncalled function expression, so Node's
  // require would return {}. Every test below runs on Node, which is the real
  // proof; this pins the reason it can.
  const source = readFileSync(CORE, 'utf8');
  assert.ok(!source.startsWith('// @bun @bun-cjs'), 'must not use Bun’s private CJS wrapper');
  assert.match(source, /^module\.exports = /m, 'must export through module.exports');
});

test('the entry registers the todo tool and the settle hook', { skip }, async () => {
  const h = await load();
  assert.ok(h.tools.todo, 'todo tool registered');
  assert.ok(h.handlers.agent_before_settle?.length, 'agent_before_settle hook registered');
});

test('the bundled extension fires the settle reminder for an open task', { skip }, async () => {
  const h = await load();
  const ctx = ctxFor('sid-fire');

  const created = await h.tools.todo.execute('call-1', { action: 'create', subject: 'bundled task' }, undefined, undefined, ctx);
  assert.match(JSON.stringify(created), /bundled task/);

  const result = await settle(h, 'sid-fire');
  assert.equal(result?.continue, true, 'one continuation requested');
  const entry = result.entries.at(-1);
  assert.equal(entry.customType, 'rpiv-todo-settle-reminder');
  assert.equal(entry.display, false);
  assert.match(entry.content, /1 task is still open/);
});

test('the bundled extension stays silent once the list is closed', { skip }, async () => {
  const h = await load();
  const ctx = ctxFor('sid-closed');

  await h.tools.todo.execute('call-1', { action: 'create', subject: 'done task' }, undefined, undefined, ctx);
  await h.tools.todo.execute('call-2', { action: 'update', id: 1, status: 'completed' }, undefined, undefined, ctx);
  assert.equal(await settle(h, 'sid-closed'), undefined);
});

test('the bundled extension does not remind a run that aborted', { skip }, async () => {
  const h = await load();
  await h.tools.todo.execute('call-1', { action: 'create', subject: 'left open' }, undefined, undefined, ctxFor('sid-aborted'));
  assert.equal(await settle(h, 'sid-aborted', { outcome: 'aborted' }), undefined);
  assert.equal(await settle(h, 'sid-aborted', { outcome: 'error' }), undefined);
});

test('the committed dist matches a fresh build of plugins/pi-todo', { skip: driftSkip }, () => {
  // `--check` also refuses to compare across toolchains (a different bun or
  // rpiv-config version), which it reports as a skip rather than as drift.
  const out = execFileSync('bun', ['scripts/build-todo-bundle.mjs', '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.match(out, /^(ok|skip)/, out);
});
