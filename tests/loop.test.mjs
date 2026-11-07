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
fs.cpSync(extension, path.join(root, 'loop.ts'));
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
      { mode: 'fixed', nextAt: now + 270_000, quietStreak: 0 },
      { mode: 'fixed', nextAt: now + 60_000, quietStreak: 0 },
    ],
    now
  );
  assert.equal(footer, '◷ 2 loops · next in 1m');
});

test('footer says "running" while a dynamic loop awaits its wakeup', () => {
  const footer = loop.formatFooter([{ mode: 'dynamic', nextAt: undefined, quietStreak: 0 }], 1_000_000);
  assert.equal(footer, '◷ 1 loop · running');
});

test('footer surfaces a quiet streak only once it is worth mentioning', () => {
  const now = 1_000_000;
  const view = (quietStreak) => ({ mode: 'dynamic', nextAt: now + 60_000, quietStreak });
  assert.equal(loop.formatFooter([view(1)], now), '◷ 1 loop · next in 1m');
  assert.equal(loop.formatFooter([view(3)], now), '◷ 1 loop · next in 1m · quiet ×3');
});

test('footer clamps a past-due next run to zero rather than going negative', () => {
  const now = 1_000_000;
  assert.equal(loop.formatFooter([{ mode: 'fixed', nextAt: now - 5_000, quietStreak: 0 }], now), '◷ 1 loop · next in 0s');
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

function harness() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const statuses = new Map();
  const notices = [];
  const sent = [];

  const ctx = {
    cwd: root,
    hasUI: true,
    isIdle: () => true,
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      notify: (message, level) => notices.push({ message, level }),
    },
  };

  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, options) => commands.set(name, options),
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: (content) => sent.push(content),
  };

  loop.default(pi);
  return { tools, commands, handlers, statuses, notices, sent, ctx, pi };
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
  assert.match(h.notices[0].message, /^◷ [a-z0-9]+ · every 30m · next in 30m · runs 1 · expires in 7d · "sweep the queue"$/);
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
