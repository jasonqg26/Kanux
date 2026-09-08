const { Modal, Notice, Setting } = require("obsidian");

// Customize: a board's appearance, changed live. Every control ends up as a CSS
// variable or class on the board root; the strip at the top is a slice of the
// board drawn by those same rules, so what it shows is what the board gets.
const {
  CODE_PLACEMENTS,
  CODE_STYLES,
  LIST_COLORS,
  cardCodeChip,
  clone,
  createElement,
} = require("../helpers");
const { boardAppearanceMethods } = require("../board/board-appearance");
const { choiceGroup } = require("./modal-ui");
const { TextPromptModal, confirmAction } = require("./prompt-modals");
const { VaultBackgroundSuggestModal } = require("./vault-suggest-modals");

// A slider or colour picker fires on every tick of a drag. The preview follows
// every tick; the board and data.json wait until the hand pauses this long.
const COMMIT_DELAY_MS = 140;
const BUILTIN_PRESETS = [
  ["obsidian", "Obsidian theme"],
  ["trello-dark", "Trello dark"],
  ["trello-light", "Trello light"],
  ["transparent", "Transparent"],
  ["high-contrast", "High contrast"],
  ["custom", "Custom"],
];
const CODE_STYLE_LABELS = { outline: "Outline", filled: "Filled", soft: "Soft", plain: "Plain" };
const CODE_PLACEMENT_LABELS = { inline: "Before title", above: "Above title" };
// The palette by name, in its order, so a colour dot is announced as more than a hex code.
const COLOR_NAMES = ["Slate", "Blue", "Green", "Amber", "Red", "Violet", "Teal", "Pink"];
// The style options are drawn as chips; this is the text inside them.
const SAMPLE_CODE = "01";
const PREVIEW_CODE = "BUG-014";
// Where keyboard focus can land inside a settings row.
const FOCUSABLE = "button, input, select, [tabindex]:not([tabindex=\"-1\"])";

const px = (value) => `${Math.round(value)}px`;
const percent = (value) => `${Math.round(value * 100)}%`;
const times = (value) => `${Number(value).toFixed(2)}×`;

/** Merges one level deep, the way the plugin does: a section is an object, the rest is replaced. */
function mergeAppearancePatch(target, patch) {
  Object.entries(patch || {}).forEach(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) target[key] = Object.assign({}, target[key] || {}, value);
    else target[key] = value;
  });
  return target;
}

class BoardAppearanceModal extends Modal {
  /**
   * `onClosed` lets whoever opened this on top of their own dialog repaint
   * once the user is done here; the template editor's preview relies on it.
   */
  constructor(app, plugin, boardId, onClosed = null) {
    super(app);
    this.plugin = plugin;
    this.boardId = boardId;
    this.onClosed = onClosed;
    this.bodyEl = null;
    this.previewRoot = null;
    this.presetDropdown = null;
    this.codeStyleGroup = null;
    // Edits not written yet, merged into one patch and committed together.
    this.pendingPatch = null;
    this.commitTimer = null;
  }

  onOpen() {
    this.render(false);
  }

  onClose() {
    this.flushCommit();
    this.contentEl.replaceChildren();
    if (this.onClosed) this.onClosed();
  }

  /** The appearance as the user sees it: what is stored plus what still waits to be written. */
  draftAppearance() {
    const draft = clone(this.plugin.getBoardAppearance(this.boardId));
    return this.plugin.normalizeAppearance(mergeAppearancePatch(draft, this.pendingPatch));
  }

  /**
   * Applies a change. The preview answers at once; the board and data.json
   * follow now or, for a control mid-drag, once the hand pauses.
   */
  update(patch, options = {}) {
    this.pendingPatch = mergeAppearancePatch(this.pendingPatch || {}, patch);
    this.paintPreview(this.draftAppearance());
    if (options.debounce) {
      window.clearTimeout(this.commitTimer);
      this.commitTimer = window.setTimeout(() => { this.commit().catch(console.error); }, COMMIT_DELAY_MS);
      return Promise.resolve();
    }
    return this.commit(options.rerender);
  }

  async commit(rerender = false) {
    window.clearTimeout(this.commitTimer);
    this.commitTimer = null;
    const patch = this.pendingPatch;
    this.pendingPatch = null;
    if (patch) await this.plugin.updateBoardAppearance(this.boardId, patch);
    if (rerender) this.render();
    else this.syncPreset();
  }

  flushCommit() {
    if (this.pendingPatch) this.commit().catch(console.error);
  }

  /** Any edit turns a built-in preset into this board's own; the dropdown says so at once. */
  syncPreset() {
    if (!this.presetDropdown) return;
    const preset = this.plugin.getBoardAppearance(this.boardId).preset;
    if (this.presetDropdown.getValue() !== preset) this.presetDropdown.setValue(preset);
  }

  chooseComputerImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp,image/avif,image/x-icon";
    input.style.display = "none";
    document.body.append(input);
    const cleanup = () => input.remove();
    input.addEventListener("cancel", cleanup, { once: true });
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      try {
        if (!file) return;
        const imagePath = await this.plugin.importAppearanceBackground(file);
        await this.update({
          background: { type: "image", imageSource: "plugin", imagePath, imageFit: "original" },
        }, { rerender: true });
        new Notice("Background image imported into Kanux's private data folder.");
      } catch (error) {
        new Notice(error && error.message
          ? error.message
          : "The background image could not be imported. Try a PNG, JPG or WebP file, or pick one from the vault.");
      } finally {
        cleanup();
      }
    }, { once: true });
    try {
      if (typeof input.showPicker === "function") input.showPicker();
      else input.click();
    } catch (error) {
      input.click();
    }
  }

  render(preserveScroll = true) {
    const board = this.plugin.findBoard(this.boardId);
    if (!board) { this.close(); return; }
    const appearance = this.draftAppearance();
    // A redraw must not cost the user their place: scroll and focus come back.
    const focus = preserveScroll ? this.captureFocus() : null;
    const scrollTop = preserveScroll && this.bodyEl ? this.bodyEl.scrollTop : 0;

    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-appearance-modal-shell");
    this.contentEl.addClass("ot-appearance-modal");

    const intro = createElement("p", "ot-appearance-modal-intro", "Only this board changes, and it changes as you go. The strip shows what the board gets.");
    this.previewRoot = this.buildPreview(board, appearance);
    this.bodyEl = createElement("div", "ot-appearance-modal-body");
    this.contentEl.append(createElement("h2", "", `Customize ${board.name}`), intro, this.previewRoot, this.bodyEl, this.buildActions());

    this.renderPreset(appearance);
    this.renderBackground(appearance);
    this.renderCards(appearance);
    this.renderCodes(appearance);
    this.renderColumns(appearance);
    this.renderLayout(appearance);
    this.renderReuse(board);

    if (!preserveScroll) return;
    requestAnimationFrame(() => {
      this.bodyEl.scrollTop = scrollTop;
      this.restoreFocus(focus);
    });
  }

  captureFocus() {
    const active = document.activeElement;
    const row = active && this.contentEl.contains(active) ? active.closest("[data-ot-setting]") : null;
    if (!row) return null;
    return { key: row.dataset.otSetting, index: Array.from(row.querySelectorAll(FOCUSABLE)).indexOf(active) };
  }

  restoreFocus(focus) {
    if (!focus) return;
    const row = this.contentEl.querySelector(`[data-ot-setting="${focus.key}"]`);
    const controls = row ? Array.from(row.querySelectorAll(FOCUSABLE)) : [];
    const target = controls[Math.max(0, focus.index)] || controls[0];
    if (target) target.focus({ preventScroll: true });
  }

  /** A settings row with a stable key, so focus can find it again after a redraw. */
  row(key, name, desc = "") {
    const setting = new Setting(this.bodyEl).setName(name);
    if (desc) setting.setDesc(desc);
    setting.settingEl.dataset.otSetting = key;
    return setting;
  }

  heading(title, intro = "") {
    new Setting(this.bodyEl).setName(title).setHeading();
    if (intro) this.bodyEl.append(createElement("p", "ot-appearance-section-intro", intro));
  }

  /** A slider that says its value: the tooltip alone shows nothing on touch. */
  slider(setting, { min, max, step, value, format, patch }) {
    const readout = createElement("span", "ot-appearance-value", format(value));
    setting.addSlider((slider) => slider.setLimits(min, max, step).setValue(value).setDynamicTooltip()
      .onChange((next) => {
        readout.textContent = format(next);
        this.update(patch(next), { debounce: true });
      }));
    setting.controlEl.prepend(readout);
    return setting;
  }

  /**
   * A slice of the board drawn by the board's own rules: the root's variables
   * and classes, one column, two cards, one wearing a code. Decorative, so it
   * is hidden from assistive tech; the controls below carry the meaning.
   */
  buildPreview(board, appearance) {
    const root = createElement("div", "ot-board-root ot-appearance-preview");
    root.setAttribute("aria-hidden", "true");
    const first = board.lists[0];

    const list = createElement("div", "ot-list ot-appearance-preview-list");
    list.style.setProperty("--ot-list-color", (first && first.color) || "var(--interactive-accent)");
    const title = createElement("div", "ot-appearance-preview-list-title");
    title.append(createElement("span", "ot-mini-card-dot"), createElement("span", "", (first && first.title) || "To do"));
    const cards = createElement("div", "ot-appearance-preview-cards");
    cards.append(this.previewCard(PREVIEW_CODE, "Fix the login redirect"), this.previewCard("", "Write the release notes"));
    list.append(title, cards);

    root.append(list);
    this.paintPreview(appearance, root);
    return root;
  }

  previewCard(code, text) {
    const card = createElement("div", "ot-card ot-appearance-preview-card");
    const title = createElement("div", "ot-card-title");
    if (code) title.append(cardCodeChip(code, null));
    title.append(createElement("span", "ot-card-title-text", text));
    card.append(title);
    return card;
  }

  paintPreview(appearance, root = this.previewRoot) {
    if (!root) return;
    // The board view's own painters, pointed at the strip instead of a view:
    // the whole mixin, so an image background can reach its own helper, and
    // the plugin, so that helper can resolve the image.
    const view = Object.assign(Object.create(boardAppearanceMethods), { plugin: this.plugin });
    view.applyAppearanceVariables(root, appearance);
    view.applyAppearanceClasses(root, appearance);
    view.applyBoardBackground(root, appearance.background);
    // The chip is rebuilt so style, colour and placement follow the choice.
    root.querySelectorAll(".ot-card-code").forEach((chip) => chip.replaceWith(cardCodeChip(chip.textContent, appearance.codes)));
    if (this.codeStyleGroup) {
      if (appearance.codes.color) this.codeStyleGroup.style.setProperty("--ot-code-color", appearance.codes.color);
      else this.codeStyleGroup.style.removeProperty("--ot-code-color");
    }
  }

  renderPreset(appearance) {
    this.heading("Preset");
    this.row("preset", "Visual preset", "Start from a built-in look. Any change below makes it this board's own.")
      .addDropdown((dropdown) => {
        this.presetDropdown = dropdown;
        BUILTIN_PRESETS.forEach(([value, label]) => dropdown.addOption(value, label));
        dropdown.setValue(appearance.preset).onChange(async (value) => {
          if (value === "custom") {
            await this.update({ preset: "custom" });
            return;
          }
          await this.plugin.applyBoardAppearancePreset(this.boardId, value);
          this.render();
        });
      });
  }

  renderBackground(appearance) {
    const background = appearance.background;
    this.heading("Background");
    this.row("background.type", "Background type").addDropdown((dropdown) => dropdown
      .addOption("theme", "Obsidian theme")
      .addOption("solid", "Solid color")
      .addOption("gradient", "Gradient")
      .addOption("image", "Image")
      .setValue(background.type)
      .onChange((value) => this.update({ background: { type: value } }, { rerender: true })));

    if (background.type === "solid") {
      this.row("background.color", "Background color").addColorPicker((picker) => picker
        .setValue(background.color)
        .onChange((value) => this.update({ background: { color: value } }, { debounce: true })));
    }
    if (background.type === "gradient") {
      this.row("background.gradientStart", "Gradient start").addColorPicker((picker) => picker
        .setValue(background.gradientStart)
        .onChange((value) => this.update({ background: { gradientStart: value } }, { debounce: true })));
      this.row("background.gradientEnd", "Gradient end").addColorPicker((picker) => picker
        .setValue(background.gradientEnd)
        .onChange((value) => this.update({ background: { gradientEnd: value } }, { debounce: true })));
    }
    if (background.type === "image") this.renderBackgroundImage(background);
  }

  renderBackgroundImage(background) {
    const source = background.imageSource === "plugin" ? "Kanux data" : "Vault";
    const image = this.row("background.image", "Background image", background.imagePath
      ? `${source}: ${background.imagePath.split("/").pop()}`
      : "No image chosen yet.")
      .addButton((button) => button.setButtonText("From vault").onClick(() => {
        new VaultBackgroundSuggestModal(this.app, (file) => {
          this.update({ background: { imageSource: "vault", imagePath: file.path, imageFit: "original" } }, { rerender: true }).catch(console.error);
        }).open();
      }))
      .addButton((button) => button.setButtonText("From this device").setCta().onClick(() => this.chooseComputerImage()));
    if (background.imagePath) {
      image.addButton((button) => button.setButtonText("Clear").onClick(() => this.update({ background: { imagePath: "" } }, { rerender: true })));
    }

    this.row("background.imageFit", "Image fit", "Cover fills the board without stretching the image; its edges may be cropped.")
      .addDropdown((dropdown) => dropdown
        .addOption("original", "Original size, no enlargement")
        .addOption("cover", "Cover: fill the board, crop the edges")
        .addOption("contain", "Contain: show the whole image")
        .addOption("repeat", "Repeat at original size")
        .setValue(background.imageFit)
        .onChange((value) => this.update({ background: { imageFit: value } })));
    this.slider(this.row("background.overlayOpacity", "Image darkening", "A dark layer over the image, so text stays readable."), {
      min: 0, max: 0.85, step: 0.05, value: background.overlayOpacity, format: percent,
      patch: (value) => ({ background: { overlayOpacity: value } }),
    });
  }

  renderCards(appearance) {
    const cards = appearance.cards;
    this.heading("Cards");
    this.row("cards.useTheme", "Use theme card color", cards.useTheme
      ? "Cards follow the Obsidian theme. Turn off to choose their color and hover color."
      : "Cards use the two colors below.")
      .addToggle((toggle) => toggle.setValue(cards.useTheme)
        .onChange((value) => this.update({ cards: { useTheme: value } }, { rerender: true })));
    this.row("cards.background", "Card color").addColorPicker((picker) => picker
      .setValue(cards.background).setDisabled(cards.useTheme)
      .onChange((value) => this.update({ cards: { background: value } }, { debounce: true })));
    this.row("cards.hoverBackground", "Hover color", "The card while the pointer rests on it.").addColorPicker((picker) => picker
      .setValue(cards.hoverBackground).setDisabled(cards.useTheme)
      .onChange((value) => this.update({ cards: { hoverBackground: value } }, { debounce: true })));
    this.slider(this.row("cards.borderRadius", "Corners"), {
      min: 0, max: 24, step: 1, value: cards.borderRadius, format: px,
      patch: (value) => ({ cards: { borderRadius: value } }),
    });
    this.row("cards.shadow", "Shadow").addDropdown((dropdown) => dropdown
      .addOption("none", "None").addOption("small", "Small").addOption("medium", "Medium").addOption("large", "Large")
      .setValue(cards.shadow)
      .onChange((value) => this.update({ cards: { shadow: value } })));
    this.slider(this.row("cards.verticalGap", "Space between cards"), {
      min: 0, max: 28, step: 1, value: cards.verticalGap, format: px,
      patch: (value) => ({ cards: { verticalGap: value } }),
    });
    this.slider(this.row("cards.titleSize", "Title size"), {
      min: 12, max: 30, step: 1, value: cards.titleSize, format: px,
      patch: (value) => ({ cards: { titleSize: value } }),
    });
    this.row("labels.displayMode", "Label display", "When a card's labels show their names.").addDropdown((dropdown) => dropdown
      .addOption("compact", "Always compact")
      .addOption("expanded", "Always expanded")
      .addOption("hover", "Expand the hovered label")
      .addOption("card-hover", "Expand while the card is hovered")
      .setValue(appearance.labels.displayMode)
      .onChange((value) => this.update({ labels: { displayMode: value } })));
  }

  /**
   * One look for every code chip on the board, so BUG-014 and FEAT-002 read as
   * the same kind of thing. The style options are the chips themselves, and the
   * group carries the chosen colour so every sample follows it.
   */
  renderCodes(appearance) {
    const codes = appearance.codes;
    this.heading("Card codes", "A template that numbers its cards stamps each one with a code like BUG-014. Every code on this board is drawn the same way.");

    this.codeStyleGroup = choiceGroup("ot-segmented ot-appearance-choice", "Code style", CODE_STYLES.map((style) => ({
      value: style,
      label: CODE_STYLE_LABELS[style],
      render: (button) => button.append(cardCodeChip(SAMPLE_CODE, { style })),
    })), codes.style, (style) => this.update({ codes: { style } }));
    if (codes.color) this.codeStyleGroup.style.setProperty("--ot-code-color", codes.color);
    this.row("codes.style", "Style", "Outlined, filled, softly tinted, or plain text.").controlEl.append(this.codeStyleGroup);

    const colors = choiceGroup("ot-code-colors", "Code color", [
      // The accent dot is painted by the stylesheet, so it has nothing to render.
      { value: "", label: "Accent (theme color)", render: () => {} },
      ...LIST_COLORS.map((color, index) => ({
        value: color,
        label: COLOR_NAMES[index] || color,
        render: (button) => button.style.setProperty("--ot-swatch", color),
      })),
    ], codes.color, (color) => this.update({ codes: { color } }));
    this.row("codes.color", "Color", "The theme's accent, or one of the palette.").controlEl.append(colors);

    const placement = choiceGroup("ot-segmented ot-appearance-choice", "Code placement", CODE_PLACEMENTS.map((value) => ({
      value,
      label: CODE_PLACEMENT_LABELS[value],
    })), codes.placement, (value) => this.update({ codes: { placement: value } }));
    this.row("codes.placement", "Placement", "In front of the title, or on a line of its own above it.").controlEl.append(placement);
  }

  renderColumns(appearance) {
    const lists = appearance.lists;
    this.heading("Columns");
    this.row("lists.useTheme", "Use theme column color", lists.useTheme
      ? "Columns follow the Obsidian theme. Turn off to choose their color."
      : "Columns use the color below.")
      .addToggle((toggle) => toggle.setValue(lists.useTheme)
        .onChange((value) => this.update({ lists: { useTheme: value } }, { rerender: true })));
    this.row("lists.background", "Column color").addColorPicker((picker) => picker
      .setValue(lists.background).setDisabled(lists.useTheme)
      .onChange((value) => this.update({ lists: { background: value } }, { debounce: true })));
    this.slider(this.row("lists.borderRadius", "Corners"), {
      min: 0, max: 24, step: 1, value: lists.borderRadius, format: px,
      patch: (value) => ({ lists: { borderRadius: value } }),
    });
    this.slider(this.row("lists.columnGap", "Space between columns"), {
      min: 0, max: 40, step: 1, value: lists.columnGap, format: px,
      patch: (value) => ({ lists: { columnGap: value } }),
    });
    this.slider(this.row("lists.topBorderWidth", "Top border", "A band in the column's color along its top edge."), {
      min: 0, max: 12, step: 1, value: lists.topBorderWidth, format: px,
      patch: (value) => ({ lists: { topBorderWidth: value } }),
    });
    this.row("lists.showColorDot", "Show color dot", "A dot in the column's color beside its name.").addToggle((toggle) => toggle
      .setValue(lists.showColorDot)
      .onChange((value) => this.update({ lists: { showColorDot: value } })));
  }

  renderLayout(appearance) {
    this.heading("Layout and typography");
    this.row("colorScheme", "Content contrast", "The board's text colors, independent of the Obsidian theme.").addDropdown((dropdown) => dropdown
      .addOption("theme", "Follow Obsidian theme")
      .addOption("dark", "Light text on dark surfaces")
      .addOption("light", "Dark text on light surfaces")
      .setValue(appearance.colorScheme)
      .onChange((value) => this.update({ colorScheme: value })));
    this.row("density", "Density", "How much room columns and cards take.").addDropdown((dropdown) => dropdown
      .addOption("compact", "Compact").addOption("normal", "Normal").addOption("comfortable", "Comfortable")
      .setValue(appearance.density)
      .onChange((value) => this.update({ density: value })));
    this.slider(this.row("fontScale", "Text scale"), {
      min: 0.85, max: 1.4, step: 0.05, value: appearance.fontScale, format: times,
      patch: (value) => ({ fontScale: value }),
    });
    this.row("motion.enabled", "Animations", "Movement when cards and columns change.").addToggle((toggle) => toggle
      .setValue(appearance.motion.enabled)
      .onChange((value) => this.update({ motion: { enabled: value } })));
  }

  /** Saving, applying and copying whole looks: the rare actions, kept at the end. */
  renderReuse(board) {
    this.heading("Save and reuse");
    const presets = this.plugin.getAppearancePresets();
    let selectedPresetId = presets[0] ? presets[0].id : "";
    const saved = this.row("presets", "Saved presets", presets.length
      ? "Apply a look you saved, or save this board's look to use it on other boards."
      : "Save this board's look to use it on other boards.");
    if (presets.length) {
      saved.addDropdown((dropdown) => {
        presets.forEach((preset) => dropdown.addOption(preset.id, preset.name));
        dropdown.setValue(selectedPresetId).onChange((value) => { selectedPresetId = value; });
      });
      saved.addButton((button) => button.setButtonText("Apply").onClick(async () => {
        const preset = presets.find((item) => item.id === selectedPresetId);
        if (!preset) return;
        if (!await this.confirmReplace(`Apply the preset "${preset.name}" to this board?`)) return;
        await this.plugin.applyCustomAppearancePreset(this.boardId, preset.id);
        this.render();
      }));
      saved.addButton((button) => button.setButtonText("Delete").setWarning().onClick(async () => {
        const preset = presets.find((item) => item.id === selectedPresetId);
        if (!preset) return;
        const confirmed = await confirmAction(this.app, "Delete appearance preset", `Delete the preset "${preset.name}"? Boards that used it keep their look.`);
        if (!confirmed) return;
        await this.plugin.deleteAppearancePreset(preset.id);
        this.render();
      }));
    }
    saved.addButton((button) => button.setButtonText("Save as preset…").onClick(() => {
      new TextPromptModal(this.app, "Save appearance", "Preset name", "", async (name) => {
        const preset = await this.plugin.saveAppearancePreset(name, this.plugin.getBoardAppearance(this.boardId));
        if (!preset) return;
        new Notice(`Appearance preset "${preset.name}" saved.`);
        this.render();
      }).open();
    }));

    const others = this.plugin.data.boards.filter((item) => item.id !== board.id);
    let sourceBoardId = others[0] ? others[0].id : "";
    const copy = this.row("copy", "Copy from another board", others.length
      ? "Replace this board's appearance with another board's."
      : "Create another board to copy its appearance.");
    if (!others.length) return;
    copy.addDropdown((dropdown) => {
      others.forEach((item) => dropdown.addOption(item.id, item.name));
      dropdown.setValue(sourceBoardId).onChange((value) => { sourceBoardId = value; });
    });
    copy.addButton((button) => button.setButtonText("Copy appearance").onClick(async () => {
      const source = others.find((item) => item.id === sourceBoardId);
      if (!source) return;
      if (!await this.confirmReplace(`Copy the appearance of "${source.name}" onto this board?`)) return;
      await this.plugin.copyBoardAppearance(this.boardId, source.id);
      this.render();
    }));
  }

  /** Replacing a look is one click and has no undo, so it asks first. */
  confirmReplace(question) {
    return confirmAction(this.app, "Replace this board's appearance", `${question} The current look is replaced; save it as a preset first if you want it back.`, {
      confirmText: "Replace",
      confirmIcon: "palette",
      warning: "",
    });
  }

  buildActions() {
    const actions = createElement("div", "ot-modal-actions");
    // Keyed like a settings row, so focus comes back to Reset after it redraws.
    actions.dataset.otSetting = "actions";
    const reset = createElement("button", "mod-warning", "Reset this board");
    const done = createElement("button", "mod-cta", "Done");
    reset.type = "button";
    done.type = "button";
    reset.addEventListener("click", async () => {
      const confirmed = await confirmAction(this.app, "Reset this board", "Reset every appearance setting of this board to the Obsidian theme look? Saved presets are kept.", {
        confirmText: "Reset",
        confirmIcon: "rotate-ccw",
      });
      if (!confirmed) return;
      await this.plugin.applyBoardAppearancePreset(this.boardId, "obsidian");
      this.render();
    });
    done.addEventListener("click", () => this.close());
    actions.append(reset, done);
    return actions;
  }
}

module.exports = {
  BoardAppearanceModal,
};
