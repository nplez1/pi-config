import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The keepalive writes its diagnostics under $HOME, so point HOME at a scratch
// directory before the module loads (its log path is computed at import time).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-keepalive-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
const savedHome = process.env.HOME;
process.env.HOME = home;
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

// Copy the real source next to a `type: module` package.json so bare Node can
// load it; the file has no relative imports, and its pi import is type-only.
const source = fileURLToPath(new URL('../dot-pi/agent/extensions/cache-keepalive.ts', import.meta.url));
fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
fs.copyFileSync(source, path.join(root, 'cache-keepalive.ts'));
const { default: install } = await import(pathToFileURL(path.join(root, 'cache-keepalive.ts')));

// A minimal pi: captures extension handlers and an in-process event bus.
function fakePi() {
  const handlers = {};
  const channels = {};
  const commands = {};
  const entries = [];
  return {
    entries,
    commands,
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerCommand(name, options) {
      commands[name] = options;
    },
    appendEntry(customType, data) {
      entries.push({ type: 'custom', customType, data });
    },
    events: {
      on(channel, handler) {
        (channels[channel] ??= []).push(handler);
      },
      emit(channel, data) {
        for (const handler of channels[channel] ?? []) handler(data);
      },
    },
    async fire(name, event, ctx) {
      const results = [];
      for (const handler of handlers[name] ?? []) results.push(await handler(event, ctx));
      return results;
    },
  };
}

// Anthropic-free model with a short cache lifetime: 11s TTL -> 1s refresh cadence.
const model = {
  id: 'test-model',
  api: 'openai-completions',
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  promptCache: { short: 11 },
};

function fakeCtx(refreshUsage) {
  const calls = [];
  return {
    calls,
    model,
    thinkingLevel: 'off',
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => 'session-1',
      getEntries: () => [],
      getBranch: () => [
        { type: 'message', message: { role: 'assistant', usage: { input: 1000, cacheRead: 50_000, cacheWrite: 0 } } },
      ],
    },
    modelRegistry: {
      streamSimple(_model, _context, _options) {
        calls.push(_options);
        return {
          result: async () => ({
            stopReason: 'stop',
            usage: { ...refreshUsage, cost: { total: 0.01 } },
          }),
        };
      },
    },
  };
}

function readLog() {
  const file = path.join(home, '.pi', 'agent', 'logs', 'cache-keepalive.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a running workflow keeps the cache warm and is logged end to end', async () => {
  const pi = fakePi();
  install(pi);
  const ctx = fakeCtx({ input: 0, cacheRead: 51_000, cacheWrite: 0, output: 1 });

  await pi.fire('session_start', {}, ctx);
  await pi.fire('context_with_system', { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] }, ctx);

  // The workflow announces itself on the same channel an agent uses.
  pi.events.emit('subagents:started', { id: 'wf_test', runId: 'wf_test', mode: 'workflow', type: 'workflow' });
  await pi.fire('agent_settled', { aborted: false }, ctx);

  await sleep(1_400);
  let log = readLog();
  const start = log.find((line) => line.event === 'start');
  assert.ok(start, 'keepalive should start while a workflow is pending');
  assert.equal(start.pendingSubagents, 1);
  const refresh = log.find((line) => line.event === 'refresh');
  assert.ok(refresh, 'a refresh should run and be logged');
  assert.equal(refresh.cacheRead, 51_000, 'the refresh should report its cache read');
  assert.equal(refresh.promptTokensExpected, 51_000);

  // The workflow settles: the next tick must stop rather than keep paying for warmth.
  pi.events.emit('subagents:completed', { id: 'wf_test', runId: 'wf_test', mode: 'workflow', status: 'completed' });
  await sleep(1_400);
  log = readLog();
  assert.ok(
    log.some((line) => line.event === 'stop' && line.reason === 'no pending subagent or loop fire'),
    'keepalive should stop once nothing is pending',
  );
  assert.ok(log.some((line) => line.event === 'subagent_completed' && line.id === 'wf_test'));
});

test('no pending work means no keepalive, and the skip is logged with its reason', async () => {
  const pi = fakePi();
  install(pi);
  const ctx = fakeCtx({ input: 0, cacheRead: 51_000, cacheWrite: 0, output: 1 });

  await pi.fire('session_start', {}, ctx);
  await pi.fire('context_with_system', { messages: [{ role: 'user', content: 'hi' }] }, ctx);
  await pi.fire('agent_settled', { aborted: false }, ctx);

  const log = readLog();
  assert.ok(log.some((line) => line.event === 'start_skipped' && line.reason === 'no pending subagent or loop'));
  assert.equal(ctx.calls.length, 0, 'nothing should be sent');
});

test('PI_CACHE_KEEPALIVE=off at launch sends nothing while a workflow is pending', async () => {
  const savedEnv = process.env.PI_CACHE_KEEPALIVE;
  process.env.PI_CACHE_KEEPALIVE = 'off';
  try {
    const pi = fakePi();
    install(pi);
    const ctx = fakeCtx({ input: 0, cacheRead: 51_000, cacheWrite: 0, output: 1 });
    await pi.fire('session_start', {}, ctx);
    await pi.fire('context_with_system', { messages: [{ role: 'user', content: 'hi' }] }, ctx);
    pi.events.emit('subagents:started', { id: 'wf_env', runId: 'wf_env', mode: 'workflow', type: 'workflow' });
    await pi.fire('agent_settled', { aborted: false }, ctx);
    await sleep(1_400);
    assert.equal(ctx.calls.length, 0, 'no refresh should be sent when disabled at launch');
    assert.ok(readLog().some((line) => line.event === 'start_skipped' && line.reason === 'disabled for this session'));
    await pi.fire('session_shutdown', {}, ctx);
  } finally {
    if (savedEnv === undefined) delete process.env.PI_CACHE_KEEPALIVE;
    else process.env.PI_CACHE_KEEPALIVE = savedEnv;
  }
});

test('/cache-keepalive off stops a running keepalive and is kept for the session', async () => {
  const pi = fakePi();
  install(pi);
  const ctx = fakeCtx({ input: 0, cacheRead: 51_000, cacheWrite: 0, output: 1 });
  await pi.fire('session_start', {}, ctx);
  await pi.fire('context_with_system', { messages: [{ role: 'user', content: 'hi' }] }, ctx);
  pi.events.emit('subagents:started', { id: 'wf_cmd', runId: 'wf_cmd', mode: 'workflow', type: 'workflow' });
  await pi.fire('agent_settled', { aborted: false }, ctx);
  await sleep(1_200);
  assert.ok(ctx.calls.length > 0, 'keepalive should be refreshing before the toggle');

  await pi.commands['cache-keepalive'].handler('off', ctx);
  const callsAtOff = ctx.calls.length;
  await sleep(1_400);
  assert.equal(ctx.calls.length, callsAtOff, 'no refresh should follow /cache-keepalive off');
  assert.equal(pi.entries.at(-1)?.data?.enabled, false, 'the choice should be saved to the session');

  // Pi's own warm-ups are vetoed while off.
  const decisions = await pi.fire('cache_warming_decision', { action: 'warm', warmCost: 0, missCost: 1 }, ctx);
  assert.ok(decisions.some((d) => d?.action === 'stop'), "Pi's own warm-up should be vetoed while off");
  pi.events.emit('subagents:completed', { id: 'wf_cmd', runId: 'wf_cmd', mode: 'workflow', status: 'completed' });

  // A later launch of the same session file restores the saved choice.
  const reloaded = fakePi();
  install(reloaded);
  const reloadCtx = fakeCtx({ input: 0, cacheRead: 51_000, cacheWrite: 0, output: 1 });
  reloadCtx.sessionManager.getEntries = () => pi.entries;
  await reloaded.fire('session_start', {}, reloadCtx);
  await reloaded.fire('context_with_system', { messages: [{ role: 'user', content: 'hi' }] }, reloadCtx);
  reloaded.events.emit('subagents:started', { id: 'wf_r', runId: 'wf_r', mode: 'workflow', type: 'workflow' });
  await reloaded.fire('agent_settled', { aborted: false }, reloadCtx);
  await sleep(1_200);
  assert.equal(reloadCtx.calls.length, 0, 'the saved off choice should survive a reload');
  reloaded.events.emit('subagents:completed', { id: 'wf_r', runId: 'wf_r', mode: 'workflow', status: 'completed' });
  await reloaded.fire('session_shutdown', {}, reloadCtx);
  await pi.fire('session_shutdown', {}, ctx);
});
