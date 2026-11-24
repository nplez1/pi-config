import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ext = await import(
  fileURLToPath(new URL('../dot-pi/agent/extensions/edit-repair.ts', import.meta.url))
);
const {
  default: register,
  normalizeLine,
  findOccurrences,
  buildLineIndex,
  lineAt,
  uniqueAnchor,
  closestWindow,
  matchEdits,
  findOverlaps,
  renderDiagnostic,
} = ext;

const FILE = `import { alpha } from './alpha'

export function resize(dimensions: Size): Size {
  const scale = 1
  return {
    width: dimensions.width * scale,
    height: dimensions.height * scale,
  }
}

export function restore(dimensions: Size): Size {
  const scale = 1
  return {
    width: dimensions.width * scale,
    height: dimensions.height * scale,
  }
}
`;

// ── primitives ─────────────────────────────────────────────────────────────

test('normalizeLine: strips trailing space and indentation, folds unicode', () => {
  assert.equal(normalizeLine('    const x = 1   '), 'const x = 1');
  assert.equal(normalizeLine('say \u201Chi\u201D'), 'say "hi"');
  assert.equal(normalizeLine('a \u2014 b'), 'a - b');
});

test('findOccurrences: counts, caps, and reports none', () => {
  assert.deepEqual(findOccurrences('aXaXa', 'X'), [1, 3]);
  assert.equal(findOccurrences('aXaXaXaXaXaXa', 'X', 3).length, 3);
  assert.deepEqual(findOccurrences('abc', 'z'), []);
  assert.deepEqual(findOccurrences('abc', ''), []);
});

test('lineAt: char offsets map to zero-based lines', () => {
  const index = buildLineIndex('one\ntwo\nthree');
  assert.equal(lineAt(index, 0), 0);
  assert.equal(lineAt(index, 3), 0, 'offset 3 is the newline that ends line 0');
  assert.equal(lineAt(index, 4), 1);
  assert.equal(lineAt(index, 8), 2);
  assert.equal(lineAt(index, 999), 2);
});

// ── ambiguity: the dominant real failure ───────────────────────────────────

test('uniqueAnchor: grows a repeated block until it is unique', () => {
  const needle = '  const scale = 1';
  const at = findOccurrences(FILE, needle);
  assert.equal(at.length, 2, 'fixture must contain the duplicated line');

  const first = uniqueAnchor(FILE, at[0], at[0] + needle.length);
  assert.ok(first, 'a unique anchor must exist for the resize() copy');
  assert.equal(findOccurrences(FILE, first).length, 1);
  assert.match(first, /function resize/);
});

test('uniqueAnchor: a periodic file has no anchor short of the whole file', () => {
  // Every shorter snippet repeats, and swallowing the whole file to break the tie would
  // be a rewrite, not a hint, so the tie is reported as unresolvable.
  const text = 'same\nsame\nsame\n';
  const at = findOccurrences(text, 'same');
  assert.equal(uniqueAnchor(text, at[0], at[0] + 4), null);
});

test('uniqueAnchor: a nearby unique neighbour is enough', () => {
  const text = 'a\nsame\nb\na\nsame\nb\n';
  const at = findOccurrences(text, 'same');
  const anchor = uniqueAnchor(text, at[0], at[0] + 4);
  assert.ok(anchor);
  assert.equal(findOccurrences(text, anchor).length, 1);
  assert.ok(anchor.split('\n').length < text.split('\n').length - 1);
});

test('renderDiagnostic: ambiguity lists both occurrences with unique oldText', () => {
  const edits = [{ oldText: '  const scale = 1', newText: '  const scale = 2' }];
  const { text, alreadyApplied } = renderDiagnostic({
    path: 'src/size.ts',
    fileText: FILE,
    edits,
    errorText: 'Found 2 occurrences of edits[0] in src/size.ts. Each oldText must be unique.',
  });
  assert.equal(alreadyApplied, false);
  assert.match(text, /matches 2 places in src\/size\.ts/);
  assert.match(text, /occurrence \[1\] starts line 4/);
  assert.match(text, /occurrence \[2\] starts line 12/);
  assert.match(text, /unique oldText for \[1\]/);
  assert.match(text, /unique oldText for \[2\]/);
  // Which edit was ambiguous is what matters; uniqueAnchor is tested directly above.
  const firstHeader = text.indexOf('unique oldText for [1]');
  const secondHeader = text.indexOf('unique oldText for [2]');
  assert.ok(firstHeader > 0 && secondHeader > firstHeader);
  assert.match(text.slice(firstHeader, secondHeader), /function resize/);
  assert.match(text.slice(secondHeader), /function restore/);
});

test('renderDiagnostic: a single matching edit is not reported', () => {
  const edits = [
    { oldText: "import { alpha } from './alpha'", newText: "import { beta } from './beta'" },
    { oldText: '  const scale = 1', newText: '  const scale = 2' },
  ];
  const { text } = renderDiagnostic({ path: 'a.ts', fileText: FILE, edits, errorText: 'boom' });
  assert.doesNotMatch(text, /edits\[0\] matches/);
  assert.match(text, /edits\[1\] matches 2 places/);
});

// ── drift: the other half ──────────────────────────────────────────────────

test('closestWindow: finds a renamed block by similarity, not exact lines', () => {
  const needle = [
    'export function resize(size: Size): Size {',
    '  return {',
  ].join('\n');
  const closest = closestWindow(FILE, needle);
  assert.ok(closest);
  assert.equal(closest.startLine, 2);
  assert.ok(closest.ratio > 0.5 && closest.ratio < 1, `similarity should be partial, got ${closest.ratio}`);
  assert.deepEqual(closest.missing, ['export function resize(size: Size): Size {']);
});

test('closestWindow: an exact block scores 1', () => {
  const needle = "import { alpha } from './alpha'";
  const closest = closestWindow(FILE, needle);
  assert.ok(closest);
  assert.equal(closest.startLine, 0);
  assert.equal(closest.ratio, 1);
  assert.deepEqual(closest.missing, []);
});

test('renderDiagnostic: not-found returns line-numbered current text', () => {
  const edits = [{ oldText: 'export function resize(size: Size): Size {', newText: 'x' }];
  const { text } = renderDiagnostic({
    path: 'src/size.ts',
    fileText: FILE,
    edits,
    errorText: 'Could not find edits[0] in src/size.ts The oldText must match exactly',
  });
  assert.match(text, /edits\[0\] was not found in src\/size\.ts/);
  assert.match(text, /Closest current text starts at line 3/);
  assert.match(text, /lines in your oldText that are not in this region verbatim/);
  assert.match(text, /export function resize\(dimensions: Size\)/);
});
test('renderDiagnostic: nothing was written is stated so the model does not assume success', () => {
  const { text, alreadyApplied } = renderDiagnostic({
    path: 'a.ts',
    fileText: FILE,
    edits: [{ oldText: 'nope', newText: 'x' }],
    errorText: 'Could not find the exact text in a.ts',
  });
  assert.equal(alreadyApplied, false);
  assert.match(text, /nothing was written to a\.ts/);
});

// ── overlap and no-op ──────────────────────────────────────────────────────

test('findOverlaps: intersecting ranges are reported, disjoint ones are not', () => {
  const text = 'aaaa\nbbbb\ncccc\n';
  const overlapping = findOverlaps(text, [
    { oldText: 'aaaa\nbbbb', newText: 'x' },
    { oldText: 'bbbb\ncccc', newText: 'y' },
  ]);
  assert.equal(overlapping.length, 1);
  assert.equal(overlapping[0].a, 0);
  assert.equal(overlapping[0].b, 1);

  assert.equal(
    findOverlaps(text, [
      { oldText: 'aaaa', newText: 'x' },
      { oldText: 'cccc', newText: 'y' },
    ]).length,
    0,
  );
});

test('renderDiagnostic: overlap names the two edits and their lines', () => {
  const text = 'a\nb\nc\n';
  const { text: out } = renderDiagnostic({
    path: 'a.ts',
    fileText: text,
    edits: [
      { oldText: 'a\nb', newText: 'x' },
      { oldText: 'b\nc', newText: 'y' },
    ],
    errorText: 'edits[0] and edits[1] overlap in a.ts',
  });
  assert.match(out, /overlapping edits/);
  assert.match(out, /edits\[0\] \(line 1\) and edits\[1\] \(line 2\)/);
});

test('renderDiagnostic: "No changes made" becomes a satisfied no-op', () => {
  const { text, alreadyApplied } = renderDiagnostic({
    path: 'a.ts',
    fileText: FILE,
    edits: [{ oldText: '  const scale = 1', newText: '  const scale = 1' }],
    errorText: 'No changes made to a.ts The replacement produced identical content.',
  });
  assert.equal(alreadyApplied, true);
  assert.match(text, /already contains the intended content/);
});

test('renderDiagnostic: an unexplained failure does not invent a cause', () => {
  const { text } = renderDiagnostic({
    path: 'a.ts',
    fileText: FILE,
    edits: [{ oldText: "import { alpha } from './alpha'", newText: "import { beta } from './beta'" }],
    errorText: 'EACCES: permission denied',
  });
  assert.match(text, /not a text mismatch/);
});

test('renderDiagnostic: output is capped', () => {
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
  const { text } = renderDiagnostic({
    path: 'big.ts',
    fileText: big,
    edits: [{ oldText: 'line 1999\nmissing line', newText: 'x' }],
    errorText: 'Could not find edits[0]',
  });
  assert.ok(text.length <= 6100, `diagnostic must stay bounded, got ${text.length}`);
});

// ── handler wiring ─────────────────────────────────────────────────────────

function fakePi() {
  const handlers = {};
  const pi = { on: (name, fn) => ((handlers[name] ??= []).push(fn)), registerCommand: () => {} };
  register(pi);
  return handlers;
}

const failureEvent = (input, errorText) => ({
  type: 'tool_result',
  toolName: 'edit',
  toolCallId: 'c1',
  input,
  content: [{ type: 'text', text: errorText }],
  isError: true,
});

test('handler: a failed edit is rewritten with current file text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'edit-repair-'));
  await writeFile(join(dir, 'size.ts'), FILE);
  const handler = fakePi().tool_result[0];
  const out = await handler(
    failureEvent(
      { path: 'size.ts', edits: [{ oldText: '  const scale = 1', newText: '  const scale = 2' }] },
      'Found 2 occurrences of edits[0] in size.ts.',
    ),
    { cwd: dir },
  );
  assert.equal(out.isError, true, 'the edit genuinely did not apply');
  assert.match(out.content[0].text, /unique oldText for \[1\]/);
});

test('handler: a no-op reports success so the loop stops recovering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'edit-repair-'));
  await writeFile(join(dir, 'size.ts'), FILE);
  const handler = fakePi().tool_result[0];
  const out = await handler(
    failureEvent({ path: 'size.ts', edits: [{ oldText: 'x', newText: 'x' }] }, 'No changes made to size.ts'),
    { cwd: dir },
  );
  assert.equal(out.isError, false);
});

test('handler: an unreadable path says so rather than diagnosing nothing', async () => {
  const handler = fakePi().tool_result[0];
  const out = await handler(
    failureEvent({ path: 'gone.ts', edits: [{ oldText: 'x', newText: 'y' }] }, 'Could not find edits[0]'),
    { cwd: '/nonexistent-dir-for-test' },
  );
  assert.match(out.content[0].text, /could not be read back/);
});

test('handler: successful edits and other tools pass through untouched', async () => {
  const handler = fakePi().tool_result[0];
  const ok = { ...failureEvent({ path: 'a.ts', edits: [] }, ''), isError: false };
  assert.equal(await handler(ok, { cwd: '/' }), undefined);
  const other = { ...failureEvent({ path: 'a.ts', edits: [] }, 'boom'), toolName: 'read' };
  assert.equal(await handler(other, { cwd: '/' }), undefined);
});

test('matchEdits: counts occurrences per edit', () => {
  const matches = matchEdits(FILE, [
    { oldText: '  const scale = 1', newText: 'x' },
    { oldText: "from './alpha'", newText: 'y' },
  ]);
  assert.equal(matches[0].occurrences.length, 2);
  assert.equal(matches[1].occurrences.length, 1);
});
