import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the real extension source in isolation. Its only runtime peer import
// is @earendil-works/pi-tui (width helpers); pi-ai/pi-coding-agent are type-only.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nice-footer-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const extension = fileURLToPath(new URL('../dot-pi/agent/extensions/nice-model-footer.ts', import.meta.url));
fs.cpSync(extension, path.join(root, 'nice-model-footer.ts'));
fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
const tuiDir = path.join(root, 'node_modules', '@earendil-works', 'pi-tui');
fs.mkdirSync(tuiDir, { recursive: true });
fs.writeFileSync(path.join(tuiDir, 'package.json'), '{"type":"module","exports":"./index.js"}');
fs.writeFileSync(path.join(tuiDir, 'index.js'), [
  'import { stripVTControlCharacters } from "node:util";',
  'export const visibleWidth = s => stripVTControlCharacters(String(s)).length;',
  'export const truncateToWidth = (s, w, tail = "...") => {',
  '  const str = String(s);',
  '  return visibleWidth(str) <= w ? str : str.slice(0, Math.max(0, w - tail.length)) + tail;',
  '};',
].join('\n'));
const { default: register } = await import(pathToFileURL(path.join(root, 'nice-model-footer.ts')));

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } };
const assistant = (provider, model, u = usage) => ({
  type: 'message',
  message: { role: 'assistant', provider, model, content: [], usage: u },
});

const withUsage = (overrides) => ({ ...usage, ...overrides, cost: { total: overrides.costTotal ?? usage.cost.total } });

const FUSION = { provider: 'copilot-fusion', id: 'standard', name: 'Fusion/Standard', api: 'pi-virtual', reasoning: false, contextWindow: 100000 };
const LUNA = { provider: 'github-copilot', id: 'gpt-6-luna', name: 'GPT-6 Luna', api: 'openai-responses', reasoning: true, contextWindow: 1000000 };

// The deepseek router (deepseek-routing.ts) and the side it can route to.
const DEEPSEEK_AUTO = { provider: 'deepseek', id: 'deepseek-flash-auto', name: 'Deepseek v4.1 Flash Auto', api: 'pi-virtual', reasoning: true, contextWindow: 1000000 };
const DEEPINFRA_FLASH = { provider: 'deepinfra', id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', name: 'Deepseek v4.1 Flash 1017 (DeepInfra)', api: 'openai-completions', reasoning: true, contextWindow: 1000000 };

function render({ model, branch = [], providers = 2, width = 200, thinkingLevel = 'off', models = [LUNA], providerNames = {}, statuses = new Map(), cwd = '/tmp/work' }) {
  let footerFactory;
  const handlers = {};
  register({ on: (name, fn) => { handlers[name] = fn; } });
  const ctx = {
    mode: 'tui',
    cwd,
    model,
    thinkingLevel,
    sessionManager: {
      getEntries: () => branch,
      getBranch: () => branch,
      getCwd: () => cwd,
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ contextWindow: model?.contextWindow ?? 100000, percent: 12.3 }),
    modelRegistry: {
      isUsingOAuth: () => false,
      getProvider: () => undefined,
      getProviderDisplayName: provider => providerNames[provider] ?? provider,
      find: (provider, id) => models.find(m => m.provider === provider && m.id === id),
    },
    ui: { setFooter: factory => { footerFactory = factory; } },
  };
  handlers.session_start(undefined, ctx);
  const theme = { fg: (_color, s) => s, bold: s => s };
  const footerData = {
    getGitBranch: () => undefined,
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => providers,
    onBranchChange: () => () => {},
  };
  return footerFactory({ requestRender: () => {} }, theme, footerData).render(width).join('\n');
}

test('cache read and write counters are gone from the stats row', () => {
  const out = render({
    model: LUNA,
    branch: [assistant('github-copilot', 'gpt-6-luna', withUsage({ cacheRead: 15_000_000, cacheWrite: 48_000 }))],
  });
  assert.ok(!/\bR\d/.test(out), `no R counter: ${out}`);
  assert.ok(!/\bW\d/.test(out), `no W counter: ${out}`);
});

test('the cache-hit rate survives, rounded to a whole percent', () => {
  const out = render({
    model: LUNA,
    // 999 cache reads of a 1000-token prompt = 99.9% → CH100%.
    branch: [assistant('github-copilot', 'gpt-6-luna', withUsage({ input: 1, cacheRead: 999, cacheWrite: 0 }))],
  });
  assert.ok(out.includes('CH100%'), out);
});

test('the cache-hit rate only appears once the session has cache traffic', () => {
  const out = render({
    model: LUNA,
    branch: [assistant('github-copilot', 'gpt-6-luna', withUsage({ input: 1000, cacheRead: 0, cacheWrite: 0 }))],
  });
  assert.ok(!out.includes('CH'), out);
});

test('cost drops to two decimals and loses its leading zero under a dollar', () => {
  const cents = render({
    model: LUNA,
    branch: [assistant('github-copilot', 'gpt-6-luna', withUsage({ costTotal: 0.084 }))],
  });
  assert.ok(cents.includes('$.08'), cents);

  const dollars = render({
    model: LUNA,
    branch: [assistant('github-copilot', 'gpt-6-luna', withUsage({ costTotal: 1.239 }))],
  });
  assert.ok(dollars.includes('$1.24'), dollars);
});

test('context reads as a whole percent over a whole window', () => {
  const out = render({ model: LUNA });
  assert.ok(out.includes('12%/1M'), out);
  assert.ok(!out.includes('12.3'), out);
  assert.ok(!out.includes('1.0M'), out);
});

test('the loop call-out rides on the path line instead of taking its own row', () => {
  const out = render({
    model: LUNA,
    statuses: new Map([['loop', '◷ 1 loop · next in 4m 30s']]),
  });
  const lines = out.split('\n');
  assert.equal(lines[0], '/tmp/work • ◷ 1 loop · next in 4m 30s', out);
  assert.equal(lines.filter(line => line.includes('◷')).length, 1, 'exactly one line carries the loop');
  assert.ok(!lines.slice(1).some(line => line.includes('loop')), out);
});

test('the loop call-out is the one thing a narrow footer keeps', () => {
  // 40 columns cannot hold the path and the countdown: the path gives way.
  const out = render({
    model: LUNA,
    width: 40,
    statuses: new Map([['loop', '◷ 2 loops · next in 12m']]),
  });
  const first = out.split('\n')[0];
  assert.ok(first.endsWith('◷ 2 loops · next in 12m'), out);
  assert.ok(first.length <= 40, `${first} is wider than the footer`);
});

test('a loop call-out that cannot fit at all is truncated, not dropped', () => {
  const out = render({
    model: LUNA,
    width: 12,
    statuses: new Map([['loop', '◷ 2 loops · next in 12m']]),
  });
  const first = out.split('\n')[0];
  assert.equal(first, '◷ 2 loops...', out);
});

test('unrelated extension statuses still get their own row', () => {
  const out = render({
    model: LUNA,
    statuses: new Map([
      ['loop', '◷ 1 loop · running'],
      ['zeta-ext', 'ready'],
      ['alpha-ext', 'watching'],
    ]),
  });
  const lines = out.split('\n');
  assert.equal(lines[0], '/tmp/work • ◷ 1 loop · running', out);
  assert.equal(lines.at(-1), 'watching ready', out);
});

test('a multi-line status is flattened before it reaches the path line', () => {
  const out = render({
    model: LUNA,
    statuses: new Map([['loop', '◷ 1 loop\nnext  in\t4m']]),
  });
  assert.equal(out.split('\n')[0], '/tmp/work • ◷ 1 loop next in 4m', out);
});

test('a virtual selection shows where the latest response routed', () => {
  const out = render({ model: FUSION, branch: [assistant('github-copilot', 'gpt-6-luna')] });
  assert.ok(out.includes('(copilot-fusion) Fusion/Standard → GPT-6 Luna'), out);
});

test('a virtual selection with no response yet shows no arrow', () => {
  const out = render({ model: FUSION, branch: [] });
  assert.ok(out.includes('(copilot-fusion) Fusion/Standard'), out);
  assert.ok(!out.includes('→'), out);
});

test('a physical selection never gets an arrow', () => {
  const out = render({ model: LUNA, branch: [assistant('github-copilot', 'gpt-6-luna')] });
  assert.ok(out.includes('GPT6Luna • thinking off'), out);
  assert.ok(!out.includes('→'), out);
});

test('an unknown routed model falls back to its raw id', () => {
  const out = render({ model: FUSION, branch: [assistant('other-provider', 'mystery-9')] });
  assert.ok(out.includes('Fusion/Standard → mystery-9'), out);
});

test('a single provider drops the parenthesized prefix but keeps the arrow', () => {
  const out = render({ model: FUSION, branch: [assistant('github-copilot', 'gpt-6-luna')], providers: 1 });
  assert.ok(out.includes('Fusion/Standard → GPT-6 Luna'), out);
  assert.ok(!out.includes('(copilot-fusion)'), out);
});

test('the deepseek router shows its short label and the routed side', () => {
  const out = render({
    model: DEEPSEEK_AUTO,
    branch: [assistant('deepinfra', DEEPINFRA_FLASH.id)],
    thinkingLevel: 'high',
    models: [DEEPINFRA_FLASH],
    providerNames: { deepinfra: 'DeepInfra' },
    statuses: new Map([['deepseek-pricing', 'off-peak → DeepInfra']]),
  });
  // No "(deepseek)" prefix and no trailing "→ DeepInfra": the routed label
  // already names the side that answered.
  assert.ok(out.includes('Auto • high → v4.1F1017 (DeepInfra) • off-peak'), out);
  assert.ok(!out.includes('(deepseek)'), out);
  assert.ok(!out.includes('off-peak → DeepInfra'), out);
});

test('the deepseek tier keeps its target when it disagrees with the routed side', () => {
  // A peak boundary can cross mid-session: the latest response went to
  // DeepInfra, but the next request will not, so both sides are worth showing.
  const out = render({
    model: DEEPSEEK_AUTO,
    branch: [assistant('deepinfra', DEEPINFRA_FLASH.id)],
    thinkingLevel: 'high',
    models: [DEEPINFRA_FLASH],
    providerNames: { deepinfra: 'DeepInfra' },
    statuses: new Map([['deepseek-pricing', 'peak → DeepSeek']]),
  });
  assert.ok(out.includes('Auto • high → v4.1F1017 (DeepInfra) • peak → DeepSeek'), out);
});

test('the deepseek tier keeps its target before the first response', () => {
  const out = render({
    model: DEEPSEEK_AUTO,
    branch: [],
    thinkingLevel: 'high',
    models: [DEEPINFRA_FLASH],
    statuses: new Map([['deepseek-pricing', 'off-peak → DeepInfra']]),
  });
  assert.ok(out.includes('Auto • high • off-peak → DeepInfra'), out);
});

test('a directly selected deepinfra model shows the short label alone', () => {
  const out = render({ model: DEEPINFRA_FLASH, models: [DEEPINFRA_FLASH] });
  assert.ok(out.includes('(deepinfra) v4.1F1017 • thinking off'), out);
  assert.ok(!out.includes('→'), out);
});
