// Loading and normalization of the persisted plugin data (data.json):
// boards, cards, labels, assignees, and the migrations older saves need.
const {
  DEFAULT_APPEARANCE,
  DEFAULT_DATA,
  LEGACY_CARD_FOLDER,
  cardFileBaseName,
  cleanColor,
  cleanDate,
  cleanLabelName,
  clone,
  labelKey,
  normalizeChecklists,
  normalizeDependencies,
  textLine,
  uid,
} = require("../helpers");

const pluginDataMethods = {
  /**
   * Loads saved board data, normalizes older/missing fields, then imports any
   * Markdown card notes that were created or edited outside the board.
   */
  async loadPluginData() {
    const saved = await this.loadData();
    const savedLabelDisplayMode = saved && saved.labelDisplayMode;
    const needsLabelDisplayMigration = !["compact", "expanded", "hover", "card-hover"].includes(savedLabelDisplayMode);
    const savedBackground = saved && saved.appearance && saved.appearance.background;
    const needsImageFitMigration = !!savedBackground
      && savedBackground.type === "image"
      && savedBackground.imageFitVersion !== 3;
    this.data = Object.assign(clone(DEFAULT_DATA), saved || {});
    this.data.boards = Array.isArray(this.data.boards) ? this.data.boards : [];
    this.data.cards = this.data.cards || {};
    this.data.labels = this.data.labels || [];
    this.data.syncDeckEnabled = this.data.syncDeckEnabled !== false;
    this.data.completionSound = this.data.completionSound !== false;
    this.data.labelDisplayMode = needsLabelDisplayMigration
      ? (this.data.compactLabels ? "compact" : "expanded")
      : savedLabelDisplayMode;
    this.data.compactLabels = this.data.labelDisplayMode === "compact";
    if (!this.data.appearance || typeof this.data.appearance !== "object") this.data.appearance = {};
    if (!this.data.appearance.labels) this.data.appearance.labels = { displayMode: this.data.labelDisplayMode };
    this.data.appearancePresets = Array.isArray(this.data.appearancePresets)
      ? this.data.appearancePresets.map((preset) => ({
        id: textLine(preset && preset.id) || uid("appearance-preset"),
        name: textLine(preset && preset.name) || "Untitled preset",
        appearance: this.normalizeAppearance(preset && preset.appearance),
        createdAt: textLine(preset && preset.createdAt) || new Date().toISOString(),
      }))
      : [];
    if (needsImageFitMigration) this.data.appearance.background.imageFit = "original";
    this.data.appearance = this.normalizeAppearance(this.data.appearance);
    this.data.labels = this.normalizeGlobalLabels(this.data.labels);
    const needsBoardAppearanceMigration = this.data.boards.some((board) => {
      const background = board && board.appearance && board.appearance.background;
      return !board
        || !board.appearance
        || !board.appearance.labels
        || (background && background.type === "image" && background.imageFitVersion !== 3);
    });
    this.data.boards = this.data.boards.map((board) => this.normalizeBoard(board, this.data.appearance));
    this.loadNeedsSave = this.ensureListColors()
      || needsLabelDisplayMigration
      || needsImageFitMigration
      || needsBoardAppearanceMigration;
    Object.values(this.data.cards).forEach((card) => {
      const needsChecklistMigration = !Array.isArray(card.checklists) || Object.prototype.hasOwnProperty.call(card, "checklist");
      card.boardId = card.boardId || this.boardIdForList(card.listId) || this.data.activeBoardId || "";
      card.labels = this.normalizeCardLabels(card.labels || []);
      card.completed = !!card.completed;
      card.startDate = cleanDate(card.startDate);
      card.dueDate = cleanDate(card.dueDate);
      card.checklists = normalizeChecklists(card.checklists, card.checklist);
      card.dependencies = normalizeDependencies(card.dependencies);
      delete card.checklist;
      if (needsChecklistMigration) this.loadNeedsSave = true;
    });
    this.data.boards.forEach((board) => {
      board.folderPath = board.folderPath || this.inferBoardFolder(board) || cardFileBaseName(board.name);
    });
    this.data.activeBoardId = this.findBoard(this.data.activeBoardId)
      ? this.data.activeBoardId
      : (this.data.boards[0] && this.data.boards[0].id) || "";
  },

  normalizeBoard(board, fallbackAppearance = DEFAULT_APPEARANCE) {
    const appearance = clone((board && board.appearance) || fallbackAppearance);
    if (!appearance.labels) {
      appearance.labels = { displayMode: (this.data && this.data.labelDisplayMode) || "expanded" };
    }
    if (appearance.background
      && appearance.background.type === "image"
      && appearance.background.imageFitVersion !== 3) {
      appearance.background.imageFit = "original";
    }
    return {
      id: board && board.id ? board.id : uid("board"),
      name: textLine(board && board.name) || "Untitled board",
      folderPath: textLine(board && board.folderPath),
      lists: Array.isArray(board && board.lists)
        ? board.lists.map((list) => ({
          id: list && list.id ? list.id : uid("list"),
          title: textLine(list && list.title) || "Untitled list",
          color: cleanColor(list && list.color),
          cardIds: Array.isArray(list && list.cardIds) ? list.cardIds : [],
        }))
        : [],
      deletedListIds: Array.isArray(board && board.deletedListIds) ? board.deletedListIds : [],
      appearance: this.normalizeAppearance(appearance),
    };
  },

  ensureListColors() {
    let changed = false;
    this.data.boards.forEach((board) => {
      board.lists.forEach((list, index) => {
        if (list.color) return;
        list.color = this.defaultListColor(index);
        changed = true;
      });
    });
    return changed;
  },

  inferBoardFolder(board) {
    const card = Object.values(this.data.cards).find((item) => {
      return item.boardId === board.id || board.lists.some((list) => list.id === item.listId || list.cardIds.includes(item.id));
    });
    if (card && card.filePath && card.filePath.includes("/")) return card.filePath.split("/").slice(0, -1).join("/");
    return board.id === "default" ? LEGACY_CARD_FOLDER : "";
  },

  /**
   * Cleans duplicate labels by case-insensitive name while preserving color.
   */
  normalizeGlobalLabels(labels) {
    const seen = new Set();
    return (labels || [])
      .map((label) => ({
        name: cleanLabelName(label),
        color: label && label.color ? label.color : "#d43c35",
      }))
      .filter((label) => label.name)
      .filter((label) => {
        const key = labelKey(label);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  },

  ensureGlobalLabel(label) {
    this.data.labels = this.normalizeGlobalLabels(this.data.labels);

    const cleanLabel = {
      name: cleanLabelName(label),
      color: label && label.color ? label.color : "#d43c35",
    };
    if (!cleanLabel.name) return null;

    const existing = this.data.labels.find((item) => labelKey(item) === labelKey(cleanLabel));
    if (existing) return existing;

    this.data.labels.push(cleanLabel);
    return cleanLabel;
  },

  /**
   * Normalizes a card's label list and registers every label globally.
   */
  normalizeCardLabels(labels) {
    const seen = new Set();
    return (labels || [])
      .map((label) => this.ensureGlobalLabel(label))
      .filter(Boolean)
      .filter((label) => {
        const key = labelKey(label);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  },

  normalizeAssignees(assignees) {
    const seen = new Set();
    return (Array.isArray(assignees) ? assignees : [])
      .filter((a) => a && a.email)
      .filter((a) => (seen.has(a.email) ? false : seen.add(a.email)))
      .map((a) => ({ email: String(a.email), name: a.name || a.email, color: a.color || "#8b5cf6" }));
  },
};

module.exports = { pluginDataMethods };
