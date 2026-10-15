/* pi-picker-patch:start — reasoning level in the model picker (local patch; see pi-config/patches/README.md) */
/*
 * Appended by `patches/model-picker.mjs` to the pi bundle chunk that defines
 * ModelSelectorComponent (the file that actually runs when you type /model).
 *
 * Everything here only *wraps* existing behaviour, so it survives being
 * appended to a minified chunk: it never rewrites a line of upstream code.
 * It does depend on these chunk-scope names still existing:
 *
 *   ModelSelectorComponent.prototype.{handleInput,updateList,handleSelect}
 *   InteractiveMode.prototype.showModelSelector          (to reach the session)
 *   theme.fg, Text, matchesKey, Key
 *   getSupportedThinkingLevels, clampThinkingLevel       (guarded, fallback inlined)
 *
 * If a pi update renames them, the guards below make the block a no-op and
 * `patches/model-picker.mjs --check` reports it, instead of breaking pi.
 */
(function () {
  var g = globalThis;
  if (g.__piPickerPatchInstalled) return;

  var levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  var supportedLevels = function (model) {
    // Mirrors @earendil-works/pi-ai getSupportedThinkingLevels(); used only if
    // that import is not in chunk scope any more.
    if (typeof getSupportedThinkingLevels === "function") return getSupportedThinkingLevels(model);
    if (!model || !model.reasoning) return ["off"];
    var map = model.thinkingLevelMap;
    return levels.filter(function (level) {
      var mapped = map ? map[level] : undefined;
      if (mapped === null) return false;
      if (level === "xhigh" || level === "max") return mapped !== undefined;
      return true;
    });
  };

  var clampLevel = function (model, level) {
    // Mirrors @earendil-works/pi-ai clampThinkingLevel().
    if (typeof clampThinkingLevel === "function") return clampThinkingLevel(model, level);
    var available = supportedLevels(model);
    if (available.indexOf(level) !== -1) return level;
    var requested = levels.indexOf(level);
    if (requested === -1) return available[0] || "off";
    for (var up = requested; up < levels.length; up++) {
      if (available.indexOf(levels[up]) !== -1) return levels[up];
    }
    for (var down = requested - 1; down >= 0; down--) {
      if (available.indexOf(levels[down]) !== -1) return levels[down];
    }
    return available[0] || "off";
  };

  if (typeof ModelSelectorComponent !== "function" || !ModelSelectorComponent.prototype) return;
  if (typeof InteractiveMode !== "function" || !InteractiveMode.prototype) return;

  g.__piPickerPatchInstalled = true;

  var sessionOf = function () {
    var mode = g.__piPickerMode;
    return mode && mode.session ? mode.session : undefined;
  };

  var highlightedModel = function (component) {
    var items = component.filteredModels;
    var item = items && items[component.selectedIndex];
    return item ? item.model : undefined;
  };

  /** The level the picker currently shows for a model: the pending choice, clamped. */
  var pendingLevel = function (component, model) {
    if (component.__piPickerLevel === undefined) {
      var session = sessionOf();
      component.__piPickerLevel = session && session.thinkingLevel ? session.thinkingLevel : "off";
    }
    return clampLevel(model, component.__piPickerLevel);
  };

  /*
   * The picker has no reference to the session, but InteractiveMode owns both.
   * Capture the instance while the picker opens, and make its session apply a
   * level chosen in the picker right after the model lands (setModel re-clamps
   * the session level for the new model, so the order matters).
   */
  var patchSession = function (session) {
    if (!session || session.__piPickerSetModelPatched) return;
    var original;
    try {
      original = session.setModel.bind(session);
      session.__piPickerSetModelPatched = true;
    } catch (e) {
      return;
    }
    session.setModel = async function (model, options) {
      var result = await original(model, options);
      var pending = g.__piPickerChosen;
      g.__piPickerChosen = undefined;
      if (pending && pending.level && typeof session.setThinkingLevel === "function") {
        try {
          session.setThinkingLevel(pending.level, { persist: pending.persist === true });
        } catch (e) {}
        var mode = g.__piPickerMode;
        if (mode && mode.footer && typeof mode.footer.invalidate === "function") {
          try {
            mode.footer.invalidate();
          } catch (e) {}
        }
      }
      return result;
    };
  };

  var showModelSelector = InteractiveMode.prototype.showModelSelector;
  InteractiveMode.prototype.showModelSelector = function () {
    g.__piPickerMode = this;
    patchSession(this.session);
    return showModelSelector.apply(this, arguments);
  };

  var handleInput = ModelSelectorComponent.prototype.handleInput;
  ModelSelectorComponent.prototype.handleInput = function (data) {
    var model = highlightedModel(this);
    if (model && typeof matchesKey === "function" && typeof Key !== "undefined") {
      if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
        var available = supportedLevels(model);
        var current = pendingLevel(this, model);
        var index = available.indexOf(current);
        if (index !== -1 && available.length > 1) {
          var next = index + (matchesKey(data, Key.right) ? 1 : -1);
          // Clamp at the ends rather than wrapping: from "max" a wrap to "off" is a surprise.
          this.__piPickerLevel = available[Math.min(available.length - 1, Math.max(0, next))];
        }
        this.updateList();
        if (this.tui && typeof this.tui.requestRender === "function") this.tui.requestRender();
        return;
      }
    }
    // Enter is handled by handleSelect() below. Ctrl+S bypasses it and calls
    // the picker's own default callback, so wrap that callback rather than
    // guessing the keybinding: the level is stashed only when the save happens.
    if (model && typeof this.onSelectAsDefaultCallback === "function" && !this.onSelectAsDefaultCallback.__piPickerWrapped) {
      var component = this;
      var originalCallback = this.onSelectAsDefaultCallback;
      var wrapped = function (selected) {
        g.__piPickerChosen = { level: pendingLevel(component, selected), persist: true };
        return originalCallback.apply(component, arguments);
      };
      wrapped.__piPickerWrapped = true;
      this.onSelectAsDefaultCallback = wrapped;
    }
    return handleInput.call(this, data);
  };

  var handleSelect = ModelSelectorComponent.prototype.handleSelect;
  ModelSelectorComponent.prototype.handleSelect = function (model) {
    g.__piPickerChosen = model ? { level: pendingLevel(this, model), persist: false } : undefined;
    return handleSelect.call(this, model);
  };

  /**
   * One line of text describing the level for the highlighted model.
   *
   * It is inserted just under the search box rather than appended to the list:
   * the picker renders into the editor area, which is height-bounded, so the
   * last lines (the hint line and bottom border) are the first to be clipped
   * when the terminal is short. The top of the picker is always visible.
   */
  var reasoningText = function (component, model) {
    var available = supportedLevels(model);
    var prefix = theme.fg("muted", "  Reasoning: ");
    if (!model.reasoning) return prefix + theme.fg("dim", "off \u00b7 model has no thinking levels");
    if (available.length <= 1) {
      return prefix + theme.fg("accent", available[0] || "off") + theme.fg("dim", " \u00b7 no other levels");
    }
    return prefix + theme.fg("accent", pendingLevel(component, model)) + theme.fg("dim", "  \u2190 \u2192");
  };

  /** The picker's search box: the only child that can read a value. */
  var searchInputIndex = function (children) {
    for (var index = 0; index < children.length; index++) {
      var child = children[index];
      if (child && typeof child.getValue === "function") return index;
    }
    return -1;
  };

  var updateList = ModelSelectorComponent.prototype.updateList;
  ModelSelectorComponent.prototype.updateList = function () {
    var result = updateList.apply(this, arguments);
    try {
      var model = highlightedModel(this);
      if (!model || typeof theme === "undefined" || typeof Text !== "function") return result;
      var line = reasoningText(this, model);
      var existing = this.__piPickerReasoning;
      if (existing && typeof existing.setText === "function") {
        existing.setText(line);
      } else {
        var children = this.children;
        var anchor = children ? searchInputIndex(children) : -1;
        var text = new Text(line, 0, 0);
        this.__piPickerReasoning = text;
        if (anchor !== -1) children.splice(anchor + 1, 0, text);
        else if (this.listContainer) this.listContainer.addChild(text);
      }
    } catch (e) {}
    return result;
  };
})();
/* pi-picker-patch:end */
