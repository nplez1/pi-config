import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Exercise the real extension source. Its only import is type-only, so bare Node
// (type stripping) loads it as-is.
const { default: register, omitInterruptedTail, isMarker } = await import(
  fileURLToPath(new URL('../dot-pi/agent/extensions/continue.ts', import.meta.url))
);

const user = (text = 'go') => ({ role: 'user', content: [{ type: 'text', text }] });
const reply = (stopReason = 'stop', content = [{ type: 'text', text: 'ok' }]) => ({
  role: 'assistant',
  stopReason,
  content,
});
const calls = (...ids) => ({
  role: 'assistant',
  stopReason: 'toolUse',
  content: ids.map((id) => ({ type: 'toolCall', id, name: 'bash', arguments: {} })),
});
const result = (toolCallId) => ({ role: 'toolResult', toolCallId, content: [] });
const marker = () => ({ role: 'custom', customType: 'continue-run', content: '', display: false });

function fakePi({ idle = true, messages = [] } = {}) {
  const handlers = {};
  const commands = {};
  const sent = [];
  const notes = [];
  const pi = {
    on: (name, fn) => (handlers[name] = fn),
    registerCommand: (name, spec) => (commands[name] = spec),
    sendMessage: (msg, opts) => sent.push({ msg, opts }),
  };
  const ctx = {
    isIdle: () => idle,
    sessionManager: { buildSessionProjection: () => ({ messages }) },
    ui: { notify: (text, type) => notes.push({ text, type }) },
  };
  register(pi);
  return { handlers, commands, sent, notes, ctx };
}

test('isMarker matches only the continue marker', () => {
  assert.equal(isMarker(marker()), true);
  assert.equal(isMarker({ role: 'custom', customType: 'other' }), false);
  assert.equal(isMarker(user()), false);
});

test('a completed or ordinary tail is kept as is', () => {
  const t = [user(), reply('stop')];
  assert.deepEqual(omitInterruptedTail(t), t);
  const pending = [user(), calls('a'), result('a')];
  assert.deepEqual(omitInterruptedTail(pending), pending);
  assert.deepEqual(omitInterruptedTail([user()]), [user()]);
});

test('an errored or aborted tail reply is omitted', () => {
  const head = [user()];
  assert.deepEqual(omitInterruptedTail([...head, reply('error')]), head);
  assert.deepEqual(omitInterruptedTail([...head, reply('aborted', [])]), head);
});

test('a tool call with no result is omitted with the results after it', () => {
  const head = [user()];
  assert.deepEqual(omitInterruptedTail([...head, calls('a', 'b'), result('a')]), head);
  assert.deepEqual(omitInterruptedTail([...head, calls('a')]), head);
});

test('context: no marker leaves the request untouched', () => {
  const { handlers } = fakePi();
  const t = [user(), reply('stop')];
  assert.equal(handlers.context({ messages: t }, {}), undefined);
});

test('context: a marker is stripped so the request is the transcript alone', () => {
  const { handlers } = fakePi();
  const out = handlers.context({ messages: [user(), reply('stop'), marker()] }, {});
  assert.deepEqual(out.messages, [user(), reply('stop')]);
});

test('context: a marker after a failed reply also drops that reply', () => {
  const { handlers } = fakePi();
  const out = handlers.context({ messages: [user(), reply('error'), marker()] }, {});
  assert.deepEqual(out.messages, [user()]);
});

test('context: a marker after a completed run keeps the later reply', () => {
  const { handlers } = fakePi();
  const out = handlers.context(
    { messages: [user(), reply('error'), marker(), reply('stop'), user('next')] },
    {},
  );
  assert.deepEqual(out.messages, [user(), reply('error'), reply('stop'), user('next')]);
});

test('command: refuses while the agent is busy', async () => {
  const p = fakePi({ idle: false, messages: [user()] });
  await p.commands.continue.handler('', p.ctx);
  assert.equal(p.sent.length, 0);
  assert.equal(p.notes[0].type, 'warning');
});

test('command: refuses an empty session', async () => {
  const p = fakePi({ messages: [] });
  await p.commands.continue.handler('', p.ctx);
  assert.equal(p.sent.length, 0);
  assert.equal(p.notes[0].type, 'info');
});

test('command: refuses when the last reply already completed', async () => {
  const p = fakePi({ messages: [user(), reply('stop')] });
  await p.commands.continue.handler('', p.ctx);
  assert.equal(p.sent.length, 0);
  assert.match(p.notes[0].text, /nothing to resume/);
});

test('command: an unanswered user message starts a hidden, empty run', async () => {
  const p = fakePi({ messages: [user('do the thing')] });
  await p.commands.continue.handler('', p.ctx);
  assert.equal(p.sent.length, 1);
  assert.deepEqual(p.sent[0].msg, { customType: 'continue-run', content: '', display: false });
  assert.deepEqual(p.sent[0].opts, { triggerTurn: true });
});

test('command: a session killed mid-tool-call still resumes', async () => {
  const p = fakePi({ messages: [user(), calls('a'), result('a')] });
  await p.commands.continue.handler('', p.ctx);
  assert.equal(p.sent.length, 1);
});

test('command: a previous marker is ignored when judging the last message', async () => {
  const p = fakePi({ messages: [user(), reply('stop'), marker()] });
  await p.commands.continue.handler('', p.ctx);
  assert.equal(p.sent.length, 0);
});
