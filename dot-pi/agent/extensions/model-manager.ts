/**
 * Model Manager
 *
 * Interactive model list management: browse every available model (from all
 * configured providers), give each one a friendly display name, and
 * enable/disable models.
 *
 * Persistence:
 *  - Friendly names -> ~/.pi/agent/models.json  (providers.<p>.modelOverrides.<id>.name)
 *  - Enable/disable -> ~/.pi/agent/settings.json (enabledModels patterns)
 *
 * Both files are read fresh on every invocation, so multiple edits in one
 * session never clobber each other. Structural changes (names, scope) are
 * picked up by pi at next startup.
 *
 * Usage: /model-manager
 * Keys in the model list: space / d = toggle enable, enter = actions, esc = back
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";

const CFG_DIR = join(homedir(), ".pi", "agent");
const SETTINGS_PATH = join(CFG_DIR, "settings.json");
const MODELS_PATH = join(CFG_DIR, "models.json");

type AnyJson = Record<string, unknown>;

async function readJson(path: string, fallback: AnyJson): Promise<AnyJson> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: AnyJson): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Minimal minimatch support for enabledModels patterns (*, ?). */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if ("\\^$.|+()[]{}".includes(ch)) out += "\\" + ch;
    else out += ch;
  }
  return new RegExp(`^${out}$`, "i");
}

function patternMatches(pattern: string, fullId: string, bareId: string): boolean {
  const targets = [fullId, bareId];
  if (/[*?[\]]/.test(pattern)) {
    const re = globToRegExp(pattern);
    return targets.some((t) => re.test(t));
  }
  return targets.some((t) => t.toLowerCase() === pattern.toLowerCase());
}

function isModelEnabled(
  fullId: string,
  bareId: string,
  patterns: string[] | undefined
): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => patternMatches(p, fullId, bareId));
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function friendlyName(overrides: AnyJson | undefined, model: Model): string {
  const name = overrides?.[model.id] as { name?: string } | undefined;
  return name?.name?.trim() ? name.name : model.id;
}

/** Row label with enabled marker and active-model star. */
function rowLabel(friendly: string, enabled: boolean, isActive: boolean): string {
  const mark = enabled ? "✓" : "✗";
  const star = isActive ? " ⭐" : "";
  return `${friendly} ${mark}${star}`;
}

/** Row description: provider, context, output, reasoning. */
function rowDescription(model: Model): string {
  return `${model.provider} · ctx ${fmtTokens(model.contextWindow)} · out ${fmtTokens(
    model.maxTokens
  )}${model.reasoning ? " · reasoning" : ""}`;
}

interface ManagerState {
  patterns: string[];
  modelsCfg: AnyJson;
  providers: Record<string, AnyJson>;
  settings: AnyJson;
  fullIds: Map<string, Model>;
  activeId: string | null;
}

/**
 * Toggle a model in/out of the enabled scope.
 *
 * pi's enabledModels is an allowlist: empty/missing = every model enabled. To
 * disable model X while everything else is enabled, we must write an explicit
 * allowlist of *all other* models. To enable model X back, if that makes the
 * allowlist cover every available model, we clear it (undefined = all enabled).
 */
function applyToggle(
  state: ManagerState,
  fullId: string,
  model: Model,
  enable: boolean,
  allFullIds: string[]
): void {
  // Interpret the current scope as a concrete set of enabled fullIds.
  const currentlyEnabledSet = new Set<string>();
  if (state.patterns.length === 0) {
    for (const id of allFullIds) currentlyEnabledSet.add(id);
  } else {
    for (const id of allFullIds) {
      const m = state.fullIds.get(id);
      if (m && isModelEnabled(id, m.id, state.patterns)) currentlyEnabledSet.add(id);
    }
  }

  if (enable) currentlyEnabledSet.add(fullId);
  else currentlyEnabledSet.delete(fullId);

  // If every available model is enabled, clear the allowlist (all enabled).
  const allEnabled = allFullIds.every((id) => currentlyEnabledSet.has(id));
  if (allEnabled) {
    state.patterns = [];
    return;
  }
  // Otherwise persist the explicit allowlist.
  state.patterns = [...currentlyEnabledSet];
}

/** Persist settings.json with the current patterns. */
async function saveSettings(state: ManagerState): Promise<void> {
  if (state.patterns.length === 0) delete state.settings.enabledModels;
  else state.settings.enabledModels = state.patterns;
  await writeJson(SETTINGS_PATH, state.settings);
}

/** Persist models.json with the current overrides. */
async function saveModels(state: ManagerState): Promise<void> {
  state.modelsCfg.providers = state.providers;
  await writeJson(MODELS_PATH, state.modelsCfg);
}

/** Generic framed SelectList dialog. Returns item.value or null. */
function showSelect(
  ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
  title: string,
  items: SelectItem[],
  footer: string,
  toggle?: (item: SelectItem) => boolean | Promise<boolean>
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Text(theme.fg("dim", footer), 1, 0));

    const list = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);

    container.addChild(
      new Text(theme.fg("dim", "↑↓ navigate · space toggle · enter actions · esc back"), 1, 0)
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if ((data === " " || data === "d") && toggle) {
          const item = list.getSelectedItem();
          if (item) {
            const handled = toggle(item);
            if (handled instanceof Promise) {
              void handled.then((h) => {
                if (!h) {
                  list.handleInput(data);
                  tui.requestRender();
                }
              });
              return;
            }
            if (handled) return;
          }
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("model-manager", {
    description: "Browse models: friendly names, enable/disable (space toggles)",
    handler: async (_args, ctx) => {
      const models = await ctx.modelRegistry.getAvailable();

      const settings = await readJson(SETTINGS_PATH, {});
      const modelsCfg = await readJson(MODELS_PATH, { providers: {} });
      const providers = (modelsCfg.providers ?? {}) as Record<string, AnyJson>;
      const state: ManagerState = {
        settings,
        modelsCfg,
        providers,
        patterns: settings.enabledModels ? [...(settings.enabledModels as string[])] : [],
        fullIds: new Map(),
        activeId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      };

      const items: SelectItem[] = models.map((model) => {
        const fullId = `${model.provider}/${model.id}`;
        state.fullIds.set(fullId, model);
        const overrides = providers[model.provider]?.modelOverrides as AnyJson | undefined;
        state.patterns = state.patterns; // no-op, keeps reference stable
        const enabled = isModelEnabled(fullId, model.id, state.patterns);
        return {
          value: fullId,
          label: rowLabel(friendlyName(overrides, model), enabled, fullId === state.activeId),
          description: rowDescription(model),
        };
      });

      if (items.length === 0) {
        ctx.ui.notify("No available models. Check provider auth.", "warning");
        return;
      }

      // Toggle handler used by the space shortcut in the top-level list.
      const handleSpaceToggle = (item: SelectItem): boolean => {
        const model = state.fullIds.get(item.value);
        if (!model) return false;
        const currentlyEnabled = isModelEnabled(item.value, model.id, state.patterns);
        const allFullIds = [...state.fullIds.keys()];
        applyToggle(state, item.value, model, !currentlyEnabled, allFullIds);
        const nowEnabled = !currentlyEnabled;
        const ov = state.providers[model.provider]?.modelOverrides as AnyJson | undefined;
        item.label = rowLabel(
          friendlyName(ov, model),
          nowEnabled,
          item.value === state.activeId
        );
        item.description = rowDescription(model);
        ctx.ui.notify(
          `${nowEnabled ? "Enabled" : "Disabled"} ${model.id} (applies on next start)`,
          "info"
        );
        void saveSettings(state);
        return true;
      };

      for (;;) {
        const pickedValue = await showSelect(
          ctx,
          "Model Manager",
          items,
          "Select a model to rename or toggle · space toggles enable · ⭐ = active",
          handleSpaceToggle
        );
        if (!pickedValue) {
          ctx.ui.notify("Saved. Changes take effect on next pi start.", "info");
          return;
        }

        const model = state.fullIds.get(pickedValue);
        if (!model) continue;
        const fullId = pickedValue;
        const overrides = state.providers[model.provider]?.modelOverrides as AnyJson | undefined;
        const currentName = friendlyName(overrides, model);
        const enabled = isModelEnabled(fullId, model.id, state.patterns);

        const actionItems: SelectItem[] = [
          {
            value: "rename",
            label: "Rename",
            description: `Display name: ${currentName}`,
          },
          {
            value: "clear-name",
            label: "Clear name",
            description: "Revert to the raw model id",
          },
          enabled
            ? {
                value: "disable",
                label: "Disable",
                description: "Remove from the enabled model scope",
              }
            : {
                value: "enable",
                label: "Enable",
                description: "Add back to the enabled model scope",
              },
          {
            value: "switch",
            label: "Switch to this model",
            description: "Set as the active model for this session",
          },
          { value: "back", label: "Back", description: "Return to the model list" },
        ];

        const action = await showSelect(
          ctx,
          `Model: ${currentName}`,
          actionItems,
          `${model.provider}/${model.id}`, // no toggle in the action menu
        );
        if (!action || action === "back") continue;

        if (action === "rename") {
          const name = await ctx.ui.input("Display name (empty keeps id):", currentName);
          if (name === undefined) continue;
          const trimmed = name.trim();
          const providerCfg = (state.providers[model.provider] ??= {});
          const ov = (providerCfg.modelOverrides ??= {}) as AnyJson;
          if (trimmed && trimmed !== model.id) {
            ov[model.id] = { ...((ov[model.id] as AnyJson) ?? {}), name: trimmed };
          } else {
            delete ov[model.id];
            if (Object.keys(ov).length === 0) delete providerCfg.modelOverrides;
          }
          await saveModels(state);
          ctx.ui.notify(`Renamed to "${trimmed}" (applies on next start)`, "info");
        } else if (action === "clear-name") {
          const providerCfg = state.providers[model.provider] as AnyJson | undefined;
          const ov = providerCfg?.modelOverrides as AnyJson | undefined;
          if (ov) {
            delete ov[model.id];
            if (Object.keys(ov).length === 0) delete providerCfg!.modelOverrides;
          }
          await saveModels(state);
          ctx.ui.notify("Name cleared", "info");
        } else if (action === "enable" || action === "disable") {
          if (action === "disable" && fullId === state.activeId) {
            const ok = await ctx.ui.confirm(
              "Disable active model",
              "This is the model currently in use. Disabling it will not affect this session, but it will be outside the model scope after restart."
            );
            if (!ok) continue;
          }
          applyToggle(state, fullId, model, action === "enable", [...state.fullIds.keys()]);
          await saveSettings(state);
          ctx.ui.notify(
            `${action === "enable" ? "Enabled" : "Disabled"} ${model.id} (applies on next start)`,
            "info"
          );
        } else if (action === "switch") {
          const ok = await pi.setModel(model);
          if (ok) ctx.ui.notify(`Switched to ${model.id}`, "info");
          else ctx.ui.notify("Switch failed", "error");
        }

        // Rebuild row labels/descriptions so the next dialog reflects changes.
        for (const item of items) {
          const m = state.fullIds.get(item.value)!;
          const ov = state.providers[m.provider]?.modelOverrides as AnyJson | undefined;
          const en = isModelEnabled(item.value, m.id, state.patterns);
          item.label = rowLabel(friendlyName(ov, m), en, item.value === state.activeId);
          item.description = rowDescription(m);
        }
      }
    },
  });
}
