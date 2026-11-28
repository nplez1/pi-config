import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ext = await import(
  fileURLToPath(new URL('../dot-pi/agent/extensions/message-timestamps.ts', import.meta.url))
);
const { default: register, formatStamp } = ext;

const FAINT = '\x1b[90m';
const FAINT_OFF = '\x1b[39m';

/** The host surface the extension touches: two registrations and one event. */
function fakePi() {
  const handlers = new Map();
  let transformer;
  let options;
  register({
    on: (name, fn) => handlers.set(name, fn),
    registerMarkdownTransformer: (fn, opts) => {
      transformer = fn;
      options = opts;
    },
  });
  return {
    transformer,
    options,
    messageStart: (role, timestamp) => handlers.get('message_start')?.({ message: { role, timestamp } }),
  };
}

test('stamps the transcript surfaces only, so a thinking block keeps its own label', async () => {
  assert.deepEqual(fakePi().options.messageTypes, ['user', 'assistant']);
});

test('a restored message is stamped from its session entry timestamp', async () => {
  const { transformer } = fakePi();
  const timestamp = new Date(2026, 10, 27, 12, 53).toISOString();
  const out = transformer('the gate is green', {
    messageType: 'user',
    isStreaming: false,
    availableWidth: 80,
    messageId: 'a1',
    timestamp,
  });
  assert.equal(out, `${FAINT}11/27 12:53pm${FAINT_OFF}\n\nthe gate is green`);
});

test('a live message keeps the clock message_start recorded, not the render time', async () => {
  const { transformer, messageStart } = fakePi();
  messageStart('assistant', new Date(2026, 10, 27, 8, 4).getTime());
  // Every streaming repaint and every width change must show the same stamp; a
  // label that drifted while the reply streamed would be worse than none.
  for (const markdown of ['part', 'part one, two', 'part one, two, three']) {
    assert.equal(
      transformer(markdown, { messageType: 'assistant', isStreaming: true, availableWidth: 80 }),
      `${FAINT}11/27 8:04am${FAINT_OFF}\n\n${markdown}`,
    );
  }
});

test('a message painted before its own message_start stamps itself', async () => {
  const { transformer } = fakePi();
  const out = transformer('hello', { messageType: 'user', isStreaming: false, availableWidth: 80 });
  assert.equal(out, `${FAINT}${formatStamp(Date.now())}${FAINT_OFF}\n\nhello`);
});

test('an empty message is left alone rather than given a stamp on a blank line', async () => {
  const { transformer } = fakePi();
  assert.equal(transformer('   ', { messageType: 'assistant', isStreaming: false, availableWidth: 80 }), '   ');
});

test('the clock is 12-hour with the date, and names the year only when it is not this one', async () => {
  const now = new Date(2026, 10, 27, 18, 0).getTime();
  assert.equal(formatStamp(new Date(2026, 10, 27, 0, 5).getTime(), now), '11/27 12:05am');
  assert.equal(formatStamp(new Date(2026, 10, 27, 12, 0).getTime(), now), '11/27 12:00pm');
  assert.equal(formatStamp(new Date(2026, 10, 27, 9, 7).getTime(), now), '11/27 9:07am');
  assert.equal(formatStamp(new Date(2025, 10, 27, 12, 53).getTime(), now), '25/11/27 12:53pm');
  assert.equal(formatStamp(Number.NaN), '');
});
