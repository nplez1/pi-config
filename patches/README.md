# pi bundle patches

Patches to the *installed* pi bundle — the code `pi` actually runs. Not
extensions: some things the extension API cannot reach.

| Patch | What it does |
|---|---|
| `model-picker-name`, `scoped-models-name` | `/model` and `/scoped-models` list friendly model names from `models.json` (`providers.<p>.modelOverrides.<id>.name`) instead of raw model ids |
| `thinking-levels` | the `/model` picker shows a `Reasoning:` line for the highlighted model; `←`/`→` change it, `Enter` applies model **and** level together, `Ctrl+S` saves both as defaults |
## Why a patch instead of an extension

`/model` is handled inside interactive mode *before* extension commands are
dispatched, and the picker is the built-in `ModelSelectorComponent`. An
extension can add a second picker, but it cannot replace `/model`, so the
reasoning level has to be patched into the real one.

The picker's reasoning line sits directly under the search box:

```
─────────────────────────────────────────────
Scope: all | scoped
  /model ▏
  Reasoning: high  ← →          <-- new, always visible
  → ✓ deepseek-flash            [deepseek] · default
  → deepseek-v4-pro             [deepseek]
  (1/9)
  Model Name: DeepSeek V4 Pro
─────────────────────────────────────────────
```

It is *not* appended to the bottom of the list on purpose: the picker renders
into the editor area, whose height is bounded, so on a short terminal the last
lines — the hint line and the bottom border — are the first to be clipped (they
already are on a 24-row terminal). The top of the picker is always visible.

The preview is inert until `Enter`: arrows change only what the picker shows, and
`Esc` leaves the session untouched. On commit the level is applied *after* the
model lands, because `setModel` re-clamps the session level for the new model —
applying it first would be silently overridden. pi's footer picks up the new
level on its next repaint (the same way its own `Model:` status message behaves),
so send a message or run any command if you want to see it immediately.

Levels are the ones the highlighted model actually accepts (`reasoning: false`
models say so and ignore the arrows; a `thinkingLevelMap` that hides levels
hides them here too, clamped via `pi-ai`'s own `getSupportedThinkingLevels` /
`clampThinkingLevel`). So on `deepseek-flash`, whose map nulls minimal, medium and
xhigh, `←` from `high` goes straight to `low`.

Because `←`/`→` are taken, the search box no longer moves its text caret. That
is the Codex/Copilot behaviour; backspace still edits the query.

## Files

| File | Role |
|---|---|
| `model-picker.mjs` | the applier: finds the bundle chunk, swaps two unique strings, appends the block, verifies, records state |
| `model-picker-block.js` | the code appended to the chunk — pure wrapping of existing methods, no upstream line is rewritten |
| `test-model-picker.mjs` | behavioural test: drives the patched component with a fake TUI/session |
| `test-find-pi-dir.mjs` | which install gets patched: builds throwaway installs and checks the applier's search order |
| `.state.json` | generated: which chunk was patched, its size and mtime (gitignored) |
| `../dot-pi/agent/extensions/pi-picker-patch-guard.ts` | re-applies on the first TUI session after an update |

### Which install gets patched

The applier looks for a `pi` in this order and patches the first one with a
`dist/bundle/chunks`:

1. `--pi-dir <path>` — explicit, and an error if it holds no install;
2. `PI_AGENT_PACKAGE_DIR`;
3. the package the `pi` on `PATH` resolves into;
4. `$PI_MANAGED_INSTALL_ROOT/releases/<current-version>`;
5. the managed root read out of the launcher script on `PATH`;
6. `<home>/.pi/agent/install/releases/<current-version>`;
7. a global npm install (`npm root -g`, then the usual Homebrew and
   `~/.npm-global` locations).

Steps 4–6 cover the managed `releases-v1` install (pi 1.1+), where `pi` is a
launcher script under `~/.pi/agent/bin` that execs
`install/releases/<current-version>/node_modules/@earendil-works/pi-coding-agent`.
`current-version` is what that launcher reads, so a stale release left on disk is
never patched by mistake. `test-find-pi-dir.mjs` pins this order.

## Use it

```bash
node ~/Code/pi-config/patches/model-picker.mjs            # apply what is missing
node ~/Code/pi-config/patches/model-picker.mjs --check    # exit 1 if not patched
node ~/Code/pi-config/patches/test-model-picker.mjs       # verify behaviour
node ~/Code/pi-config/patches/test-find-pi-dir.mjs        # verify install discovery
node ~/Code/pi-config/patches/model-picker.mjs --json     # machine-readable (used by the guard)
```

`install.sh` applies the patch, and the guard extension re-applies it after a pi
update (you get a notification asking for a restart, since the running process
already loaded the old bundle). Disable the automatic part with
`PI_PICKER_PATCH=off`; `/picker-patch` does it on demand.

## After a pi update

A `pi` install/update replaces the chunk (new filename, new minified layout).
The applier finds the chunk by content, not by name, so it normally just works.
If upstream changes the anchors, the applier fails loudly and changes nothing:

```
model-picker: cannot apply all patches
  model-picker-name: expected exactly 1 occurrence of its upstream pattern, found 0.
```

In that case re-derive the two swap strings from the new chunk (they are short
and unique) or drop them — the reasoning block is independent and only depends
on method names, so it keeps working.

The applier backs up upstream once as `<chunk>.pi-config-orig`, writes
atomically, and smoke-tests the result with `pi --version`, restoring the backup
if the patched bundle fails to load.

## Not patched

`dist/modes/interactive/components/*.js` (the unbundled sources) are left alone:
`pi` executes the bundle, and those files only matter to code that imports the
package. So an extension that imports `ModelSelectorComponent` gets the
unpatched component.
