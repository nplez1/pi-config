import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// The real `@juicesharp/rpiv-config` ships TypeScript, which Node will not strip
// under node_modules (the Pi host loads extensions through jiti, so it can). Map
// it to a stub whose config the tests set, installed before the plugin loads.
const STUB_URL = new URL('./support/rpiv-config-stub.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@juicesharp/rpiv-config') return { url: STUB_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const configStub = await import(STUB_URL);

// Exercise the real plugin source under bare Node (type stripping). The modules
// under test import only type-only Pi APIs at runtime, plus the plugin's own
// tree — no Pi host process needed.
const plugin = fileURLToPath(new URL('../plugins/pi-todo/', import.meta.url));
const load = (name) => import(new URL(name, `file://${plugin}`).href);

const { decideReminder, buildReminderContent, registerSettleReminder, REMINDER_CUSTOM_TYPE, MAX_LISTED_TASKS } =
  await load('settle-reminder.ts');
const { createBackgroundWorkProbe, coldJobArmed, liveLoopArmed, subagentsBusy, callRpc, RPC_TIMEOUT_MS } = await load(
  'settle-background.ts',
);
const { selectOpenTasks } = await load('state/selectors.ts');
const store = await load('state/store.ts');
const {
  loadSettleReminderSettings,
  DEFAULT_SETTLE_REMINDER_COOLDOWN_MS,
  MIN_SETTLE_REMINDER_COOLDOWN_MS,
} = await load('config.ts');

const task = (id, status, extra = {}) => ({ id, subject: `task ${id}`, status, ...extra });
const baseInput = (overrides = {}) => ({
  enabled: true,
  outcome: 'completed',
  openCount: 2,
  isForeground: true,
  backgroundBusy: false,
  pendingMessages: false,
  sinceLastReminderMs: Number.POSITIVE_INFINITY,
  cooldownMs: 300_000,
  ...overrides,
});

// ── config ─────────────────────────────────────────────────────────────────

function withConfig(config, fn) {
  configStub.setConfig(config);
  try {
    return fn();
  } finally {
    configStub.setConfig({});
  }
}

test('settle reminder is on unless the config says false', () => {
  withConfig({}, () => assert.equal(loadSettleReminderSettings().enabled, true));
  withConfig({ settleReminder: 'nope' }, () => assert.equal(loadSettleReminderSettings().enabled, true));
  withConfig({ settleReminder: false }, () => assert.equal(loadSettleReminderSettings().enabled, false));
});

test('cooldown falls back to the default below the floor or on a non-number', () => {
  const defaultMs = DEFAULT_SETTLE_REMINDER_COOLDOWN_MS;
  for (const value of [undefined, '60000', null, Number.NaN, 0, MIN_SETTLE_REMINDER_COOLDOWN_MS - 1]) {
    withConfig({ settleReminderCooldownMs: value }, () =>
      assert.equal(loadSettleReminderSettings().cooldownMs, defaultMs, String(value)),
    );
  }
  withConfig({ settleReminderCooldownMs: MIN_SETTLE_REMINDER_COOLDOWN_MS }, () =>
    assert.equal(loadSettleReminderSettings().cooldownMs, MIN_SETTLE_REMINDER_COOLDOWN_MS),
  );
  withConfig({ settleReminderCooldownMs: 120_000 }, () =>
    assert.equal(loadSettleReminderSettings().cooldownMs, 120_000),
  );
});

// ── selectOpenTasks ────────────────────────────────────────────────────────

test('selectOpenTasks keeps pending and in_progress, drops completed and deleted', () => {
  const state = {
    nextId: 5,
    tasks: [
      task(1, 'pending'),
      task(2, 'in_progress'),
      task(3, 'completed'),
      task(4, 'deleted'),
    ],
  };
  assert.deepEqual(
    selectOpenTasks(state).map((t) => t.id),
    [1, 2],
  );
  assert.deepEqual(selectOpenTasks({ nextId: 1, tasks: [] }), []);
});

// ── buildReminderContent ───────────────────────────────────────────────────

test('buildReminderContent names every open task with its status and activity', () => {
  const content = buildReminderContent([
    task(4, 'pending', { subject: 'Research   existing\ntool' }),
    task(7, 'in_progress', { subject: 'Write tests', activeForm: 'writing tests' }),
    task(9, 'pending', { subject: 'Land the fix', blockedBy: [7, 8] }),
  ]);

  assert.match(content, /Todo reminder — 3 tasks are still open \(2 pending, 1 in progress\):/);
  // Whitespace in model-written text is flattened so one task stays one bullet.
  assert.ok(content.includes('- #4 [pending] Research existing tool'));
  assert.ok(content.includes('- #7 [in_progress] Write tests (writing tests)'));
  assert.ok(content.includes('- #9 [pending] Land the fix ⛓ blocked by #7, #8'));
  assert.match(content, /do not claim the work is done while items remain open\.$/);
});

test('buildReminderContent uses singular grammar for one task', () => {
  const content = buildReminderContent([task(1, 'pending')]);
  assert.match(content, /1 task is still open \(1 pending, 0 in progress\)/);
});

test('buildReminderContent collapses overflow past MAX_LISTED_TASKS', () => {
  const tasks = Array.from({ length: MAX_LISTED_TASKS + 3 }, (_, i) => task(i + 1, 'pending'));
  const content = buildReminderContent(tasks);
  const bullets = content.split('\n').filter((line) => line.startsWith('- #'));
  assert.equal(bullets.length, MAX_LISTED_TASKS);
  assert.ok(content.includes(`- …and 3 more (call todo with action "list" to see them)`));
});

// ── decideReminder ─────────────────────────────────────────────────────────

test('decideReminder reminds only when every gate passes', () => {
  assert.deepEqual(decideReminder(baseInput()), { remind: true });
});

test('decideReminder reports the first blocking gate', () => {
  const blocked = [
    ['disabled', { enabled: false }],
    ['nothing-open', { openCount: 0 }],
    ['run-not-completed', { outcome: 'aborted' }],
    ['run-not-completed', { outcome: 'error' }],
    ['child-session', { isForeground: false }],
    ['background-work', { backgroundBusy: true }],
    ['pending-messages', { pendingMessages: true }],
    ['cooldown', { sinceLastReminderMs: 299_999 }],
  ];
  for (const [reason, overrides] of blocked) {
    assert.deepEqual(decideReminder(baseInput(overrides)), { remind: false, reason }, reason);
  }
});

test('decideReminder treats the cooldown edge as elapsed', () => {
  assert.deepEqual(decideReminder(baseInput({ sinceLastReminderMs: 300_000 })), { remind: true });
});

// ── scheduled-job predicates ───────────────────────────────────────────────

test('coldJobArmed: only an enabled job fires', () => {
  assert.equal(coldJobArmed({ enabled: true }), true);
  assert.equal(coldJobArmed({ enabled: false }), false);
  assert.equal(coldJobArmed({}), false);
  assert.equal(coldJobArmed(null), false);
  assert.equal(coldJobArmed('job'), false);
});

test('liveLoopArmed: paused and expired loops are not armed', () => {
  assert.equal(liveLoopArmed({ paused: false }), true);
  assert.equal(liveLoopArmed({}), true);
  assert.equal(liveLoopArmed({ paused: true }), false);
  assert.equal(liveLoopArmed({ expiresAt: Date.now() + 60_000 }), true);
  assert.equal(liveLoopArmed({ expiresAt: Date.now() - 60_000 }), false);
  assert.equal(liveLoopArmed(undefined), false);
});

// ── subagents registry probe ───────────────────────────────────────────────

const MANAGER_KEY = Symbol.for('pi-subagents:manager');

function withRegistry(registry, fn) {
  Object.defineProperty(globalThis, MANAGER_KEY, { value: registry, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    delete globalThis[MANAGER_KEY];
  }
}

test('subagentsBusy reads the pi-subagents manager registry', () => {
  assert.equal(subagentsBusy(), false, 'no registry installed');
  assert.equal(withRegistry({ hasRunning: () => true }, subagentsBusy), true);
  assert.equal(withRegistry({ hasRunning: () => false }, subagentsBusy), false);
  // A foreign or half-torn-down registry answers false instead of throwing.
  assert.equal(
    withRegistry(
      {
        hasRunning: () => {
          throw new Error('torn down');
        },
      },
      subagentsBusy,
    ),
    false,
  );
  assert.equal(withRegistry({}, subagentsBusy), false);
  assert.equal(withRegistry(null, subagentsBusy), false);
});

// ── RPC transport ──────────────────────────────────────────────────────────

function fakeBus(handlers = {}) {
  const emitted = [];
  return {
    emitted,
    on: (channel, handler) => {
      (handlers[channel] ??= []).push(handler);
      return () => {
        handlers[channel] = handlers[channel].filter((h) => h !== handler);
      };
    },
    emit: (channel, data) => {
      emitted.push({ channel, data });
      for (const handler of handlers[channel] ?? []) handler(data);
    },
  };
}

/** A scheduler stand-in: replies on the per-request channel, like pi-subagents does. */
function schedulerBus(replies) {
  const handlers = {};
  const bus = fakeBus(handlers);
  for (const [channel, reply] of Object.entries(replies)) {
    bus.on(channel, (request) => {
      bus.emit(`${channel}:reply:${request.requestId}`, reply);
    });
  }
  return bus;
}

test('callRpc resolves through the scoped reply channel', async () => {
  const bus = schedulerBus({ 'x:list': { success: true, data: { jobs: [{ enabled: true }] } } });
  assert.deepEqual(await callRpc(bus, 'x:list', {}), { jobs: [{ enabled: true }] });
});

test('callRpc rejects an error envelope and a silent channel', async () => {
  const failing = schedulerBus({ 'x:list': { success: false, error: 'nope' } });
  await assert.rejects(() => callRpc(failing, 'x:list', {}), /nope/);

  const silent = fakeBus();
  await assert.rejects(() => callRpc(silent, 'x:list', {}, 5), /no reply from x:list/);
  assert.ok(RPC_TIMEOUT_MS > 0);
});

// ── background-work probe ──────────────────────────────────────────────────

test('probe: nothing running and nothing scheduled is idle', async () => {
  const probe = createBackgroundWorkProbe(schedulerBus({}), () => false);
  assert.equal(await probe.pending(), false);
});

test('probe: an armed cold job or live loop counts as background work', async () => {
  const cold = createBackgroundWorkProbe(
    schedulerBus({ 'subagents:rpc:schedules:list': { success: true, data: { jobs: [{ enabled: true }] } } }),
    () => false,
  );
  assert.equal(await cold.pending(), true);

  const pausedOnly = createBackgroundWorkProbe(
    schedulerBus({ 'subagents:rpc:schedules:list': { success: true, data: { jobs: [{ enabled: false }] } } }),
    () => false,
  );
  assert.equal(await pausedOnly.pending(), false);

  const live = createBackgroundWorkProbe(
    schedulerBus({ 'loop:rpc:schedules:list': { success: true, data: { jobs: [{ paused: false }] } } }),
    () => false,
  );
  assert.equal(await live.pending(), true);
});

test('probe: a running subagent short-circuits the RPCs', async () => {
  const bus = fakeBus();
  const probe = createBackgroundWorkProbe(bus, () => true);
  assert.equal(await probe.pending(), true);
  assert.equal(bus.emitted.length, 0, 'no scheduler round trip when an agent is running');
});

test('probe: a silent channel is asked once per session, and reset() re-arms it', async () => {
  const bus = fakeBus();
  const probe = createBackgroundWorkProbe(bus, () => false);

  assert.equal(await probe.pending(), false);
  const afterFirst = bus.emitted.length;
  assert.equal(await probe.pending(), false);
  assert.equal(bus.emitted.length, afterFirst, 'an absent scheduler is not probed again');

  probe.reset();
  await probe.pending();
  assert.ok(bus.emitted.length > afterFirst, 'a new session asks again');
});

test('probe: a malformed reply counts as nothing scheduled and does not throw', async () => {
  const probe = createBackgroundWorkProbe(
    schedulerBus({ 'subagents:rpc:schedules:list': { success: true, data: {} } }),
    () => false,
  );
  assert.equal(await probe.pending(), false);
});

// ── the hook ───────────────────────────────────────────────────────────────

function fakePi() {
  const handlers = {};
  const pi = {
    events: fakeBus(),
    on: (name, fn) => {
      (handlers[name] ??= []).push(fn);
    },
  };
  const call = async (name, event, ctx) => {
    let result;
    for (const fn of handlers[name] ?? []) result = await fn(event, ctx);
    return result;
  };
  return { pi, handlers, call };
}

/** A foreground interactive session holding `tasks`, plus the hook harness. */
async function harness({ tasks, sid = 'sid-fg', pendingMessages = false, probe } = {}) {
  store.__resetState();
  store.replaceState(sid, { tasks, nextId: 99 });
  store.setActiveRenderSession(sid);

  const { pi, call, handlers } = fakePi();
  registerSettleReminder(pi, probe);
  const ctx = (id = sid) => ({
    sessionManager: { getSessionId: () => id },
    hasPendingMessages: () => pendingMessages,
  });
  const settle = (overrides = {}, id = sid) =>
    call(
      'agent_before_settle',
      { type: 'agent_before_settle', entries: [], continue: false, outcome: 'completed', ...overrides },
      ctx(id),
    );
  return { pi, handlers, settle, call, ctx };
}

test('hook: appends a hidden reminder and requests one continuation', async () => {
  const h = await harness({ tasks: [task(1, 'pending')], probe: createBackgroundWorkProbe(undefined, () => false) });
  const result = await h.settle();

  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 1);
  const [entry] = result.entries;
  assert.equal(entry.type, 'custom_message');
  assert.equal(entry.customType, REMINDER_CUSTOM_TYPE);
  assert.equal(entry.display, false);
  assert.match(entry.content, /1 task is still open/);
});

test('hook: preserves entries earlier handlers already proposed', async () => {
  const h = await harness({ tasks: [task(1, 'pending')], probe: createBackgroundWorkProbe(undefined, () => false) });
  const earlier = { type: 'custom', customType: 'other-extension', data: {} };
  const result = await h.settle({ entries: [earlier] });
  assert.deepEqual(result.entries[0], earlier);
  assert.equal(result.entries.length, 2);
});

test('hook: a completed list settles silently', async () => {
  const h = await harness({ tasks: [task(1, 'completed')], probe: createBackgroundWorkProbe(undefined, () => false) });
  assert.equal(await h.settle(), undefined);
});

test('hook: an aborted or errored run is not reminded', async () => {
  const h = await harness({ tasks: [task(1, 'pending')], probe: createBackgroundWorkProbe(undefined, () => false) });
  assert.equal(await h.settle({ outcome: 'aborted' }), undefined);
  assert.equal(await h.settle({ outcome: 'error' }), undefined);
});

test('hook: a child session is not reminded', async () => {
  const h = await harness({ tasks: [task(1, 'pending')], probe: createBackgroundWorkProbe(undefined, () => false) });
  store.replaceState('sid-child', { tasks: [task(2, 'pending')], nextId: 9 });
  assert.equal(await h.settle({}, 'sid-child'), undefined);
});

test('hook: queued messages suppress the reminder', async () => {
  const h = await harness({
    tasks: [task(1, 'pending')],
    pendingMessages: true,
    probe: createBackgroundWorkProbe(undefined, () => false),
  });
  assert.equal(await h.settle(), undefined);
});

test('hook: background work suppresses the reminder', async () => {
  const h = await harness({ tasks: [task(1, 'pending')], probe: createBackgroundWorkProbe(undefined, () => true) });
  assert.equal(await h.settle(), undefined);
});

test('hook: the cooldown caps repeats, a human turn clears it, an extension turn does not', async () => {
  const h = await harness({ tasks: [task(1, 'pending')], probe: createBackgroundWorkProbe(undefined, () => false) });

  const first = await h.settle();
  assert.equal(first.continue, true, 'first settle reminds');
  assert.equal(await h.settle(), undefined, 'the continuation settle is inside the cap');

  // Extension-sourced input (a loop tick, another extension) must not buy a nudge.
  await h.call('input', { type: 'input', text: 'tick', source: 'extension' }, h.ctx());
  assert.equal(await h.settle(), undefined);

  // A human prompt is a new request, so the cap is cleared.
  await h.call('input', { type: 'input', text: 'keep going', source: 'interactive' }, h.ctx());
  const afterHuman = await h.settle();
  assert.equal(afterHuman.continue, true);
});

test('hook: a disabled config settles silently', async () => {
  const h = await harness({ tasks: [task(1, 'pending')], probe: createBackgroundWorkProbe(undefined, () => false) });
  configStub.setConfig({ settleReminder: false });
  try {
    assert.equal(await h.settle(), undefined);
  } finally {
    configStub.setConfig({});
  }
});

test('hook: a throwing probe settles silently instead of erroring the boundary', async () => {
  const h = await harness({
    tasks: [task(1, 'pending')],
    probe: {
      pending: async () => {
        throw new Error('registry exploded');
      },
      reset: () => {},
    },
  });
  assert.equal(await h.settle(), undefined);
});

test('hook: a new session starts with a fresh cap', async () => {
  const h = await harness({ tasks: [task(1, 'pending')], probe: createBackgroundWorkProbe(undefined, () => false) });
  assert.equal((await h.settle()).continue, true);
  assert.equal(await h.settle(), undefined);
  await h.call('session_start', { type: 'session_start' }, h.ctx());
  assert.equal((await h.settle()).continue, true);
});
