import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the real fork runtime in isolation. Pi normally supplies these peer
// modules; the test only needs the functions formatting uses.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-goal-footer-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const plugin = fileURLToPath(new URL('../plugins/pi-codex-goal/', import.meta.url));
fs.cpSync(path.join(plugin, 'src'), path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
for (const [name, code] of [
  ['pi-tui', 'import { stripVTControlCharacters } from "node:util"; export const stripTerminalSequences = stripVTControlCharacters;'],
  ['pi-ai', 'export function isContextOverflow() { return false; }'],
]) {
  const dir = path.join(root, 'node_modules', '@earendil-works', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module","exports":"./index.js"}');
  fs.writeFileSync(path.join(dir, 'index.js'), code);
}
const { createGoalRuntimeStatus } = await import(pathToFileURL(path.join(root, 'src/goal-runtime-status.ts')));

function fixture(mode = 'tui') {
  let goal = null;
  let attention = null;
  let autoResume = false;
  let backgroundWork = null;
  const statuses = [];
  const widgets = [];
  const ctx = { mode, ui: {
    setStatus: (...args) => statuses.push(args),
    setWidget: (...args) => widgets.push(args),
  } };
  const runtime = createGoalRuntimeStatus({
    getGoalForDisplay: () => goal,
    getGoalStatus: () => goal?.status ?? null,
    getRecoveryAttention: () => attention,
    isProviderLimitAutoResumeScheduled: () => autoResume,
    getBackgroundWork: () => backgroundWork,
  });
  return {
    runtime, ctx, statuses, widgets,
    setGoal: value => { goal = value; },
    setAttention: value => { attention = value; },
    setAutoResume: value => { autoResume = value; },
    setBackgroundWork: value => { backgroundWork = value; },
    last: () => statuses.at(-1)?.[1],
  };
}
function goal(status, objective = 'Ship the feature') {
  return { goalId: 'goal-1', objective, status, tokenBudget: null,
    usage: { tokensUsed: 0, activeSeconds: 30 }, createdAt: 1, updatedAt: 1 };
}

test('active goal has one sanitized status row and live refresh', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  f.setGoal(goal('active', 'Ship\n\u001b[31mthe\u001b[0m feature'));
  f.runtime.refreshUi(f.ctx);
  assert.equal(f.last(), 'Pursuing goal (30s) · Goal (active): Ship the feature');
  assert.deepEqual(f.widgets, [['codex-goal-objective', undefined]]);
  f.setGoal({ ...goal('active'), usage: { tokensUsed: 0, activeSeconds: 31 } });
  t.mock.timers.tick(1000);
  assert.equal(f.last(), 'Pursuing goal (31s) · Goal (active): Ship the feature');

  // Background work is what the goal is doing, not a separate state: it rides
  // in the same parenthesis as usage and never becomes "waiting".
  f.setBackgroundWork({ count: 2, labels: ['Explore', 'review'], unknown: false });
  t.mock.timers.tick(1000);
  assert.equal(
    f.last(),
    'Pursuing goal (31s, 2 subagents: Explore, review) · Goal (active): Ship the feature',
  );
  f.setBackgroundWork({ count: 1, labels: [], unknown: true });
  t.mock.timers.tick(1000);
  assert.match(f.last(), /Pursuing goal \(31s, subagents running\)/);
  f.setBackgroundWork(null);
  f.runtime.stopStatusRefresh();
});

test('status transitions keep important warnings and clear the objective', () => {
  const f = fixture();
  for (const [status, prefix] of [
    ['paused', 'Goal paused'], ['blocked', 'Goal blocked'],
    ['waiting', 'Goal waiting'], ['budgetLimited', 'Goal abandoned'],
  ]) {
    f.setGoal({ ...goal(status), waitingReason: 'worker' });
    f.runtime.refreshUi(f.ctx);
    assert.ok(f.last().startsWith(prefix), status);
    assert.match(f.last(), / · Goal \(.*\): Ship the feature$/);
  }
  f.setGoal(goal('paused'));
  f.setAutoResume(true);
  f.runtime.refreshUi(f.ctx);
  assert.match(f.last(), /Auto-resume will retry/);
  f.setAutoResume(false);
  f.setAttention({ kind: 'paused', reason: 'needs review' });
  f.runtime.refreshUi(f.ctx);
  assert.match(f.last(), /Goal needs attention \(needs review\)/);
  f.setAttention(null);
  f.setGoal(goal('complete'));
  f.runtime.refreshUi(f.ctx);
  assert.equal(f.last(), 'Goal achieved (30s)');
  f.setGoal(null);
  f.runtime.refreshUi(f.ctx);
  assert.equal(f.last(), undefined);
  f.runtime.stopStatusRefresh();
});

test('non-TUI mode retains upstream status without a widget', () => {
  const f = fixture('rpc');
  f.setGoal(goal('paused'));
  f.runtime.refreshUi(f.ctx);
  assert.equal(f.last(), 'Goal paused (/goal resume)');
  assert.deepEqual(f.widgets, []);
  f.runtime.stopStatusRefresh();
});
