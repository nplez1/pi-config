var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};

// pi-host:typebox
var require_typebox = __commonJS(function(exports2, module2) {
  module2.exports = globalThis[Symbol.for("pi-todo-bundle@2.15.0:host-modules")]("typebox");
});

// pi-host:typebox/value
var require_value = __commonJS(function(exports2, module2) {
  module2.exports = globalThis[Symbol.for("pi-todo-bundle@2.15.0:host-modules")]("typebox/value");
});

// plugins/pi-todo/node_modules/@juicesharp/rpiv-config/config.ts
function expandTilde(p) {
  if (p === "~")
    return import_node_os.homedir();
  if (p.startsWith("~/"))
    return import_node_path.join(import_node_os.homedir(), p.slice(2));
  return p;
}
function defaultConfigDir() {
  return import_node_path.join(import_node_os.homedir(), ".config");
}
function resolveConfigDir() {
  const xdg = readEnvVar("XDG_CONFIG_HOME");
  if (!xdg)
    return defaultConfigDir();
  const expanded = expandTilde(xdg);
  return import_node_path.isAbsolute(expanded) ? expanded : defaultConfigDir();
}
function legacyConfigPath(name, file = "config.json") {
  return import_node_path.join(defaultConfigDir(), name, file);
}
function configPath(name, file = "config.json") {
  return import_node_path.join(resolveConfigDir(), name, file);
}
function loadJsonConfig(path) {
  if (!import_node_fs.existsSync(path))
    return {};
  try {
    const parsed = JSON.parse(import_node_fs.readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed;
  } catch (err) {
    console.warn(`rpiv-config: invalid JSON at ${path}, using default ({}) — ${err.message}`);
    return {};
  }
}
function loadJsonConfigWithLegacyFallback(name, file = "config.json") {
  const xdgPath = configPath(name, file);
  if (import_node_fs.existsSync(xdgPath)) {
    return loadJsonConfig(xdgPath);
  }
  return loadJsonConfig(legacyConfigPath(name, file));
}
function validateGuidanceFields(fields) {
  if (!fields || typeof fields !== "object")
    return {};
  const g = fields;
  const result = {};
  if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
    result.promptSnippet = g.promptSnippet;
  }
  if (Array.isArray(g.promptGuidelines) && g.promptGuidelines.length > 0 && g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)) {
    result.promptGuidelines = g.promptGuidelines;
  }
  if (typeof g.description === "string" && g.description.length > 0) {
    result.description = g.description;
  }
  return result;
}
function readEnvVar(key, fallback) {
  return process.env[key]?.trim() || fallback;
}
var import_node_fs, import_node_os, import_node_path, import_typebox, import_value, GuidanceFieldsSchema;
var init_config = __esm(() => {
  import_node_fs = require("node:fs");
  import_node_os = require("node:os");
  import_node_path = require("node:path");
  import_typebox = __toESM(require_typebox(), 1);
  import_value = __toESM(require_value(), 1);
  GuidanceFieldsSchema = import_typebox.Type.Object({
    promptSnippet: import_typebox.Type.Optional(import_typebox.Type.String()),
    promptGuidelines: import_typebox.Type.Optional(import_typebox.Type.Array(import_typebox.Type.String())),
    description: import_typebox.Type.Optional(import_typebox.Type.String())
  }, { additionalProperties: true });
});

// plugins/pi-todo/node_modules/@juicesharp/rpiv-config/index.ts
var init_rpiv_config = __esm(() => {
  init_config();
});

// plugins/pi-todo/config.ts
function loadConfig() {
  return loadJsonConfigWithLegacyFallback("rpiv-todo");
}
function loadSettleReminderSettings() {
  const config = loadConfig();
  const cooldown = config.settleReminderCooldownMs;
  return {
    enabled: config.settleReminder !== false,
    cooldownMs: typeof cooldown === "number" && Number.isFinite(cooldown) && cooldown >= MIN_SETTLE_REMINDER_COOLDOWN_MS ? cooldown : DEFAULT_SETTLE_REMINDER_COOLDOWN_MS
  };
}
function getMaxWidgetLines() {
  const config = loadConfig();
  const lines = config.maxWidgetLines;
  if (typeof lines !== "number" || lines < 3)
    return DEFAULT_MAX_WIDGET_LINES;
  return lines;
}
function isValidCollapseKeySpec(spec) {
  if (!spec)
    return false;
  if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++"))
    return false;
  const parts = spec.split("+");
  const base = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);
  if (modifiers.length !== new Set(modifiers).size)
    return false;
  if (!modifiers.every((m) => MODIFIERS.has(m)))
    return false;
  return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}
function resolveCollapseKey() {
  const config = loadConfig();
  const raw = typeof config.collapseKey === "string" ? config.collapseKey.trim().toLowerCase() : undefined;
  if (raw === undefined || raw === "")
    return DEFAULT_COLLAPSE_KEY;
  if (raw === COLLAPSE_KEY_OFF)
    return COLLAPSE_KEY_OFF;
  return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}
var DEFAULT_MAX_WIDGET_LINES = 12, DEFAULT_COLLAPSE_KEY = "ctrl+shift+t", COLLAPSE_KEY_OFF = "off", DEFAULT_SETTLE_REMINDER_COOLDOWN_MS, MIN_SETTLE_REMINDER_COOLDOWN_MS, SPECIAL_KEYS, MODIFIERS;
var init_config2 = __esm(() => {
  init_rpiv_config();
  DEFAULT_SETTLE_REMINDER_COOLDOWN_MS = 5 * 60 * 1000;
  MIN_SETTLE_REMINDER_COOLDOWN_MS = 30 * 1000;
  SPECIAL_KEYS = new Set([
    "escape",
    "esc",
    "enter",
    "return",
    "tab",
    "space",
    "backspace",
    "delete",
    "insert",
    "clear",
    "home",
    "end",
    "pageup",
    "pagedown",
    "up",
    "down",
    "left",
    "right",
    ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)
  ]);
  MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
});

// plugins/pi-todo/state/state.ts
var EMPTY_STATE;
var init_state = __esm(() => {
  EMPTY_STATE = { tasks: [], nextId: 1 };
});

// plugins/pi-todo/state/store.ts
function sid(ctx) {
  return ctx.sessionManager.getSessionId() ?? "";
}
function freshState() {
  return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}
function slotFor(sessionId) {
  return sessions.get(sessionId) ?? freshState();
}
function getState(sessionId) {
  return slotFor(sessionId);
}
function replaceState(sessionId, next) {
  sessions.set(sessionId, next);
}
function commitState(sessionId, next) {
  sessions.set(sessionId, next);
}
function evictSession(sessionId) {
  sessions.delete(sessionId);
}
function getRenderState() {
  return slotFor(activeRenderSession);
}
function setActiveRenderSession(sessionId) {
  activeRenderSession = sessionId;
}
function getActiveRenderSession() {
  return activeRenderSession;
}
function clearActiveRenderSession() {
  activeRenderSession = "";
}
var sessions, activeRenderSession = "";
var init_store = __esm(() => {
  init_state();
  sessions = new Map;
});

// plugins/pi-todo/state/selectors.ts
function selectVisibleTasks(state) {
  return state.tasks.filter((t) => t.status !== "deleted");
}
function selectTasksByStatus(state) {
  const visible = selectVisibleTasks(state);
  return {
    pending: visible.filter((t) => t.status === "pending"),
    inProgress: visible.filter((t) => t.status === "in_progress"),
    completed: visible.filter((t) => t.status === "completed")
  };
}
function selectTodoCounts(state) {
  const groups = selectTasksByStatus(state);
  return {
    total: groups.pending.length + groups.inProgress.length + groups.completed.length,
    pending: groups.pending.length,
    inProgress: groups.inProgress.length,
    completed: groups.completed.length
  };
}
function selectShowTaskIds(state) {
  return selectVisibleTasks(state).some((t) => t.blockedBy && t.blockedBy.length > 0);
}
function selectTaskSubjectById(state, id) {
  return state.tasks.find((t) => t.id === id)?.subject;
}
function selectOverlayLayout(state, budget) {
  const all = selectVisibleTasks(state);
  if (all.length <= budget) {
    return { visible: all, hiddenCompleted: 0, truncatedTail: 0 };
  }
  const innerBudget = budget - 1;
  const nonCompleted = all.filter((t) => t.status !== "completed");
  const totalCompleted = all.length - nonCompleted.length;
  if (nonCompleted.length <= innerBudget) {
    const kept = new Set(nonCompleted);
    for (const t of all) {
      if (kept.size >= innerBudget)
        break;
      if (t.status === "completed")
        kept.add(t);
    }
    const visible = all.filter((t) => kept.has(t));
    const shownCompleted = visible.filter((t) => t.status === "completed").length;
    return { visible, hiddenCompleted: totalCompleted - shownCompleted, truncatedTail: 0 };
  }
  const visible = nonCompleted.slice(0, innerBudget);
  const truncatedTail = nonCompleted.length - innerBudget;
  return { visible, hiddenCompleted: totalCompleted, truncatedTail };
}
function selectHasActive(state) {
  return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}
function selectOpenTasks(state) {
  return selectVisibleTasks(state).filter((t) => ACTIVE_STATUSES.has(t.status));
}
var ACTIVE_STATUSES;
var init_selectors = __esm(() => {
  ACTIVE_STATUSES = new Set(["pending", "in_progress"]);
});

// plugins/pi-todo/state/i18n-bridge.ts
function formatStatusLabel(status) {
  switch (status) {
    case "pending":
      return t("status.pending", STATUS_LABEL_PENDING);
    case "in_progress":
      return t("status.in_progress", STATUS_LABEL_IN_PROGRESS);
    case "completed":
      return t("status.completed", STATUS_LABEL_COMPLETED);
    case "deleted":
      return t("status.deleted", STATUS_LABEL_DELETED);
  }
}
var scopeImpl = (_key, fallback) => fallback, t, STATUS_LABEL_PENDING = "pending", STATUS_LABEL_IN_PROGRESS = "in progress", STATUS_LABEL_COMPLETED = "completed", STATUS_LABEL_DELETED = "deleted";
var init_i18n_bridge = __esm(() => {
  t = scopeImpl;
});

// plugins/pi-todo/tool/sanitize.ts
function sanitizeTerminalText(value) {
  return value.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "").replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "").replace(/\u001b./g, "").replace(/[\u2028\u2029]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => character === `
` || character === "\r" || character === "\t" ? " " : "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

// pi-host:@earendil-works/pi-ai
var require_pi_ai = __commonJS(function(exports2, module2) {
  module2.exports = globalThis[Symbol.for("pi-todo-bundle@2.15.0:host-modules")]("@earendil-works/pi-ai");
});

// pi-host:@earendil-works/pi-tui
var require_pi_tui = __commonJS(function(exports2, module2) {
  module2.exports = globalThis[Symbol.for("pi-todo-bundle@2.15.0:host-modules")]("@earendil-works/pi-tui");
});

// plugins/pi-todo/view/format.ts
function overlayStatusGlyph(status, theme) {
  switch (status) {
    case "pending":
      return theme.fg("dim", "○");
    case "in_progress":
      return theme.fg("warning", "◐");
    case "completed":
      return theme.fg("success", "✓");
    case "deleted":
      return theme.fg("error", "✗");
  }
}
function formatOverlayTaskLine(t, theme, showId) {
  const glyph = overlayStatusGlyph(t.status, theme);
  const subjectColor = t.status === "in_progress" ? "accent" : t.status === "completed" || t.status === "deleted" ? "muted" : "text";
  let subject = theme.fg(subjectColor, sanitizeTerminalText(t.subject));
  if (t.status === "completed" || t.status === "deleted") {
    subject = theme.strikethrough(subject);
  }
  let line = `${glyph}`;
  if (showId)
    line += ` ${theme.fg("dim", `#${t.id}`)}`;
  line += ` ${subject}`;
  if (t.status === "in_progress" && t.activeForm) {
    line += ` ${theme.fg("muted", `(${sanitizeTerminalText(t.activeForm)})`)}`;
  }
  if (t.blockedBy && t.blockedBy.length > 0) {
    line += ` ${theme.fg("muted", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
  }
  return line;
}
function formatCommandTaskLine(t, glyph) {
  const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
  const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  return `  ${glyph} #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}
function renderTodoCall(args, theme, state) {
  let text = theme.fg("toolTitle", theme.bold("todo "));
  if (args.action)
    text += theme.fg("muted", ACTION_GLYPH[args.action] ?? args.action);
  if (args.action === "create" && args.subject) {
    text += ` ${theme.fg("dim", sanitizeTerminalText(args.subject))}`;
  } else if (args.action === "create" && Array.isArray(args.tasks)) {
    text += ` ${theme.fg("dim", `${args.tasks.length} tasks`)}`;
  } else if ((args.action === "update" || args.action === "get" || args.action === "delete") && args.id !== undefined) {
    const subject = selectTaskSubjectById(state, args.id);
    text += ` ${theme.fg("accent", subject ? sanitizeTerminalText(subject) : `#${args.id}`)}`;
  } else if (args.action === "list" && args.status) {
    text += ` ${theme.fg("muted", formatStatusLabel(args.status))}`;
  }
  return new import_pi_tui.Text(text, 0, 0);
}
function renderTodoResult(result, theme, isError = false) {
  const failure = failureReason(result, isError);
  if (failure !== undefined)
    return new import_pi_tui.Text(theme.fg("error", failure ? `✗ ${failure}` : "✗"), 0, 0);
  const status = echoedStatus(result.details);
  if (status) {
    return new import_pi_tui.Text(theme.fg(STATUS_COLOR[status], `${STATUS_GLYPH[status]} ${formatStatusLabel(status)}`), 0, 0);
  }
  return new import_pi_tui.Text(theme.fg("success", "✓"), 0, 0);
}
function failureReason(result, isError) {
  const reducerError = result.details?.error;
  if (!isError && !reducerError)
    return;
  const message = reducerError ?? result.content?.find((c) => c.type === "text")?.text ?? "";
  return sanitizeTerminalText(message.split(`
`)[0]);
}
function echoedStatus(details) {
  if (!details)
    return;
  const params = details.params;
  switch (details.action) {
    case "create":
      return details.tasks.at(-1)?.status;
    case "update":
      return params.status ?? details.tasks.find((t) => t.id === params.id)?.status;
    case "delete":
      return details.tasks.find((t) => t.id === params.id)?.status;
    case "list":
    case "get":
    case "clear":
      return;
  }
}
var import_pi_tui, STATUS_GLYPH, STATUS_COLOR, ACTION_GLYPH;
var init_format = __esm(() => {
  init_i18n_bridge();
  init_selectors();
  import_pi_tui = __toESM(require_pi_tui(), 1);
  STATUS_GLYPH = {
    pending: "○",
    in_progress: "◐",
    completed: "●",
    deleted: "⊘"
  };
  STATUS_COLOR = {
    pending: "dim",
    in_progress: "warning",
    completed: "success",
    deleted: "muted"
  };
  ACTION_GLYPH = {
    create: "+",
    update: "→",
    delete: "×",
    get: "›",
    list: "☰",
    clear: "∅"
  };
});

// plugins/pi-todo/todo-overlay.ts
var exports_todo_overlay = {};
__export(exports_todo_overlay, {
  TodoOverlay: () => TodoOverlay
});

class TodoOverlay {
  uiCtx;
  widgetRegistered = false;
  tui;
  completedTaskIdsPendingHide = new Set;
  hiddenCompletedTaskIds = new Set;
  lastNextId;
  collapsed = false;
  setUICtx(ctx) {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }
  update() {
    if (!this.uiCtx)
      return;
    const snapshot = this.getSnapshot();
    const visible = this.selectOverlayTasks(snapshot);
    if (visible.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(WIDGET_KEY, (tui, factoryTheme) => {
        this.tui = tui;
        return {
          render: (width) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
          invalidate: () => {}
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }
  resetCompletedDisplayState() {
    this.completedTaskIdsPendingHide.clear();
    this.hiddenCompletedTaskIds.clear();
    this.lastNextId = undefined;
  }
  hideCompletedTasksFromPreviousTurn() {
    if (this.completedTaskIdsPendingHide.size === 0)
      return;
    for (const taskId of this.completedTaskIdsPendingHide) {
      this.hiddenCompletedTaskIds.add(taskId);
    }
    this.completedTaskIdsPendingHide.clear();
    this.tui?.requestRender();
  }
  toggleCollapse() {
    this.collapsed = !this.collapsed;
    this.tui?.requestRender(true);
  }
  isRegistered() {
    return this.widgetRegistered;
  }
  getSnapshot() {
    const state = getRenderState();
    if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
      this.resetCompletedDisplayState();
    }
    this.lastNextId = state.nextId;
    const completedTaskIds = new Set(state.tasks.filter((task) => task.status === "completed").map((task) => task.id));
    for (const taskId of this.completedTaskIdsPendingHide) {
      if (!completedTaskIds.has(taskId))
        this.completedTaskIdsPendingHide.delete(taskId);
    }
    for (const taskId of this.hiddenCompletedTaskIds) {
      if (!completedTaskIds.has(taskId))
        this.hiddenCompletedTaskIds.delete(taskId);
    }
    return { tasks: [...state.tasks], nextId: state.nextId };
  }
  selectOverlayTasks(snapshot) {
    return snapshot.tasks.filter((task) => task.status !== "deleted" && !this.shouldHideCompletedTask(task));
  }
  shouldHideCompletedTask(task) {
    return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
  }
  renderWidget(theme, width) {
    const snapshot = this.getSnapshot();
    const overlayTasks = this.selectOverlayTasks(snapshot);
    if (overlayTasks.length === 0)
      return [];
    const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
    const truncate = (line) => import_pi_tui2.truncateToWidth(line, width, "…");
    const counts = selectTodoCounts({
      tasks: snapshot.tasks.filter((task) => task.status !== "deleted"),
      nextId: snapshot.nextId
    });
    const hasActive = selectHasActive(overlayState);
    const showIds = selectShowTaskIds(overlayState);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const headingText = `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`;
    const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);
    if (this.collapsed) {
      const key = resolveCollapseKey();
      const hint = key === COLLAPSE_KEY_OFF ? t("overlay.collapsed", OVERLAY_COLLAPSED) : t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
      return this.withTrailingSpacer([heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`)]);
    }
    const lines = [heading];
    const bodyBudget = this.uiCtx?.getToolsExpanded?.() === true ? overlayTasks.length : getMaxWidgetLines() - 1;
    const layout = selectOverlayLayout(overlayState, bodyBudget);
    for (const task of layout.visible) {
      lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
    }
    const newlyDisplayedCompletedTaskIds = overlayTasks.filter((task) => task.status === "completed" && !this.completedTaskIdsPendingHide.has(task.id) && !this.hiddenCompletedTaskIds.has(task.id)).map((task) => task.id);
    for (const taskId of newlyDisplayedCompletedTaskIds) {
      this.completedTaskIdsPendingHide.add(taskId);
    }
    if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
      const last = lines.length - 1;
      lines[last] = lines[last].replace("├─", "└─");
      return this.withTrailingSpacer(lines);
    }
    const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
    const overflowParts = [];
    if (layout.hiddenCompleted > 0)
      overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
    if (layout.truncatedTail > 0)
      overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
    const more = t("overlay.more", OVERLAY_MORE);
    const summary = overflowParts.length > 0 ? `+${totalHidden} ${more} (${overflowParts.join(", ")})` : `+${totalHidden} ${more}`;
    lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
    return this.withTrailingSpacer(lines);
  }
  withTrailingSpacer(lines) {
    if (lines.length === 0)
      return lines;
    lines.push("");
    return lines;
  }
  dispose() {
    if (this.uiCtx)
      this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.collapsed = false;
    this.resetCompletedDisplayState();
  }
}
var import_pi_tui2, WIDGET_KEY = "rpiv-todos", OVERLAY_HEADING = "Todos", OVERLAY_MORE = "more", OVERLAY_EXPAND_HINT = "{key} to expand", OVERLAY_COLLAPSED = "collapsed";
var init_todo_overlay = __esm(() => {
  init_config2();
  init_i18n_bridge();
  init_selectors();
  init_store();
  init_format();
  import_pi_tui2 = __toESM(require_pi_tui(), 1);
});

// plugins/pi-todo/index.ts
var exports_pi_todo = {};
__export(exports_pi_todo, {
  PREWARM_DELAY_MS: () => PREWARM_DELAY_MS,
  default: () => pi_todo_default,
  isStaleOverlayModuleError: () => isStaleOverlayModuleError,
  makeTodoOverlayLoader: () => makeTodoOverlayLoader,
  registerLocales: () => registerLocales
});
module.exports = __toCommonJS(exports_pi_todo);
init_config2();

// plugins/pi-todo/state/replay.ts
init_state();
var TASK_STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
var optional = (value, valid) => value === undefined || valid(value);
var isString = (v) => typeof v === "string";
function isTask(value) {
  if (!value || typeof value !== "object")
    return false;
  const t = value;
  return Number.isSafeInteger(t.id) && typeof t.subject === "string" && TASK_STATUSES.has(t.status) && optional(t.description, isString) && optional(t.activeForm, isString) && optional(t.owner, isString) && optional(t.blockedBy, (v) => Array.isArray(v) && v.every((id) => Number.isSafeInteger(id))) && optional(t.metadata, (v) => typeof v === "object" && v !== null);
}
function isTaskDetails(value) {
  if (!value || typeof value !== "object")
    return false;
  const v = value;
  return Array.isArray(v.tasks) && v.tasks.every(isTask) && Number.isSafeInteger(v.nextId);
}
function stateOf(details) {
  return { tasks: details.tasks.map((t) => ({ ...t })), nextId: details.nextId };
}
function replayFromBranch(ctx) {
  let fromEntries;
  let fromToolResults;
  for (const entry of ctx.sessionManager.getBranch()) {
    const e = entry;
    if (e.type === "custom") {
      if (e.customType === "rpiv-todo-state" && isTaskDetails(e.data))
        fromEntries = stateOf(e.data);
      continue;
    }
    if (e.type !== "message")
      continue;
    const msg = e.message;
    if (msg?.role !== "toolResult" || msg.toolName !== "todo")
      continue;
    if (!isTaskDetails(msg.details))
      continue;
    fromToolResults = stateOf(msg.details);
  }
  return fromEntries ?? fromToolResults ?? { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

// plugins/pi-todo/index.ts
init_store();

// plugins/pi-todo/settle-reminder.ts
init_config2();

// plugins/pi-todo/settle-background.ts
var RPC_TIMEOUT_MS = 250;
var COLD_LIST_CHANNEL = "subagents:rpc:schedules:list";
var LIVE_LIST_CHANNEL = "loop:rpc:schedules:list";
var SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function subagentsBusy() {
  const registry = Reflect.get(globalThis, SUBAGENTS_MANAGER_KEY);
  if (!isRecord(registry))
    return false;
  const hasRunning = registry.hasRunning;
  if (typeof hasRunning !== "function")
    return false;
  try {
    return hasRunning.call(registry) === true;
  } catch {
    return false;
  }
}
function coldJobArmed(job) {
  return isRecord(job) && job.enabled === true;
}
function liveLoopArmed(job) {
  if (!isRecord(job) || job.paused === true)
    return false;
  const expiresAt = job.expiresAt;
  return typeof expiresAt !== "number" || expiresAt > Date.now();
}
var requestCounter = 0;
function callRpc(bus, channel, params, timeoutMs = RPC_TIMEOUT_MS) {
  const requestId = `rpiv-todo-${++requestCounter}-${channel}`;
  const replyChannel = `${channel}:reply:${requestId}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let unsubscribe = () => {};
    const finish = (fn) => {
      if (settled)
        return;
      settled = true;
      if (timer !== undefined)
        clearTimeout(timer);
      unsubscribe();
      fn();
    };
    timer = setTimeout(() => finish(() => reject(new Error(`no reply from ${channel} within ${timeoutMs}ms`))), timeoutMs);
    unsubscribe = bus.on(replyChannel, (raw) => {
      const reply = raw;
      finish(() => {
        if (!reply)
          reject(new Error(`${channel} replied with no envelope`));
        else if (reply.success === true)
          resolve(reply.data);
        else
          reject(new Error(reply.error));
      });
    });
    bus.emit(channel, { ...params, requestId });
  });
}
function createBackgroundWorkProbe(bus, probeSubagents = subagentsBusy) {
  const unavailable = new Set;
  const scheduled = async (channel, armed) => {
    if (!bus || unavailable.has(channel))
      return false;
    try {
      const reply = await callRpc(bus, channel, {});
      const jobs = reply?.jobs;
      return Array.isArray(jobs) && jobs.some(armed);
    } catch {
      unavailable.add(channel);
      return false;
    }
  };
  return {
    async pending() {
      if (probeSubagents())
        return true;
      const [cold, live] = await Promise.all([
        scheduled(COLD_LIST_CHANNEL, coldJobArmed),
        scheduled(LIVE_LIST_CHANNEL, liveLoopArmed)
      ]);
      return cold || live;
    },
    reset() {
      unavailable.clear();
    }
  };
}

// plugins/pi-todo/settle-reminder.ts
init_selectors();
init_store();
var REMINDER_CUSTOM_TYPE = "rpiv-todo-settle-reminder";
var MAX_LISTED_TASKS = 10;
function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}
function buildReminderContent(tasks) {
  const open = tasks.length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const pending = open - inProgress;
  const counts = `${pending} pending, ${inProgress} in progress`;
  const listed = tasks.slice(0, MAX_LISTED_TASKS).map((task) => {
    const form = task.status === "in_progress" && task.activeForm ? ` (${oneLine(task.activeForm)})` : "";
    const blocked = task.blockedBy?.length ? ` ⛓ blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : "";
    return `- #${task.id} [${task.status}] ${oneLine(task.subject)}${form}${blocked}`;
  });
  const hidden = open - Math.min(open, MAX_LISTED_TASKS);
  if (hidden > 0)
    listed.push(`- …and ${hidden} more (call todo with action "list" to see them)`);
  return [
    `Todo reminder — ${open} ${open === 1 ? "task is" : "tasks are"} still open (${counts}):`,
    ...listed,
    "Keep working until they are done. Mark each task completed as you finish it, and mark a task in_progress before you start it. If a task cannot be finished in this run, say plainly why it is still open and leave it pending — do not claim the work is done while items remain open."
  ].join(`
`);
}
function decideReminder(input) {
  if (!input.enabled)
    return { remind: false, reason: "disabled" };
  if (input.openCount === 0)
    return { remind: false, reason: "nothing-open" };
  if (input.outcome !== "completed")
    return { remind: false, reason: "run-not-completed" };
  if (!input.isForeground)
    return { remind: false, reason: "child-session" };
  if (input.backgroundBusy)
    return { remind: false, reason: "background-work" };
  if (input.pendingMessages)
    return { remind: false, reason: "pending-messages" };
  if (input.sinceLastReminderMs < input.cooldownMs)
    return { remind: false, reason: "cooldown" };
  return { remind: true };
}
function registerSettleReminder(pi, probe = createBackgroundWorkProbe(pi.events)) {
  let lastReminderAt;
  pi.on("session_start", async () => {
    lastReminderAt = undefined;
    probe.reset();
  });
  pi.on("input", async (event) => {
    if (event.source !== "extension")
      lastReminderAt = undefined;
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    const { enabled, cooldownMs } = loadSettleReminderSettings();
    if (!enabled)
      return;
    let sessionId;
    try {
      sessionId = sid(ctx);
    } catch {
      return;
    }
    const foreground = getActiveRenderSession();
    const decisionInput = {
      enabled,
      outcome: event.outcome,
      openCount: selectOpenTasks(getState(sessionId)).length,
      isForeground: foreground === "" || foreground === sessionId,
      pendingMessages: ctx.hasPendingMessages(),
      sinceLastReminderMs: lastReminderAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - lastReminderAt,
      cooldownMs
    };
    const local = decideReminder({ ...decisionInput, backgroundBusy: false });
    if (!local.remind)
      return;
    let backgroundBusy;
    try {
      backgroundBusy = await probe.pending();
    } catch {
      return;
    }
    const decision = decideReminder({ ...decisionInput, backgroundBusy });
    if (!decision.remind)
      return;
    lastReminderAt = Date.now();
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: REMINDER_CUSTOM_TYPE,
          content: buildReminderContent(selectOpenTasks(getState(sessionId))),
          display: false
        }
      ],
      continue: true
    };
  });
}

// plugins/pi-todo/todo.ts
init_config2();
init_i18n_bridge();
init_selectors();

// plugins/pi-todo/state/invariants.ts
var VALID_TRANSITIONS = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set
};
function isTransitionValid(from, to) {
  if (from === to)
    return true;
  return VALID_TRANSITIONS[from].has(to);
}

// plugins/pi-todo/state/task-graph.ts
function detectCycle(taskList, taskId, newBlockedBy) {
  const edges = new Map;
  for (const t of taskList) {
    if (t.id === taskId) {
      const merged = new Set([...t.blockedBy ?? [], ...newBlockedBy]);
      edges.set(t.id, [...merged]);
    } else {
      edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
    }
  }
  const visiting = new Set;
  const visited = new Set;
  const hasCycleFrom = (node) => {
    if (visiting.has(node))
      return true;
    if (visited.has(node))
      return false;
    visiting.add(node);
    for (const nb of edges.get(node) ?? []) {
      if (hasCycleFrom(nb))
        return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of edges.keys()) {
    if (hasCycleFrom(node))
      return true;
  }
  return false;
}
function deriveBlocks(taskList) {
  const blocks = new Map;
  for (const t of taskList) {
    for (const dep of t.blockedBy ?? []) {
      const arr = blocks.get(dep) ?? [];
      arr.push(t.id);
      blocks.set(dep, arr);
    }
  }
  return blocks;
}

// plugins/pi-todo/state/state-reducer.ts
function changesState(op) {
  switch (op.kind) {
    case "create":
    case "delete":
    case "clear":
      return true;
    case "update":
      return op.changed;
    case "list":
    case "get":
    case "error":
      return false;
  }
}
function errorResult(state, message) {
  return { state, op: { kind: "error", message } };
}
var BATCH_ITEM_FIELDS = ["description", "activeForm", "blockedBy", "owner", "metadata"];
function asCreateItem(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  return value;
}
function buildCreatedTask(id, spec, subject) {
  const newTask = {
    id,
    subject,
    status: "pending"
  };
  if (spec.description)
    newTask.description = spec.description;
  if (spec.activeForm)
    newTask.activeForm = spec.activeForm;
  if (spec.blockedBy?.length)
    newTask.blockedBy = [...spec.blockedBy];
  if (spec.owner)
    newTask.owner = spec.owner;
  if (spec.metadata)
    newTask.metadata = { ...spec.metadata };
  return newTask;
}
function validateCreateBlockedBy(state, blockedBy, siblingIds) {
  if (!blockedBy?.length)
    return;
  for (const dep of blockedBy) {
    if (siblingIds.has(dep)) {
      return `blockedBy: #${dep} is another item in this batch; create the prerequisite first, then the dependent with blockedBy`;
    }
    const depTask = state.tasks.find((t) => t.id === dep);
    if (!depTask)
      return `blockedBy: #${dep} not found`;
    if (depTask.status === "deleted")
      return `blockedBy: #${dep} is deleted`;
  }
  return;
}
function sameNumberList(a, b) {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
function sameRecord(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
function taskChanged(before, after) {
  return before.subject !== after.subject || before.status !== after.status || before.description !== after.description || before.activeForm !== after.activeForm || before.owner !== after.owner || !sameNumberList(before.blockedBy, after.blockedBy) || !sameRecord(before.metadata, after.metadata);
}
function applyTaskMutation(state, action, params) {
  switch (action) {
    case "create": {
      const batch = params.tasks;
      if (Array.isArray(batch) && params.subject !== undefined) {
        return errorResult(state, "create requires subject or tasks[], not both");
      }
      if (Array.isArray(batch)) {
        const topLevel = BATCH_ITEM_FIELDS.filter((field) => params[field] !== undefined);
        if (topLevel.length) {
          return errorResult(state, `create with tasks[] takes ${topLevel.join(", ")} on each item, not at the top level`);
        }
        if (batch.length === 0) {
          return errorResult(state, "tasks[] must be non-empty");
        }
        const items = [];
        for (let i = 0;i < batch.length; i++) {
          const spec = asCreateItem(batch[i]);
          const subject = spec?.subject;
          if (!spec || !subject?.trim()) {
            return errorResult(state, `tasks[${i}]: subject required for create`);
          }
          items.push({ spec, subject });
        }
        const siblingIds = new Set(items.map((_, i) => state.nextId + i));
        for (const item of items) {
          const blockedError = validateCreateBlockedBy(state, item.spec.blockedBy, siblingIds);
          if (blockedError)
            return errorResult(state, blockedError);
        }
        const created = items.map((item, i) => buildCreatedTask(state.nextId + i, item.spec, item.subject));
        return {
          state: { tasks: [...state.tasks, ...created], nextId: state.nextId + created.length },
          op: { kind: "create", taskIds: created.map((t) => t.id) }
        };
      }
      if (!params.subject?.trim()) {
        return errorResult(state, "subject required for create");
      }
      const blockedError = validateCreateBlockedBy(state, params.blockedBy, new Set);
      if (blockedError)
        return errorResult(state, blockedError);
      const newTask = buildCreatedTask(state.nextId, params, params.subject);
      return {
        state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
        op: { kind: "create", taskIds: [newTask.id] }
      };
    }
    case "update": {
      if (params.id === undefined)
        return errorResult(state, "id required for update");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1)
        return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];
      const hasMutation = params.subject !== undefined || params.description !== undefined || params.activeForm !== undefined || params.status !== undefined || params.owner !== undefined || params.metadata !== undefined || params.addBlockedBy && params.addBlockedBy.length > 0 || params.removeBlockedBy && params.removeBlockedBy.length > 0;
      if (!hasMutation)
        return errorResult(state, "update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy");
      let newStatus = current.status;
      if (params.status !== undefined) {
        if (!isTransitionValid(current.status, params.status)) {
          return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
        }
        newStatus = params.status;
      }
      let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
      if (params.removeBlockedBy?.length) {
        const toRemove = new Set(params.removeBlockedBy);
        newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
      }
      if (params.addBlockedBy?.length) {
        for (const dep of params.addBlockedBy) {
          if (dep === current.id)
            return errorResult(state, `cannot block #${current.id} on itself`);
          const depTask = state.tasks.find((t) => t.id === dep);
          if (!depTask)
            return errorResult(state, `addBlockedBy: #${dep} not found`);
          if (depTask.status === "deleted")
            return errorResult(state, `addBlockedBy: #${dep} is deleted`);
          if (!newBlockedBy.includes(dep))
            newBlockedBy.push(dep);
        }
        if (detectCycle(state.tasks, current.id, newBlockedBy)) {
          return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
        }
      }
      let newMetadata = current.metadata;
      if (params.metadata !== undefined) {
        const merged = { ...current.metadata ?? {} };
        for (const [k, v] of Object.entries(params.metadata)) {
          if (v === null)
            delete merged[k];
          else
            merged[k] = v;
        }
        newMetadata = Object.keys(merged).length ? merged : undefined;
      }
      const updated = { ...current, status: newStatus };
      if (params.subject !== undefined)
        updated.subject = params.subject;
      if (params.description !== undefined)
        updated.description = params.description;
      if (params.activeForm !== undefined)
        updated.activeForm = params.activeForm;
      if (params.owner !== undefined)
        updated.owner = params.owner;
      if (newBlockedBy.length)
        updated.blockedBy = newBlockedBy;
      else
        delete updated.blockedBy;
      if (newMetadata === undefined)
        delete updated.metadata;
      else
        updated.metadata = newMetadata;
      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      return {
        state: { tasks: newTasks, nextId: state.nextId },
        op: {
          kind: "update",
          id: updated.id,
          fromStatus: current.status,
          toStatus: newStatus,
          changed: taskChanged(current, updated)
        }
      };
    }
    case "list": {
      return {
        state,
        op: {
          kind: "list",
          includeDeleted: params.includeDeleted === true,
          ...params.status !== undefined ? { statusFilter: params.status } : {}
        }
      };
    }
    case "get": {
      if (params.id === undefined)
        return errorResult(state, "id required for get");
      const task = state.tasks.find((t) => t.id === params.id);
      if (!task)
        return errorResult(state, `#${params.id} not found`);
      return { state, op: { kind: "get", task } };
    }
    case "delete": {
      if (params.id === undefined)
        return errorResult(state, "id required for delete");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1)
        return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];
      if (current.status === "deleted")
        return errorResult(state, `#${current.id} is already deleted`);
      const updated = { ...current, status: "deleted" };
      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      return {
        state: { tasks: newTasks, nextId: state.nextId },
        op: { kind: "delete", id: updated.id, subject: updated.subject }
      };
    }
    case "clear": {
      const count = state.tasks.length;
      return {
        state: { tasks: [], nextId: 1 },
        op: { kind: "clear", count }
      };
    }
  }
}

// plugins/pi-todo/todo.ts
init_store();

// plugins/pi-todo/tool/normalize-params.ts
function prepareTodoArguments(args) {
  if (!isRecord2(args) || args.tasks === undefined)
    return args;
  const tasks = decodeArray(args.tasks);
  if (!Array.isArray(tasks))
    return args;
  const decoded = tasks.map(decodeObject);
  if (tasks === args.tasks && decoded.every((item, i) => item === tasks[i]))
    return args;
  return { ...args, tasks: decoded };
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decodeArray(value) {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  return Array.isArray(parsed) ? parsed : value;
}
function decodeObject(value) {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  return isRecord2(parsed) ? parsed : value;
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}

// plugins/pi-todo/tool/response-envelope.ts
function formatListLine(t) {
  const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
  return `[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}
function formatGetLines(task, state) {
  const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
  const lines = [`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`];
  if (task.description)
    lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
  if (task.activeForm)
    lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
  if (task.blockedBy?.length) {
    lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
  }
  if (blocks.length) {
    lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
  }
  if (task.owner)
    lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
  return lines.join(`
`);
}
function formatContent(op, state) {
  switch (op.kind) {
    case "create": {
      return op.taskIds.map((id) => {
        const created = state.tasks.find((x) => x.id === id);
        if (!created)
          return `Created #${id}`;
        return `Created #${created.id}: ${sanitizeTerminalText(created.subject)} (pending)`;
      }).join(`
`);
    }
    case "update": {
      if (!op.changed) {
        return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
      }
      const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
      return `Updated #${op.id}${transition}`;
    }
    case "delete":
      return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
    case "clear":
      return `Cleared ${op.count} tasks`;
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted)
        view = view.filter((t) => t.status !== "deleted");
      if (op.statusFilter)
        view = view.filter((t) => t.status === op.statusFilter);
      return view.length === 0 ? "No tasks" : view.map(formatListLine).join(`
`);
    }
    case "get":
      return formatGetLines(op.task, state);
    case "error":
      return `Error: ${op.message}`;
  }
}
function buildToolResult(action, params, state, op) {
  const text = formatContent(op, state);
  const details = {
    action,
    params,
    tasks: state.tasks,
    nextId: state.nextId,
    ...op.kind === "error" ? { error: op.message } : {}
  };
  return { content: [{ type: "text", text }], details };
}

// plugins/pi-todo/tool/types.ts
var import_pi_ai = __toESM(require_pi_ai(), 1);
var import_typebox2 = __toESM(require_typebox(), 1);
var TOOL_NAME = "todo";
var TOOL_LABEL = "Todo";
var COMMAND_NAME = "todos";
var STATE_ENTRY_TYPE = "rpiv-todo-state";
var ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
var MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";
var CreateTaskInputSchema = import_typebox2.Type.Object({
  subject: import_typebox2.Type.String({ description: "Task subject line" }),
  description: import_typebox2.Type.Optional(import_typebox2.Type.String({ description: "Long-form task description" })),
  activeForm: import_typebox2.Type.Optional(import_typebox2.Type.String({
    description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')"
  })),
  blockedBy: import_typebox2.Type.Optional(import_typebox2.Type.Array(import_typebox2.Type.Number(), {
    description: "Existing task ids this item waits on. Cannot name another item in this same batch; create the prerequisite first, then the dependent with blockedBy."
  })),
  owner: import_typebox2.Type.Optional(import_typebox2.Type.String({ description: "Agent/owner assigned to this task" })),
  metadata: import_typebox2.Type.Optional(import_typebox2.Type.Record(import_typebox2.Type.String(), import_typebox2.Type.Unknown(), {
    description: "Arbitrary metadata"
  }))
});
var TodoParamsSchema = import_typebox2.Type.Object({
  action: import_pi_ai.StringEnum(["create", "update", "list", "get", "delete", "clear"]),
  subject: import_typebox2.Type.Optional(import_typebox2.Type.String({
    description: "Task subject line (required for create unless tasks[] is set)"
  })),
  description: import_typebox2.Type.Optional(import_typebox2.Type.String({ description: "Long-form task description" })),
  activeForm: import_typebox2.Type.Optional(import_typebox2.Type.String({
    description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')"
  })),
  status: import_typebox2.Type.Optional(import_pi_ai.StringEnum(["pending", "in_progress", "completed", "deleted"], {
    description: "Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status."
  })),
  blockedBy: import_typebox2.Type.Optional(import_typebox2.Type.Array(import_typebox2.Type.Number(), {
    description: "Initial blockedBy ids (create only)"
  })),
  addBlockedBy: import_typebox2.Type.Optional(import_typebox2.Type.Array(import_typebox2.Type.Number(), {
    description: "Task ids to add to blockedBy (update only, additive merge)"
  })),
  removeBlockedBy: import_typebox2.Type.Optional(import_typebox2.Type.Array(import_typebox2.Type.Number(), {
    description: "Task ids to remove from blockedBy (update only, additive merge)"
  })),
  owner: import_typebox2.Type.Optional(import_typebox2.Type.String({ description: "Agent/owner assigned to this task" })),
  metadata: import_typebox2.Type.Optional(import_typebox2.Type.Record(import_typebox2.Type.String(), import_typebox2.Type.Unknown(), {
    description: "Arbitrary metadata; pass null value for a key to delete that key on update"
  })),
  id: import_typebox2.Type.Optional(import_typebox2.Type.Number({
    description: "Task id (required for update, get, delete)"
  })),
  includeDeleted: import_typebox2.Type.Optional(import_typebox2.Type.Boolean({
    description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false."
  })),
  tasks: import_typebox2.Type.Optional(import_typebox2.Type.Array(CreateTaskInputSchema, {
    description: "Batch create: independent tasks in one call, one-of with subject. The whole list is validated then committed together. Items cannot blockedBy each other; create the prerequisite first, then the dependent with blockedBy."
  }))
});

// plugins/pi-todo/todo.ts
init_format();
init_store();
var SECTION_PENDING = "── Pending ──";
var SECTION_IN_PROGRESS = "── In Progress ──";
var SECTION_COMPLETED = "── Completed ──";
var DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
var DEFAULT_PROMPT_GUIDELINES = [
  "Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  "When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
  "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
  "Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
  `To change a task's status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.`,
  "Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
  "To create several independent tasks at once, pass create with tasks: [{subject}, ...]. Do not also pass subject. tasks[] cannot blockedBy each other (ids do not exist until the call commits); create the prerequisite first, then the dependent with blockedBy. Dependency chains stay single-create.",
  "list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
  "Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress."
];
function registerTodoTool(pi) {
  const guidance = validateGuidanceFields(loadConfig().guidance);
  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description: "Manage a task list for tracking multi-step progress. Actions: create (new task, or several independent tasks at once via tasks[]), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
    promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
    parameters: TodoParamsSchema,
    prepareArguments: prepareTodoArguments,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = applyTaskMutation(getState(sid(ctx)), params.action, params);
      commitState(sid(ctx), result.state);
      const toolResult = buildToolResult(params.action, params, result.state, result.op);
      if (changesState(result.op))
        pi.appendEntry(STATE_ENTRY_TYPE, toolResult.details);
      return toolResult;
    },
    renderCall(args, theme, _context) {
      return renderTodoCall(args, theme, getRenderState());
    },
    renderResult(result, _opts, theme, context) {
      return renderTodoResult(result, theme, context?.isError);
    }
  });
}
function registerTodosCommand(pi) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Show all todos on the current branch, grouped by status",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
        return;
      }
      const state = getState(sid(ctx));
      const visible = selectVisibleTasks(state);
      if (visible.length === 0) {
        ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
        return;
      }
      const groups = selectTasksByStatus(state);
      const counts = selectTodoCounts(state);
      const header = [];
      if (counts.completed > 0)
        header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
      if (counts.inProgress > 0)
        header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
      if (counts.pending > 0)
        header.push(`${counts.pending} ${formatStatusLabel("pending")}`);
      const lines = [header.join(" · ")];
      if (groups.pending.length > 0) {
        lines.push(t("command.section.pending", SECTION_PENDING));
        for (const task of groups.pending)
          lines.push(formatCommandTaskLine(task, "○"));
      }
      if (groups.inProgress.length > 0) {
        lines.push(t("command.section.in_progress", SECTION_IN_PROGRESS));
        for (const task of groups.inProgress)
          lines.push(formatCommandTaskLine(task, "◐"));
      }
      if (groups.completed.length > 0) {
        lines.push(t("command.section.completed", SECTION_COMPLETED));
        for (const task of groups.completed)
          lines.push(formatCommandTaskLine(task, "✓"));
      }
      ctx.ui.notify(lines.join(`
`), "info");
    }
  });
}

// plugins/pi-todo/index.ts
var PREWARM_DELAY_MS = 2000;
var STALE_OVERLAY_MESSAGE = "Todo overlay module cache is stale; restart Pi";
function isStaleOverlayModuleError(e) {
  return String(e).includes(STALE_OVERLAY_MESSAGE);
}
function makeTodoOverlayLoader(importOverlay = () => Promise.resolve().then(() => (init_todo_overlay(), exports_todo_overlay))) {
  let memo;
  return async () => {
    memo ??= importOverlay();
    const current = memo;
    let mod;
    try {
      mod = await current;
    } catch (error) {
      if (memo === current)
        memo = undefined;
      throw error;
    }
    if (typeof mod.TodoOverlay !== "function") {
      const keys = JSON.stringify(Object.keys(mod));
      throw new Error(`${STALE_OVERLAY_MESSAGE} (resolved namespace keys: ${keys})`);
    }
    return mod;
  };
}
function registerLocales(_packageUrl) {}
function isStaleCtxError(e) {
  return /stale after session replacement/.test(String(e));
}
function formatError(e) {
  return e instanceof Error ? e.message : String(e);
}
function pi_todo_default(pi, importOverlay = () => Promise.resolve().then(() => (init_todo_overlay(), exports_todo_overlay))) {
  let todoOverlay;
  const loadTodoOverlay = makeTodoOverlayLoader(importOverlay);
  let uiCtx;
  let lifecycleGeneration = 0;
  async function updateTodoOverlay(resetCompletedDisplayState = false, generation = lifecycleGeneration) {
    const hasVisibleTasks = getRenderState().tasks.some((task) => task.status !== "deleted");
    if (!uiCtx || !todoOverlay && !hasVisibleTasks)
      return;
    const { TodoOverlay } = await loadTodoOverlay();
    if (generation !== lifecycleGeneration || !uiCtx)
      return;
    todoOverlay ??= new TodoOverlay;
    todoOverlay.setUICtx(uiCtx);
    if (resetCompletedDisplayState)
      todoOverlay.resetCompletedDisplayState();
    todoOverlay.update();
  }
  registerTodoTool(pi);
  registerTodosCommand(pi);
  registerSettleReminder(pi);
  const collapseKey = resolveCollapseKey();
  if (collapseKey !== COLLAPSE_KEY_OFF) {
    pi.registerShortcut(collapseKey, {
      description: "Collapse or expand the todo overlay",
      handler: (ctx) => {
        if (!ctx.hasUI || !todoOverlay?.isRegistered())
          return;
        todoOverlay.toggleCollapse();
      }
    });
  }
  const replayAndRefresh = async (ctx) => {
    let isForeground = false;
    try {
      const id = sid(ctx);
      replaceState(id, replayFromBranch(ctx));
      isForeground = id === getActiveRenderSession();
    } catch (e) {
      if (!isStaleCtxError(e))
        throw e;
    }
    if (isForeground)
      await updateTodoOverlay(true);
  };
  pi.on("session_start", async (_event, ctx) => {
    let id;
    try {
      id = sid(ctx);
      replaceState(id, replayFromBranch(ctx));
    } catch (e) {
      if (!isStaleCtxError(e))
        throw e;
      return;
    }
    if (!ctx.hasUI)
      return;
    if (getActiveRenderSession() === "")
      setActiveRenderSession(id);
    if (id !== getActiveRenderSession())
      return;
    const generation = ++lifecycleGeneration;
    uiCtx = ctx.ui;
    await updateTodoOverlay(true, generation);
  });
  pi.on("session_compact", async (_event, ctx) => {
    await replayAndRefresh(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await replayAndRefresh(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    let s;
    try {
      s = sid(ctx);
    } catch (e) {
      if (!isStaleCtxError(e))
        throw e;
      s = "";
    }
    evictSession(s);
    if (s === "" || s === getActiveRenderSession()) {
      lifecycleGeneration++;
      uiCtx = undefined;
      try {
        todoOverlay?.dispose();
      } finally {
        todoOverlay = undefined;
        clearActiveRenderSession();
      }
    }
  });
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME || event.isError)
      return;
    try {
      await updateTodoOverlay();
    } catch (e) {
      if (isStaleOverlayModuleError(e))
        throw e;
      console.warn(`[rpiv-todo] overlay refresh failed (will retry on next update): ${formatError(e)}`);
    }
  });
  const prewarmTimer = setTimeout(() => void loadTodoOverlay().catch(() => {
    return;
  }), PREWARM_DELAY_MS);
  prewarmTimer.unref?.();
  pi.on("agent_start", async () => {
    todoOverlay?.hideCompletedTasksFromPreviousTurn();
  });
}
