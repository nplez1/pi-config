import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Exercise the real extension source. Its only import is type-only, so bare Node
// (type stripping) loads it as-is.
const ext = await import(
  fileURLToPath(new URL('../dot-pi/agent/extensions/toolcall-rescue.ts', import.meta.url))
);
const {
  default: register,
  assistantText,
  hasToolCalls,
  stripDsml,
  parseCalls,
  detectEnvelope,
  rescueFor,
  distance,
  suggestTool,
  renderRescue,
  RESCUE_REPLACEMENT,
  MAX_CONSECUTIVE_RESCUES,
} = ext;

// U+FF5C, DeepSeek's DSML wrapper character. Written as an escape so this file
// stays ASCII: the real replies wrap every tag in `<` + F F 5 C `DSML` F F 5 C.
const MARK = '\uff5c';
const dsml = (tag) => `<${MARK}DSML${MARK}${tag}`;

/**
 * The transcript exactly as one failing turn stored it (session
 * 2026-11-28T08-31-08, `isoquant` / `deepseek-v4.1-flash-1017-fast`,
 * `stopReason: "stop"`, zero tool calls). Degraded: no `function_calls` opener,
 * a stray `</parameter>`, and the tool name misspelled as `codemodode`.
 */
const OBSERVED =
  `\n${dsml('invoke name="codemodode" string="true">')}\n` +
  `${dsml('/parameter>')}\n` +
  `${dsml('/invoke>')}\n` +
  `${dsml('/calls>')}`;

/** The same failure with arguments, as the 2026-11-27 session stored it. */
const OBSERVED_WITH_ARGS =
  `\n${dsml('invoke name="codemod" string="true">')}export const meta = { ok: true }${dsml('/parameter>')}\n` +
  `${dsml('parameter name="code" string="true">')}\nexport const meta = { ok: true };\n${dsml('/parameter>')}\n` +
  `${dsml('/invoke>')}\n` +
  `${dsml('/calls>')}`;

const assistantMessage = (text, extra = []) => ({
  role: 'assistant',
  stopReason: 'stop',
  content: [{ type: 'text', text }, ...extra],
});

const cleanTurn = (text) => ({ outcome: 'completed', toolResults: [], message: assistantMessage(text) });

// ── reading the message ────────────────────────────────────────────────────

test('assistantText reads text blocks only, never thinking or tool calls', () => {
  assert.equal(
    assistantText({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'not reply text' },
        { type: 'text', text: 'hello ' },
        { type: 'toolCall', name: 'bash' },
        { type: 'text', text: 'world' },
      ],
    }),
    'hello world',
  );
  assert.equal(assistantText({ role: 'assistant' }), '');
  assert.equal(assistantText(undefined), '');
});

test('hasToolCalls sees only real tool calls', () => {
  assert.equal(hasToolCalls({ content: [{ type: 'text', text: 'x' }] }), false);
  assert.equal(hasToolCalls({ content: [{ type: 'toolCall', name: 'bash' }] }), true);
  assert.equal(hasToolCalls({ content: 'a string body' }), false);
});

// ── detection ──────────────────────────────────────────────────────────────

test('stripDsml leaves the tag structure the markers wrap', () => {
  assert.equal(stripDsml(OBSERVED).trim(), '<invoke name="codemodode" string="true">\n</parameter>\n</invoke>\n</calls>');
});

test('the observed DSML reply is detected, degraded envelope and all', () => {
  const found = detectEnvelope(OBSERVED);
  assert.ok(found, 'the reply that ended a real turn must be detected');
  assert.equal(found.dialect, 'dsml');
  assert.deepEqual(
    found.calls.map((call) => call.name),
    ['codemodode'],
  );
  assert.equal(found.lead.trim(), '');
});

test('DSML arguments are recovered in the order written', () => {
  const found = detectEnvelope(OBSERVED_WITH_ARGS);
  assert.ok(found);
  assert.equal(found.calls.length, 1);
  assert.equal(found.calls[0].name, 'codemod');
  // The stray unnamed `</parameter>` block carries no name, so it contributes nothing;
  // the named `code` parameter keeps its body with the closing tags clipped off.
  assert.deepEqual(found.calls[0].parameters, [
    { name: 'code', value: 'export const meta = { ok: true };' },
  ]);
});

test('prose before the envelope is kept as lead, and still detected', () => {
  const found = detectEnvelope(`I will run that now.\n${OBSERVED}`);
  assert.ok(found);
  // The envelope itself starts with a newline, so the lead keeps both of them.
  assert.equal(found.lead, 'I will run that now.\n\n');
});

test('parallel calls in one envelope are all recovered', () => {
  const text =
    '<function_calls>\n' +
    '<invoke name="read">\n<parameter name="path">/a.ts</parameter>\n</invoke>\n' +
    '<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>\n' +
    '</function_calls>';
  const found = detectEnvelope(text);
  assert.ok(found);
  assert.equal(found.dialect, 'xml');
  assert.deepEqual(
    found.calls.map((call) => call.name),
    ['read', 'bash'],
  );
  assert.deepEqual(found.calls[1].parameters, [{ name: 'command', value: 'ls' }]);
});

test('parseCalls ignores an invoke with no name', () => {
  assert.deepEqual(parseCalls('<invoke>\n</invoke>'), []);
});

test('a reply that merely talks about the format is not detected', () => {
  // Prose first, and nothing that ends the reply with a closing tag.
  assert.equal(detectEnvelope('Pi has no DSML parser, so <invoke name="codemode"> lands as text.'), null);
  // The plain XML dialect must *end* the reply: this one keeps explaining afterwards.
  assert.equal(
    detectEnvelope(
      '<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>\n' +
        'Note that the close tag above is what the model should have sent.',
    ),
    null,
  );
  // An envelope inside a fenced block is documentation, quiz or sample — not a call.
  assert.equal(
    detectEnvelope(
      'The shape is:\n\n```xml\n<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>\n```',
    ),
    null,
  );
  // Nothing to see at all.
  assert.equal(detectEnvelope('Done: 3 files changed.'), null);
  assert.equal(detectEnvelope(''), null);
});

test('an XML envelope with no recoverable call is left alone', () => {
  assert.equal(detectEnvelope('<function_calls>\n</function_calls>'), null);
});

// ── the boundary decision ──────────────────────────────────────────────────

test('rescueFor fires on the exact shape the failing turns had', () => {
  const turn = { outcome: 'completed', toolResults: [], message: assistantMessage(OBSERVED) };
  assert.ok(rescueFor(turn));
});

test('rescueFor refuses every turn that is not the failure', () => {
  // An error or abort is a hard exit; pi's own handling owns those.
  assert.equal(rescueFor({ ...cleanTurn(OBSERVED), outcome: 'error' }), null);
  assert.equal(rescueFor({ ...cleanTurn(OBSERVED), outcome: 'aborted' }), null);
  // A turn that ran something is not a lost turn.
  assert.equal(rescueFor({ ...cleanTurn(OBSERVED), toolResults: [{ toolCallId: 'x' }] }), null);
  // A reply that already called a tool needs no rescue even if it also printed markup.
  const both = assistantMessage(OBSERVED, [{ type: 'toolCall', name: 'bash' }]);
  assert.equal(rescueFor({ outcome: 'completed', toolResults: [], message: both }), null);
  // Only assistant replies are considered.
  assert.equal(
    rescueFor({ outcome: 'completed', toolResults: [], message: { role: 'user', content: [{ type: 'text', text: OBSERVED }] } }),
    null,
  );
});

// ── naming the tool that was meant ─────────────────────────────────────────

test('distance ranks the misspellings the model actually produced', () => {
  // `codemap` is three edits of seven characters, which is why suggestTool's
  // absolute bound is a third of the name and not a flat two edits.
  for (const written of ['codemod', 'codemap', 'codemodode']) {
    assert.ok(
      distance(written, 'codemode') <= Math.ceil(written.length / 3),
      `${written} should be within a third of its length of codemode`,
    );
  }
});

test('suggestTool resolves a real name, a case slip, and the observed typos', () => {
  assert.deepEqual(suggestTool('bash', ['bash', 'read']), { tool: 'bash', note: null });
  assert.deepEqual(suggestTool('Bash', ['bash', 'read']), {
    tool: 'bash',
    note: 'tool names are case-sensitive, so `Bash` is not one',
  });
  for (const written of ['codemod', 'codemap', 'codemodode']) {
    const suggestion = suggestTool(written, ['bash', 'codemode', 'read']);
    assert.equal(suggestion.tool, 'codemode', `${written} should resolve to codemode`);
    assert.match(suggestion.note, /no tool is named/);
  }
  assert.deepEqual(suggestTool('zzzzzzzz', ['bash', 'read']), {
    tool: null,
    note: 'no tool is named `zzzzzzzz`, and no active tool is close to it',
  });
  // Nothing is invented when the session has no tools at all.
  assert.deepEqual(suggestTool('codemodode', []), {
    tool: null,
    note: 'no tool is named `codemodode`, and no active tool is close to it',
  });
});

// ── the corrective message ─────────────────────────────────────────────────

test('renderRescue names the call, the real tool, and the arguments', () => {
  const found = detectEnvelope(OBSERVED_WITH_ARGS);
  const text = renderRescue(found, ['bash', 'codemode']);
  assert.match(text, /Recovered from the text:/);
  assert.match(text, /`codemod` — no tool is named `codemod`; the closest is `codemode`/);
  assert.match(text, /use `codemode` for it/);
  assert.match(text, /code: "export const meta = \{ ok: true \};"/);
  // It has to say what to do instead, in the imperative, once.
  assert.match(text, /Re-issue that call now, as a real tool call/);
  assert.match(text, /Never write a tool call as markup in your reply/);
});

test('renderRescue never repeats the envelope it is correcting', () => {
  // The message must not teach the pattern: no DSML markers in it, ever.
  for (const sample of [OBSERVED, OBSERVED_WITH_ARGS]) {
    const text = renderRescue(detectEnvelope(sample), ['codemode']);
    assert.equal(text.includes(MARK), false, 'the corrective message must not carry a DSML marker');
    assert.equal(/<invoke/i.test(text), false, 'the corrective message must not carry an <invoke> tag');
  }
});

test('renderRescue still gives instructions when nothing could be recovered', () => {
  const text = renderRescue({ dialect: 'dsml', calls: [], lead: '' }, ['bash']);
  assert.match(text, /Nothing usable could be recovered/);
  assert.match(text, /Re-issue that call now/);
});

// ── the handler ────────────────────────────────────────────────────────────

function fakePi(tools = ['bash', 'codemode', 'read']) {
  const handlers = {};
  const commands = {};
  const notes = [];
  const pi = {
    on: (name, fn) => {
      (handlers[name] ??= []).push(fn);
    },
    registerCommand: (name, spec) => (commands[name] = spec),
    getActiveTools: () => tools,
  };
  register(pi);
  const ctx = {
    hasUI: true,
    ui: { notify: (text, type) => notes.push({ text, type }) },
  };
  // Handlers chain, mirroring pi's composition: later handlers see earlier proposals.
  const call = async (name, event) => {
    let result;
    for (const fn of handlers[name] ?? []) {
      const next = await fn(event, ctx);
      if (next) result = { ...(result ?? {}), ...next };
    }
    return result;
  };
  return { handlers, commands, notes, ctx, call };
}

const turnEvent = (overrides = {}) => ({
  type: 'turn_end',
  turnIndex: 0,
  message: assistantMessage(OBSERVED),
  toolResults: [],
  messageEntryId: 'e13d1efe',
  toolResultEntryIds: [],
  entries: [],
  continue: false,
  outcome: 'completed',
  ...overrides,
});

test('turn_end: the malformed reply is edited out, and the run continues', async () => {
  const p = fakePi();
  const result = await p.call('turn_end', turnEvent());

  assert.equal(result.continue, true, 'the whole point: pi must not settle the run');
  assert.equal(result.entries.length, 2);

  const [edit, message] = result.entries;
  assert.equal(edit.type, 'context_edit');
  assert.equal(edit.targetId, 'e13d1efe', 'the reply itself is what gets replaced');
  assert.equal(edit.replacement, RESCUE_REPLACEMENT);

  assert.equal(message.type, 'custom_message');
  assert.equal(message.customType, 'toolcall-rescue');
  assert.equal(message.display, false, 'the corrective turn is not transcript noise');
  assert.match(message.content, /`codemodode`/);
  assert.match(message.content, /`codemode`/);

  // The user is told, once, in the UI rather than in the transcript.
  assert.equal(p.notes.length, 1);
  assert.equal(p.notes[0].type, 'warning');
  assert.match(p.notes[0].text, /codemodode was written as dsml text/);
});

test('turn_end: entries proposed by earlier handlers are preserved', async () => {
  const p = fakePi();
  const earlier = [{ type: 'custom_message', customType: 'someone-else', content: 'x', display: false }];
  const result = await p.call('turn_end', turnEvent({ entries: earlier }));
  assert.deepEqual(result.entries[0], earlier[0]);
  assert.equal(result.entries.length, 3);
});

test('turn_end: a clean turn returns nothing at all', async () => {
  const p = fakePi();
  assert.equal(await p.call('turn_end', turnEvent({ message: assistantMessage('All done: 3 files changed.') })), undefined);
  assert.equal(p.notes.length, 0);
});

test('turn_end: a turn that ran a tool is never rewritten', async () => {
  const p = fakePi();
  const event = turnEvent({ toolResults: [{ toolCallId: 'c1' }] });
  assert.equal(await p.call('turn_end', event), undefined);
});

test('turn_end: the guard stops rescuing instead of looping forever', async () => {
  const p = fakePi();
  for (let i = 0; i < MAX_CONSECUTIVE_RESCUES; i += 1) {
    const result = await p.call('turn_end', turnEvent());
    assert.equal(result?.continue, true, `rescue ${i + 1} of ${MAX_CONSECUTIVE_RESCUES}`);
  }
  // The fourth consecutive malformed turn is left alone, so the session settles
  // instead of spending turns on a model that will not change its answer.
  assert.equal(await p.call('turn_end', turnEvent()), undefined);
  // And it says why, once, rather than on every later turn.
  const warnings = p.notes.filter((note) => /giving up/.test(note.text));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, new RegExp(`giving up after ${MAX_CONSECUTIVE_RESCUES}`));
});

test('turn_end: a good turn resets the budget, so a later slip is still rescued', async () => {
  const p = fakePi();
  for (let i = 0; i < MAX_CONSECUTIVE_RESCUES; i += 1) await p.call('turn_end', turnEvent());
  await p.call('turn_end', turnEvent({ message: assistantMessage('Done.'), toolResults: [{ toolCallId: 'c1' }] }));
  const rescued = await p.call('turn_end', turnEvent());
  assert.equal(rescued?.continue, true, 'progress buys back the whole budget');
});

test('input: a new instruction resets the budget too', async () => {
  const p = fakePi();
  for (let i = 0; i < MAX_CONSECUTIVE_RESCUES; i += 1) await p.call('turn_end', turnEvent());
  assert.equal(await p.call('turn_end', turnEvent()), undefined);
  await p.call('input', { text: 'try again' });
  const rescued = await p.call('turn_end', turnEvent());
  assert.equal(rescued?.continue, true);
});

test('command: /toolcall-rescue reports the count and the last call', async () => {
  const p = fakePi();
  assert.ok(p.commands['toolcall-rescue']);
  await p.commands['toolcall-rescue'].handler('', p.ctx);
  assert.match(p.notes.at(-1).text, /nothing rescued this session/);

  await p.call('turn_end', turnEvent());
  await p.commands['toolcall-rescue'].handler('', p.ctx);
  const report = p.notes.at(-1).text;
  assert.match(report, /1 malformed tool call\(s\) rescued/);
  assert.match(report, /`codemodode` as dsml/);
});
