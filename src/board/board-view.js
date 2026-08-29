const { ItemView, Menu, Notice, setIcon } = require("obsidian");

// View shell: lifecycle, render orchestration, toolbar, and the board home.
// Rendering details live in the sibling modules mixed into the prototype below.
const {
  KANUX_ICON,
  VIEW_TYPE,
  createElement,
  iconButton,
  textButton,
} = require("../helpers");
const { AboutModal, BoardAppearanceModal } = require("../modals");
const { boardAppearanceMethods } = require("./board-appearance");
const { cardDragMethods } = require("./card-drag");
const { listCardMethods } = require("./list-cards");
const { presenceMethods } = require("./presence");
const { tableFilterMethods } = require("./table-filters");
const { tableViewMethods } = require("./table-view");

/**
 * Obsidian view for the task board.
 *
 * This class owns rendering and short-lived UI state only. Persistent changes
 * are delegated back to the plugin so board data and card notes remain synced.
 */
class BoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.addingCardListId = null;
    this.editingCardId = null;
    this.showingBoardHome = false;
    this.tableStates = new Map();
    this.cardDragState = null;
    this.cardDragFrameId = null;
    this.cardReflowAnimations = new WeakMap();
    this.cardDropRefreshBlockedUntil = 0;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Kanux";
  }

  getIcon() {
    return KANUX_ICON;
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.finishCardDrag(false);
    this.stopPresence();
    this.closeTablePopover();
  }

  render() {
    this.finishCardDrag(false);
    const board = this.plugin.getBoard();
    this.stopPresence();
    this.prepareBoardRoot();
    const updateBanner = this.renderUpdateBanner();
    if (updateBanner) this.contentEl.append(updateBanner);
    if (!board || this.showingBoardHome) {
      this.renderBoardHome();
      return;
    }
    this.renderActiveBoard(board);
  }

  prepareBoardRoot() {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-board-root");
    const labelDisplayMode = this.plugin.getAppearance().labels.displayMode;
    this.contentEl.classList.toggle("is-compact-labels", labelDisplayMode === "compact");
    this.contentEl.classList.toggle("is-hover-labels", labelDisplayMode === "hover");
    this.contentEl.classList.toggle("is-card-hover-labels", labelDisplayMode === "card-hover");
    this.applyAppearance();
  }

  renderActiveBoard(board) {
    const mode = this.getViewMode(board);
    const toolbar = this.buildBoardToolbar(board, mode);
    if (mode === "table") {
      this.contentEl.append(toolbar, this.renderTable(board));
      return;
    }
    const scroller = createElement("div", "ot-board-scroll");
    board.lists.forEach((list) => scroller.append(this.renderList(list)));
    this.contentEl.append(toolbar, scroller);
    this.startPresence(board);
  }

  buildBoardToolbar(board, mode) {
    const toolbar = createElement("div", "ot-toolbar");
    toolbar.append(this.buildBoardToolbarTitle(board, mode));
    const primaryActions = createElement("div", "ot-toolbar-primary");
    primaryActions.append(
      textButton("plus-square", "New board", () => this.plugin.createBoardPrompt()),
      textButton("plus", "Add list", () => this.plugin.addList())
    );
    toolbar.append(primaryActions, this.buildBoardToolbarActions(board));
    return toolbar;
  }

  buildBoardToolbarTitle(board, mode) {
    const title = createElement("div", "ot-toolbar-title");
    title.append(iconButton("layout-dashboard", "Boards", () => {
      this.showingBoardHome = true;
      this.render();
    }));
    title.append(createElement("h2", "", board.name));
    if (this.plugin.data.boards.length > 1) title.append(this.renderBoardSelect(board));
    title.append(this.renderViewSwitch(board, mode));
    return title;
  }

  buildBoardToolbarActions(board) {
    const actions = createElement("div", "ot-toolbar-actions");
    if (this.plugin.isSyncDeckEnabled() && !this.plugin.getSyncDeckPlugin()) {
      actions.append(textButton("cloud", "Sync Boards", () => this.plugin.openSyncDeck(), "ot-cloud-cta"));
    }
    actions.append(
      textButton("palette", "Customize", () => new BoardAppearanceModal(this.app, this.plugin, board.id).open()),
      textButton("info", "About", () => new AboutModal(this.app, this.plugin).open())
    );
    return actions;
  }

  // "Update available" banner shown at the top when a newer GitHub release exists
  // (Kanux is installed manually, so it gets no community-store prompt).
  renderUpdateBanner() {
    const info = this.plugin.updateAvailable;
    if (!info) return null;
    const banner = createElement("div", "ot-update-banner");
    const label = createElement("div", "ot-update-banner-text");
    const icon = createElement("span", "ot-update-banner-icon");
    try { setIcon(icon, "arrow-up-circle"); } catch (error) { icon.textContent = "⭑"; }
    label.append(icon, createElement("span", "", `Kanux ${info.version} is available.`));
    const button = createElement("button", "mod-cta", "Update");
    button.type = "button";
    button.addEventListener("click", () => window.open(info.url, "_blank"));
    banner.append(label, button);
    return banner;
  }

  // Per-board, per-device view preference ("board" | "table"). Stored in data.json
  // (never in the synced index files), so switching lenses can't touch card data.
  getViewMode(board) {
    const modes = this.plugin.data.viewModes;
    return (modes && board && modes[board.id]) || "board";
  }

  setViewMode(board, mode) {
    if (!board) return;
    this.plugin.data.viewModes = this.plugin.data.viewModes || {};
    if (this.plugin.data.viewModes[board.id] === mode) return;
    this.plugin.data.viewModes[board.id] = mode;
    // Light persistence only — a view toggle must NOT rewrite board index files.
    // Fire-and-forget: the re-render below doesn't depend on the write, and a rare
    // data.json write failure shouldn't surface as an unhandled rejection.
    Promise.resolve(this.plugin.saveData(this.plugin.data)).catch(() => {});
    this.render();
  }

  renderViewSwitch(board, mode) {
    const wrap = createElement("div", "ot-view-switch");
    const tab = (key, icon, label) => {
      const button = createElement("button", "ot-view-tab" + (mode === key ? " is-active" : ""));
      button.type = "button";
      const glyph = createElement("span", "ot-view-tab-icon");
      try { setIcon(glyph, icon); } catch (error) { glyph.textContent = ""; }
      button.append(glyph, createElement("span", "", label));
      button.addEventListener("click", () => this.setViewMode(board, key));
      return button;
    };
    wrap.append(tab("board", "columns", "Board"), tab("table", "table", "Table"));
    return wrap;
  }

  async syncNotes() {
    // Same action as the About modal's "Sync notes": re-import every card from
    // its Markdown note so changes synced by SyncDeck show up on the boards.
    try {
      new Notice("Re-importing Kanux notes...");
      await this.plugin.syncCardsFromFolder();
      this.plugin.refreshViews();
      new Notice("Kanux notes re-imported.");
    } catch (error) {
      new Notice(`Re-import failed: ${error.message}`);
    }
  }

  renderBoardHome() {
    const welcome = createElement("section", "ot-welcome-panel");
    const welcomeCopy = createElement("div", "ot-welcome-copy");
    welcomeCopy.append(
      createElement("h2", "", this.plugin.data.boards.length ? "Your boards" : "Create your first board"),
      createElement("p", "", "Create focused kanban boards and keep every card as a Markdown note in your vault.")
    );
    const welcomeActions = createElement("div", "ot-welcome-actions");
    welcomeActions.append(textButton("plus", "Create board", () => this.plugin.createBoardPrompt()));
    if (this.plugin.isSyncDeckEnabled() && !this.plugin.getSyncDeckPlugin()) {
      welcomeActions.append(textButton("cloud", "Sync your boards & vaults", () => this.plugin.openSyncDeck(), "ot-cloud-cta"));
    }
    welcomeActions.append(
      textButton("refresh-cw", "Re-import notes", () => this.syncNotes()),
      textButton("info", "About", () => new AboutModal(this.app, this.plugin).open())
    );
    welcome.append(welcomeCopy, welcomeActions);

    const boards = createElement("div", "ot-board-home");
    if (!this.plugin.data.boards.length) {
      const empty = createElement("div", "ot-empty-board-home");
      empty.append(
        createElement("h3", "", "No boards yet"),
        createElement("p", "", "Start with a project, sprint, content plan, or anything else you want to track.")
      );
      boards.append(empty);
    } else {
      this.plugin.data.boards.forEach((board) => boards.append(this.renderBoardTile(board)));
    }

    this.contentEl.append(welcome, boards);
  }

  renderBoardSelect(activeBoard) {
    const select = createElement("select", "ot-board-select");
    this.plugin.data.boards.forEach((board) => {
      const option = createElement("option", "", board.name);
      option.value = board.id;
      option.selected = board.id === activeBoard.id;
      select.append(option);
    });
    select.addEventListener("change", async () => {
      this.showingBoardHome = false;
      await this.plugin.setActiveBoard(select.value);
    });
    return select;
  }

  renderBoardTile(board) {
    const tile = createElement("button", "ot-board-tile");
    tile.type = "button";
    const cardCount = board.lists.reduce((total, list) => total + list.cardIds.length, 0);
    tile.append(createElement("span", "ot-board-tile-title", board.name));
    tile.append(createElement("span", "ot-board-tile-meta", `${board.lists.length} lists / ${cardCount} cards`));
    tile.addEventListener("click", async () => {
      this.showingBoardHome = false;
      await this.plugin.setActiveBoard(board.id);
    });

    const menuButton = iconButton("ellipsis", "Board menu", (event) => this.showBoardMenu(event, board));
    menuButton.classList.add("ot-board-tile-menu");
    tile.append(menuButton);
    return tile;
  }

  showBoardMenu(event, board) {
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("Rename board")
        .setIcon("pencil")
        .onClick(() => this.plugin.renameBoard(board.id));
    });
    menu.addItem((item) => {
      item
        .setTitle("Delete board")
        .setIcon("trash")
        .onClick(() => this.plugin.deleteBoard(board.id));
    });
    menu.showAtMouseEvent(event);
  }
}

Object.assign(
  BoardView.prototype,
  boardAppearanceMethods,
  cardDragMethods,
  listCardMethods,
  presenceMethods,
  tableFilterMethods,
  tableViewMethods
);

module.exports = { BoardView };
