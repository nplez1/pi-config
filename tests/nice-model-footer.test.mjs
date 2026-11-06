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
const assistant = (provider, model) => ({
  type: 'message',
  message: { role: 'assistant', provider, model, content: [], usage },
});

const FUSION = { provider: 'copilot-fusion', id: 'standard', name: 'Fusion/Standard', api: 'pi-virtual', reasoning: false, contextWindow: 100000 };
const LUNA = { provider: 'github-copilot', id: 'gpt-6-luna', name: 'GPT-6 Luna', api: 'openai-responses', reasoning: true, contextWindow: 1000000 };

// The deepseek router (deepseek-routing.ts) and the side it can route to.
const DEEPSEEK_AUTO = { provider: 'deepseek', id: 'deepseek-flash-auto', name: 'Deepseek v4.1 Flash Auto', api: 'pi-virtual', reasoning: true, contextWindow: 1000000 };
const DEEPINFRA_FLASH = { provider: 'deepinfra', id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', name: 'Deepseek v4.1 Flash 1017 (DeepInfra)', api: 'openai-completions', reasoning: true, contextWindow: 1000000 };

function render({ model, branch = [], providers = 2, width = 200, thinkingLevel = 'off', models = [LUNA], providerNames = {} }) {
  let footerFactory;
  const handlers = {};
  register({ on: (name, fn) => { handlers[name] = fn; } });
  const ctx = {
    mode: 'tui',
    cwd: '/tmp/work',
    model,
    thinkingLevel,
    sessionManager: {
      getEntries: () => branch,
      getBranch: () => branch,
      getCwd: () => '/tmp/work',
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
    getExtensionStatuses: () => new Map(),
    getAvailableProviderCount: () => providers,
    onBranchChange: () => () => {},
  };
  return footerFactory({ requestRender: () => {} }, theme, footerData).render(width).join('\n');
}

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
  });
  assert.ok(out.includes('(deepseek) Auto • high → v4.1Flash v1017 (DeepInfra)'), out);
});

test('a directly selected deepinfra model shows the short label alone', () => {
  const out = render({ model: DEEPINFRA_FLASH, models: [DEEPINFRA_FLASH] });
  assert.ok(out.includes('(deepinfra) v4.1Flash v1017 • thinking off'), out);
  assert.ok(!out.includes('→'), out);
});
