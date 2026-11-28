import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic: never read the machine's real verify.json. Tests that need a config file write
// one into a temp dir and point the extension at it.
const emptyConfig = join(await mkdtemp(join(tmpdir(), 'verify-empty-')), 'verify.json');
process.env.PI_VERIFY_CONFIG = emptyConfig;

const ext = await import(
  fileURLToPath(new URL('../dot-pi/agent/extensions/verify-after-edit.ts', import.meta.url))
);
const {
  default: register,
  withDefaults,
  matchesProject,
  matchesPathPattern,
  patternSpecificity,
  pickProject,
  resolveConfig,
  discoverProject,
  describeSource,
  collectEditedPaths,
  collectBashCommands,
  rootToolCallId,
  nestedCallsForTurn,
  nestedRecordKey,
  alreadyRan,
  commandsToRun,
  filterPaths,
  trimOutput,
  clampChars,
  outputBudget,
  renderVerifyMessage,
  missingRequirements,
  DEBOUNCE_MS,
} = ext;

// ── config resolution ──────────────────────────────────────────────────────

test('matchesProject: boundary-aware, so /a/b never matches /a/bc', () => {
  assert.equal(matchesProject('/a/b', '/a/b'), true);
  assert.equal(matchesProject('/a/b/c', '/a/b'), true);
  assert.equal(matchesProject('/a/bc', '/a/b'), false);
  assert.equal(matchesProject('/a/b/c', '/a/b/'), true);
  assert.equal(matchesProject('/x', '/a/b'), false);
  assert.equal(matchesProject('/a/b', ''), false);
});

test('matchesPathPattern: globs cover any worktree root a tool invents', () => {
  assert.equal(matchesPathPattern('/w/orca/Feature-A', '/w/*'), true);
  assert.equal(matchesPathPattern('/w/orca/Feature-A/src', '/w/*'), true);
  assert.equal(matchesPathPattern('/w/orca/Feature-A', '/w/orca/*'), true);
  assert.equal(matchesPathPattern('/w/orca/Feature-A/src/main', '/w/orca/*'), true);
  assert.equal(matchesPathPattern('/w/orca/a/b', '/w/**'), true);
  assert.equal(matchesPathPattern('/w/orca/Feature-A', '/w/other/*'), false);
  assert.equal(matchesPathPattern('/w/orca', '/w/orca/*'), false, 'the pattern names children, not the root');
  assert.equal(matchesPathPattern('/a/b/c', '/a/b'), true, 'a plain entry stays a prefix');
  assert.equal(matchesPathPattern('/a/bc', '/a/b'), false);
});

test('patternSpecificity: literal characters decide, so the narrowest entry wins', () => {
  assert.ok(patternSpecificity('/w/orca/specific') > patternSpecificity('/w/*'));
  assert.equal(patternSpecificity('/w/**'), 3);
});

test('pickProject: the most specific matching entry wins, prefix or glob', () => {
  const projects = {
    '/repo': { commands: ['root-check'] },
    '/repo/worktrees/*': { commands: ['wt-check'] },
    '/repo/worktrees/w1': { commands: ['exact-check'] },
  };
  assert.equal(pickProject('/repo/worktrees/w1/src', projects).pattern, '/repo/worktrees/w1');
  assert.equal(pickProject('/repo/worktrees/w2', projects).pattern, '/repo/worktrees/*');
  assert.equal(pickProject('/repo/other', projects).pattern, '/repo');
  assert.equal(pickProject('/elsewhere', projects), null);
  assert.equal(pickProject('/repo', undefined), null);
});

test('discoverProject: walks up to the git root for the tracked config', () => {
  const files = new Set(['/w/orca/Feature-A/.git', '/w/orca/Feature-A/.pi/verify.json']);
  const exists = (p) => files.has(p);
  const found = discoverProject('/w/orca/Feature-A/src/main', exists);
  assert.equal(found.root, '/w/orca/Feature-A');
  assert.equal(found.verifyFile, '/w/orca/Feature-A/.pi/verify.json');
});

test('discoverProject: the config may sit above the cwd but below the git root', () => {
  const files = new Set(['/w/orca/Feature-A/.pi/verify.json']);
  const found = discoverProject('/w/orca/Feature-A/apps/web', (p) => files.has(p));
  assert.equal(found.verifyFile, '/w/orca/Feature-A/.pi/verify.json');
  assert.equal(
    found.root,
    '/w/orca/Feature-A',
    'without a .git the config directory is the project boundary, never the filesystem root',
  );
});

test('discoverProject: no config anywhere yields no file, not an error', () => {
  const found = discoverProject('/nowhere/at/all', () => false);
  assert.equal(found.verifyFile, null);
  assert.ok(found.root.length > 0);
});

test('withDefaults: fills gaps without inventing commands', () => {
  const base = withDefaults({ commands: [], timeoutSeconds: 180 }, { commands: ['x'] });
  assert.deepEqual(base.commands, ['x']);
  assert.equal(base.timeoutSeconds, 180);
  assert.deepEqual(withDefaults(base, { commands: ['', '  '] }).commands, []);
  assert.equal(withDefaults(base, { timeoutSeconds: -1 }).timeoutSeconds, 180);
});

test('withDefaults: keeps requires, dropping blank entries', () => {
  const base = withDefaults({ commands: [], timeoutSeconds: 180 }, { requires: ['node_modules', '', '  '] });
  assert.deepEqual(base.requires, ['node_modules']);
  // Omitted stays omitted: no requirements is not the same as an empty gate.
  assert.equal(withDefaults({ commands: [], timeoutSeconds: 180 }, { commands: ['x'] }).requires, undefined);
});

test('missingRequirements: relative names resolve against the run directory', () => {
  const present = new Set(['/repo/node_modules']);
  const exists = (p) => present.has(p);

  assert.deepEqual(missingRequirements(['node_modules'], '/repo', exists), []);
  assert.deepEqual(missingRequirements(['node_modules', 'dist'], '/repo', exists), ['dist']);
  // Absent config, or an empty list, gates nothing.
  assert.deepEqual(missingRequirements(undefined, '/repo', exists), []);
  assert.deepEqual(missingRequirements([], '/repo', exists), []);
  // Absolute requirements are honoured as written, not joined onto the dir.
  assert.deepEqual(missingRequirements(['/repo/node_modules'], '/elsewhere', exists), []);
});

test('resolveConfig: tracked file beats path pattern beats repo name beats default', () => {
  const globalFile = {
    default: { commands: ['global'] },
    byName: { orca: { commands: ['named'], timeoutSeconds: 120 } },
    projects: { '/repo': { commands: ['mapped'], timeoutSeconds: 240 } },
  };

  const named = resolveConfig({ cwd: '/elsewhere/x', globalFile, repoName: 'orca' });
  assert.deepEqual(named.config.commands, ['named']);
  assert.deepEqual(named.source, { kind: 'repo-name', name: 'orca' });

  const mapped = resolveConfig({ cwd: '/repo/src', globalFile, repoName: 'orca' });
  assert.deepEqual(mapped.config.commands, ['mapped'], 'a path entry is more specific than a repo name');
  assert.equal(mapped.config.timeoutSeconds, 240);
  assert.deepEqual(mapped.source, { kind: 'path-pattern', pattern: '/repo' });

  const local = resolveConfig({
    cwd: '/repo/src',
    globalFile,
    repoName: 'orca',
    localFile: { commands: ['local'] },
    localPath: '/repo/.pi/verify.json',
  });
  assert.deepEqual(local.config.commands, ['local']);
  assert.equal(local.config.timeoutSeconds, 240, 'unspecified keys keep the more general value');
  assert.deepEqual(local.source, { kind: 'project-file', path: '/repo/.pi/verify.json' });

  assert.deepEqual(resolveConfig({ cwd: '/elsewhere', globalFile }).config.commands, ['global']);
  const inert = resolveConfig({ cwd: '/repo', globalFile: null });
  assert.deepEqual(inert.config.commands, []);
  assert.deepEqual(inert.source, { kind: 'none' });
});

test('describeSource: names the reason the config applied', () => {
  assert.match(describeSource({ kind: 'project-file', path: '/r/.pi/verify.json' }), /tracked config at/);
  assert.match(describeSource({ kind: 'path-pattern', pattern: '/w/*' }), /projects/);
  assert.match(describeSource({ kind: 'repo-name', name: 'orca' }), /byName/);
  assert.match(describeSource({ kind: 'none' }), /inert/);
});

// ── what the turn did ──────────────────────────────────────────────────────

const turnMessage = (calls) => ({
  content: calls.map((c, i) => ({ type: 'toolCall', id: c.id ?? `c${i}`, name: c.name, arguments: c.arguments ?? {} })),
});

test('collectEditedPaths: only edits and writes that succeeded', () => {
  const message = turnMessage([
    { id: 'a', name: 'edit', arguments: { path: 'src/a.ts' } },
    { id: 'b', name: 'write', arguments: { path: 'src/b.ts' } },
    { id: 'c', name: 'edit', arguments: { path: 'src/c.ts' } },
    { id: 'd', name: 'read', arguments: { path: 'src/d.ts' } },
    { id: 'e', name: 'bash', arguments: { command: 'pnpm tc' } },
  ]);
  const results = [
    { toolCallId: 'a', isError: false },
    { toolCallId: 'b', isError: false },
    { toolCallId: 'c', isError: true },
  ];
  assert.deepEqual(collectEditedPaths(message, results), ['src/a.ts', 'src/b.ts']);
});

test('collectEditedPaths: a turn with no edits yields nothing to check', () => {
  assert.deepEqual(collectEditedPaths(turnMessage([{ name: 'bash', arguments: { command: 'ls' } }]), []), []);
  assert.deepEqual(collectEditedPaths(undefined, []), []);
});

test('collectBashCommands: gathers the commands the model issued', () => {
  const message = turnMessage([
    { name: 'bash', arguments: { command: 'pnpm tc' } },
    { name: 'read', arguments: { path: 'x' } },
  ]);
  assert.deepEqual(collectBashCommands(message), ['pnpm tc']);
});

// ── edits a tool made on the model's behalf (codemode and friends) ─────────

// Pi reports a nested call as `<parent id>/<n>`, at any depth, and keeps it out of the transcript.
const nestedWrite = (parentId, path, extra = {}) => ({
  toolName: 'write',
  toolCallId: `${parentId}/1`,
  parentToolCallId: parentId,
  input: { path },
  isError: false,
  ...extra,
});

test('rootToolCallId: only a nested id names a parent', () => {
  assert.equal(rootToolCallId('call_abc/1'), 'call_abc');
  assert.equal(rootToolCallId('call_abc/1/2'), 'call_abc', 'depth collapses to the model-issued call');
  assert.equal(rootToolCallId('call_abc'), null, 'a model-issued call has no parent');
  assert.equal(rootToolCallId(undefined), null);
});

test('nestedCallsForTurn: only calls this turn made', () => {
  const ids = new Set(['call_a']);
  assert.deepEqual(nestedCallsForTurn([nestedWrite('call_a', 'x.ts')], ids).length, 1);
  assert.deepEqual(nestedCallsForTurn([nestedWrite('call_old', 'x.ts')], ids), [], 'a stale parent is ignored');
  // Two levels down (`call_a/1/2`) still belongs to `call_a`, so the parent field is not needed.
  const deep = { toolName: 'write', toolCallId: 'call_a/1/2', input: { path: 'y.ts' }, isError: false };
  assert.deepEqual(nestedCallsForTurn([deep], ids).length, 1);
  assert.deepEqual(nestedCallsForTurn([], ids), []);
  assert.deepEqual(nestedCallsForTurn(undefined, ids), []);
});

test('collectEditedPaths: a codemode write is an edit, even though the message shows only the script', () => {
  const message = turnMessage([{ id: 'call_a', name: 'codemode', arguments: { code: 'await tools.write(…)' } }]);
  const nested = [nestedWrite('call_a', 'src/a.ts'), nestedWrite('call_a', 'src/b.ts')];
  assert.deepEqual(collectEditedPaths(message, [{ toolCallId: 'call_a', isError: false }], nested).sort(), [
    'src/a.ts',
    'src/b.ts',
  ]);
});

test('collectEditedPaths: a nested edit is judged by its own result, not the script\'s', () => {
  // The script wrote the file and then threw. Calls made before a failure are not undone.
  const message = turnMessage([{ id: 'call_a', name: 'codemode', arguments: { code: '…' } }]);
  const nested = [nestedWrite('call_a', 'src/written.ts')];
  assert.deepEqual(collectEditedPaths(message, [{ toolCallId: 'call_a', isError: true }], nested), ['src/written.ts']);
  // A nested edit that itself failed wrote nothing.
  const failed = [nestedWrite('call_a', 'src/never.ts', { isError: true })];
  assert.deepEqual(collectEditedPaths(message, [{ toolCallId: 'call_a', isError: false }], failed), []);
});

test('collectEditedPaths: a nested edit from another turn does not count', () => {
  const message = turnMessage([{ id: 'call_now', name: 'codemode', arguments: { code: '…' } }]);
  assert.deepEqual(collectEditedPaths(message, [], [nestedWrite('call_previous', 'src/old.ts')]), []);
});

test('collectEditedPaths: a direct and a scripted edit to the same file are reported once', () => {
  const message = turnMessage([
    { id: 'call_a', name: 'edit', arguments: { path: 'src/a.ts' } },
    { id: 'call_b', name: 'codemode', arguments: { code: '…' } },
  ]);
  assert.deepEqual(collectEditedPaths(message, [], [nestedWrite('call_b', 'src/a.ts')]), ['src/a.ts']);
});

test('collectBashCommands: a check run from inside a script is not run again', () => {
  const message = turnMessage([{ id: 'call_a', name: 'codemode', arguments: { code: '…' } }]);
  const nested = [
    { toolName: 'bash', toolCallId: 'call_a/1', parentToolCallId: 'call_a', input: { command: 'pnpm tc' }, isError: false },
    { toolName: 'bash', toolCallId: 'call_old/1', parentToolCallId: 'call_old', input: { command: 'pnpm lint' } },
  ];
  assert.deepEqual(collectBashCommands(message, nested), ['pnpm tc']);
});

test('alreadyRan / commandsToRun: a check the model just ran is not run again', () => {
  assert.equal(alreadyRan('pnpm tc', ['cd /repo && pnpm tc']), true);
  assert.equal(alreadyRan('pnpm tc', ['pnpm run check']), false);
  assert.equal(alreadyRan('pnpm tc', []), false);
  assert.equal(alreadyRan('', ['anything']), false);

  assert.deepEqual(commandsToRun(['pnpm tc', 'pnpm lint'], ['cd /repo && pnpm tc']), ['pnpm lint']);
  assert.deepEqual(commandsToRun(['pnpm tc'], []), ['pnpm tc']);
  assert.deepEqual(commandsToRun(['pnpm tc'], ['pnpm tc']), []);
});

test('filterPaths: extension and ignore filters', () => {
  const paths = ['src/a.ts', 'src/b.tsx', 'src/c.css', 'node_modules/x/y.ts'];
  assert.deepEqual(filterPaths(paths, { commands: [], timeoutSeconds: 1, extensions: ['ts', '.TSX'] }), [
    'src/a.ts',
    'src/b.tsx',
    'node_modules/x/y.ts',
  ]);
  assert.deepEqual(filterPaths(paths, { commands: [], timeoutSeconds: 1, ignorePaths: ['node_modules'] }), [
    'src/a.ts',
    'src/b.tsx',
    'src/c.css',
  ]);
  // A bare entry is a path segment, so `dist` must not swallow `distribution.ts`.
  assert.deepEqual(
    filterPaths(['src/dist/x.ts', 'src/distribution.ts', 'src/build/y.ts'], {
      commands: [],
      timeoutSeconds: 1,
      ignorePaths: ['dist', 'build'],
    }),
    ['src/distribution.ts'],
  );
  // A slashed entry is normalised to the same segment rule, not treated as a substring.
  assert.deepEqual(
    filterPaths(['apps/web/dist/x.ts', 'src/dist/y.ts'], { commands: [], timeoutSeconds: 1, ignorePaths: ['/dist/'] }),
    [],
  );
  assert.deepEqual(filterPaths(paths, { commands: [], timeoutSeconds: 1 }), paths, 'no filter means everything');
});

// ── rendering ──────────────────────────────────────────────────────────────

test('trimOutput: bounded lines with an explicit omission note', () => {
  const short = 'a\nb\n';
  assert.equal(trimOutput(short), 'a\nb');
  const long = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
  const out = trimOutput(long);
  assert.equal(out.split('\n').length, 101);
  assert.match(out, /150 more line\(s\) omitted/);
});

test('renderVerifyMessage: says the extension ran it, and reports the outcome', () => {
  const text = renderVerifyMessage(
    ['src/a.ts'],
    [{ command: 'pnpm tc', code: 0, killed: false, stdout: 'ok', stderr: '', durationMs: 1234 }],
    false,
  );
  assert.match(text, /The extension ran the project check itself/);
  assert.match(text, /Do not run it again this turn/);
  assert.match(text, /pnpm tc.*passed.*1\.2s/);
  assert.match(text, /--- pnpm tc ---\nok/);
  assert.doesNotMatch(text, /Fix what this reports/);
});

test('renderVerifyMessage: a failure is labelled and asks for a fix', () => {
  const text = renderVerifyMessage(
    ['src/a.ts', 'src/b.ts'],
    [{ command: 'pnpm tc', code: 2, killed: false, stdout: '', stderr: 'error TS2345', durationMs: 900 }],
    true,
  );
  assert.match(text, /2 files/);
  assert.match(text, /exit 2/);
  assert.match(text, /error TS2345/);
  assert.match(text, /Fix what this reports/);
});

test('renderVerifyMessage: a timeout is not reported as a plain failure', () => {
  const text = renderVerifyMessage(
    ['a.ts'],
    [{ command: 'pnpm tc', code: 143, killed: true, stdout: '', stderr: '', durationMs: 240000 }],
    true,
  );
  assert.match(text, /timed out/);
});

test('renderVerifyMessage: output is capped', () => {
  const text = renderVerifyMessage(
    ['a.ts'],
    [{ command: 'x', code: 1, killed: false, stdout: 'y'.repeat(20000), stderr: '', durationMs: 1 }],
    true,
  );
  assert.ok(text.length <= 8100, `message must stay bounded, got ${text.length}`);
});

// ── handler wiring ─────────────────────────────────────────────────────────

function fakePi({ exec } = {}) {
  const handlers = {};
  const commands = {};
  const pi = {
    on: (name, fn) => ((handlers[name] ??= []).push(fn)),
    registerCommand: (name, spec) => (commands[name] = spec),
    exec: exec ?? (async () => ({ stdout: 'ok', stderr: '', code: 0, killed: false, truncated: false })),
  };
  register(pi);
  const notes = [];
  const ctx = {
    cwd: '/nonexistent-verify-project-for-tests',
    hasUI: true,
    signal: { aborted: false },
    ui: { notify: (text, type) => notes.push({ text, type }) },
  };
  return { handlers, commands, ctx, notes };
}

const editedTurn = (extra = {}) => ({
  type: 'turn_end',
  turnIndex: 3,
  outcome: 'completed',
  entries: [],
  message: turnMessage([{ id: 'a', name: 'edit', arguments: { path: 'src/a.ts' } }]),
  toolResults: [{ toolCallId: 'a', isError: false }],
  ...extra,
});

test('handler: with no config, nothing runs and nothing is appended', async () => {
  const p = fakePi({ exec: () => assert.fail('must not execute without config') });
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);
  assert.equal(await p.handlers.turn_end[0](editedTurn(), p.ctx), undefined);
});

test('handler: a turn with no successful edit never runs the check', async () => {
  const p = fakePi({ exec: () => assert.fail('must not execute without an edit') });
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);
  const out = await p.handlers.turn_end[0](editedTurn({ toolResults: [{ toolCallId: 'a', isError: true }] }), p.ctx);
  assert.equal(out, undefined);
});

test('handler: an unfinished turn does not run the check', async () => {
  const p = fakePi({ exec: () => assert.fail('must not execute on a non-completed turn') });
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);
  assert.equal(await p.handlers.turn_end[0](editedTurn({ outcome: 'aborted' }), p.ctx), undefined);
});

test('no-op guard: an identical (command, files) run inside the debounce window is skipped', () => {
  // The debounce key is built from command + sorted paths; this pins the constant so a
  // change to it is a deliberate decision rather than an accident.
  assert.equal(DEBOUNCE_MS, 10_000);
});

test('handler: a configured edit runs the check and appends its result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-project-'));
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(
    join(dir, '.pi', 'verify.json'),
    JSON.stringify({ commands: ['pnpm tc'], timeoutSeconds: 60, extensions: ['ts'] }),
  );

  const calls = [];
  const p = fakePi({
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'all good', stderr: '', code: 0, killed: false, truncated: false };
    },
  });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const out = await p.handlers.turn_end[0](editedTurn(), p.ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'sh');
  assert.deepEqual(calls[0].args, ['-c', 'pnpm tc']);
  assert.equal(calls[0].options.cwd, dir);
  assert.equal(calls[0].options.timeout, 60_000, 'timeout is milliseconds');
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].type, 'custom_message');
  assert.equal(out.entries[0].customType, 'verify-after-edit');
  assert.match(out.entries[0].content, /all good/);
  assert.equal(out.continue, undefined, 'a tool result already forces the next request');
});

test('handler: a project-level check runs at the project root, not the subdirectory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-project-'));
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(join(dir, '.git'), 'gitdir: /dev/null\n');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
  await writeFile(join(dir, '.pi', 'verify.json'), JSON.stringify({ commands: ['pnpm tc'] }));
  await mkdir(join(dir, 'src', 'deep'), { recursive: true });

  const calls = [];
  const p = fakePi({ exec: async (_c, _a, options) => {
    calls.push(options);
    return { stdout: '', stderr: '', code: 0, killed: false, truncated: false };
  } });
  // The session opened two levels below the repo root, which is what a worktree subdir
  // launch or an editor integration does.
  p.ctx.cwd = join(dir, 'src', 'deep');
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  await p.handlers.turn_end[0](editedTurn(), p.ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, dir, 'pnpm tc is root-relative, so it runs at the repo root');
});

test('handler: runIn "cwd" keeps the session directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-project-'));
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(
    join(dir, '.pi', 'verify.json'),
    JSON.stringify({ commands: ['pnpm tc'], runIn: 'cwd' }),
  );

  const calls = [];
  const p = fakePi({ exec: async (_c, _a, options) => {
    calls.push(options);
    return { stdout: '', stderr: '', code: 0, killed: false, truncated: false };
  } });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);
  await p.handlers.turn_end[0](editedTurn(), p.ctx);
  assert.equal(calls[0].cwd, dir);
});

test('handler: a check the model already ran this turn is not duplicated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-project-'));
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(join(dir, '.pi', 'verify.json'), JSON.stringify({ commands: ['pnpm tc'] }));

  const p = fakePi({ exec: () => assert.fail('must not duplicate the check the model ran') });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const turn = editedTurn();
  turn.message.content.push({ type: 'toolCall', id: 'z', name: 'bash', arguments: { command: 'cd . && pnpm tc' } });
  assert.equal(await p.handlers.turn_end[0](turn, p.ctx), undefined);
});

test('handler: a failing check stops the chain after the first command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-project-'));
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(
    join(dir, '.pi', 'verify.json'),
    JSON.stringify({ commands: ['first', 'second'] }),
  );

  const seen = [];
  const p = fakePi({
    exec: async (_command, args) => {
      seen.push(args[1]);
      return { stdout: '', stderr: 'error TS1', code: 1, killed: false, truncated: false };
    },
  });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const out = await p.handlers.turn_end[0](editedTurn(), p.ctx);
  assert.deepEqual(seen, ['first']);
  assert.match(out.entries[0].content, /Fix what this reports/);
});

test('handler: an edit to an ignored path runs nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-project-'));
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(
    join(dir, '.pi', 'verify.json'),
    JSON.stringify({ commands: ['pnpm tc'], ignorePaths: ['src'] }),
  );

  const p = fakePi({ exec: () => assert.fail('must not check an ignored path') });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);
  assert.equal(await p.handlers.turn_end[0](editedTurn(), p.ctx), undefined);
});

// ── codemode: edits made by a tool the model called ────────────────────────

/** Drive the extension the way pi does: nested results first, then the parent's. */
async function runScriptedTurn(p, { parentId = 'call_a', paths, scriptBash, parentError = false }) {
  await p.handlers.turn_start?.[0]?.({ turnIndex: 1 }, p.ctx);
  let n = 0;
  for (const path of paths) {
    n += 1;
    await p.handlers.tool_result[0](
      {
        type: 'tool_result',
        toolName: 'write',
        toolCallId: `${parentId}/${n}`,
        parentToolCallId: parentId,
        input: { path, content: 'x' },
        content: [],
        isError: false,
      },
      p.ctx,
    );
  }
  if (scriptBash) {
    n += 1;
    await p.handlers.tool_result[0](
      {
        type: 'tool_result',
        toolName: 'bash',
        toolCallId: `${parentId}/${n}`,
        parentToolCallId: parentId,
        input: { command: scriptBash },
        content: [],
        isError: false,
      },
      p.ctx,
    );
  }
  return p.handlers.turn_end[0](
    {
      type: 'turn_end',
      turnIndex: 1,
      outcome: 'completed',
      entries: [],
      message: turnMessage([{ id: parentId, name: 'codemode', arguments: { code: '…' } }]),
      toolResults: [{ toolCallId: parentId, isError: parentError }],
    },
    p.ctx,
  );
}

async function projectWith(verifyJson) {
  const dir = await mkdtemp(join(tmpdir(), 'verify-project-'));
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(join(dir, '.pi', 'verify.json'), JSON.stringify(verifyJson));
  return dir;
}

test('handler: a codemode-only turn runs the check', async () => {
  const dir = await projectWith({ commands: ['pnpm tc'] });
  const calls = [];
  const p = fakePi({
    exec: async (_command, args, options) => {
      calls.push({ command: args[1], cwd: options.cwd });
      return { stdout: 'all good', stderr: '', code: 0, killed: false, truncated: false };
    },
  });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const out = await runScriptedTurn(p, { paths: ['src/a.ts'] });
  assert.equal(calls.length, 1, 'a scripted write is a write');
  assert.equal(calls[0].command, 'pnpm tc');
  assert.equal(calls[0].cwd, dir);
  assert.match(out.entries[0].content, /src\/a\.ts/);
  assert.match(out.entries[0].content, /all good/);
});

test('handler: a script that failed after writing still gets checked', async () => {
  const dir = await projectWith({ commands: ['pnpm tc'] });
  const p = fakePi();
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const out = await runScriptedTurn(p, { paths: ['src/a.ts'], parentError: true });
  assert.ok(out, 'the write landed even though the script threw');
});

test('handler: a check the script already ran is not duplicated', async () => {
  const dir = await projectWith({ commands: ['pnpm tc'] });
  const p = fakePi({ exec: () => assert.fail('must not duplicate the scripted check') });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  assert.equal(await runScriptedTurn(p, { paths: ['src/a.ts'], scriptBash: 'pnpm tc' }), undefined);
});

test('handler: nested calls are not carried into the next turn', async () => {
  const dir = await projectWith({ commands: ['pnpm tc'] });
  let runs = 0;
  const p = fakePi({
    exec: async () => {
      runs += 1;
      return { stdout: '', stderr: '', code: 0, killed: false, truncated: false };
    },
  });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  await runScriptedTurn(p, { paths: ['src/a.ts'] });
  assert.equal(runs, 1);
  // The next turn calls a tool that writes nothing; the previous turn's script must not fire it.
  await p.handlers.turn_start?.[0]?.({ turnIndex: 2 }, p.ctx);
  const quiet = await p.handlers.turn_end[0](
    {
      type: 'turn_end',
      outcome: 'completed',
      entries: [],
      message: turnMessage([{ id: 'call_b', name: 'codemode', arguments: { code: '…' } }]),
      toolResults: [{ toolCallId: 'call_b', isError: false }],
    },
    p.ctx,
  );
  assert.equal(quiet, undefined);
  assert.equal(runs, 1);
});

test('handler: a script that writes dozens of files triggers one run, not dozens', async () => {
  const dir = await projectWith({ commands: ['pnpm tc'] });
  const paths = Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts`);
  const runs = [];
  const p = fakePi({
    exec: async (_command, args) => {
      runs.push(args[1]);
      return { stdout: '', stderr: '', code: 0, killed: false, truncated: false };
    },
  });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const out = await runScriptedTurn(p, { paths });
  assert.equal(runs.length, 1, 'the check is a turn-boundary event, not a per-file one');
  assert.match(out.entries[0].content, /40 files/, 'the file set is reported, not enumerated');
  assert.match(out.entries[0].content, /src\/file-0\.ts/, 'the first few are named');
  assert.match(out.entries[0].content, /…/);
});

/** Feed arbitrary nested results, then close the turn — the shape pi produces for a script. */
async function feedScript(p, records, { parentId = 'call_a', parentError = false } = {}) {
  await p.handlers.turn_start?.[0]?.({ turnIndex: 1 }, p.ctx);
  for (const record of records) {
    await p.handlers.tool_result[0](
      { type: 'tool_result', content: [], isError: false, toolCallId: `${parentId}/x`, parentToolCallId: parentId, ...record },
      p.ctx,
    );
  }
  return p.handlers.turn_end[0](
    {
      type: 'turn_end',
      turnIndex: 1,
      outcome: 'completed',
      entries: [],
      message: turnMessage([{ id: parentId, name: 'codemode', arguments: { code: '…' } }]),
      toolResults: [{ toolCallId: parentId, isError: parentError }],
    },
    p.ctx,
  );
}

test('handler: a script that reads hundreds of files does not hide its one edit', async () => {
  const dir = await projectWith({ commands: ['pnpm tc'] });
  let runs = 0;
  const p = fakePi({
    exec: async () => {
      runs += 1;
      return { stdout: '', stderr: '', code: 0, killed: false, truncated: false };
    },
  });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const reads = Array.from({ length: 300 }, (_, i) => ({
    toolName: 'read',
    toolCallId: `call_a/r${i}`,
    input: { path: `src/f${i}.ts` },
  }));
  const write = { toolName: 'write', toolCallId: 'call_a/w1', input: { path: 'src/edited.ts' } };
  const out = await feedScript(p, [...reads, write]);

  assert.equal(runs, 1);
  assert.match(out.entries[0].content, /src\/edited\.ts/, 'the edit survives a noisy script');
});

test('handler: hundreds of scripted edits are all reported, none evicted', async () => {
  const dir = await projectWith({ commands: ['pnpm tc'] });
  let runs = 0;
  const p = fakePi({
    exec: async () => {
      runs += 1;
      return { stdout: '', stderr: '', code: 0, killed: false, truncated: false };
    },
  });
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const writes = Array.from({ length: 300 }, (_, i) => ({
    toolName: 'write',
    toolCallId: `call_a/w${i}`,
    input: { path: `src/f${i}.ts` },
  }));
  const out = await feedScript(p, writes);
  assert.equal(runs, 1);
  assert.match(out.entries[0].content, /300 files/, 'a bounded list must not silently shrink the file set');
});

test('handler: a script rewriting one file reports one file', async () => {
  const dir = await projectWith({ commands: ['pnpm tc'] });
  const p = fakePi();
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const writes = Array.from({ length: 50 }, (_, i) => ({
    toolName: 'write',
    toolCallId: `call_a/w${i}`,
    input: { path: 'src/a.ts' },
  }));
  const out = await feedScript(p, writes);
  assert.match(out.entries[0].content, /after your edit to src\/a\.ts/);
  assert.doesNotMatch(out.entries[0].content, /50 files/);
});

test('handler: a failed scripted write does not hide a later successful one', async () => {
  const dir = await projectWith({ commands: ['pnpm tc'] });
  const p = fakePi();
  p.ctx.cwd = dir;
  await p.handlers.session_start[0]({ reason: 'startup' }, p.ctx);

  const out = await feedScript(p, [
    { toolName: 'write', toolCallId: 'call_a/w0', input: { path: 'src/a.ts' }, isError: true },
    { toolName: 'write', toolCallId: 'call_a/w1', input: { path: 'src/a.ts' } },
  ]);
  assert.match(out.entries[0].content, /src\/a\.ts/);
});

test('nestedRecordKey: records edits and bash only, keyed to collapse repeats', () => {
  const write = (path, extra = {}) => ({ toolName: 'write', toolCallId: 'p/1', parentToolCallId: 'p', input: { path }, ...extra });
  assert.equal(nestedRecordKey(write('a.ts')), nestedRecordKey(write('a.ts')), 'same path and parent collapses');
  assert.notEqual(nestedRecordKey(write('a.ts')), nestedRecordKey(write('b.ts')));
  assert.notEqual(nestedRecordKey(write('a.ts')), nestedRecordKey(write('a.ts', { isError: true })));
  assert.notEqual(
    nestedRecordKey(write('a.ts')),
    nestedRecordKey({ toolName: 'edit', toolCallId: 'p/2', parentToolCallId: 'p', input: { path: 'a.ts' } }),
  );
  assert.equal(nestedRecordKey({ toolName: 'read', toolCallId: 'p/3', parentToolCallId: 'p', input: { path: 'a.ts' } }), null);
  assert.equal(
    nestedRecordKey({ toolName: 'bash', toolCallId: 'p/4', parentToolCallId: 'p', input: { command: 'pnpm tc' } }),
    'bash\u0000p\u0000pnpm tc',
  );
  assert.equal(nestedRecordKey({ toolName: 'bash', input: { command: '  ' } }), null);
  assert.equal(nestedRecordKey({ toolName: 'write', input: {} }), null);
});

// ── output budget: one file's limit is not a dozen files' limit ────────────

const failingRun = (lines, command = 'pnpm tc') => ({
  command,
  code: 1,
  killed: false,
  stdout: Array.from({ length: lines }, (_, i) => `src/f${i}.ts(1,1): error TS2322`).join('\n'),
  stderr: '',
  durationMs: 1000,
});

test('outputBudget: the baseline is one file, and growth is bounded', () => {
  assert.deepEqual(outputBudget(1), { lines: 100, chars: 8000 });
  assert.deepEqual(outputBudget(0), outputBudget(1), 'a missing count is not a bigger budget');
  assert.ok(outputBudget(10).lines > outputBudget(1).lines);
  assert.ok(outputBudget(10).chars > outputBudget(1).chars);
  assert.ok(outputBudget(40).lines > outputBudget(10).lines);
  // A pathological file count must not buy an unbounded message.
  assert.ok(outputBudget(10_000).lines <= 400);
  assert.ok(outputBudget(10_000).chars <= 24_000);
  assert.deepEqual(outputBudget(1000), outputBudget(200), 'the driver is clamped');
});

test('renderVerifyMessage: a wide edit keeps the failure list a single file would lose', () => {
  const many = Array.from({ length: 20 }, (_, i) => `src/w${i}.ts`);
  const one = renderVerifyMessage(['a.ts'], [failingRun(300)], true);
  const wide = renderVerifyMessage(many, [failingRun(300)], true);
  // 300 lines does not fit the single-file budget, but does fit twenty files' worth.
  assert.match(one, /more line\(s\) omitted/);
  assert.doesNotMatch(wide, /more line\(s\) omitted/);
  assert.match(wide, /src\/f299\.ts/, 'the last failure is still there');
  assert.ok(wide.length > one.length);
});

test('renderVerifyMessage: the instruction survives even when output is enormous', () => {
  const files = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`);
  const text = renderVerifyMessage(files, [failingRun(5000)], true);
  assert.match(text, /exit 1/, 'the status line is reserved, never truncated away');
  assert.match(text, /Fix what this reports before moving on\.?$/, 'the closing instruction is never cut');
  assert.ok(text.length <= 24_000, `ceiling must hold, got ${text.length}`);
  assert.match(text, /omitted|truncated/, 'says what it dropped');
});

test('renderVerifyMessage: a message under budget is untouched', () => {
  const text = renderVerifyMessage(['a.ts'], [failingRun(3)], true);
  assert.doesNotMatch(text, /truncated/);
});

test('clampChars: cuts on a line boundary and says so', () => {
  const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const out = clampChars(body, 60);
  assert.ok(out.length <= 60, `got ${out.length}`);
  assert.match(out, /truncated/);
  assert.ok(!out.includes('line 49'));
  assert.equal(clampChars('short', 100), 'short');
  assert.match(clampChars('anything', 0), /truncated/);
});
