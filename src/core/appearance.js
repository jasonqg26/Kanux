// Appearance state: normalization, per-board overrides, built-in and custom
// presets, and the background image assets stored under the config dir.
const {
  DEFAULT_APPEARANCE,
  cleanColor,
  clone,
  isImagePath,
  textLine,
  uid,
} = require("../helpers");

// One shared table for the built-in looks so the global and per-board preset
// pickers can never drift apart.
const BUILTIN_APPEARANCE_PRESETS = {
  obsidian: DEFAULT_APPEARANCE,
  "trello-dark": {
    preset: "trello-dark",
    colorScheme: "dark",
    surfaceScheme: "dark",
    density: "normal",
    fontScale: 1,
    background: { type: "solid", color: "#0f172a", overlayOpacity: 0.35 },
    cards: { useTheme: false, background: "#26282c", hoverBackground: "#30343b", borderRadius: 9, shadow: "medium" },
    lists: { useTheme: false, background: "#101214", borderRadius: 12 },
    motion: { enabled: true },
  },
  "trello-light": {
    preset: "trello-light",
    colorScheme: "light",
    surfaceScheme: "light",
    density: "normal",
    fontScale: 1,
    background: { type: "solid", color: "#dbeafe", overlayOpacity: 0.1 },
    cards: { useTheme: false, background: "#ffffff", hoverBackground: "#f4f5f7", borderRadius: 9, shadow: "medium" },
    lists: { useTheme: false, background: "#f1f2f4", borderRadius: 12 },
    motion: { enabled: true },
  },
  transparent: {
    preset: "transparent",
    colorScheme: "theme",
    surfaceScheme: "theme",
    density: "normal",
    fontScale: 1,
    background: { type: "theme", overlayOpacity: 0 },
    cards: { useTheme: true, borderRadius: 9, shadow: "small" },
    lists: { useTheme: true, borderRadius: 12 },
    motion: { enabled: true },
  },
  "high-contrast": {
    preset: "high-contrast",
    colorScheme: "dark",
    surfaceScheme: "dark",
    density: "comfortable",
    fontScale: 1.12,
    background: { type: "solid", color: "#000000", overlayOpacity: 0 },
    cards: { useTheme: false, background: "#242424", hoverBackground: "#303030", borderRadius: 6, shadow: "large" },
    lists: { useTheme: false, background: "#080808", borderRadius: 8 },
    motion: { enabled: false },
  },
};

// Fresh copy of a built-in preset plus its canonical name ("obsidian" for an
// unknown key, mirroring the previous fallback behavior).
function builtinAppearancePreset(preset) {
  const known = Object.prototype.hasOwnProperty.call(BUILTIN_APPEARANCE_PRESETS, preset);
  const name = known ? preset : "obsidian";
  return { appearance: clone(BUILTIN_APPEARANCE_PRESETS[name]), name };
}

const appearanceMethods = {
  normalizeAppearance(appearance) {
    const source = appearance && typeof appearance === "object" ? appearance : {};
    const background = source.background && typeof source.background === "object" ? source.background : {};
    const cards = source.cards && typeof source.cards === "object" ? source.cards : {};
    const lists = source.lists && typeof source.lists === "object" ? source.lists : {};
    const labels = source.labels && typeof source.labels === "object" ? source.labels : {};
    const motion = source.motion && typeof source.motion === "object" ? source.motion : {};
    const inferredSurfaceScheme = source.preset === "trello-light"
      ? "light"
      : (["trello-dark", "high-contrast"].includes(source.preset) ? "dark" : DEFAULT_APPEARANCE.surfaceScheme);
    const inferredCardHover = source.preset === "trello-light" || source.surfaceScheme === "light"
      ? "#f4f5f7"
      : DEFAULT_APPEARANCE.cards.hoverBackground;
    const number = (value, fallback, min, max) => Number.isFinite(Number(value))
      ? Math.min(max, Math.max(min, Number(value)))
      : fallback;
    const choice = (value, choices, fallback) => choices.includes(value) ? value : fallback;

    return {
      preset: choice(source.preset, ["obsidian", "trello-dark", "trello-light", "transparent", "high-contrast", "custom"], DEFAULT_APPEARANCE.preset),
      colorScheme: choice(source.colorScheme, ["theme", "dark", "light"], DEFAULT_APPEARANCE.colorScheme),
      surfaceScheme: choice(source.surfaceScheme, ["theme", "dark", "light"], inferredSurfaceScheme),
      density: choice(source.density, ["compact", "normal", "comfortable"], DEFAULT_APPEARANCE.density),
      fontScale: number(source.fontScale, DEFAULT_APPEARANCE.fontScale, 0.85, 1.4),
      labels: {
        displayMode: choice(labels.displayMode, ["compact", "expanded", "hover", "card-hover"], DEFAULT_APPEARANCE.labels.displayMode),
      },
      background: {
        type: choice(background.type, ["theme", "solid", "gradient", "image"], DEFAULT_APPEARANCE.background.type),
        color: cleanColor(background.color) || DEFAULT_APPEARANCE.background.color,
        gradientStart: cleanColor(background.gradientStart) || DEFAULT_APPEARANCE.background.gradientStart,
        gradientEnd: cleanColor(background.gradientEnd) || DEFAULT_APPEARANCE.background.gradientEnd,
        imagePath: textLine(background.imagePath),
        imageSource: choice(background.imageSource, ["vault", "plugin"], DEFAULT_APPEARANCE.background.imageSource),
        imageFit: choice(background.imageFit, ["original", "cover", "contain", "repeat"], DEFAULT_APPEARANCE.background.imageFit),
        imageFitVersion: 3,
        overlayOpacity: number(background.overlayOpacity, DEFAULT_APPEARANCE.background.overlayOpacity, 0, 0.85),
      },
      cards: {
        useTheme: cards.useTheme !== false,
        background: cleanColor(cards.background) || DEFAULT_APPEARANCE.cards.background,
        hoverBackground: cleanColor(cards.hoverBackground) || inferredCardHover,
        verticalGap: number(cards.verticalGap, DEFAULT_APPEARANCE.cards.verticalGap, 0, 28),
        titleSize: number(cards.titleSize, DEFAULT_APPEARANCE.cards.titleSize, 12, 30),
        borderRadius: number(cards.borderRadius, DEFAULT_APPEARANCE.cards.borderRadius, 0, 24),
        shadow: choice(cards.shadow, ["none", "small", "medium", "large"], DEFAULT_APPEARANCE.cards.shadow),
      },
      lists: {
        useTheme: lists.useTheme !== false,
        background: cleanColor(lists.background) || DEFAULT_APPEARANCE.lists.background,
        columnGap: number(lists.columnGap, DEFAULT_APPEARANCE.lists.columnGap, 0, 40),
        topBorderWidth: number(lists.topBorderWidth, DEFAULT_APPEARANCE.lists.topBorderWidth, 0, 12),
        showColorDot: lists.showColorDot !== false,
        borderRadius: number(lists.borderRadius, DEFAULT_APPEARANCE.lists.borderRadius, 0, 24),
      },
      motion: {
        enabled: motion.enabled !== false,
      },
    };
  },

  getAppearance() {
    const board = this.getBoard();
    if (!board) {
      this.data.appearance = this.normalizeAppearance(this.data.appearance);
      return this.data.appearance;
    }
    board.appearance = this.normalizeAppearance(board.appearance || this.data.appearance);
    return board.appearance;
  },

  getBoardAppearance(boardId) {
    const board = this.findBoard(boardId);
    if (!board) return this.normalizeAppearance(DEFAULT_APPEARANCE);
    board.appearance = this.normalizeAppearance(board.appearance || this.data.appearance);
    return board.appearance;
  },

  getAppearanceAssetFolder() {
    const configDir = this.app.vault.configDir || ".obsidian";
    return `${configDir}/kanux/backgrounds`.replace(/\\/g, "/");
  },

  async importAppearanceBackground(file) {
    if (!file || typeof file.arrayBuffer !== "function" || !isImagePath(file.name)) {
      throw new Error("Choose a supported image file.");
    }
    const adapter = this.app.vault.adapter;
    if (!adapter || !adapter.exists || !adapter.writeBinary || !adapter.mkdir) {
      throw new Error("This Obsidian storage adapter cannot import images.");
    }
    const folder = this.getAppearanceAssetFolder();
    const parentFolder = folder.slice(0, folder.lastIndexOf("/"));
    if (!await adapter.exists(parentFolder)) await adapter.mkdir(parentFolder);
    if (!await adapter.exists(folder)) await adapter.mkdir(folder);
    const extension = file.name.split(".").pop().toLowerCase();
    const target = `${folder}/background-${Date.now().toString(36)}.${extension}`;
    await adapter.writeBinary(target, await file.arrayBuffer());
    return target;
  },

  getAppearanceBackgroundResource(background) {
    if (!background || !background.imagePath) return "";
    if (background.imageSource === "plugin") {
      const adapter = this.app.vault.adapter;
      return adapter && adapter.getResourcePath ? adapter.getResourcePath(background.imagePath) : "";
    }
    const file = this.app.vault.getAbstractFileByPath(background.imagePath);
    return file ? this.app.vault.getResourcePath(file) : "";
  },

  async updateAppearance(patch, options = {}) {
    const current = clone(this.getAppearance());
    Object.entries(patch || {}).forEach(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        current[key] = Object.assign({}, current[key] || {}, value);
      } else {
        current[key] = value;
      }
    });
    if (!options.keepPreset && !Object.prototype.hasOwnProperty.call(patch || {}, "preset")) current.preset = "custom";
    this.data.appearance = this.normalizeAppearance(current);
    await this.saveData(this.data);
    this.refreshViews();
  },

  async updateBoardAppearance(boardId, patch, options = {}) {
    const board = this.findBoard(boardId);
    if (!board) return;
    const current = clone(this.getBoardAppearance(boardId));
    Object.entries(patch || {}).forEach(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        current[key] = Object.assign({}, current[key] || {}, value);
      } else {
        current[key] = value;
      }
    });
    if (!options.keepPreset && !Object.prototype.hasOwnProperty.call(patch || {}, "preset")) current.preset = "custom";
    board.appearance = this.normalizeAppearance(current);
    await this.saveData(this.data);
    this.refreshViews();
  },

  async applyAppearancePreset(preset) {
    const builtin = builtinAppearancePreset(preset);
    this.data.appearance = this.normalizeAppearance(builtin.appearance);
    this.data.appearance.preset = builtin.name;
    await this.saveData(this.data);
    this.refreshViews();
  },

  async applyBoardAppearancePreset(boardId, preset) {
    const builtin = builtinAppearancePreset(preset);
    const selected = this.normalizeAppearance(builtin.appearance);
    selected.preset = builtin.name;
    const board = this.findBoard(boardId);
    if (board) board.appearance = selected;
    await this.saveData(this.data);
    this.refreshViews();
  },

  getAppearancePresets() {
    return Array.isArray(this.data.appearancePresets) ? this.data.appearancePresets : [];
  },

  async saveAppearancePreset(name, appearance) {
    const cleanName = textLine(name);
    if (!cleanName) return null;
    this.data.appearancePresets = this.getAppearancePresets();
    const existing = this.data.appearancePresets.find((preset) => preset.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      existing.name = cleanName;
      existing.appearance = this.normalizeAppearance(clone(appearance));
      existing.createdAt = new Date().toISOString();
      await this.saveData(this.data);
      return existing;
    }
    const preset = {
      id: uid("appearance-preset"),
      name: cleanName,
      appearance: this.normalizeAppearance(clone(appearance)),
      createdAt: new Date().toISOString(),
    };
    this.data.appearancePresets.push(preset);
    await this.saveData(this.data);
    return preset;
  },

  async deleteAppearancePreset(presetId) {
    const before = this.getAppearancePresets().length;
    this.data.appearancePresets = this.getAppearancePresets().filter((preset) => preset.id !== presetId);
    if (this.data.appearancePresets.length === before) return false;
    await this.saveData(this.data);
    return true;
  },

  async applyCustomAppearancePreset(boardId, presetId) {
    const board = this.findBoard(boardId);
    const preset = this.getAppearancePresets().find((item) => item.id === presetId);
    if (!board || !preset) return false;
    board.appearance = this.normalizeAppearance(clone(preset.appearance));
    board.appearance.preset = "custom";
    await this.saveData(this.data);
    this.refreshViews();
    return true;
  },

  async copyBoardAppearance(targetBoardId, sourceBoardId) {
    const target = this.findBoard(targetBoardId);
    const source = this.findBoard(sourceBoardId);
    if (!target || !source || target.id === source.id) return false;
    target.appearance = this.normalizeAppearance(clone(this.getBoardAppearance(source.id)));
    target.appearance.preset = "custom";
    await this.saveData(this.data);
    this.refreshViews();
    return true;
  },

  async toggleCompactLabels() {
    const next = this.getLabelDisplayMode() === "compact" ? "expanded" : "compact";
    await this.setLabelDisplayMode(next);
  },

  getLabelDisplayMode() {
    return this.getAppearance().labels.displayMode;
  },

  async setLabelDisplayMode(mode) {
    const next = ["compact", "expanded", "hover", "card-hover"].includes(mode) ? mode : "expanded";
    const board = this.getBoard();
    if (!board) return;
    await this.updateBoardAppearance(board.id, { labels: { displayMode: next } });
  },
};

module.exports = { appearanceMethods };
