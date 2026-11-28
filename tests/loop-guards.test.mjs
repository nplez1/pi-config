import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Exercise the real extension source. Its only import is type-only, so bare Node
// (type stripping) loads it as-is.
const ext = await import(
  fileURLToPath(new URL('../dot-pi/agent/extensions/loop-guards.ts', import.meta.url))
);
const { default: register, parseLeadingSleep, guardSleep, shouldForceSubagentWait, MAX_SLEEP_SECONDS, MAX_BARE_SLEEP_SECONDS } = ext;

function fakePi() {
  const handlers = {};
  const commands = {};
  const notes = [];
  const pi = {
    on: (name, fn) => {
      (handlers[name] ??= []).push(fn);
    },
    registerCommand: (name, spec) => (commands[name] = spec),
  };
  register(pi);
  const ctx = { ui: { notify: (text, type) => notes.push({ text, type }) } };
  // Handlers chain, mirroring pi's composition: later handlers see earlier mutations.
  const call = (name, event) => {
    for (const fn of handlers[name] ?? []) fn(event, ctx);
    return event;
  };
  return { handlers, commands, notes, ctx, call };
}

const bashCall = (command, id = 'call_1') => ({ type: 'tool_call', toolName: 'bash', toolCallId: id, input: { command } });

// ── parsing ────────────────────────────────────────────────────────────────

test('parseLeadingSleep: forms seen in real transcripts', () => {
  assert.deepEqual(parseLeadingSleep('sleep 900; echo checked'), { seconds: 900, rest: 'echo checked', prefix: '' });
  assert.deepEqual(parseLeadingSleep('sleep 295; cd /tmp && ls'), { seconds: 295, rest: 'cd /tmp && ls', prefix: '' });
  assert.deepEqual(parseLeadingSleep('sleep 210\nTOKEN="x"'), { seconds: 210, rest: 'TOKEN="x"', prefix: '' });
  assert.deepEqual(parseLeadingSleep('sleep 420;cd /x'), { seconds: 420, rest: 'cd /x', prefix: '' });
  assert.deepEqual(parseLeadingSleep('sleep 5m; pnpm tc'), { seconds: 300, rest: 'pnpm tc', prefix: '' });
  assert.deepEqual(parseLeadingSleep('sleep 1.5; x'), { seconds: 1.5, rest: 'x', prefix: '' });
  assert.deepEqual(parseLeadingSleep('sleep 900'), { seconds: 900, rest: '', prefix: '' });
});

test('parseLeadingSleep: a sleep behind no-op prefixes is still the leading statement', () => {
  // The 2026-11-24 release session: 17 of 17 sleeps looked like this and the guard never fired.
  assert.deepEqual(parseLeadingSleep('cd /Volumes/Storage/Code/orca/main && sleep 480; git status --porcelain | head -8'), {
    seconds: 480,
    rest: 'git status --porcelain | head -8',
    prefix: 'cd /Volumes/Storage/Code/orca/main && ',
  });
  assert.deepEqual(parseLeadingSleep('cd /tmp; sleep 60'), { seconds: 60, rest: '', prefix: 'cd /tmp; ' });
  assert.deepEqual(parseLeadingSleep('set -e; sleep 90; pnpm tc'), { seconds: 90, rest: 'pnpm tc', prefix: 'set -e; ' });
  assert.deepEqual(parseLeadingSleep('ORCA_QUEUE=off && sleep 45; pnpm test'), {
    seconds: 45,
    rest: 'pnpm test',
    prefix: 'ORCA_QUEUE=off && ',
  });
  assert.deepEqual(parseLeadingSleep('export A=1 && sleep 30'), { seconds: 30, rest: '', prefix: 'export A=1 && ' });
  assert.deepEqual(parseLeadingSleep('true && sleep 30'), { seconds: 30, rest: '', prefix: 'true && ' });
});

test('parseLeadingSleep: two prefixes chain, and the prefix is reproduced verbatim', () => {
  assert.deepEqual(parseLeadingSleep('cd /repo && set -e; sleep 300; git status'), {
    seconds: 300,
    rest: 'git status',
    prefix: 'cd /repo && set -e; ',
  });
  assert.deepEqual(parseLeadingSleep('cd "/a b" && A=1 B=2 && sleep 300; ls'), {
    seconds: 300,
    rest: 'ls',
    prefix: 'cd "/a b" && A=1 B=2 && ',
  });
});

test('parseLeadingSleep: leaves embedded sleeps alone', () => {
  // Not the leading statement: part of a program, not a stand-in for a wait.
  assert.equal(parseLeadingSleep('for i in $(seq 3); do sleep 2; done'), null);
  assert.equal(parseLeadingSleep('cd /tmp && ls && sleep 900'), null);
  assert.equal(parseLeadingSleep('cd /tmp && for i in 1 2; do sleep 2; done'), null);
  assert.equal(parseLeadingSleep('pnpm tc; sleep 5'), null);
  assert.equal(parseLeadingSleep('echo sleep 900'), null);
  assert.equal(parseLeadingSleep(''), null);
});

test('parseLeadingSleep: a wrapped sleep is a program, not a wait', () => {
  // Unwrapping these would rewrite the inside of something that owns its own timing.
  assert.equal(parseLeadingSleep('timeout 60 sleep 900'), null);
  assert.equal(parseLeadingSleep('bash -c "sleep 900"'), null);
  assert.equal(parseLeadingSleep('cd /repo && timeout 60 sleep 900'), null);
  assert.equal(parseLeadingSleep('FOO=1 sleep 900'), null);
});

// ── verdicts ───────────────────────────────────────────────────────────────

test('guardSleep: short sleeps are allowed untouched', () => {
  assert.deepEqual(guardSleep('sleep 2; curl -s localhost'), { action: 'allow' });
  assert.deepEqual(guardSleep(`sleep ${MAX_BARE_SLEEP_SECONDS}`), { action: 'allow' });
  assert.deepEqual(guardSleep(`sleep ${MAX_SLEEP_SECONDS}; pnpm tc`), { action: 'allow' });
  assert.deepEqual(guardSleep('pnpm tc'), { action: 'allow' });
});

test('guardSleep: a long bare sleep is blocked with an actionable reason', () => {
  const v = guardSleep('sleep 900');
  assert.equal(v.action, 'block');
  assert.match(v.reason, /wait: true/);
  assert.match(v.reason, /bounded poll/);
});

test('guardSleep: a long sleep gating real work is clamped, keeping the work', () => {
  const v = guardSleep('sleep 900; cd /repo && pnpm tc');
  assert.equal(v.action, 'rewrite');
  assert.equal(v.command, `sleep ${MAX_SLEEP_SECONDS}; cd /repo && pnpm tc`);
  assert.match(v.note, /clamped/);
});

test('guardSleep: clamping preserves the newline form', () => {
  const v = guardSleep('sleep 600\ngh api /repos/x');
  assert.equal(v.action, 'rewrite');
  assert.equal(v.command, `sleep ${MAX_SLEEP_SECONDS}; gh api /repos/x`);
});

test('guardSleep: sub-120s sleep in front of work is not clamped', () => {
  assert.deepEqual(guardSleep('sleep 90; pnpm tc'), { action: 'allow' });
});

test('guardSleep: a prefixed sleep is clamped and the prefix still runs', () => {
  const v = guardSleep('cd /Volumes/Storage/Code/orca/main && sleep 480; git status --porcelain | head -8');
  assert.equal(v.action, 'rewrite');
  assert.equal(
    v.command,
    `cd /Volumes/Storage/Code/orca/main && sleep ${MAX_SLEEP_SECONDS}; git status --porcelain | head -8`,
  );
  assert.match(v.note, /clamped/);
});

test('guardSleep: two prefixes are reproduced in order around the clamp', () => {
  const v = guardSleep('cd /repo && set -e; sleep 300; pnpm tc');
  assert.equal(v.action, 'rewrite');
  assert.equal(v.command, `cd /repo && set -e; sleep ${MAX_SLEEP_SECONDS}; pnpm tc`);
});

test('guardSleep: a prefixed bare sleep is blocked like an unprefixed one', () => {
  const v = guardSleep('cd /repo && sleep 480');
  assert.equal(v.action, 'block');
  assert.match(v.reason, /nothing follows it/);
});

test('guardSleep: a wrapped sleep is left alone', () => {
  assert.deepEqual(guardSleep('cd /repo && timeout 900 sleep 900'), { action: 'allow' });
  assert.deepEqual(guardSleep('bash -c "sleep 900"'), { action: 'allow' });
});

// ── subagent polling ───────────────────────────────────────────────────────

test('shouldForceSubagentWait: a poll for a named agent is forced to wait', () => {
  assert.equal(shouldForceSubagentWait({ agent_id: 'abc' }), true);
  assert.equal(shouldForceSubagentWait({ agent_id: 'abc', verbose: false, wait: false }), true);
  assert.equal(shouldForceSubagentWait({ agentId: 'abc' }), true);
});

test('shouldForceSubagentWait: waits, fleet listings, and empty ids are left alone', () => {
  assert.equal(shouldForceSubagentWait({ agent_id: 'abc', wait: true }), false);
  assert.equal(shouldForceSubagentWait({}), false);
  assert.equal(shouldForceSubagentWait(undefined), false);
  assert.equal(shouldForceSubagentWait({ agent_id: '' }), false);
  assert.equal(shouldForceSubagentWait({ wait: false }), false);
});

// ── handler wiring ─────────────────────────────────────────────────────────

test('tool_call: a clamped command reaches execution clamped', () => {
  const p = fakePi();
  const event = p.call('tool_call', bashCall('sleep 900; pnpm tc'));
  assert.equal(event.input.command, `sleep ${MAX_SLEEP_SECONDS}; pnpm tc`);
  assert.equal(event.block, undefined);
});

test('tool_call: the measured `cd … && sleep N; …` shape is clamped in place', () => {
  const p = fakePi();
  const event = p.call('tool_call', bashCall('cd /Volumes/Storage/Code/orca/main && sleep 480; git status --porcelain | head -8'));
  assert.equal(
    event.input.command,
    `cd /Volumes/Storage/Code/orca/main && sleep ${MAX_SLEEP_SECONDS}; git status --porcelain | head -8`,
  );
});

test('tool_call: a bare sleep is blocked before execution', () => {
  const p = fakePi();
  const out = (p.handlers.tool_call[0])(bashCall('sleep 900'), p.ctx);
  assert.equal(out.block, true);
});

test('tool_call: an ordinary command is untouched', () => {
  const p = fakePi();
  const event = p.call('tool_call', bashCall('git status --short'));
  assert.equal(event.input.command, 'git status --short');
});

test('tool_call: a subagent poll is rewritten to wait in place', () => {
  const p = fakePi();
  const event = {
    type: 'tool_call',
    toolName: 'get_subagent_result',
    toolCallId: 'call_9',
    input: { agent_id: 'a1', wait: false },
  };
  p.call('tool_call', event);
  assert.equal(event.input.wait, true);
});

test('tool_result: the clamp note rides on the result the model reads next', () => {
  const p = fakePi();
  p.call('tool_call', bashCall('sleep 900; pnpm tc', 'call_7'));
  const out = (p.handlers.tool_result[0])(
    {
      type: 'tool_result',
      toolName: 'bash',
      toolCallId: 'call_7',
      input: {},
      content: [{ type: 'text', text: 'TYPECHECK_EXIT:0' }],
      isError: false,
    },
    p.ctx,
  );
  assert.equal(out.content.length, 1);
  assert.match(out.content[0].text, /^TYPECHECK_EXIT:0/);
  assert.match(out.content[0].text, /\[loop-guards\] .*clamped/);
});

test('tool_result: the note is consumed once, so a replayed id does not get it twice', () => {
  const p = fakePi();
  p.call('tool_call', bashCall('sleep 900; pnpm tc', 'call_8'));
  const result = {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: 'call_8',
    input: {},
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  };
  assert.ok((p.handlers.tool_result[0])(result, p.ctx));
  assert.equal((p.handlers.tool_result[0])(result, p.ctx), undefined);
});

test('tool_result: a bash result with no note is left alone', () => {
  const p = fakePi();
  const out = (p.handlers.tool_result[0])(
    { type: 'tool_result', toolName: 'bash', toolCallId: 'nope', input: {}, content: [], isError: false },
    p.ctx,
  );
  assert.equal(out, undefined);
});

test('before_agent_start: the standing rule is added once and it is idempotent', () => {
  const p = fakePi();
  const options = { promptGuidelines: [] };
  (p.handlers.before_agent_start[0])({ systemPromptOptions: options }, p.ctx);
  (p.handlers.before_agent_start[0])({ systemPromptOptions: options }, p.ctx);
  assert.equal(options.promptGuidelines.length, 1);
  assert.match(options.promptGuidelines[0], /sleep/);
});

test('command: /loop-guards reports the counters', async () => {
  const p = fakePi();
  await p.commands['loop-guards'].handler('', p.ctx);
  assert.match(p.notes.at(-1).text, /no guards fired/);

  (p.handlers.tool_call[0])(bashCall('sleep 900'), p.ctx);
  await p.commands['loop-guards'].handler('', p.ctx);
  assert.match(p.notes.at(-1).text, /1 bare sleep\(s\) blocked/);
});
