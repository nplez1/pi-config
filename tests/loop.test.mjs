import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the real extension source in isolation. Its only runtime peer import
// is `typebox`; the pi-coding-agent import is type-only and erased.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const extension = fileURLToPath(new URL('../dot-pi/agent/extensions/loop.ts', import.meta.url));
// `loop.ts` imports its cold-backend helper as `./shared/scheduled-rpc` (no
// extension), which is what pi's loader resolves and what plain Node does not.
// The copy gets the extension added rather than the source, so production keeps
// the loader-shaped specifier and the test still runs on bare Node.
fs.cpSync(
  fileURLToPath(new URL('../dot-pi/agent/extensions/shared/scheduled-rpc.ts', import.meta.url)),
  path.join(root, 'scheduled-rpc.ts'),
);
fs.writeFileSync(
  path.join(root, 'loop.ts'),
  fs.readFileSync(extension, 'utf8').replace('./shared/scheduled-rpc', './scheduled-rpc.ts'),
);
fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');

// Minimal TypeBox stand-in: the tests never validate a schema, they only need
// the module to import.
const typeboxDir = path.join(root, 'node_modules', 'typebox');
fs.mkdirSync(typeboxDir, { recursive: true });
fs.writeFileSync(path.join(typeboxDir, 'package.json'), '{"type":"module","exports":"./index.js"}');
fs.writeFileSync(
  path.join(typeboxDir, 'index.js'),
  'const mk = () => ({ type: "stub" });\n' +
    'export const Type = new Proxy({}, { get: () => () => mk() });\n'
);

const loop = await import(pathToFileURL(path.join(root, 'loop.ts')));

// ── Parsing: the six examples Claude's own skill lists ──────────────────────

test('leading interval token splits into interval + prompt', () => {
  assert.deepEqual(loop.parseLoopInput('5m /babysit-prs'), {
    ok: true,
    mode: 'fixed',
    prompt: '/babysit-prs',
    intervalMs: 300_000,
    intervalText: '5m',
  });
});

test('trailing "every N unit" clause is extracted', () => {
  const parsed = loop.parseLoopInput('check the deploy every 20m');
  assert.equal(parsed.mode, 'fixed');
  assert.equal(parsed.prompt, 'check the deploy');
  assert.equal(parsed.intervalMs, 1_200_000);
});

test('trailing "every N <word>" accepts spelled-out units', () => {
  const parsed = loop.parseLoopInput('run tests every 5 minutes');
  assert.equal(parsed.mode, 'fixed');
  assert.equal(parsed.prompt, 'run tests');
  assert.equal(parsed.intervalMs, 300_000);
});

test('a prompt with no interval is dynamic', () => {
  assert.deepEqual(loop.parseLoopInput('check the deploy'), {
    ok: true,
    mode: 'dynamic',
    prompt: 'check the deploy',
  });
});

test('"every" not followed by a time expression stays in the prompt', () => {
  const parsed = loop.parseLoopInput('check every PR');
  assert.equal(parsed.mode, 'dynamic');
  assert.equal(parsed.prompt, 'check every PR');
});

test('an interval with no prompt is interval-only, never a prompt named "5m"', () => {
  assert.deepEqual(loop.parseLoopInput('5m'), {
    ok: true,
    mode: 'interval-only',
    intervalMs: 300_000,
    intervalText: '5m',
  });
});

test('empty input is rejected', () => {
  assert.equal(loop.parseLoopInput('   ').ok, false);
});

test('parseIntervalToken only accepts bare tokens', () => {
  assert.equal(loop.parseIntervalToken('5m'), 300_000);
  assert.equal(loop.parseIntervalToken('2h'), 7_200_000);
  assert.equal(loop.parseIntervalToken('0m'), undefined);
  assert.equal(loop.parseIntervalToken('5 m'), undefined);
  assert.equal(loop.parseIntervalToken('5w'), undefined);
});

// ── Duration + footer formatting ────────────────────────────────────────────

test('formatDuration reads like a footer, not a stopwatch', () => {
  assert.equal(loop.formatDuration(0), '0s');
  assert.equal(loop.formatDuration(12_000), '12s');
  assert.equal(loop.formatDuration(270_000), '4m 30s');
  assert.equal(loop.formatDuration(300_000), '5m');
  assert.equal(loop.formatDuration(3_600_000), '1h');
  assert.equal(loop.formatDuration(3_720_000), '1h 2m');
  assert.equal(loop.formatDuration(90_000_000), '1d 1h');
});

test('footer is empty when nothing is armed', () => {
  assert.equal(loop.formatFooter([], Date.now()), undefined);
});

test('footer counts loops and shows the soonest next run', () => {
  const now = 1_000_000;
  const footer = loop.formatFooter(
    [
      { kind: 'live', mode: 'fixed', nextAt: now + 270_000, quietStreak: 0 },
      { kind: 'live', mode: 'fixed', nextAt: now + 60_000, quietStreak: 0 },
    ],
    now
  );
  assert.equal(footer, '◷ 2 loops · next in 1m');
});

test('footer names both backends when both are scheduled', () => {
  const now = 1_000_000;
  const footer = loop.formatFooter(
    [
      { kind: 'live', mode: 'fixed', nextAt: now + 300_000, quietStreak: 0 },
      { kind: 'cold', mode: 'fixed', nextAt: now + 60_000, quietStreak: 0 },
    ],
    now
  );
  // The soonest fire wins regardless of backend, and each is counted on its own.
  assert.equal(footer, '◷ 1 loop · 1 job · next in 1m');
});

test('footer says only "job" when the live backend has nothing armed', () => {
  const now = 1_000_000;
  const footer = loop.formatFooter([{ kind: 'cold', mode: 'fixed', nextAt: now + 120_000, quietStreak: 0 }], now);
  assert.equal(footer, '◷ 1 job · next in 2m');
});

test('footer says "running" while a dynamic loop awaits its wakeup', () => {
  const footer = loop.formatFooter([{ kind: 'live', mode: 'dynamic', nextAt: undefined, quietStreak: 0 }], 1_000_000);
  assert.equal(footer, '◷ 1 loop · running');
});

test('footer surfaces a quiet streak only once it is worth mentioning', () => {
  const now = 1_000_000;
  const view = (quietStreak) => ({ kind: 'live', mode: 'dynamic', nextAt: now + 60_000, quietStreak });
  assert.equal(loop.formatFooter([view(1)], now), '◷ 1 loop · next in 1m');
  assert.equal(loop.formatFooter([view(3)], now), '◷ 1 loop · next in 1m · quiet ×3');
});

test('footer clamps a past-due next run to zero rather than going negative', () => {
  const now = 1_000_000;
  assert.equal(
    loop.formatFooter([{ kind: 'live', mode: 'fixed', nextAt: now - 5_000, quietStreak: 0 }], now),
    '◷ 1 loop · next in 0s'
  );
});

// ── Scheduling arithmetic ───────────────────────────────────────────────────

test('nextFixedRun keeps the cadence when the fire was on time', () => {
  const previous = 1_000_000;
  assert.equal(loop.nextFixedRun(previous, previous + 1_000, 300_000), previous + 300_000);
});

test('nextFixedRun does not catch up missed slots', () => {
  // The timer came due 3 intervals ago while a turn was running: one fire, then
  // the next slot is one interval from now — not a burst of three.
  const previous = 1_000_000;
  const now = previous + 3 * 300_000;
  assert.equal(loop.nextFixedRun(previous, now, 300_000), now + 300_000);
});

test('a late fire stays on the original phase, and counts the slots it ran past', () => {
  // Due at 1,000,000 on a 5m cadence, delivered 12.5 minutes late: the slots at
  // +5m and +10m passed unfired, and the next fire is the +15m slot — not 5m
  // after the late fire, which is how "every 2h" used to slide off the clock.
  const previous = 1_000_000;
  const now = previous + 750_000;
  assert.equal(loop.missedSlots(previous, now, 300_000), 2);
  assert.equal(loop.nextFixedRun(previous, now, 300_000), previous + 900_000);
  assert.equal(loop.missedSlots(previous, previous + 1_000, 300_000), 0);
});

test('clampWakeupSeconds holds the [60, 3600] window', () => {
  assert.deepEqual(loop.clampWakeupSeconds(270), { seconds: 270, clamped: false });
  assert.deepEqual(loop.clampWakeupSeconds(5), { seconds: 60, clamped: true });
  assert.deepEqual(loop.clampWakeupSeconds(99_999), { seconds: 3600, clamped: true });
  assert.equal(loop.clampWakeupSeconds('soon').seconds, undefined);
  assert.match(loop.clampWakeupSeconds(0).error, /positive/);
});

test('the documented limits are the ones Claude uses', () => {
  assert.equal(loop.MIN_INTERVAL_MS, 60_000);
  assert.equal(loop.MIN_WAKEUP_SECONDS, 60);
  assert.equal(loop.MAX_WAKEUP_SECONDS, 3600);
  assert.equal(loop.LOOP_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(loop.FALLBACK_WAKEUP_MS, 20 * 60 * 1000);
  assert.equal(loop.MAX_LOOPS, 50);
});

// ── Extension wiring (fake pi, no model call) ───────────────────────────────

function harness(options = {}) {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const statuses = new Map();
  const notices = [];
  const sent = [];
  const busCalls = [];
  const busHandlers = new Map();
  // A fake pi-subagents scheduler: enough of the three RPCs for `/loop` to drive
  // the cold backend, with an in-memory job list it can list, create into, and
  // remove from.
  const coldJobs = new Map((options.coldJobs ?? []).map((job) => [job.id, job]));

  const bus = {
    on(event, fn) {
      const set = busHandlers.get(event) ?? new Set();
      set.add(fn);
      busHandlers.set(event, set);
      return () => set.delete(fn);
    },
    emit(event, data) {
      busCalls.push({ event, data });
      if (!event.startsWith('subagents:rpc:schedules:')) {
        // A real bus notifies subscribers; that is how the scheduler's own events
        // reach `/loop`, so the fake has to do it too.
        for (const fn of busHandlers.get(event) ?? []) fn(data);
        return;
      }
      const replyChannel = `${event}:reply:${data.requestId}`;
      let reply;
      if (options.failRpc) reply = { success: false, error: options.failRpc };
      else if (event.endsWith(':list')) reply = { success: true, data: { jobs: [...coldJobs.values()] } };
      else if (event.endsWith(':create')) {
        const id = `cold${coldJobs.size + 1}`;
        coldJobs.set(id, {
          id,
          name: data.prompt,
          schedule: data.schedule,
          scheduleType: 'interval',
          enabled: true,
          prompt: data.prompt,
          runCount: 0,
          nextRun: new Date(Date.now() + 60_000).toISOString(),
        });
        reply = { success: true, data: { id, nextRun: coldJobs.get(id).nextRun } };
      } else if (event.endsWith(':remove')) {
        coldJobs.delete(data.jobId);
        reply = { success: true, data: { removed: data.jobId } };
      }
      // Reply out of band, the way a real extension would: the caller is already
      // awaiting the promise this emit is inside of.
      queueMicrotask(() => {
        for (const fn of busHandlers.get(replyChannel) ?? []) fn(reply);
      });
    },
  };

  const ctx = {
    cwd: options.cwd ?? root,
    hasUI: true,
    isIdle: () => true,
    ...(options.sessionId ? { sessionManager: { getSessionId: () => options.sessionId } } : {}),
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      notify: (message, level) => notices.push({ message, level }),
    },
  };

  const pi = {
    events: options.noBus ? undefined : bus,
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, options2) => commands.set(name, options2),
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: (content) => sent.push(content),
  };

  loop.default(pi);
  return { tools, commands, handlers, statuses, notices, sent, ctx, pi, bus, busCalls, coldJobs };
}

const tool = (h) => h.tools.get('ScheduleWakeup');
const run = (h, args) => h.commands.get('loop').handler(args, h.ctx);

test('the extension registers the ScheduleWakeup tool and the /loop command', () => {
  const h = harness();
  assert.ok(tool(h), 'ScheduleWakeup tool registered');
  assert.ok(h.commands.get('loop'), '/loop command registered');
  for (const event of ['session_start', 'turn_end', 'agent_settled', 'session_shutdown']) {
    assert.ok(h.handlers.get(event), `${event} handler registered`);
  }
});

test('/loop <interval> <prompt> arms a fixed loop, runs it immediately, and fills the footer', async () => {
  const h = harness();
  await run(h, '5m check the deploy');

  assert.deepEqual(h.sent, ['check the deploy']);
  // formatDuration rounds up, so a fresh 5m loop reads 5m rather than 4m 59s.
  assert.match(h.statuses.get('loop'), /^◷ 1 loop · next in 5m$/);
  assert.match(h.notices[0].message, /Loop [a-z0-9]+ armed · every 5m · expires in 7 days/);
  h.handlers.get('session_shutdown')();
});

test('/loop <prompt> with no interval arms a self-paced loop that waits for ScheduleWakeup', async () => {
  const h = harness();
  await run(h, 'check the deploy');

  assert.deepEqual(h.sent, ['check the deploy']);
  assert.equal(h.statuses.get('loop'), '◷ 1 loop · running');
  h.handlers.get('session_shutdown')();
});

test('ScheduleWakeup arms the next self-paced iteration and reports the delay', async () => {
  const h = harness();
  await run(h, 'check the deploy');
  h.sent.length = 0;

  const result = await tool(h).execute('call-1', { delaySeconds: 270, reason: 'CI takes ~8m' });
  assert.match(result.content[0].text, /^Next wakeup scheduled for \d\d:\d\d:\d\d \(in 270s\)\. Reason: CI takes ~8m$/);
  assert.match(h.statuses.get('loop'), /^◷ 1 loop · next in 4m 30s$/);
  h.handlers.get('session_shutdown')();
});

test('ScheduleWakeup clamps a delay into [60, 3600] and says so', async () => {
  const h = harness();
  await run(h, 'check the deploy');
  const result = await tool(h).execute('call-1', { delaySeconds: 5, reason: 'too eager' });
  assert.match(result.content[0].text, /in 60s, clamped from 5s\)/);
  h.handlers.get('session_shutdown')();
});

test('ScheduleWakeup refuses to schedule without a reason', async () => {
  const h = harness();
  await run(h, 'check the deploy');
  const result = await tool(h).execute('call-1', { delaySeconds: 270 });
  assert.match(result.content[0].text, /`reason` is required/);
  assert.equal(h.statuses.get('loop'), '◷ 1 loop · running');
  h.handlers.get('session_shutdown')();
});

test('ScheduleWakeup with stop:true ends the loop and clears the footer', async () => {
  const h = harness();
  await run(h, 'check the deploy');
  const result = await tool(h).execute('call-1', { stop: true });
  assert.match(result.content[0].text, /^Loop stopped — "check the deploy" will not fire again\.$/);
  assert.equal(h.statuses.get('loop'), undefined);
  h.handlers.get('session_shutdown')();
});

test('a self-paced loop that ends its turn without rescheduling gets one fallback wakeup', async () => {
  const h = harness();
  await run(h, 'check the deploy');

  // Turn one ends without ScheduleWakeup: one grace wakeup, not an end.
  await h.handlers.get('agent_settled')({}, h.ctx);
  assert.match(h.statuses.get('loop'), /^◷ 1 loop · next in 20m$/);
  assert.match(h.notices.at(-1).message, /one fallback wakeup in 20m/);
  h.handlers.get('session_shutdown')();
});

test('the fallback path ends the loop only after a second silent turn', () => {
  // Pure decision table: the handler drives this, so pin the rules here rather
  // than trying to fast-forward a real 20-minute timer.
  const base = { stopped: false, runs: 1, nextAt: undefined, fallbackArmed: false };
  assert.equal(loop.decideDynamicSettle(base), 'arm-fallback');
  assert.equal(loop.decideDynamicSettle({ ...base, fallbackArmed: true }), 'end-loop');
  // A wakeup is armed: the loop chose to continue.
  assert.equal(loop.decideDynamicSettle({ ...base, nextAt: Date.now() + 1000 }), 'wait');
  // Nothing has run yet, or the loop is already stopped.
  assert.equal(loop.decideDynamicSettle({ ...base, runs: 0 }), 'wait');
  assert.equal(loop.decideDynamicSettle({ ...base, stopped: true }), 'wait');
});

test('a loop that reschedules is never ended by the fallback path', async () => {
  const h = harness();
  await run(h, 'check the deploy');
  await tool(h).execute('call-1', { delaySeconds: 1200, reason: 'quiet branch' });
  await h.handlers.get('agent_settled')({}, h.ctx);
  assert.match(h.statuses.get('loop'), /^◷ 1 loop · next in (19m 5\ds|20m)$/);
  h.handlers.get('session_shutdown')();
});

test('a second self-paced loop is refused, and /loop stop clears the first', async () => {
  const h = harness();
  await run(h, 'check the deploy');
  await run(h, 'check the other thing');
  assert.match(h.notices.at(-1).message, /A self-paced loop is already running/);
  assert.deepEqual(h.sent, ['check the deploy']);

  await run(h, 'stop all');
  assert.equal(h.statuses.get('loop'), undefined);
  assert.match(h.notices.at(-1).message, /Stopped 1 loop\./);
  h.handlers.get('session_shutdown')();
});

test('an interval below the one-minute floor is raised, and the user is told', async () => {
  const h = harness();
  await run(h, '5s check the deploy');
  assert.match(h.notices[0].message, /below the 1m floor; using 1m/);
  assert.match(h.statuses.get('loop'), /^◷ 1 loop · next in 1m$/);
  h.handlers.get('session_shutdown')();
});

test('/loop list reports each armed loop', async () => {
  const h = harness();
  await run(h, '30m sweep the queue');
  h.notices.length = 0;
  await run(h, 'list');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].message, /^◷ [a-z0-9]+ · every 30m · next in 30m \(\d\d:\d\d\) · runs 1 · expires in 7d · "sweep the queue"$/);
  h.handlers.get('session_shutdown')();
});

test('/loop 5m with no loop.md asks for a prompt instead of looping on the text "5m"', async () => {
  const h = harness();
  await run(h, '5m');
  assert.match(h.notices.at(-1).message, /needs a prompt: \/loop 5m <prompt>/);
  assert.equal(h.notices.at(-1).level, 'warning');
  assert.deepEqual(h.sent, []);
  h.handlers.get('session_shutdown')();
});

test('/loop 5m takes its prompt from .pi/loop.md at that cadence', async () => {
  const h = harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-md-'));
  fs.mkdirSync(path.join(dir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pi', 'loop.md'), 'tend the release branch\n');
  const ctx = { ...h.ctx, cwd: dir };
  await h.commands.get('loop').handler('5m', ctx);
  assert.deepEqual(h.sent, ['tend the release branch']);
  assert.match(h.notices[0].message, /armed · every 5m/);
  assert.match(h.statuses.get('loop'), /^◷ 1 loop · next in 5m$/);
  fs.rmSync(dir, { recursive: true, force: true });
  h.handlers.get('session_shutdown')();
});

test('bare /loop with no loop.md shows usage rather than arming an empty loop', async () => {
  const h = harness();
  await run(h, '');
  assert.match(h.notices.at(-1).message, /^Usage: \/loop \[interval\] <prompt>/);
  assert.deepEqual(h.sent, []);
  h.handlers.get('session_shutdown')();
});

// ── Cold backend: the same command, a subagent execution home ───────────────
//
// Cold exists because a live tick pays for the main context every fire: the whole
// transcript goes back to the model, and the tick's messages stay in it. A cold
// tick is a separate subagent session. Both are session-scoped, so the only
// difference a user should see is the tag and the footer count.

const coldJob = (overrides = {}) => ({
  id: 'cold-a',
  name: 'say hello',
  schedule: '1m',
  scheduleType: 'interval',
  intervalMs: 60_000,
  enabled: true,
  prompt: 'say hello',
  runCount: 0,
  nextRun: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

test('--cold is stripped wherever it appears, so it never reaches the prompt', () => {
  assert.deepEqual(loop.stripColdFlag('1m --cold say hello'), { cold: true, input: '1m say hello' });
  assert.deepEqual(loop.stripColdFlag('1m say hello --cold'), { cold: true, input: '1m say hello' });
  assert.deepEqual(loop.stripColdFlag('1m say hello'), { cold: false, input: '1m say hello' });
});

test('/loop 5m --cold hands the job to the scheduler instead of the session', async () => {
  const h = harness();
  await run(h, '5m --cold say hello');

  // The whole point: nothing is injected into this conversation.
  assert.deepEqual(h.sent, []);
  const created = h.busCalls.find((call) => call.event.endsWith(':create'));
  assert.equal(created.data.schedule, '5m');
  assert.equal(created.data.prompt, 'say hello');
  assert.match(h.notices.at(-1).message, /Cold loop cold1 armed · every 5m · runs in a subagent session/);
  assert.equal(h.statuses.get('loop'), '◷ 1 job · next in 1m');
  h.handlers.get('session_shutdown')();
});

test('--cold refuses a self-paced loop, which needs a session to pace itself in', async () => {
  const h = harness();
  await run(h, '--cold say hello');
  assert.match(h.notices.at(-1).message, /--cold needs an interval/);
  assert.equal(h.busCalls.filter((call) => call.event.endsWith(':create')).length, 0);
  h.handlers.get('session_shutdown')();
});

test('--cold reports the scheduler being unavailable rather than arming nothing', async () => {
  const h = harness({ noBus: true });
  await run(h, '5m --cold say hello');
  assert.match(h.notices.at(-1).message, /--cold needs pi-subagents/);
  assert.deepEqual(h.sent, []);
  h.handlers.get('session_shutdown')();
});

test('--cold surfaces a scheduler refusal instead of pretending it worked', async () => {
  const h = harness({ failRpc: 'Scheduler is not active in this session yet.' });
  await run(h, '5m --cold say hello');
  assert.match(h.notices.at(-1).message, /Cold loop not armed — Scheduler is not active/);
  assert.equal(h.statuses.get('loop'), undefined);
  h.handlers.get('session_shutdown')();
});

test('/loop list shows both backends, each tagged with its execution home', async () => {
  const h = harness({ coldJobs: [coldJob()] });
  await h.handlers.get('session_start')({}, h.ctx);
  await run(h, '30m sweep the queue');
  h.notices.length = 0;
  await run(h, 'list');
  assert.equal(h.notices.length, 2);
  assert.match(h.notices[0].message, /^◷ [a-z0-9]+ · every 30m · next in 30m \(\d\d:\d\d\) · runs 1 · expires in 7d · "sweep the queue"$/);
  assert.match(h.notices[1].message, /^◷ cold-a · \[cold\] every 1m · next in 1m · runs 0 · "say hello"$/);
  h.handlers.get('session_shutdown')();
});

test('/loop stop routes a cold id to the scheduler', async () => {
  const h = harness({ coldJobs: [coldJob()] });
  await h.handlers.get('session_start')({}, h.ctx);
  await run(h, 'stop cold-a');
  const removed = h.busCalls.find((call) => call.event.endsWith(':remove'));
  assert.equal(removed.data.jobId, 'cold-a');
  assert.match(h.notices.at(-1).message, /Stopped cold job cold-a\./);
  assert.equal(h.statuses.get('loop'), undefined);
  h.handlers.get('session_shutdown')();
});

test('/loop stop all stops both backends and counts them separately', async () => {
  const h = harness({ coldJobs: [coldJob()] });
  await h.handlers.get('session_start')({}, h.ctx);
  await run(h, '30m sweep the queue');
  await run(h, 'stop all');
  assert.match(h.notices.at(-1).message, /^Stopped 1 loop and 1 job\.$/);
  assert.equal(h.statuses.get('loop'), undefined);
  h.handlers.get('session_shutdown')();
});

test('a cold job appears in the footer as soon as the scheduler announces it', async () => {
  const h = harness();
  await h.handlers.get('session_start')({}, h.ctx);
  h.bus.emit('subagents:scheduled', { type: 'added', job: coldJob() });
  assert.equal(h.statuses.get('loop'), '◷ 1 job · next in 1m');
  h.bus.emit('subagents:scheduled', { type: 'removed', jobId: 'cold-a' });
  assert.equal(h.statuses.get('loop'), undefined);
  h.handlers.get('session_shutdown')();
});

// A cold job arms the scheduler's timer, not `/loop`'s — so without a tick of its
// own the footer printed whatever the last event wrote and froze there ("next in
// 2s" that never moved). The countdown has to be recomputed, not just rewritten.
test('a cold-only session keeps ticking, so the countdown does not freeze', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const h = harness();
  await h.handlers.get('session_start')({}, h.ctx);
  h.bus.emit('subagents:scheduled', { type: 'added', job: coldJob() });
  assert.equal(h.statuses.get('loop'), '◷ 1 job · next in 1m');
  t.mock.timers.tick(1000);
  assert.equal(h.statuses.get('loop'), '◷ 1 job · next in 59s');
  t.mock.timers.tick(1000);
  assert.equal(h.statuses.get('loop'), '◷ 1 job · next in 58s');
  h.handlers.get('session_shutdown')();
});

// ── Session scope: resumed, never standing ──────────────────────────────────

test('a resumed session restores its live loops, without a burst of catch-up fires', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-resume-'));
  const sessionId = 'session-abc';
  fs.mkdirSync(path.join(dir, '.pi', 'loops'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.pi', 'loops', `${sessionId}.json`),
    JSON.stringify({
      version: 1,
      loops: [
        {
          id: 'kept',
          prompt: 'check the deploy',
          mode: 'fixed',
          intervalMs: 300_000,
          createdAt: Date.now() - 60_000,
          expiresAt: Date.now() + 86_400_000,
          runs: 4,
        },
      ],
    })
  );

  const h = harness({ cwd: dir, sessionId });
  await h.handlers.get('session_start')({}, h.ctx);

  // Restored and visible, but nothing was injected: the missed slot is dropped,
  // not replayed, and the next fire is a full interval away.
  assert.equal(h.statuses.get('loop'), '◷ 1 loop · next in 5m');
  assert.deepEqual(h.sent, []);
  h.notices.length = 0;
  await run(h, 'list');
  assert.match(h.notices[0].message, /runs 4/);
  h.handlers.get('session_shutdown')();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a new session does not inherit another session\'s loops', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-fresh-'));
  fs.mkdirSync(path.join(dir, '.pi', 'loops'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.pi', 'loops', 'other-session.json'),
    JSON.stringify({ version: 1, loops: [{ id: 'x', prompt: 'p', mode: 'fixed', intervalMs: 60_000, createdAt: 1, expiresAt: Date.now() + 86_400_000, runs: 0 }] })
  );
  const h = harness({ cwd: dir, sessionId: 'this-session' });
  await h.handlers.get('session_start')({}, h.ctx);
  assert.equal(h.statuses.get('loop'), undefined);
  h.handlers.get('session_shutdown')();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an expired persisted loop is not restored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-expired-'));
  const sessionId = 'session-old';
  fs.mkdirSync(path.join(dir, '.pi', 'loops'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.pi', 'loops', `${sessionId}.json`),
    JSON.stringify({ version: 1, loops: [{ id: 'gone', prompt: 'p', mode: 'fixed', intervalMs: 60_000, createdAt: 1, expiresAt: Date.now() - 1, runs: 9 }] })
  );
  const h = harness({ cwd: dir, sessionId });
  await h.handlers.get('session_start')({}, h.ctx);
  assert.equal(h.statuses.get('loop'), undefined);
  h.handlers.get('session_shutdown')();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── The live backend's RPC surface ──────────────────────────────────────────
//
// The model reaches live loops through pi-subagents' `manage_schedules` →
// `backend: "live"`, which lands on these five channels. The literals are
// hardcoded here on purpose: they are the wire contract with
// `plugins/pi-subagents/src/schedule-live-rpc.ts`, and a test that imported the
// constant would pass even after both sides were renamed apart.

const LIVE_CREATE = 'loop:rpc:schedules:create';
const LIVE_LIST = 'loop:rpc:schedules:list';
const LIVE_UPDATE = 'loop:rpc:schedules:update';
const LIVE_RUN = 'loop:rpc:schedules:run';
const LIVE_REMOVE = 'loop:rpc:schedules:remove';

/** The reply a channel answered with, or undefined when it stayed silent. */
function replyTo(h, channel, requestId) {
  const call = h.busCalls.find((c) => c.event === `${channel}:reply:${requestId}`);
  return call?.data;
}

/** Emit one request and return its reply. */
function ask(h, channel, requestId, params = {}) {
  h.bus.emit(channel, { requestId, ...params });
  return replyTo(h, channel, requestId);
}

async function started(options) {
  const h = harness(options);
  await h.handlers.get('session_start')({}, h.ctx);
  return h;
}

test('a model-created live loop is armed, and the user is told what it costs', async () => {
  const h = await started();
  const reply = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'check the deploy' });

  assert.equal(reply.success, true);
  assert.equal(reply.data.intervalMs, 300_000);
  assert.ok(reply.data.id, 'the caller gets an id back to cancel with');
  // The footer is how a live loop is visible at all — arming one silently would
  // be a model spending the user's context with nothing on screen.
  assert.match(h.statuses.get('loop'), /1 loop/);
  assert.ok(
    h.notices.some((n) => n.message.includes('armed by the model') && n.message.includes('main context')),
    'the user is told a live loop appeared and that it costs main context'
  );
  assert.ok(
    h.notices.some((n) => n.message.includes('· every 5m ·')),
    'and the cadence reads once, not "every every 5m"'
  );
  h.handlers.get('session_shutdown')();
});

test('a model-created live loop does not fire mid-turn, unlike /loop at the prompt', async () => {
  const h = await started();
  ask(h, LIVE_CREATE, 'r1', { schedule: '1m', prompt: 'say hello' });

  // `/loop 1m say hello` runs its first iteration immediately; a tool call
  // arrives mid-turn, and firing here would steer the turn that created it.
  assert.deepEqual(h.sent, [], 'nothing injected while the creating turn is in flight');
  h.handlers.get('session_shutdown')();
});

test('the live backend refuses a schedule it cannot honour, naming where it belongs', async () => {
  const h = await started();
  const reply = ask(h, LIVE_CREATE, 'r1', { schedule: '0 0 9 * * 1', prompt: 'x' });

  assert.equal(reply.success, false);
  assert.match(reply.error, /not a live-loop schedule/);
  assert.match(reply.error, /cold backend/);
  h.handlers.get('session_shutdown')();
});

test('a live loop can be a one-shot, armed at the instant it was given', async () => {
  const h = await started();
  const reply = ask(h, LIVE_CREATE, 'r1', { schedule: '+30m', prompt: 'check once' });

  assert.equal(reply.success, true);
  assert.equal(reply.data.mode, 'once');
  // The due instant is the whole of its schedule, so it must be the future the
  // caller asked for rather than "now".
  assert.ok(reply.data.fireAt > Date.now());
  h.handlers.get('session_shutdown')();
});

test('a bound set at create is reported, so the loop can say when it ends', async () => {
  const h = await started();
  const made = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'x', maxRuns: 3 });
  const list = ask(h, LIVE_LIST, 'r2', {});
  const job = list.data.jobs.find((entry) => entry.id === made.data.id);

  assert.equal(job.maxRuns, 3);
  h.handlers.get('session_shutdown')();
});

test('a bound can be cleared, because keeping going is a real request', async () => {
  const h = await started();
  const made = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'x', maxRuns: 2 });
  const reply = ask(h, LIVE_UPDATE, 'r2', { jobId: made.data.id, maxRuns: 0 });

  assert.equal(reply.success, true);
  assert.ok(reply.data.changed.includes('maxRuns removed'));
  assert.equal(reply.data.job.maxRuns, undefined);
  h.handlers.get('session_shutdown')();
});

test('a stop time already in the past is refused rather than armed', async () => {
  const h = await started();
  const reply = ask(h, LIVE_CREATE, 'r1', {
    schedule: '5m',
    prompt: 'x',
    until: '2020-01-01T00:00:00Z',
  });

  assert.equal(reply.success, false);
  assert.match(reply.error, /in the past/);
  h.handlers.get('session_shutdown')();
});

test('a sub-minute interval is clamped to the floor rather than refused', async () => {
  const h = await started();
  const reply = ask(h, LIVE_CREATE, 'r1', { schedule: '10s', prompt: 'x' });

  assert.equal(reply.success, true);
  assert.equal(reply.data.intervalMs, loop.MIN_INTERVAL_MS);
  h.handlers.get('session_shutdown')();
});

test('a prompt is required, so no loop is armed with nothing to say', async () => {
  const h = await started();
  const reply = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: '   ' });

  assert.equal(reply.success, false);
  assert.match(reply.error, /prompt/);
  assert.equal(h.statuses.get('loop'), undefined);
  h.handlers.get('session_shutdown')();
});

test('list reports the live loops, so one tool can show both backends', async () => {
  const h = await started();
  ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'check the deploy' });
  const reply = ask(h, LIVE_LIST, 'r2');

  assert.equal(reply.success, true);
  assert.equal(reply.data.jobs.length, 1);
  assert.deepEqual(
    { prompt: reply.data.jobs[0].prompt, intervalMs: reply.data.jobs[0].intervalMs },
    { prompt: 'check the deploy', intervalMs: 300_000 }
  );
  h.handlers.get('session_shutdown')();
});

test('remove disarms a live loop, and an unknown id says so instead of pretending', async () => {
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'x' });

  const removed = ask(h, LIVE_REMOVE, 'r2', { jobId: created.data.id });
  assert.equal(removed.success, true);
  assert.equal(removed.data.removed, created.data.id);
  assert.equal(h.statuses.get('loop'), undefined, 'nothing left armed');

  const missing = ask(h, LIVE_REMOVE, 'r3', { jobId: 'nope' });
  assert.equal(missing.success, false);
  assert.match(missing.error, /No live loop with id "nope"/);
  h.handlers.get('session_shutdown')();
});

test('a request with no requestId is ignored rather than answered into the void', async () => {
  const h = await started();
  h.bus.emit(LIVE_CREATE, { schedule: '5m', prompt: 'x' });
  assert.equal(
    h.busCalls.some((c) => c.event.startsWith(`${LIVE_CREATE}:reply:`)),
    false
  );
  assert.equal(h.statuses.get('loop'), undefined);
  h.handlers.get('session_shutdown')();
});

test('a session with no event bus registers no live channels, and still works', async () => {
  const h = await started({ noBus: true });
  // Nothing to emit on; the point is that wiring is a no-op rather than a crash.
  await run(h, '5m check the deploy');
  assert.deepEqual(h.sent, ['check the deploy']);
  h.handlers.get('session_shutdown')();
});

// ── The same channels cover the whole lifecycle ─────────────────────────────
//
// A model that can arm a loop but cannot change, pause or fire it has half a
// door, and a half door is what makes a model tell the user to type a command.
// Every verb answers with the job's own view, so a caller never has to re-list
// to learn what its own call did.

test('update moves the cadence, and the countdown restarts from the new one', async () => {
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'check the deploy' });

  const updated = ask(h, LIVE_UPDATE, 'r2', { jobId: created.data.id, schedule: '25m' });

  assert.equal(updated.success, true);
  assert.equal(updated.data.job.intervalMs, 1_500_000);
  // A list, and exactly the cadence: `formatInterval` already says "every", so a
  // caller repeating that string back to the user would stutter ("every every
  // 25m"), and one shape for "what changed" keeps both backends aligned.
  assert.deepEqual(updated.data.changed, ['every 25m']);
  assert.match(h.statuses.get('loop'), /next in 25m/);
  h.handlers.get('session_shutdown')();
});

test('update replaces the text a loop will fire', async () => {
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'old text' });

  ask(h, LIVE_UPDATE, 'r2', { jobId: created.data.id, prompt: 'Still alive.' });

  assert.equal(ask(h, LIVE_LIST, 'r3').data.jobs[0].prompt, 'Still alive.');
  ask(h, LIVE_RUN, 'r4', { jobId: created.data.id });
  h.handlers.get('turn_end')({}, h.ctx);
  assert.deepEqual(h.sent, ['Still alive.']);
  h.handlers.get('session_shutdown')();
});

test('pause unarms a loop without forgetting it, and the footer says why it is quiet', async () => {
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'check the deploy' });

  const paused = ask(h, LIVE_UPDATE, 'r2', { jobId: created.data.id, paused: true });

  assert.equal(paused.success, true);
  assert.equal(paused.data.job.paused, true);
  assert.equal(paused.data.job.nextAt, undefined, 'nothing armed');
  assert.equal(h.statuses.get('loop'), '◷ 1 loop · paused');
  assert.deepEqual(h.sent, []);
  h.handlers.get('session_shutdown')();
});

test('resume re-arms the cadence, and run is how it fires now', async () => {
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'Still alive.' });
  ask(h, LIVE_UPDATE, 'r2', { jobId: created.data.id, paused: true });

  const resumed = ask(h, LIVE_UPDATE, 'r3', { jobId: created.data.id, paused: false });

  assert.equal(resumed.data.job.paused, false);
  assert.match(h.statuses.get('loop'), /next in 5m/);
  // Resume means "let it run again", not "run it now" — otherwise the two homes
  // would need two meanings for the same word, and the cold one cannot fire on
  // resume at all (its timer restarts one interval out).
  h.handlers.get('turn_end')({}, h.ctx);
  assert.deepEqual(h.sent, []);

  ask(h, LIVE_RUN, 'r4', { jobId: created.data.id });
  h.handlers.get('turn_end')({}, h.ctx);
  assert.deepEqual(h.sent, ['Still alive.']);
  h.handlers.get('session_shutdown')();
});

test('run-now queues the fire for the next idle window instead of steering this turn', async () => {
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '25m', prompt: 'Still alive.' });

  const ran = ask(h, LIVE_RUN, 'r2', { jobId: created.data.id });
  assert.equal(ran.success, true);
  assert.equal(ran.data.queuedForNextIdle, true);
  assert.deepEqual(h.sent, [], 'nothing injected while the asking turn is in flight');

  h.ctx.isIdle = () => false;
  h.handlers.get('turn_end')({}, h.ctx);
  assert.deepEqual(h.sent, [], 'still mid-turn');

  h.ctx.isIdle = () => true;
  h.handlers.get('turn_end')({}, h.ctx);
  assert.deepEqual(h.sent, ['Still alive.']);
  h.handlers.get('session_shutdown')();
});

test('a paused loop cannot be run, and says which verb comes first', async () => {
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'x' });
  ask(h, LIVE_UPDATE, 'r2', { jobId: created.data.id, paused: true });

  const ran = ask(h, LIVE_RUN, 'r3', { jobId: created.data.id });

  assert.equal(ran.success, false);
  assert.match(ran.error, /is paused\. Resume it first/);
  assert.deepEqual(h.sent, []);
  h.handlers.get('session_shutdown')();
});

test('an empty update is an error, and re-asserting current values succeeds with nothing changed', async () => {
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'x' });

  const empty = ask(h, LIVE_UPDATE, 'r2', { jobId: created.data.id });
  assert.equal(empty.success, false);
  assert.match(empty.error, /Nothing to change/);

  // An idempotent caller re-asserts the state it wants; `changed: []` is how it
  // tells "already so" from "applied", without having to treat it as a failure.
  const same = ask(h, LIVE_UPDATE, 'r3', { jobId: created.data.id, schedule: '5m', prompt: 'x' });
  assert.equal(same.success, true);
  assert.deepEqual(same.data.changed, []);
  h.handlers.get('session_shutdown')();
});

test('update and run name the id they could not find instead of failing silently', async () => {
  const h = await started();
  assert.match(ask(h, LIVE_UPDATE, 'r1', { jobId: 'nope', schedule: '5m' }).error, /No live loop with id "nope"/);
  assert.match(ask(h, LIVE_RUN, 'r2', { jobId: 'nope' }).error, /No live loop with id "nope"/);
  h.handlers.get('session_shutdown')();
});

test('a paused loop comes back paused from the session store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-paused-'));
  const sessionId = 'session-paused';
  fs.mkdirSync(path.join(dir, '.pi', 'loops'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.pi', 'loops', `${sessionId}.json`),
    JSON.stringify({
      version: 1,
      loops: [
        {
          id: 'held',
          prompt: 'check the deploy',
          mode: 'fixed',
          intervalMs: 300_000,
          createdAt: Date.now() - 60_000,
          expiresAt: Date.now() + 86_400_000,
          runs: 2,
          paused: true,
        },
      ],
    })
  );

  const h = harness({ cwd: dir, sessionId });
  await h.handlers.get('session_start')({}, h.ctx);

  // Restoring a paused loop must not resume it: the store recorded a decision,
  // and a session restart is not a request to undo it.
  assert.equal(h.statuses.get('loop'), '◷ 1 loop · paused');
  assert.deepEqual(h.sent, []);
  h.handlers.get('session_shutdown')();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a paused self-paced loop is not settled away, and gains no fallback wakeup', async () => {
  const h = await started();
  await run(h, 'check the deploy');            // self-paced: fires immediately
  const id = /Loop (\S+) armed/.exec(h.notices.at(-1).message)?.[1];

  ask(h, LIVE_UPDATE, 'r1', { jobId: id, paused: true });
  h.sent.length = 0;

  // A settle is what turns a silent dynamic turn into a grace wakeup or the end
  // of the loop. A paused loop was told to stop, so it must get neither: no
  // countdown for a loop that cannot fire, and no ending of a loop only held.
  h.handlers.get('agent_settled')({}, h.ctx);
  h.handlers.get('agent_settled')({}, h.ctx);

  assert.equal(h.statuses.get('loop'), '◷ 1 loop · paused');
  assert.equal(ask(h, LIVE_LIST, 'r2').data.jobs[0].paused, true);
  h.handlers.get('session_shutdown')();
});

test('a paused cold job reads as paused, not as one mid-fire', async () => {
  const h = harness();
  await h.handlers.get('session_start')({}, h.ctx);
  // Announced the way the scheduler announces a restored job: `enabled: false`
  // travels with it, because a paused row is a fact and not an absence.
  h.bus.emit('subagents:scheduled', { type: 'added', job: coldJob({ enabled: false, nextRun: undefined }) });
  assert.equal(h.statuses.get('loop'), '◷ 1 job · paused');
  h.handlers.get('session_shutdown')();
});

test('run-now is an extra iteration, so the armed slot still fires', async () => {
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '25m', prompt: 'Still alive.' });

  // Push the armed slot into the future, then fire by hand: without the
  // manual-run flag, `nextFixedRun` would advance from this fire and swallow the
  // 25m slot entirely.
  ask(h, LIVE_UPDATE, 'r2', { jobId: created.data.id, schedule: '30m' });
  ask(h, LIVE_RUN, 'r3', { jobId: created.data.id });
  h.handlers.get('turn_end')({}, h.ctx);
  assert.deepEqual(h.sent, ['Still alive.']);

  const after = ask(h, LIVE_LIST, 'r4').data.jobs[0];
  const remaining = after.nextAt - Date.now();
  assert.ok(
    remaining > 24 * 60_000 && remaining <= 30 * 60_000,
    `the 30m slot must survive a manual fire, got ${Math.round(remaining / 60000)}m`
  );
  h.handlers.get('session_shutdown')();
});

test('ScheduleWakeup cannot pace a paused loop back to life', async () => {
  const h = await started();
  await run(h, 'check the deploy');
  const id = /Loop (\S+) armed/.exec(h.notices.at(-1).message)?.[1];
  ask(h, LIVE_UPDATE, 'r1', { jobId: id, paused: true });

  const result = await tool(h).execute('call-1', { delaySeconds: 600, reason: 'keep going' });

  assert.match(result.content[0].text, /is paused/);
  assert.match(result.content[0].text, /action: "resume"/);
  assert.equal(ask(h, LIVE_LIST, 'r2').data.jobs[0].nextAt, undefined);
  assert.equal(h.statuses.get('loop'), '◷ 1 loop · paused');
  h.handlers.get('session_shutdown')();
});

// ── Missed fires, waiting fires, history and the failure policy ─────────────

test('a fire held behind a busy session is reported as due, then fires late with its skipped slots counted', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const h = await started();
  const created = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'check the deploy' });
  t.mock.timers.tick(1000);
  assert.equal(h.sent.length, 1, 'the first fire runs as soon as the session is idle');

  h.ctx.isIdle = () => false;
  t.mock.timers.tick(16 * 60_000);
  assert.equal(h.sent.length, 1, 'nothing fires mid-turn');
  assert.match(h.statuses.get('loop'), /1 due · waiting for idle/);
  const waiting = ask(h, LIVE_LIST, 'r2').data.jobs[0];
  assert.equal(waiting.waitingForIdle, true);
  assert.equal(waiting.dueSince, 300_000);

  h.ctx.isIdle = () => true;
  t.mock.timers.tick(1000);
  assert.equal(h.sent.length, 2, 'one late fire, not a burst');
  const job = ask(h, LIVE_LIST, 'r3').data.jobs[0];
  assert.equal(job.skipped, 2, 'the +10m and +15m slots passed unfired');
  assert.equal(job.history.at(-1).skipped, 2);
  assert.ok(job.history.at(-1).lateMs >= 11 * 60_000);
  assert.equal(job.nextAt, 1_200_000, 'next fire is the +20m slot on the original phase');
  assert.ok(h.notices.some((n) => n.message.includes(`Loop ${created.data.id}`) && /skipped 2 slots/.test(n.message)));
  h.handlers.get('session_shutdown')();
});

test('a fire records what its run said, and an error in a later turn of the same fire sticks', async () => {
  const h = await started();
  const { data } = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'check the deploy', pauseAfterFailures: 0 });
  ask(h, LIVE_RUN, 'r1b', { jobId: data.id });
  h.handlers.get('turn_end')({}, h.ctx); // delivers the queued fire
  h.handlers.get('turn_end')({ message: { stopReason: 'toolUse', content: [{ type: 'toolCall' }] } }, h.ctx);
  h.handlers.get('turn_end')(
    { message: { stopReason: 'stop', content: [{ type: 'text', text: 'Deploy is green.\n2 new warnings.' }] } },
    h.ctx,
  );
  let entry = ask(h, LIVE_LIST, 'r2').data.jobs[0].history.at(-1);
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.summary, 'Deploy is green. 2 new warnings.');

  h.handlers.get('turn_end')({ message: { stopReason: 'error' } }, h.ctx);
  entry = ask(h, LIVE_LIST, 'r3').data.jobs[0].history.at(-1);
  assert.equal(entry.outcome, 'error');
  assert.equal(entry.summary, 'Deploy is green. 2 new warnings.', 'the last thing it said survives the error');
  h.handlers.get('session_shutdown')();
});

test('a loop that keeps failing pauses itself, and resume gives it a fresh count', async () => {
  const h = await started();
  const { data } = ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'check the deploy', pauseAfterFailures: 2 });
  let n = 0;
  const failedFire = () => {
    ask(h, LIVE_RUN, `run${++n}`, { jobId: data.id });
    h.handlers.get('turn_end')({}, h.ctx); // delivers the queued fire
    h.handlers.get('turn_end')({ message: { stopReason: 'error' } }, h.ctx);
    h.handlers.get('agent_settled')({}, h.ctx);
  };

  failedFire();
  assert.equal(ask(h, LIVE_LIST, 'r2').data.jobs[0].paused, false, 'one failure is not a pattern');
  failedFire();

  const paused = ask(h, LIVE_LIST, 'r4').data.jobs[0];
  assert.equal(paused.paused, true);
  assert.equal(paused.pausedReason, 'paused after 2 failed fires in a row');
  assert.equal(paused.nextAt, undefined, 'it stops billing');
  assert.ok(h.notices.some((n) => n.level === 'warning' && n.message.includes('paused after 2 failed fires')));

  const resumed = ask(h, LIVE_UPDATE, 'r5', { jobId: data.id, paused: false }).data.job;
  assert.equal(resumed.pausedReason, undefined);
  assert.equal(resumed.failureStreak, 0);
  h.handlers.get('session_shutdown')();
});

test('a resumed session lands back on its phase and counts the fires it slept through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-phase-'));
  const sessionId = 'session-phase';
  const now = Date.now();
  fs.mkdirSync(path.join(dir, '.pi', 'loops'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.pi', 'loops', `${sessionId}.json`),
    JSON.stringify({
      version: 1,
      loops: [
        {
          id: 'slept',
          prompt: 'p',
          mode: 'fixed',
          intervalMs: 300_000,
          createdAt: now - 3_600_000,
          expiresAt: now + 86_400_000,
          runs: 3,
          nextAt: now - 720_000,
        },
      ],
    }),
  );
  const h = await started({ cwd: dir, sessionId });
  const job = ask(h, LIVE_LIST, 'r1').data.jobs[0];
  // Slots at -12m, -7m and -2m passed with the session closed; the next is +3m.
  assert.equal(job.skipped, 3);
  assert.equal(job.nextAt, now - 720_000 + 900_000);
  assert.deepEqual(h.sent, [], 'still no catch-up burst');
  assert.ok(h.notices.some((n) => n.message.includes('slept (3)')));
  h.handlers.get('session_shutdown')();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bounded loop outlives the 7-day TTL, because it already has an end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-bounded-'));
  const sessionId = 'session-bounded';
  const now = Date.now();
  fs.mkdirSync(path.join(dir, '.pi', 'loops'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.pi', 'loops', `${sessionId}.json`),
    JSON.stringify({
      version: 1,
      loops: [
        { id: 'bounded', prompt: 'p', mode: 'fixed', intervalMs: 86_400_000, createdAt: now - 8 * 86_400_000, expiresAt: now - 86_400_000, runs: 8, until: now + 7 * 86_400_000 },
        { id: 'unbounded', prompt: 'p', mode: 'fixed', intervalMs: 86_400_000, createdAt: now - 8 * 86_400_000, expiresAt: now - 86_400_000, runs: 8 },
      ],
    }),
  );
  const h = await started({ cwd: dir, sessionId });
  const jobs = ask(h, LIVE_LIST, 'r1').data.jobs;
  assert.deepEqual(jobs.map((job) => job.id), ['bounded']);
  assert.equal(jobs[0].expiresAt, undefined, 'a bounded loop reports no TTL it will not hit');
  h.handlers.get('session_shutdown')();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the loop store ignores itself, so per-session state never reaches a commit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-loop-ignore-'));
  const h = await started({ cwd: dir, sessionId: 'session-ignore' });
  ask(h, LIVE_CREATE, 'r1', { schedule: '5m', prompt: 'p' });
  assert.equal(fs.readFileSync(path.join(dir, '.pi', 'loops', '.gitignore'), 'utf8').trim().split('\n').at(-1), '*');
  h.handlers.get('session_shutdown')();
  fs.rmSync(dir, { recursive: true, force: true });
});
