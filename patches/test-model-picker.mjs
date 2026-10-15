#!/usr/bin/env node
/**
 * test-model-picker.mjs — behavioural test for the patches in this directory.
 *
 * Imports the *patched* pi bundle chunk and drives the real
 * ModelSelectorComponent with a fake TUI, fake ModelRuntime and fake session,
 * then asserts the reasoning-level line, the ←/→ handling and that Enter
 * commits the level through the session.
 *
 *   node ~/Code/pi-config/patches/test-model-picker.mjs
 *
 * Run it after `model-picker.mjs` (and after every pi update) — it is the only
 * check that the patch does something, as opposed to merely loading.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(HERE, ".state.json");

// The bundle reads the theme from a well-known global symbol; a stub keeps the
// assertions free of ANSI codes and works without a terminal.
globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")] = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : undefined;
if (!state?.chunk || !fs.existsSync(state.chunk)) {
  console.error("test-model-picker: no patched chunk recorded — run model-picker.mjs first");
  process.exit(2);
}

const bundle = await import(pathToFileURL(state.chunk).href);
const { ModelSelectorComponent, InteractiveMode } = bundle;
assert.equal(typeof ModelSelectorComponent, "function", "ModelSelectorComponent missing from chunk");
assert.equal(typeof InteractiveMode, "function", "InteractiveMode missing from chunk");

const MODELS = [
  { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash", reasoning: true },
  {
    provider: "github-copilot",
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null },
  },
  { provider: "omlx", id: "local-only", name: "Local Only", reasoning: false },
];

const modelRuntime = {
  getAvailableSnapshot: () => MODELS,
  getModel: (provider, id) => MODELS.find((m) => m.provider === provider && m.id === id),
  getError: () => undefined,
  refresh: ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
};

/** Renders the picker and returns its visible text. */
function textOf(selector) {
  return selector
    .render(100)
    .map((line) => line.trimEnd())
    .join("\n");
}

function reasoningLine(selector) {
  const line = textOf(selector)
    .split("\n")
    .find((candidate) => candidate.includes("Reasoning:"));
  assert.ok(line, `no "Reasoning:" line rendered:\n${textOf(selector)}`);
  return line.trim().replace(/\s+/g, " ");
}

const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const ENTER = "\r";

function makeSelector(sessionLevel) {
  const calls = { selected: [], defaulted: [] };
  // The patch reads the session from here; `showModelSelector` sets it before
  // the component exists, so the level is known on the first render.
  globalThis.__piPickerMode = { session: { thinkingLevel: sessionLevel } };
  const selector = new ModelSelectorComponent(
    { requestRender() {} },
    MODELS[0],
    modelRuntime,
    [],
    (model) => calls.selected.push(model),
    () => {},
    undefined,
    (model) => calls.defaulted.push(model),
  );
  return { selector, calls };
}

// ---------------------------------------------------------- display + arrows

{
  const { selector } = makeSelector("medium");
  assert.equal(reasoningLine(selector), "Reasoning: medium ← →", "initial level comes from the session");

  selector.handleInput(RIGHT);
  assert.equal(reasoningLine(selector), "Reasoning: high ← →", "→ advances the level");

  selector.handleInput(RIGHT);
  assert.equal(reasoningLine(selector), "Reasoning: high ← →", "→ clamps at the model's top level");

  selector.handleInput(LEFT);
  selector.handleInput(LEFT);
  selector.handleInput(LEFT);
  selector.handleInput(LEFT);
  assert.equal(reasoningLine(selector), "Reasoning: off ← →", "← clamps at off");

  // Pending level "low" on a model that supports off/minimal/low/medium/high.
  selector.handleInput(RIGHT);
  selector.handleInput(RIGHT);
  assert.equal(reasoningLine(selector), "Reasoning: low ← →");

  // Switching the highlighted model re-clamps the pending level to the levels
  // that model actually accepts (its thinkingLevelMap hides minimal/low).
  selector.selectedIndex = 1;
  selector.updateList();
  assert.equal(reasoningLine(selector), "Reasoning: medium ← →", "pending level is clamped to the highlighted model");
  selector.handleInput(RIGHT);
  assert.equal(reasoningLine(selector), "Reasoning: high ← →", "→ skips levels the model does not support");
  selector.handleInput(LEFT);
  assert.equal(reasoningLine(selector), "Reasoning: medium ← →", "← skips unsupported levels");

  // A model with no reasoning at all.
  selector.selectedIndex = 2;
  selector.updateList();
  assert.equal(reasoningLine(selector), "Reasoning: off · model has no thinking levels", "non-reasoning model says so");
  selector.handleInput(RIGHT);
  assert.equal(reasoningLine(selector), "Reasoning: off · model has no thinking levels", "arrows are inert");

  // Search filtering must not lose the line, and ←/→ must not type into the field.
  selector.selectedIndex = 0;
  selector.updateList();
  for (const character of "astra") selector.handleInput(character);
  assert.equal(selector.getSearchInput().getValue(), "astra", "typing still reaches the search input");
  assert.equal(selector.filteredModels.length, 1, "the query filters the list");
  assert.equal(reasoningLine(selector), "Reasoning: medium ← →", "level survives filtering");
  selector.handleInput(LEFT);
  assert.equal(selector.getSearchInput().getValue(), "astra", "← does not move the search caret");
  assert.equal(reasoningLine(selector), "Reasoning: off ← →", "← still changes the level while filtering");
  selector.dispose();
}

// ------------------------------------------------- committing through a session

{
  const applied = [];
  const session = {
    thinkingLevel: "off",
    setModel: async () => {},
    setThinkingLevel(level, options) {
      applied.push({ level, options });
    },
  };

  // Reaches the private patchSession() by calling the wrapper the same way
  // interactive mode does; the original throws on our fake mode, which is fine.
  globalThis.__piPickerMode = undefined;
  try {
    InteractiveMode.prototype.showModelSelector.call({ session, footer: { invalidate() {} } });
  } catch {}

  const { selector, calls } = makeSelector("off");
  globalThis.__piPickerMode = { session, footer: { invalidate() {} } };
  session.setModel = session.setModel.bind(session);

  // The wrapper installed by showModelSelector must be in place now.
  assert.notEqual(globalThis.__piPickerMode, undefined);
  await session.setModel(MODELS[0]);
  assert.deepEqual(applied, [], "a plain model change applies no level");

  selector.selectedIndex = 1;
  selector.updateList();
  selector.handleInput(RIGHT); // off -> medium (minimal/low are unsupported)
  assert.equal(reasoningLine(selector), "Reasoning: medium ← →");
  selector.handleInput(ENTER);
  assert.equal(selector.getSearchInput().getValue(), "", "enter does not type");
  assert.deepEqual(
    globalThis.__piPickerChosen,
    { level: "medium", persist: false },
    "enter records the level for the model change",
  );

  globalThis.__piPickerMode = { session, footer: { invalidate() {} } };
  session.setThinkingLevel = (level, options) => applied.push({ level, options });
  await session.setModel(MODELS[1]);
  assert.deepEqual(applied, [{ level: "medium", options: { persist: false } }], "setModel applies the picked level");
  assert.equal(globalThis.__piPickerChosen, undefined, "the pending level is one-shot");

  // Ctrl+S sets the model as the default for new sessions, and the level shown
  // in the picker becomes the startup level. pi's app keybindings only exist
  // inside pi, so drive the callback the picker's Ctrl+S branch calls rather
  // than the keystroke itself.
  selector.selectedIndex = 0;
  selector.updateList();
  selector.handleInput(RIGHT); // medium -> high on deepseek-flash
  assert.equal(reasoningLine(selector), "Reasoning: high ← →");
  selector.onSelectAsDefaultCallback(MODELS[0]);
  assert.deepEqual(
    globalThis.__piPickerChosen,
    { level: "high", persist: true },
    "saving a default saves the level as the startup level",
  );
  assert.deepEqual(calls.defaulted, [MODELS[0]], "the picker's own default callback still runs");

  selector.dispose();
}

console.log("test-model-picker: ok — display, ←/→ clamping, filtering, enter/ctrl+s commit");
