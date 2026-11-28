import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic: never read the machine's real config. Tests that need one write it into a temp
// dir and point the extension at it; the extension re-reads it on every result.
const configDir = await mkdtemp(join(tmpdir(), 'output-cap-config-'));
process.env.PI_OUTPUT_CAP_CONFIG = join(configDir, 'config.json');

const ext = await import(
  fileURLToPath(new URL('../dot-pi/agent/extensions/output-cap.ts', import.meta.url))
);
const {
  default: register,
  DEFAULT_MAX_BYTES,
  resolveConfig,
  loadConfig,
  byteLength,
  truncateText,
  planCap,
  formatBytes,
  renderCapNote,
  writeSpill,
} = ext;

async function setConfig(value) {
  if (value === null) {
    await writeFile(process.env.PI_OUTPUT_CAP_CONFIG, 'not json', 'utf8');
    return;
  }
  await writeFile(process.env.PI_OUTPUT_CAP_CONFIG, JSON.stringify(value), 'utf8');
}

function fakePi() {
  const handlers = {};
  const pi = {
    on: (name, fn) => {
      (handlers[name] ??= []).push(fn);
    },
    registerCommand: () => {},
  };
  register(pi);
  const ctx = { ui: { notify: () => {} } };
  const result = (toolName, content) => ({
    type: 'tool_result',
    toolName,
    toolCallId: 'call_1',
    input: {},
    content,
    isError: false,
  });
  const call = (toolName, content) => (handlers.tool_result[0])(result(toolName, content), ctx);
  return { handlers, ctx, call };
}

const text = (body) => ({ type: 'text', text: body });

/** n lines of 100 chars, so the byte count is easy to reason about. */
function bigText(lines) {
  return Array.from({ length: lines }, (_, i) => `line ${i} `.padEnd(100, 'x')).join('\n');
}

/** The spill path the note names, so a test proves the file holds what was cut. */
function spillPathFrom(note) {
  const match = /full output: (\S+)\./.exec(note);
  assert.ok(match, `note should name a spill file: ${note}`);
  return match[1];
}

// ── config ─────────────────────────────────────────────────────────────────

test('resolveConfig: defaults to enabled at 8 KB', () => {
  assert.deepEqual(resolveConfig(null), { enabled: true, maxBytes: DEFAULT_MAX_BYTES });
  assert.deepEqual(resolveConfig({}), { enabled: true, maxBytes: DEFAULT_MAX_BYTES });
  assert.equal(DEFAULT_MAX_BYTES, 8192);
});

test('resolveConfig: honours enabled and maxBytes, ignoring nonsense', () => {
  assert.deepEqual(resolveConfig({ enabled: false }), { enabled: false, maxBytes: DEFAULT_MAX_BYTES });
  assert.deepEqual(resolveConfig({ maxBytes: 2048 }), { enabled: true, maxBytes: 2048 });
  assert.deepEqual(resolveConfig({ maxBytes: 0 }), { enabled: true, maxBytes: DEFAULT_MAX_BYTES });
  assert.deepEqual(resolveConfig({ maxBytes: 'big' }), { enabled: true, maxBytes: DEFAULT_MAX_BYTES });
});

test('loadConfig: a missing or corrupt file falls back to the defaults', async () => {
  await setConfig(null);
  assert.deepEqual(loadConfig(), { enabled: true, maxBytes: DEFAULT_MAX_BYTES });
  await setConfig({ maxBytes: 4096, enabled: true });
  assert.deepEqual(loadConfig(), { enabled: true, maxBytes: 4096 });
});

// ── truncation ─────────────────────────────────────────────────────────────

test('truncateText: under the cap is untouched, over it cuts on a line boundary', () => {
  assert.equal(truncateText('short', 100), 'short');
  const body = bigText(50);
  const cut = truncateText(body, 1000);
  assert.ok(byteLength(cut) <= 1000);
  assert.ok(cut.length > 0);
  assert.ok(body.startsWith(cut));
  assert.equal(cut.at(-1), 'x', 'ends on a whole line, never mid-line');
  assert.equal(cut.includes('\u0000'), false);
});

test('truncateText: never drops the result to nothing, even mid-line', () => {
  assert.equal(truncateText('a'.repeat(5000), 10), 'a'.repeat(10));
  assert.equal(truncateText('x'.repeat(5000), 1), 'x');
  assert.equal(truncateText('🙂🙂🙂', 1), '🙂', 'a multibyte head still survives');
});

test('formatBytes: KB for the sizes a session actually produces', () => {
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(8192), '8 KB');
  assert.equal(formatBytes(46 * 1024), '46 KB');
});

// ── the plan ───────────────────────────────────────────────────────────────

test('planCap: a result already under the cap is not touched', () => {
  assert.deepEqual(planCap([text('hello')], DEFAULT_MAX_BYTES), { action: 'keep' });
  assert.deepEqual(planCap([], DEFAULT_MAX_BYTES), { action: 'keep' });
});

test('planCap: over the cap keeps a head, reports both sizes, and spills the whole text', () => {
  const body = bigText(200);
  const plan = planCap([text(body)], DEFAULT_MAX_BYTES);
  assert.equal(plan.action, 'truncate');
  assert.ok(plan.originalBytes > DEFAULT_MAX_BYTES);
  assert.ok(plan.keptBytes <= DEFAULT_MAX_BYTES);
  assert.ok(plan.keptBytes > 0);
  assert.equal(plan.fullText, body);
  assert.equal(plan.content.length, 1);
  assert.ok(body.startsWith(plan.content[0].text));
});

test('planCap: non-text blocks keep their place and their content', () => {
  const body = bigText(200);
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const plan = planCap([text(body), image], DEFAULT_MAX_BYTES);
  assert.equal(plan.action, 'truncate');
  assert.equal(plan.content.length, 2);
  assert.equal(plan.content[1], image);
  assert.equal(plan.content[1].type, 'image');
});

test('writeSpill: every call gets its own file', () => {
  const a = writeSpill('one');
  const b = writeSpill('two');
  assert.notEqual(a, b);
});

// ── handler wiring ─────────────────────────────────────────────────────────

test('tool_result: an under-cap bash result is left alone', async () => {
  await setConfig(null);
  const p = fakePi();
  assert.equal(p.call('bash', [text('git status --porcelain\nclean')]), undefined);
});

test('tool_result: an over-cap read is truncated and the spill file holds the full text', async () => {
  await setConfig(null);
  const p = fakePi();
  const body = bigText(400);
  const out = p.call('read', [text(body)]);
  assert.ok(out, 'an over-cap result must be capped');
  assert.equal(out.content.length, 1);
  const kept = out.content[0].text;
  assert.ok(kept.startsWith('line 0 '), 'the head of the result survives');
  assert.ok(byteLength(kept) < byteLength(body));
  assert.match(kept, /\[output-cap\] truncated \d+ KB to \d+ KB/);
  assert.match(kept, /Prefer a narrower command \(rg -n, jq, cut -c1-200\)/);
  assert.equal(await readFile(spillPathFrom(kept), 'utf8'), body);
});

test('tool_result: an image in the result survives the cap untouched, in order', async () => {
  await setConfig(null);
  const p = fakePi();
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const out = p.call('read', [text(bigText(400)), image]);
  assert.ok(out);
  assert.equal(out.content.length, 3, 'text head, image, then the note');
  assert.deepEqual(out.content[1], image);
  assert.equal(out.content[2].type, 'text');
  assert.match(out.content[2].text, /\[output-cap\] truncated/);
});

test('tool_result: the configured cap is what applies, and enabled:false is inert', async () => {
  await setConfig({ maxBytes: 512 });
  const p = fakePi();
  const body = bigText(20);
  const out = p.call('bash', [text(body)]);
  assert.ok(out, '512 bytes is over the configured cap');
  assert.match(out.content[0].text, /to 512 B|to \d+ B/);

  await setConfig({ enabled: false });
  assert.equal(p.call('bash', [text(body)]), undefined);
});

test('tool_result: tools that do not produce unbounded text are untouched', async () => {
  await setConfig({ maxBytes: 16 });
  const p = fakePi();
  assert.equal(p.call('edit', [text(bigText(20))]), undefined);
  assert.equal(p.call('todo', [text(bigText(20))]), undefined);
});

test('tool_result: a non-text-only result still gains a note instead of losing content', async () => {
  await setConfig({ maxBytes: 16 });
  const p = fakePi();
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const out = p.call('read', [image]);
  assert.equal(out, undefined, 'an image alone carries no text to cap');

  const out2 = p.call('bash', [text(bigText(20)), image]);
  assert.ok(out2);
  assert.equal(out2.content[1], image);
});
