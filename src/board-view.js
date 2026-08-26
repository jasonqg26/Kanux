const { ItemView, Menu, Notice, setIcon } = require("obsidian");

// Renders the kanban board and handles inline card/list interactions.
const {
  LIST_DRAG_TYPE,
  KANUX_ICON,
  VIEW_TYPE,
  addButtonIcon,
  checklistItems,
  checklistStats,
  createElement,
  dateRangeLabel,
  initials,
  hasDragType,
  iconButton,
  labelKey,
  textButton,
  textLine,
} = require("./helpers");
const { AboutModal, BoardAppearanceModal, CardDatesModal, CardModal, LabelPickerModal, ListColorModal, confirmAction } = require("./modals");

// Live board presence (SyncDeck cursors) tuning.
// The transport stays plain HTTP polling; smoothness comes from client-side
// interpolation rather than a faster/heavier network loop.
const PRESENCE_SEND_INTERVAL_MS = 110; // min gap between outbound position posts while moving
const PRESENCE_POLL_ACTIVE_MS = 260; // GET poll while other cursors are on the board
const PRESENCE_POLL_IDLE_MS = 1100; // GET poll when nobody else is present
const PRESENCE_HEARTBEAT_MS = 3000; // resend our own point so the server TTL never expires us
const PRESENCE_SMOOTHING_TAU_MS = 70; // interpolation time constant; lower = snappier, higher = smoother
const PRESENCE_SNAP_DISTANCE = 0.0006; // normalized distance under which we snap instead of easing

// Drag payload type for reordering table columns (kept distinct from card/list drags).
const TABLE_COL_DRAG_TYPE = "application/x-kanux-column";
const CARD_REFLOW_DURATION_MS = 170;
const CARD_SCROLL_EDGE_PX = 56;
const CARD_SCROLL_MAX_STEP_PX = 18;
const CARD_DROP_REFRESH_GRACE_MS = 750;
const BOARD_DENSITY = {
  compact: { listWidth: 258, listMinWidth: 244, cardPadding: "7px 8px" },
  normal: { listWidth: 292, listMinWidth: 272, cardPadding: "9px 10px" },
  comfortable: { listWidth: 326, listMinWidth: 300, cardPadding: "12px" },
};
const CARD_SHADOWS = {
  none: "none",
  small: "0 1px 2px rgb(0 0 0 / 16%)",
  medium: "0 2px 4px rgb(0 0 0 / 24%), 0 1px 1px rgb(0 0 0 / 16%)",
  large: "0 6px 16px rgb(0 0 0 / 32%), 0 2px 4px rgb(0 0 0 / 22%)",
};
const BOARD_BACKGROUND_PROPERTIES = [
  "background-image",
  "background-color",
  "background-size",
  "background-position",
  "background-repeat",
  "background-attachment",
];

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

  // The optional (List = card location), reorderable/resizable/hideable fields. "Card"
  // is always the fixed first field. Definitions live here; per-board layout
  // (order / hidden / widths) is a per-device preference in data.json.
  tableColumnDefs() {
    const defs = [
      { key: "status", label: "List" },
      { key: "assignee", label: "Assignee" },
      { key: "dates", label: "Dates" },
      { key: "labels", label: "Labels" },
    ];
    return this.plugin.isSyncDeckEnabled() ? defs : defs.filter((def) => def.key !== "assignee");
  }

  defaultColWidth(key) {
    return { status: 150, assignee: 175, dates: 155, labels: 190 }[key] || 150;
  }

  getTableConfig(board) {
    const validKeys = this.tableColumnDefs().map((def) => def.key);
    const raw = (this.plugin.data.tableConfigs && this.plugin.data.tableConfigs[board.id]) || {};
    const order = (Array.isArray(raw.order) ? raw.order : []).filter((key) => validKeys.includes(key));
    validKeys.forEach((key) => { if (!order.includes(key)) order.push(key); });
    const hidden = new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter((key) => validKeys.includes(key)));
    const widths = {};
    order.forEach((key) => { widths[key] = (raw.widths && raw.widths[key]) || this.defaultColWidth(key); });
    return { nameWidth: raw.nameWidth || 260, order, hidden, widths };
  }

  persistTableConfig(board, cfg) {
    this.plugin.data.tableConfigs = this.plugin.data.tableConfigs || {};
    this.plugin.data.tableConfigs[board.id] = {
      nameWidth: cfg.nameWidth,
      order: cfg.order.slice(),
      hidden: Array.from(cfg.hidden),
      widths: Object.assign({}, cfg.widths),
    };
    // Per-device UI layout only — never rewrite the synced board files.
    Promise.resolve(this.plugin.saveData(this.plugin.data)).catch(() => {});
  }

  reorderColumn(board, cfg, draggedKey, targetKey) {
    if (draggedKey === targetKey) return;
    cfg.order = cfg.order.filter((key) => key !== draggedKey);
    const targetIndex = cfg.order.indexOf(targetKey);
    cfg.order.splice(targetIndex < 0 ? cfg.order.length : targetIndex, 0, draggedKey);
    this.persistTableConfig(board, cfg);
    this.render();
  }

  moveColumn(board, cfg, key, direction) {
    const visible = cfg.order.filter((k) => !cfg.hidden.has(k));
    const neighbour = visible[visible.indexOf(key) + direction];
    if (!neighbour) return;
    const from = cfg.order.indexOf(key);
    const to = cfg.order.indexOf(neighbour);
    cfg.order[from] = neighbour;
    cfg.order[to] = key;
    this.persistTableConfig(board, cfg);
    this.render();
  }

  getTableState(board) {
    const state = this.tableStates.get(board.id) || {
      query: "",
      listId: "all",
      completion: "all",
      sort: "board",
      labelKeys: [],
    };
    if (state.listId !== "all" && !board.lists.some((list) => list.id === state.listId)) state.listId = "all";
    if (!Array.isArray(state.labelKeys)) state.labelKeys = [];
    this.tableStates.set(board.id, state);
    return state;
  }

  collectTableData(board, state) {
    const rows = [];
    const labelsByKey = new Map();
    board.lists.forEach((list) => {
      (list.cardIds || []).forEach((cardId) => {
        const card = this.plugin.data.cards[cardId];
        if (!card) return;
        rows.push({ card, list, boardOrder: rows.length });
        (card.labels || []).forEach((label) => labelsByKey.set(labelKey(label), label));
      });
    });

    const availableLabelKeys = new Set(labelsByKey.keys());
    state.labelKeys = state.labelKeys.filter((key) => availableLabelKeys.has(key));
    const availableLabels = Array.from(labelsByKey.values())
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
    return { rows, availableLabels };
  }

  // Table view: one row per card across every list, List = the card's location.
  // Row click opens a Description + Checklist card view; every other field
  // (status, members, dates, labels) is edited inline from its cell.
  renderTable(board) {
    const cfg = this.getTableConfig(board);
    const defs = this.tableColumnDefs();
    const visible = cfg.order.filter((key) => !cfg.hidden.has(key));
    const state = this.getTableState(board);
    const { rows, availableLabels } = this.collectTableData(board, state);

    const view = createElement("div", "ot-table-view");
    let paint = () => {};
    const controls = this.buildTableControls({ board, state, availableLabels, onChange: () => paint() });

    const { wrap, tbody } = this.buildTableGrid({ board, cfg, defs, visible });
    const empty = createElement("div", "ot-table-empty");

    paint = () => {
      const filtered = this.filterAndSortTableRows(rows, state);
      tbody.replaceChildren(...filtered.map(({ card, list }) => this.renderTableRow(card, list, board, visible)));
      const activeFilters = !!state.query || state.listId !== "all" || state.completion !== "all" || state.sort !== "board" || state.labelKeys.length > 0;
      controls.syncLabelFilter();
      controls.summary.textContent = `${filtered.length} of ${rows.length} ${rows.length === 1 ? "card" : "cards"}`;
      controls.clear.disabled = !activeFilters;
      empty.textContent = rows.length ? "No cards match the current filters." : "No cards yet. Add one below.";
      empty.hidden = filtered.length > 0;
    };

    paint();
    view.append(controls.element, wrap, empty, this.renderTableComposer(board));
    return view;
  }

  buildTableGrid(context) {
    const wrap = createElement("div", "ot-table-wrap");
    const table = createElement("table", "ot-table");
    const columns = this.buildTableColumns(context.cfg, context.visible);
    table.append(columns.colgroup, this.buildTableHeader(context, columns));
    const tbody = createElement("tbody");
    table.append(tbody);
    wrap.append(table);
    return { wrap, tbody };
  }

  buildTableColumns(cfg, visible) {
    const colgroup = createElement("colgroup");
    const nameCol = createElement("col");
    nameCol.style.width = `${cfg.nameWidth}px`;
    colgroup.append(nameCol);
    const colByKey = {};
    visible.forEach((key) => {
      const col = createElement("col");
      col.style.width = `${cfg.widths[key]}px`;
      colByKey[key] = col;
      colgroup.append(col);
    });
    const addCol = createElement("col");
    addCol.style.width = "40px";
    colgroup.append(addCol);
    return { colgroup, nameCol, colByKey };
  }

  buildTableHeader({ board, cfg, defs, visible }, columns) {
    const thead = createElement("thead");
    const row = createElement("tr");
    row.append(this.buildTableNameHeader(board, cfg, columns.nameCol));
    visible.forEach((key) => {
      const definition = defs.find((def) => def.key === key);
      row.append(this.renderColumnHeader(board, cfg, key, definition ? definition.label : key, columns.colByKey[key]));
    });
    row.append(this.renderAddColumnHeader(board, cfg, defs));
    thead.append(row);
    return thead;
  }

  buildTableNameHeader(board, cfg, nameCol) {
    const header = createElement("th", "ot-th ot-th-name");
    const inner = createElement("div", "ot-th-inner");
    inner.append(createElement("span", "ot-th-label", "Card"));
    header.append(inner, this.buildColResize(nameCol, () => {
      cfg.nameWidth = parseInt(nameCol.style.width, 10) || cfg.nameWidth;
      this.persistTableConfig(board, cfg);
    }, 140));
    return header;
  }

  buildTableControls({ board, state, availableLabels, onChange }) {
    const element = createElement("div", "ot-table-controls");
    const search = this.buildTableSearch(state.query);
    const listFilter = this.buildTableSelect(
      "Filter cards by list",
      [{ label: "All lists", value: "all" }, ...board.lists.map((list) => ({ label: list.title, value: list.id }))],
      state.listId
    );
    const completionFilter = this.buildTableSelect("Filter by completion", [
      { label: "All cards", value: "all" },
      { label: "Open cards", value: "open" },
      { label: "Completed cards", value: "completed" },
    ], state.completion);
    const sort = this.buildTableSelect("Sort cards", [
      { label: "Board order", value: "board" },
      { label: "Title A–Z", value: "title" },
      { label: "Due soon", value: "due" },
      { label: "Recently updated", value: "updated" },
    ], state.sort);
    const labelFilter = this.buildTableLabelFilterButton(availableLabels, state, onChange);
    const summary = createElement("span", "ot-table-summary");
    const clear = createElement("button", "ot-text-button ot-button-with-icon ot-table-clear", "Clear filters");
    clear.type = "button";
    addButtonIcon(clear, "x");

    this.bindTableControl({ control: search.input, eventName: "input", state, stateKey: "query", onChange });
    this.bindTableControl({ control: listFilter, eventName: "change", state, stateKey: "listId", onChange });
    this.bindTableControl({ control: completionFilter, eventName: "change", state, stateKey: "completion", onChange });
    this.bindTableControl({ control: sort, eventName: "change", state, stateKey: "sort", onChange });
    const controls = { search: search.input, listFilter, completionFilter, sort };
    clear.addEventListener("click", () => this.resetTableFilters(state, controls, onChange));
    element.append(search.element, listFilter, completionFilter, sort, labelFilter.button, summary, clear);
    return { element, summary, clear, syncLabelFilter: labelFilter.sync };
  }

  buildTableSearch(value) {
    const element = createElement("label", "ot-table-search");
    const icon = createElement("span", "ot-table-search-icon");
    try { setIcon(icon, "search"); } catch (error) { icon.textContent = ""; }
    const input = createElement("input", "ot-table-search-input");
    input.type = "search";
    input.placeholder = "Search cards, lists, labels, descriptions or checklist tasks...";
    input.value = value;
    element.append(icon, input);
    return { element, input };
  }

  buildTableSelect(ariaLabel, options, value) {
    const select = createElement("select", "ot-table-filter");
    select.setAttribute("aria-label", ariaLabel);
    options.forEach((option) => select.append(new Option(option.label, option.value)));
    select.value = value;
    return select;
  }

  buildTableLabelFilterButton(availableLabels, state, onChange) {
    const button = createElement("button", "ot-text-button ot-button-with-icon ot-table-label-filter");
    button.type = "button";
    button.title = "Filter cards by label";
    button.disabled = !availableLabels.length;
    addButtonIcon(button, "tags");
    const countElement = createElement("span", "ot-table-label-filter-count");
    button.append(createElement("span", "", "Labels"), countElement);
    const sync = () => {
      const count = state.labelKeys.length;
      button.classList.toggle("is-active", count > 0);
      countElement.textContent = count ? String(count) : "";
      countElement.hidden = !count;
      button.setAttribute("aria-expanded", this._tablePopoverAnchor === button ? "true" : "false");
    };
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openTableLabelFilter({ anchor: button, availableLabels, state, onChange });
      sync();
    });
    sync();
    return { button, sync };
  }

  bindTableControl({ control, eventName, state, stateKey, onChange }) {
    control.addEventListener(eventName, () => {
      state[stateKey] = control.value;
      onChange();
    });
  }

  resetTableFilters(state, controls, onChange) {
    Object.assign(state, { query: "", listId: "all", completion: "all", sort: "board", labelKeys: [] });
    controls.search.value = "";
    controls.listFilter.value = "all";
    controls.completionFilter.value = "all";
    controls.sort.value = "board";
    onChange();
    controls.search.focus();
  }

  normalizeTableSearch(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase();
  }

  filterAndSortTableRows(rows, state) {
    const queryTerms = this.normalizeTableSearch(state.query).split(/\s+/).filter(Boolean);
    const filtered = rows.filter((row) => this.tableRowMatches(row, state, queryTerms));
    return this.sortTableRows(filtered, state.sort);
  }

  tableRowMatches({ card, list }, state, queryTerms) {
    if (state.listId !== "all" && list.id !== state.listId) return false;
    if (state.completion === "open" && card.completed) return false;
    if (state.completion === "completed" && !card.completed) return false;
    if (state.labelKeys.length && !(card.labels || []).some((label) => state.labelKeys.includes(labelKey(label)))) return false;
    if (!queryTerms.length) return true;
    const searchable = [
      card.title,
      card.details,
      list.title,
      ...(card.labels || []).map((label) => label.name),
      ...(card.assignees || []).map((assignee) => `${assignee.name || ""} ${assignee.email || ""}`),
      ...checklistItems(card.checklists).map((item) => item.text),
    ].join(" ");
    const normalizedSearchable = this.normalizeTableSearch(searchable);
    return queryTerms.every((term) => normalizedSearchable.includes(term));
  }

  sortTableRows(rows, sortMode) {
    if (sortMode === "title") {
      return rows.sort((a, b) => a.card.title.localeCompare(b.card.title, undefined, { sensitivity: "base" }));
    }
    if (sortMode === "due") {
      return rows.sort((a, b) => (a.card.dueDate || "9999-12-31").localeCompare(b.card.dueDate || "9999-12-31") || a.boardOrder - b.boardOrder);
    }
    if (sortMode === "updated") {
      return rows.sort((a, b) => String(b.card.updatedAt || "").localeCompare(String(a.card.updatedAt || "")) || a.boardOrder - b.boardOrder);
    }
    return rows;
  }

  openTableLabelFilter({ anchor, availableLabels, state, onChange }) {
    this.openTablePopover(anchor, (popover) => {
      const elements = this.buildTableLabelFilterPopover(popover);
      const context = { elements, availableLabels, state, onChange, rerender: null };
      const renderOptions = () => this.renderTableLabelFilterOptions(context);
      context.rerender = renderOptions;
      elements.search.addEventListener("input", renderOptions);
      elements.clear.addEventListener("click", () => {
        state.labelKeys = [];
        onChange();
        renderOptions();
      });
      renderOptions();
      window.setTimeout(() => elements.search.focus(), 0);
    });
  }

  buildTableLabelFilterPopover(popover) {
    popover.classList.add("ot-label-filter-popover");
    const header = createElement("div", "ot-label-filter-header");
    const search = createElement("input", "ot-label-filter-search");
    search.type = "search";
    search.placeholder = "Search labels...";
    search.setAttribute("aria-label", "Search labels");
    const meta = createElement("div", "ot-label-filter-meta");
    const resultCount = createElement("span");
    const clear = createElement("button", "ot-text-button", "Clear");
    clear.type = "button";
    meta.append(resultCount, clear);
    header.append(search, meta);
    const options = createElement("div", "ot-label-filter-options");
    const limitNote = createElement("div", "ot-label-filter-limit");
    popover.append(header, options, limitNote);
    return { search, resultCount, clear, options, limitNote };
  }

  renderTableLabelFilterOptions({ elements, availableLabels, state, onChange, rerender }) {
    const query = this.normalizeTableSearch(elements.search.value).trim();
    const matches = availableLabels.filter((label) => !query || this.normalizeTableSearch(label.name).includes(query));
    elements.options.replaceChildren();
    matches.slice(0, 80).forEach((label) => {
      const key = labelKey(label);
      const dot = createElement("span", "ot-label-filter-dot");
      dot.style.backgroundColor = label.color;
      const row = this.popoverRow(dot, label.name, state.labelKeys.includes(key));
      row.addEventListener("click", () => {
        state.labelKeys = state.labelKeys.includes(key)
          ? state.labelKeys.filter((item) => item !== key)
          : [...state.labelKeys, key];
        onChange();
        rerender();
      });
      elements.options.append(row);
    });
    if (!matches.length) elements.options.append(createElement("div", "ot-popover-empty", "No matching labels"));
    elements.resultCount.textContent = `${matches.length} ${matches.length === 1 ? "label" : "labels"}`;
    elements.limitNote.textContent = matches.length > 80 ? `Showing 80 of ${matches.length}. Refine the search to see more.` : "";
    elements.limitNote.hidden = matches.length <= 80;
    elements.clear.disabled = !state.labelKeys.length;
  }

  // A drag handle on a column's right edge. Resizes the <col> live, persists on
  // release. Stops propagation so it never triggers header reorder / sort.
  buildColResize(col, onEnd, min = 80) {
    const handle = createElement("div", "ot-col-resize");
    handle.draggable = false;
    handle.addEventListener("click", (event) => event.stopPropagation());
    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = parseInt(col.style.width, 10) || col.offsetWidth || min;
      document.body.classList.add("ot-col-resizing");
      const onMove = (moveEvent) => {
        col.style.width = `${Math.max(min, startWidth + (moveEvent.clientX - startX))}px`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("ot-col-resizing");
        onEnd();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    return handle;
  }

  renderColumnHeader(board, cfg, key, label, col) {
    const th = createElement("th", "ot-th");
    th.dataset.colKey = key;
    th.draggable = true;
    const inner = createElement("div", "ot-th-inner");
    inner.append(createElement("span", "ot-th-label", label));

    const menuButton = createElement("button", "ot-th-menu");
    menuButton.type = "button";
    menuButton.title = "Field options";
    try { setIcon(menuButton, "chevron-down"); } catch (error) { menuButton.textContent = "▾"; }
    menuButton.draggable = false;
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem((item) => item.setTitle("Move left").setIcon("arrow-left").onClick(() => this.moveColumn(board, cfg, key, -1)));
      menu.addItem((item) => item.setTitle("Move right").setIcon("arrow-right").onClick(() => this.moveColumn(board, cfg, key, 1)));
      menu.addItem((item) => item.setTitle("Hide field").setIcon("eye-off").onClick(() => {
        cfg.hidden.add(key);
        this.persistTableConfig(board, cfg);
        this.render();
      }));
      menu.showAtMouseEvent(event);
    });
    inner.append(menuButton);
    th.append(inner);

    th.addEventListener("dragstart", (event) => {
      // A drag that begins on the menu caret or the resize handle must not turn
      // into a column reorder — cancel it so a click/resize there stays intact.
      if (event.target.closest && event.target.closest(".ot-th-menu, .ot-col-resize")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData(TABLE_COL_DRAG_TYPE, key);
      event.dataTransfer.effectAllowed = "move";
      th.classList.add("is-col-dragging");
    });
    th.addEventListener("dragend", () => th.classList.remove("is-col-dragging"));
    th.addEventListener("dragover", (event) => {
      if (!hasDragType(event, TABLE_COL_DRAG_TYPE)) return;
      event.preventDefault();
      th.classList.add("is-col-drop");
    });
    th.addEventListener("dragleave", () => th.classList.remove("is-col-drop"));
    th.addEventListener("drop", (event) => {
      th.classList.remove("is-col-drop");
      if (!hasDragType(event, TABLE_COL_DRAG_TYPE)) return;
      event.preventDefault();
      const dragged = event.dataTransfer.getData(TABLE_COL_DRAG_TYPE);
      if (dragged) this.reorderColumn(board, cfg, dragged, key);
    });

    th.append(this.buildColResize(col, () => {
      cfg.widths[key] = parseInt(col.style.width, 10) || cfg.widths[key];
      this.persistTableConfig(board, cfg);
    }));
    return th;
  }

  renderAddColumnHeader(board, cfg, defs) {
    const th = createElement("th", "ot-th ot-th-add");
    const button = createElement("button", "ot-th-add-btn");
    button.type = "button";
    button.title = "Show a field";
    try { setIcon(button, "plus"); } catch (error) { button.textContent = "+"; }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const hidden = cfg.order.filter((key) => cfg.hidden.has(key));
      const menu = new Menu();
      if (!hidden.length) {
        menu.addItem((item) => item.setTitle("All fields shown").setDisabled(true));
      } else {
        hidden.forEach((key) => {
          const label = (defs.find((def) => def.key === key) || {}).label || key;
          menu.addItem((item) => item.setTitle(label).setIcon("plus").onClick(() => {
            cfg.hidden.delete(key);
            this.persistTableConfig(board, cfg);
            this.render();
          }));
        });
      }
      menu.showAtMouseEvent(event);
    });
    th.append(button);
    return th;
  }

  renderTableRow(card, list, board, visible) {
    const lockHolder = this.plugin.getCardLockHolder(card.id);
    const row = createElement("tr", "ot-table-row");
    this.configureTableRow(row, card, list, lockHolder);
    row.append(this.buildTableNameCell(card, lockHolder));
    visible.forEach((key) => row.append(this.renderTableCell(key, card, list, board, lockHolder)));
    row.append(createElement("td", "ot-td ot-td-addcell"));
    return row;
  }

  configureTableRow(row, card, list, lockHolder) {
    row.dataset.cardId = card.id;
    row.style.setProperty("--ot-row-list-color", list.color || "var(--interactive-accent)");
    row.tabIndex = 0;
    row.setAttribute("aria-label", `Open ${card.title}`);
    if (card.completed) row.classList.add("is-completed");
    if (card.completed && this.plugin.completedAnimationCardId === card.id) {
      row.classList.add("is-just-completed");
      this.plugin.completedAnimationCardId = null;
      window.setTimeout(() => row.classList.remove("is-just-completed"), 650);
    }
    if (lockHolder) row.classList.add("is-locked");
    row.addEventListener("click", () => new CardModal(this.app, this.plugin, card.id).open());
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      new CardModal(this.app, this.plugin, card.id).open();
    });
  }

  buildTableNameCell(card, lockHolder) {
    const nameCell = createElement("td", "ot-td ot-td-name");
    const nameInner = createElement("div", "ot-td-name-inner");
    nameInner.append(this.buildTableCompletionControl(card, lockHolder), createElement("span", "ot-td-title", card.title));
    const hints = this.buildTableCardHints(card);
    if (hints.childElementCount) nameInner.append(hints);
    if (lockHolder) nameInner.append(this.buildLockBadge(lockHolder));
    nameCell.append(nameInner);
    return nameCell;
  }

  buildTableCompletionControl(card, lockHolder) {
    const complete = createElement("div", "ot-table-check");
    complete.setAttribute("role", "checkbox");
    complete.setAttribute("aria-checked", card.completed ? "true" : "false");
    complete.setAttribute("aria-label", card.completed ? "Mark as incomplete" : "Mark as complete");
    complete.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      await this.plugin.toggleCardCompleted(card.id);
    });
    if (card.completed) complete.append(createElement("span", "ot-card-complete-mark", "✓"));
    return complete;
  }

  buildTableCardHints(card) {
    const hints = createElement("span", "ot-td-hints");
    const checklist = checklistItems(card.checklists);
    if (checklist.length) {
      const stats = checklistStats(checklist);
      const checklistHint = createElement("span", "ot-td-hint ot-td-checklist-hint");
      const checklistIcon = createElement("span", "ot-td-hint-icon");
      try { setIcon(checklistIcon, "list-checks"); } catch (error) { checklistIcon.textContent = "✓"; }
      checklistHint.append(checklistIcon, createElement("span", "", `${stats.done}/${stats.total}`));
      hints.append(checklistHint);
    }
    if (card.details) {
      const detailsHint = createElement("span", "ot-td-hint");
      const detailsIcon = createElement("span", "ot-td-hint-icon");
      try { setIcon(detailsIcon, "align-left"); } catch (error) { detailsIcon.textContent = "≡"; }
      detailsHint.append(detailsIcon);
      hints.append(detailsHint);
    }
    return hints;
  }

  renderTableCell(key, card, list, board, lockHolder) {
    if (key === "status") return this.renderStatusCell(card, list, board, lockHolder);
    if (key === "assignee") return this.renderAssigneeCell(card, lockHolder);
    if (key === "dates") return this.renderDatesCell(card, lockHolder);
    if (key === "labels") return this.renderLabelsCell(card, lockHolder);
    return createElement("td", "ot-td");
  }

  // A filled, Notion-style status pill: a soft tint of the list color + a solid
  // dot + label. Shared by the cell and the picker so they match.
  buildStatusPill(list) {
    const color = list.color || "#8b8b8b";
    const pill = createElement("div", "ot-status-pill");
    // 8-digit hex adds alpha, giving a soft tint that blends with light OR dark.
    pill.style.background = /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}33` : color;
    const dot = createElement("span", "ot-status-dot");
    dot.style.setProperty("--ot-status-color", color);
    pill.append(dot, createElement("span", "", list.title));
    return pill;
  }

  renderStatusCell(card, list, board, lockHolder) {
    const cell = createElement("td", "ot-td ot-td-status");
    const pill = this.buildStatusPill(list);
    pill.classList.add("is-clickable");
    pill.title = "Move to another list";
    pill.addEventListener("click", (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      this.showStatusMenu(event, card, board, list);
    });
    cell.append(pill);
    return cell;
  }

  renderAssigneeCell(card, lockHolder) {
    const cell = createElement("td", "ot-td ot-td-assignee");
    const trigger = createElement("div", "ot-cell-edit");
    trigger.title = "Assign members";
    const avatars = this.renderCardAssignees(card);
    if (avatars.childElementCount) trigger.append(avatars);
    else trigger.append(createElement("span", "ot-td-empty", "＋"));
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      this.showAssigneeMenu(event, card);
    });
    cell.append(trigger);
    return cell;
  }

  renderDatesCell(card, lockHolder) {
    const cell = createElement("td", "ot-td ot-td-dates");
    const dates = dateRangeLabel(card.startDate, card.dueDate);
    const trigger = createElement("div", "ot-cell-edit");
    trigger.title = "Edit dates";
    if (dates) {
      const dateLabel = createElement("span", "ot-table-date", dates);
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      if (card.dueDate && card.dueDate < today && !card.completed) {
        dateLabel.classList.add("is-overdue");
        dateLabel.title = "Overdue";
      }
      trigger.append(dateLabel);
    }
    else trigger.append(createElement("span", "ot-td-empty", "＋"));
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      new CardDatesModal(this.app, this.plugin, card.id).open();
    });
    cell.append(trigger);
    return cell;
  }

  renderLabelsCell(card, lockHolder) {
    const cell = createElement("td", "ot-td ot-td-labels");
    const trigger = createElement("div", "ot-cell-edit ot-cell-labels");
    trigger.title = "Edit labels";
    (card.labels || []).forEach((label) => {
      const pill = createElement("span", "ot-card-label", label.name);
      pill.style.backgroundColor = label.color;
      pill.title = label.name;
      trigger.append(pill);
    });
    if (!(card.labels || []).length) trigger.append(createElement("span", "ot-td-empty", "＋"));
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      this.openLabelPicker(card);
    });
    cell.append(trigger);
    return cell;
  }

  // A small custom dropdown anchored under `anchor`. Obsidian's Menu can only show
  // text + a lucide icon, but the status picker needs a colored dot and the member
  // picker needs profile pictures — so those use this instead. `build(pop, close)`
  // fills the rows. It survives a board re-render (it lives on document.body), so
  // the assignee picker can stay open across multi-select toggles.
  openTablePopover(anchor, build) {
    this.closeTablePopover();
    const pop = createElement("div", "ot-popover");
    const rect = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(rect.bottom + 4)}px`;
    pop.style.left = `${Math.round(rect.left)}px`;
    pop.style.minWidth = `${Math.max(190, Math.round(rect.width))}px`;
    document.body.append(pop);
    this._tablePopoverAnchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    const close = () => this.closeTablePopover();
    build(pop, close);
    const popRect = pop.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - popRect.width - 8);
    pop.style.left = `${Math.min(Math.max(8, Math.round(rect.left)), maxLeft)}px`;
    if (popRect.bottom > window.innerHeight - 8) {
      const maxTop = Math.max(8, window.innerHeight - popRect.height - 8);
      pop.style.top = `${Math.max(8, Math.min(Math.round(rect.top - popRect.height - 4), maxTop))}px`;
    }
    const onDown = (event) => { if (!pop.contains(event.target)) close(); };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    // Attach synchronously: the picker opens on a `click`, so THIS gesture's
    // mousedown already fired before we get here — the outside-close handler can't
    // self-trigger on it, and there's no deferred-add window that could leak.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    pop._cleanup = () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    this._tablePopover = pop;
  }

  closeTablePopover() {
    if (!this._tablePopover) return;
    if (this._tablePopover._cleanup) this._tablePopover._cleanup();
    this._tablePopover.remove();
    this._tablePopover = null;
    if (this._tablePopoverAnchor) this._tablePopoverAnchor.setAttribute("aria-expanded", "false");
    this._tablePopoverAnchor = null;
  }

  popoverRow(leading, label, checked) {
    const row = createElement("button", "ot-popover-row");
    row.type = "button";
    if (leading) row.append(leading);
    row.append(createElement("span", "ot-popover-label", label));
    if (checked) {
      const check = createElement("span", "ot-popover-check");
      try { setIcon(check, "check"); } catch (error) { check.textContent = "✓"; }
      row.append(check);
    }
    return row;
  }

  showStatusMenu(event, card, board, currentList) {
    this.openTablePopover(event.currentTarget, (pop, close) => {
      board.lists.forEach((list) => {
        // Each option is a full status pill (Notion-style), check on the current.
        const row = this.popoverRow(this.buildStatusPill(list), "", list.id === currentList.id);
        row.addEventListener("click", async () => {
          close();
          if (list.id !== currentList.id) await this.plugin.moveCard(card.id, list.id);
        });
        pop.append(row);
      });
    });
  }

  showAssigneeMenu(event, card) {
    const members = this.plugin.getVaultMembers();
    this.openTablePopover(event.currentTarget, (pop) => {
      if (!members.length) {
        pop.append(createElement("div", "ot-popover-empty", "No members — sign in to Sync Deck"));
        return;
      }
      const paint = () => {
        pop.replaceChildren();
        const current = ((this.plugin.data.cards[card.id] || card).assignees) || [];
        members.forEach((member) => {
          const assigned = current.some((a) => a && a.email === member.email);
          const row = this.popoverRow(this.buildAvatar(member), member.name || member.email, assigned);
          row.addEventListener("click", async () => {
            const now = ((this.plugin.data.cards[card.id] || card).assignees) || [];
            const on = now.some((a) => a && a.email === member.email);
            const next = on
              ? now.filter((a) => a && a.email !== member.email)
              : [...now, { email: member.email, name: member.name, color: member.color }];
            await this.plugin.updateCard(card.id, { assignees: next });
            paint(); // keep the picker open and refresh the checks for multi-select
          });
          pop.append(row);
        });
      };
      paint();
    });
  }

  openLabelPicker(card) {
    new LabelPickerModal(this.app, this.plugin.data.labels || [], card.labels || [], async (labels, selectedLabels, options = {}) => {
      if (options.persist === false) return;
      await this.plugin.updateCard(card.id, { labels: selectedLabels }, labels);
    }, (label) => this.plugin.deleteLabel(label)).open();
  }

  applyAppearance() {
    const root = this.contentEl;
    const appearance = this.plugin.getAppearance();
    this.applyAppearanceVariables(root, appearance);
    this.applyAppearanceClasses(root, appearance);
    this.applyBoardBackground(root, appearance.background);
  }

  applyAppearanceVariables(root, appearance) {
    const density = BOARD_DENSITY[appearance.density] || BOARD_DENSITY.normal;
    root.style.setProperty("--ot-font-scale", String(appearance.fontScale));
    root.style.setProperty("--ot-list-width", `${density.listWidth}px`);
    root.style.setProperty("--ot-list-min-width", `${density.listMinWidth}px`);
    root.style.setProperty("--ot-card-padding", density.cardPadding);
    root.style.setProperty("--ot-card-gap", `${appearance.cards.verticalGap}px`);
    root.style.setProperty("--ot-card-radius", `${appearance.cards.borderRadius}px`);
    root.style.setProperty("--ot-card-hover-background", appearance.cards.hoverBackground);
    root.style.setProperty("--ot-card-title-size", `${appearance.cards.titleSize}px`);
    root.style.setProperty("--ot-column-gap", `${appearance.lists.columnGap}px`);
    root.style.setProperty("--ot-list-top-border-width", `${appearance.lists.topBorderWidth}px`);
    root.style.setProperty("--ot-list-radius", `${appearance.lists.borderRadius}px`);
    root.style.setProperty("--ot-card-shadow", CARD_SHADOWS[appearance.cards.shadow] || CARD_SHADOWS.medium);
    root.style.setProperty("--ot-card-background", appearance.cards.useTheme
      ? "color-mix(in srgb, var(--background-primary-alt, var(--background-primary)) 88%, var(--background-modifier-hover) 12%)"
      : appearance.cards.background);
    root.style.setProperty("--ot-list-background", appearance.lists.useTheme
      ? "color-mix(in srgb, var(--background-secondary) 96%, var(--background-primary) 4%)"
      : appearance.lists.background);
  }

  applyAppearanceClasses(root, appearance) {
    root.classList.toggle("is-motion-disabled", !appearance.motion.enabled);
    root.classList.toggle("is-appearance-dark", appearance.colorScheme === "dark");
    root.classList.toggle("is-appearance-light", appearance.colorScheme === "light");
    root.classList.toggle("is-surfaces-dark", appearance.surfaceScheme === "dark");
    root.classList.toggle("is-surfaces-light", appearance.surfaceScheme === "light");
    root.classList.toggle("is-list-color-dot-hidden", !appearance.lists.showColorDot);
  }

  applyBoardBackground(root, background) {
    BOARD_BACKGROUND_PROPERTIES.forEach((property) => root.style.removeProperty(property));
    if (background.type === "solid") {
      root.style.setProperty("background-color", background.color, "important");
      return;
    }
    if (background.type === "gradient") {
      root.style.setProperty("background-color", background.gradientEnd, "important");
      root.style.setProperty("background-image", `linear-gradient(135deg, ${background.gradientStart}, ${background.gradientEnd})`);
      return;
    }
    if (background.type === "image" && background.imagePath) {
      this.applyImageBoardBackground(root, background);
      return;
    }
    root.style.setProperty("background-color", "var(--background-primary)", "important");
  }

  applyImageBoardBackground(root, background) {
    const resourcePath = this.plugin.getAppearanceBackgroundResource(background);
    root.style.setProperty("background-color", "var(--background-primary)", "important");
    if (!resourcePath) return;
    const resource = resourcePath.replace(/"/g, "\\\"");
    const imageSize = ["repeat", "original"].includes(background.imageFit) ? "auto" : background.imageFit;
    const overlay = `linear-gradient(rgb(0 0 0 / ${background.overlayOpacity}), rgb(0 0 0 / ${background.overlayOpacity}))`;
    root.style.setProperty("background-image", `${overlay}, url("${resource}")`);
    root.style.setProperty("background-position", "center, center");
    root.style.setProperty("background-size", `auto, ${imageSize}`);
    root.style.setProperty("background-repeat", background.imageFit === "repeat" ? "no-repeat, repeat" : "no-repeat, no-repeat");
    root.style.setProperty("background-attachment", "local");
  }

  renderTableComposer(board) {
    const creator = createElement("section", "ot-table-creator");
    if (!board.lists.length) {
      const empty = createElement("div", "ot-table-creator-empty");
      empty.append(
        createElement("span", "", "Add a list before creating cards."),
        textButton("plus", "Add list", () => this.plugin.addList())
      );
      creator.append(empty);
      return creator;
    }

    const form = createElement("form", "ot-table-composer");
    const inputWrap = createElement("label", "ot-table-composer-field ot-table-composer-title");
    inputWrap.append(createElement("span", "", "Card title"));
    const input = createElement("input", "ot-table-composer-input");
    input.type = "text";
    input.placeholder = "What should this card be called?";
    input.autocomplete = "off";
    inputWrap.append(input);

    const statusWrap = createElement("label", "ot-table-composer-field ot-table-composer-status");
    statusWrap.append(createElement("span", "", "List"));
    const status = createElement("select", "ot-table-composer-select");
    board.lists.forEach((list) => status.append(new Option(list.title, list.id)));
    const tableState = this.tableStates.get(board.id);
    if (tableState && board.lists.some((list) => list.id === tableState.listId)) status.value = tableState.listId;
    statusWrap.append(status);

    const add = createElement("button", "mod-cta ot-table-composer-submit", "Add card");
    add.type = "submit";
    addButtonIcon(add, "plus");
    form.append(inputWrap, statusWrap, add);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = textLine(input.value);
      if (!title) { input.focus(); return; }
      const list = board.lists.find((item) => item.id === status.value) || board.lists[0];
      if (!list) return;
      add.disabled = true;
      input.value = "";
      try {
        await this.plugin.createCard(list.id, title);
      } finally {
        add.disabled = false;
      }
    });
    creator.append(form);
    return creator;
  }

  startPresence(board) {
    if (!this.plugin.getSyncDeckBridge()) return;

    this.presenceBoard = board;
    this.presencePoint = { x: 0.5, y: 0.08 };
    this.presenceUsers = new Map();
    this.presenceSendInFlight = false;
    this.presenceDirty = false;
    this.lastPresenceSendAt = 0;
    this.presenceRafId = null;
    this.presenceLastFrame = null;
    this.presenceTrailTimer = null;
    // Monotonic session id. render() calls stopPresence()+startPresence() on every
    // board re-render, so responses from an in-flight request can land after a new
    // session started. Every async callback carries the gen it was issued under and
    // no-ops if it no longer matches, so a stale response can never touch live state.
    this.presenceGen = (this.presenceGen || 0) + 1;
    const gen = this.presenceGen;
    // Board-owned copy of the lock roster used purely as the badge-diff baseline.
    // It must NOT be plugin.cardLocks, which an open card modal rewrites out of
    // band (acquire/release/heartbeat) and would desync the diff into ghost badges.
    this.lockUiState = new Map(this.plugin.cardLocks || []);
    if (!this.presenceTickBound) this.presenceTickBound = (now) => this.presenceTick(now);

    this.presenceLayer = createElement("div", "ot-presence-layer");
    this.contentEl.append(this.presenceLayer);

    this.presenceMouseHandler = (event) => {
      const rect = this.presenceLayer.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      this.presencePoint = { x, y };
      this.sendPresence();
    };
    this.contentEl.addEventListener("pointermove", this.presenceMouseHandler);

    this.presenceHeartbeatTimer = window.setInterval(() => this.sendPresence(true), PRESENCE_HEARTBEAT_MS);
    this.sendPresence(true);
    this.pollPresence(gen);
  }

  stopPresence() {
    // Invalidate the current session so any request still in flight becomes a no-op
    // when it resolves, even if no new session starts afterwards (e.g. onClose).
    this.presenceGen = (this.presenceGen || 0) + 1;
    if (this.presenceMouseHandler && this.contentEl) {
      this.contentEl.removeEventListener("pointermove", this.presenceMouseHandler);
    }
    if (this.presencePollTimer) window.clearTimeout(this.presencePollTimer);
    if (this.presenceHeartbeatTimer) window.clearInterval(this.presenceHeartbeatTimer);
    if (this.presenceTrailTimer) window.clearTimeout(this.presenceTrailTimer);
    if (this.presenceRafId != null) cancelAnimationFrame(this.presenceRafId);
    if (this.presenceLayer && this.presenceLayer.parentElement) this.presenceLayer.remove();
    this.presenceMouseHandler = null;
    this.presencePollTimer = null;
    this.presenceHeartbeatTimer = null;
    this.presenceTrailTimer = null;
    this.presenceRafId = null;
    this.presenceLayer = null;
    this.presenceBoard = null;
    this.presencePoint = null;
    this.presenceUsers = null;
    this.lockUiState = null;
    this.presenceSendInFlight = false;
    this.presenceDirty = false;
  }

  // Post our own cursor position. Sends are coalesced: while a request is in
  // flight or we are inside the throttle window, we only mark the state dirty
  // and flush the latest point afterwards so the resting position always lands.
  sendPresence(force = false) {
    if (!this.presenceBoard || !this.presencePoint) return;
    this.presenceDirty = true;
    this.flushPresence(force);
  }

  flushPresence(force = false) {
    if (!this.presenceBoard || !this.presenceDirty || this.presenceSendInFlight) return;

    const now = Date.now();
    const sinceLast = now - (this.lastPresenceSendAt || 0);
    if (!force && sinceLast < PRESENCE_SEND_INTERVAL_MS) {
      if (!this.presenceTrailTimer) {
        this.presenceTrailTimer = window.setTimeout(() => {
          this.presenceTrailTimer = null;
          this.flushPresence();
        }, PRESENCE_SEND_INTERVAL_MS - sinceLast);
      }
      return;
    }

    if (this.presenceTrailTimer) {
      window.clearTimeout(this.presenceTrailTimer);
      this.presenceTrailTimer = null;
    }
    const gen = this.presenceGen;
    this.lastPresenceSendAt = now;
    this.presenceDirty = false;
    this.presenceSendInFlight = true;
    this.plugin.sendBoardPresence(this.presenceBoard, this.presencePoint)
      .then((result) => this.applyPresenceResult(result, gen))
      .catch(() => {})
      .finally(() => {
        if (gen !== this.presenceGen) return; // superseded session: leave the new one untouched
        this.presenceSendInFlight = false;
        if (this.presenceDirty) this.flushPresence();
      });
  }

  // Self-scheduling receive loop. It polls fast while other cursors are present
  // and backs off when alone. GETs are skipped while our own POSTs are already
  // refreshing the roster, to avoid doubling the request rate while moving.
  schedulePresencePoll(gen) {
    if (gen !== this.presenceGen || !this.presenceBoard) return;
    const hasOthers = this.presenceUsers && this.presenceUsers.size > 0;
    const delay = hasOthers ? PRESENCE_POLL_ACTIVE_MS : PRESENCE_POLL_IDLE_MS;
    this.presencePollTimer = window.setTimeout(() => this.pollPresence(gen), delay);
  }

  pollPresence(gen) {
    if (gen !== this.presenceGen || !this.presenceBoard) return;
    const now = Date.now();
    if (now - (this.lastPresenceSendAt || 0) < PRESENCE_POLL_ACTIVE_MS) {
      this.schedulePresencePoll(gen);
      return;
    }
    this.plugin.fetchBoardPresence(this.presenceBoard.id)
      .then((result) => this.applyPresenceResult(result, gen))
      .catch(() => {})
      .finally(() => this.schedulePresencePoll(gen));
  }

  // Split a presence response into its cursor roster and card-lock roster. A
  // null result means a transient error: keep both rosters as-is (no flicker).
  applyPresenceResult(result, gen) {
    if (gen !== this.presenceGen) return;
    if (!result || !Array.isArray(result.users)) return;
    this.applyPresenceSnapshot(result.users, gen);
    this.applyLockSnapshot(Array.isArray(result.locks) ? result.locks : [], gen);
  }

  // Reconcile the card-lock roster into the plugin's lock map, then patch only
  // the cards whose lock state changed so the board is not fully re-rendered.
  applyLockSnapshot(locks, gen) {
    if (gen !== this.presenceGen) return;
    // Keep the plugin's map fresh for the card modal, but diff against our own
    // board-owned baseline so out-of-band modal writes cannot create ghost badges.
    this.plugin.setCardLocks(locks);
    const before = this.lockUiState || new Map();
    const after = new Map();
    (locks || []).forEach((lock) => {
      if (lock && lock.cardId) after.set(lock.cardId, lock);
    });

    const touched = new Set(before.keys());
    after.forEach((_value, cardId) => touched.add(cardId));
    touched.forEach((cardId) => {
      const beforeHolder = before.get(cardId) || null;
      const afterHolder = after.get(cardId) || null;
      const beforeEmail = beforeHolder && beforeHolder.email;
      const afterEmail = afterHolder && afterHolder.email;
      if (beforeEmail !== afterEmail || (beforeHolder && beforeHolder.name) !== (afterHolder && afterHolder.name)) {
        this.applyCardLockUi(cardId, afterHolder);
      }
    });
    this.lockUiState = after;
  }

  // Add/update/remove the lock overlay on a single card element in place.
  applyCardLockUi(cardId, holder) {
    if (!this.contentEl) return;
    const card = this.contentEl.querySelector(`.ot-card[data-card-id="${CSS.escape(cardId)}"]`);
    if (!card) return;
    card.classList.toggle("is-locked", !!holder);
    card.draggable = !holder && this.editingCardId !== cardId;
    const badge = card.querySelector(".ot-card-lock");
    if (badge) badge.remove();
    if (holder) card.append(this.buildLockBadge(holder));
  }

  // Reconcile the incoming roster against the live cursor elements: update
  // targets on existing cursors, create ones that just joined, remove ones that
  // left. Elements are never rebuilt wholesale, so the interpolation survives.
  applyPresenceSnapshot(users, gen) {
    if (gen !== this.presenceGen) return; // response from a superseded session
    if (!this.presenceLayer || !this.presenceUsers) return;
    // A failed request yields null (see plugin.sendBoardPresence/fetchBoardPresence).
    // Only an actual array is an authoritative roster; null means "keep what we have"
    // so a transient network error does not flicker every cursor off and back on.
    if (!Array.isArray(users)) return;
    const list = users;
    const seen = new Set();

    list.forEach((user) => {
      if (!user || !Number.isFinite(user.x) || !Number.isFinite(user.y)) return;
      const key = user.email || user.name;
      if (!key) return;
      seen.add(key);
      const x = Math.max(0, Math.min(1, user.x));
      const y = Math.max(0, Math.min(1, user.y));

      let entry = this.presenceUsers.get(key);
      if (!entry) {
        entry = this.createPresenceCursor();
        entry.cur.x = x;
        entry.cur.y = y;
        this.presenceLayer.append(entry.el);
        this.presenceUsers.set(key, entry);
      }
      entry.target.x = x;
      entry.target.y = y;
      this.updatePresenceCursorMeta(entry, user);
    });

    this.presenceUsers.forEach((entry, key) => {
      if (seen.has(key)) return;
      if (entry.el.parentElement) entry.el.remove();
      this.presenceUsers.delete(key);
    });

    this.ensurePresenceLoop();
  }

  createPresenceCursor() {
    const el = createElement("div", "ot-presence-cursor");
    const arrow = createElement("span", "ot-presence-arrow");
    const label = createElement("span", "ot-presence-name");
    const avatar = createElement("img", "ot-presence-avatar");
    avatar.alt = "";
    avatar.style.display = "none";
    const nameText = createElement("span", "", "");
    label.append(avatar, nameText);
    el.append(arrow, label);
    return {
      el,
      avatarEl: avatar,
      nameTextEl: nameText,
      color: null,
      name: null,
      picture: null,
      cur: { x: 0.5, y: 0.5 },
      target: { x: 0.5, y: 0.5 },
    };
  }

  updatePresenceCursorMeta(entry, user) {
    const color = user.color || "#8b5cf6";
    if (color !== entry.color) {
      entry.color = color;
      entry.el.style.setProperty("--ot-presence-color", color);
    }
    const name = user.name || user.email || "User";
    if (name !== entry.name) {
      entry.name = name;
      entry.nameTextEl.textContent = name;
    }
    const picture = user.picture || "";
    if (picture !== entry.picture) {
      entry.picture = picture;
      if (picture) {
        entry.avatarEl.src = picture;
        entry.avatarEl.style.display = "";
      } else {
        entry.avatarEl.removeAttribute("src");
        entry.avatarEl.style.display = "none";
      }
    }
  }

  ensurePresenceLoop() {
    if (this.presenceRafId != null) return;
    if (!this.presenceUsers || this.presenceUsers.size === 0) return;
    this.presenceLastFrame = null;
    this.presenceRafId = requestAnimationFrame(this.presenceTickBound);
  }

  // Ease every cursor toward its latest network target. Frame-rate independent
  // exponential smoothing keeps motion identical at 60/120Hz; the dt clamp stops
  // a big jump after the tab was backgrounded.
  presenceTick(now) {
    this.presenceRafId = null;
    if (!this.presenceLayer || !this.presenceUsers || this.presenceUsers.size === 0) return;

    let dt = now - (this.presenceLastFrame || now);
    this.presenceLastFrame = now;
    if (!(dt > 0)) dt = 16;
    if (dt > 100) dt = 100;
    const alpha = 1 - Math.exp(-dt / PRESENCE_SMOOTHING_TAU_MS);

    const rect = this.presenceLayer.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const drawable = w > 0 && h > 0;
    let anyMoving = false;

    this.presenceUsers.forEach((entry) => {
      const dx = entry.target.x - entry.cur.x;
      const dy = entry.target.y - entry.cur.y;
      if (Math.abs(dx) < PRESENCE_SNAP_DISTANCE && Math.abs(dy) < PRESENCE_SNAP_DISTANCE) {
        entry.cur.x = entry.target.x;
        entry.cur.y = entry.target.y;
      } else {
        entry.cur.x += dx * alpha;
        entry.cur.y += dy * alpha;
        anyMoving = true;
      }
      if (drawable) {
        entry.el.style.transform = `translate(${(entry.cur.x * w).toFixed(1)}px, ${(entry.cur.y * h).toFixed(1)}px)`;
      }
    });

    // Idle when everything has settled. A new target restarts the loop via
    // ensurePresenceLoop(); until then a motionless board costs zero rAF work.
    // Keep spinning while not yet drawable so cursors still get placed once the
    // view has a size.
    if (anyMoving || !drawable) {
      this.presenceRafId = requestAnimationFrame(this.presenceTickBound);
    }
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

  /**
   * Renders one column and wires list-level drag/drop targets.
   */
  renderList(list) {
    const column = createElement("section", "ot-list");
    column.dataset.listId = list.id;
    if (list.color) column.style.setProperty("--ot-list-color", list.color);
    const clearDropState = () => column.classList.remove("is-list-drop-before", "is-list-drop-after");
    const header = this.buildListHeader(list, column, clearDropState);
    this.bindListDropTarget(column, list, clearDropState);
    const cards = this.buildListCards(list);
    const footer = this.buildListFooter(list);
    column.append(header, cards);
    if (footer) column.append(footer);
    return column;
  }

  buildListHeader(list, column, clearDropState) {
    const header = createElement("div", "ot-list-header");
    header.draggable = true;
    header.classList.add("ot-list-drag-source");
    header.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData(LIST_DRAG_TYPE, list.id);
      event.dataTransfer.effectAllowed = "move";
      column.classList.add("is-dragging-list");
    });
    header.addEventListener("dragend", () => {
      column.classList.remove("is-dragging-list");
      clearDropState();
    });
    const dragHandle = createElement("span", "ot-list-drag-handle");
    try {
      setIcon(dragHandle, "grip-vertical");
    } catch (error) {
      dragHandle.textContent = "";
    }

    const colorDot = createElement("span", "ot-list-color-dot");
    if (list.color) colorDot.style.backgroundColor = list.color;
    header.append(dragHandle, colorDot, createElement("h3", "", list.title));
    header.append(createElement("span", "ot-list-count", String(list.cardIds.length)));
    header.append(iconButton("ellipsis", "List menu", (event) => this.showListMenu(event, list)));
    return header;
  }

  bindListDropTarget(column, list, clearDropState) {
    column.addEventListener("dragover", (event) => {
      if (!hasDragType(event, LIST_DRAG_TYPE)) return;
      event.preventDefault();
      const rect = column.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      column.classList.toggle("is-list-drop-before", !after);
      column.classList.toggle("is-list-drop-after", after);
    });
    column.addEventListener("dragleave", (event) => {
      if (!column.contains(event.relatedTarget)) clearDropState();
    });
    column.addEventListener("drop", async (event) => {
      if (!hasDragType(event, LIST_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = column.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      const draggedListId = event.dataTransfer.getData(LIST_DRAG_TYPE);
      clearDropState();
      await this.plugin.moveList(draggedListId, list.id, after);
    });
  }

  buildListCards(list) {
    const cards = createElement("div", "ot-cards");
    cards.addEventListener("dragover", (event) => {
      if (!this.cardDragState) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      this.scheduleCardDropPreview(cards, event.clientX, event.clientY);
    });
    cards.addEventListener("drop", async (event) => {
      if (!this.cardDragState) return;
      event.preventDefault();
      event.stopPropagation();
      await this.commitCardDrop(cards, event.clientX, event.clientY);
    });

    if (this.addingCardListId === list.id) {
      cards.append(this.renderCardComposer(list));
    }

    list.cardIds.forEach((cardId) => {
      const card = this.plugin.data.cards[cardId];
      if (card) cards.append(this.renderCard(card));
    });
    return cards;
  }

  buildListFooter(list) {
    if (this.addingCardListId === list.id) return null;
    const footer = createElement("div", "ot-list-footer");
    footer.append(textButton("plus", "Add card", () => this.showCardComposer(list.id)));
    return footer;
  }

  showCardComposer(listId) {
    this.addingCardListId = listId;
    this.render();
  }

  hideCardComposer() {
    this.addingCardListId = null;
    this.render();
  }

  renderCardComposer(list) {
    const form = createElement("form", "ot-card-composer");
    const input = createElement("input", "ot-inline-card-input");
    input.type = "text";
    input.placeholder = "Card title";

    const actions = createElement("div", "ot-card-composer-actions");
    const add = createElement("button", "mod-cta", "Add");
    addButtonIcon(add, "plus");
    const cancel = iconButton("x", "Cancel", () => this.hideCardComposer());
    add.type = "submit";
    actions.append(add, cancel);

    form.append(input, actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = textLine(input.value);
      if (!title) {
        input.focus();
        return;
      }

      this.addingCardListId = null;
      await this.plugin.createCard(list.id, title);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.hideCardComposer();
    });

    requestAnimationFrame(() => input.focus());
    return form;
  }

  /**
   * Renders one card, including drag/drop, completion toggle, rename trigger,
   * and compact metadata badges.
   */
  renderCard(card) {
    const element = createElement("article", "ot-card");
    const isRenaming = this.editingCardId === card.id;
    const lockHolder = this.plugin.getCardLockHolder(card.id);
    const lockedByOther = !!lockHolder;
    this.configureCardElement(element, card, { isRenaming, lockedByOther });
    this.bindCardInteractions(element, card);
    const labels = this.buildCardLabels(card);
    if (labels.childElementCount) element.append(labels);
    element.append(this.buildCardMain(card, { isRenaming, lockHolder }));

    const footer = this.buildCardFooter(card);
    if (footer) element.append(footer);
    if (lockedByOther) element.append(this.buildLockBadge(lockHolder));
    return element;
  }

  configureCardElement(element, card, { isRenaming, lockedByOther }) {
    element.draggable = !isRenaming && !lockedByOther;
    element.dataset.cardId = card.id;
    if (lockedByOther) element.classList.add("is-locked");
    if (card.completed) element.classList.add("is-completed");
    if (card.completed && this.plugin.completedAnimationCardId === card.id) {
      element.classList.add("is-just-completed");
      this.plugin.completedAnimationCardId = null;
      window.setTimeout(() => element.classList.remove("is-just-completed"), 650);
    }
  }

  bindCardInteractions(element, card) {
    element.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      event.dataTransfer.setData("text/plain", card.id);
      event.dataTransfer.effectAllowed = "move";
      this.startCardDrag(event, element, card.id);
    });
    element.addEventListener("dragend", () => this.finishCardDrag(false));
    element.addEventListener("click", () => new CardModal(this.app, this.plugin, card.id).open());
  }

  buildCardLabels(card) {
    const labels = createElement("div", "ot-card-labels");
    (card.labels || []).forEach((label) => {
      const pill = createElement("span", "ot-card-label", label.name);
      pill.style.backgroundColor = label.color;
      pill.title = label.name;
      labels.append(pill);
    });
    return labels;
  }

  buildCardMain(card, { isRenaming, lockHolder }) {
    const main = createElement("div", "ot-card-main");
    const title = isRenaming ? this.renderCardTitleEditor(card) : createElement("div", "ot-card-title", card.title);
    main.append(this.buildCardCompleteButton(card, lockHolder), title, this.buildCardActions(card, lockHolder));
    return main;
  }

  buildCardCompleteButton(card, lockHolder) {
    const completeButton = iconButton(card.completed ? "check" : "circle", card.completed ? "Mark as incomplete" : "Mark as complete", async (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      await this.plugin.toggleCardCompleted(card.id);
    });
    completeButton.classList.add("ot-card-complete-toggle");
    completeButton.draggable = false;
    completeButton.replaceChildren();
    if (card.completed) completeButton.append(createElement("span", "ot-card-complete-mark", "✓"));
    return completeButton;
  }

  buildCardActions(card, lockHolder) {
    const editButton = iconButton("pencil", "Edit card", (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      this.editingCardId = card.id;
      this.showCardMenu(event, card);
      this.render();
    });
    editButton.classList.add("ot-card-action-button");
    editButton.draggable = false;
    const actions = createElement("div", "ot-card-actions");
    actions.append(editButton);
    return actions;
  }

  buildCardFooter(card) {
    const meta = this.renderCardMeta(card);
    const assignees = this.renderCardAssignees(card);
    if (!meta.childElementCount && !assignees.childElementCount) return null;
    const footer = createElement("div", "ot-card-footer");
    footer.append(meta, assignees);
    return footer;
  }

  startCardDrag(event, element, cardId) {
    this.finishCardDrag(false);
    const rect = element.getBoundingClientRect();
    const placeholder = createElement("div", "ot-card-drop-placeholder");
    placeholder.style.height = `${rect.height}px`;

    const preview = this.createCardDragPreview(element, rect.width);
    if (preview && event.dataTransfer.setDragImage) {
      event.dataTransfer.setDragImage(preview, Math.min(32, rect.width / 2), 24);
    }

    this.cardDragState = { cardId, element, placeholder, preview, targetCards: element.parentElement, clientX: 0, clientY: 0 };
    requestAnimationFrame(() => {
      if (!this.cardDragState || this.cardDragState.element !== element) return;
      element.classList.add("is-dragging");
      this.contentEl.classList.add("is-card-drag-active");
    });
  }

  createCardDragPreview(element, width) {
    if (!document.body) return null;
    const preview = element.cloneNode(true);
    preview.classList.remove("is-dragging");
    preview.classList.add("ot-card-drag-preview");
    preview.style.width = `${width}px`;
    preview.setAttribute("aria-hidden", "true");
    document.body.append(preview);
    return preview;
  }

  scheduleCardDropPreview(cards, clientX, clientY) {
    if (!this.cardDragState) return;
    Object.assign(this.cardDragState, { targetCards: cards, clientX, clientY });
    if (this.cardDragFrameId !== null) return;
    this.cardDragFrameId = requestAnimationFrame(() => this.updateCardDropPreview());
  }

  updateCardDropPreview() {
    this.cardDragFrameId = null;
    const state = this.cardDragState;
    if (!state || !state.targetCards) return;

    const verticalScroll = this.autoScrollElement(state.targetCards, state.clientY, "vertical");
    const horizontalScroll = this.autoScrollElement(state.targetCards.closest(".ot-board-scroll"), state.clientX, "horizontal");
    this.placeCardDropPreview(state.targetCards, state.clientY);

    if (verticalScroll || horizontalScroll) {
      this.cardDragFrameId = requestAnimationFrame(() => this.updateCardDropPreview());
    }
  }

  placeCardDropPreview(cards, clientY) {
    const anchor = this.findCardDropAnchor(cards, clientY);
    this.moveCardPlaceholder(cards, anchor);
  }

  findCardDropAnchor(cards, clientY) {
    const draggedElement = this.cardDragState && this.cardDragState.element;
    const candidates = Array.from(cards.querySelectorAll(".ot-card")).filter((card) => card !== draggedElement);
    return candidates.find((card) => {
      const rect = card.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    }) || null;
  }

  moveCardPlaceholder(cards, anchor) {
    const state = this.cardDragState;
    if (!state || (state.placeholder.parentElement === cards && state.placeholder.nextElementSibling === anchor)) return;

    const previousCards = state.placeholder.parentElement;
    const affectedCards = this.captureCardPositions([previousCards, cards]);
    if (previousCards) previousCards.classList.remove("is-drop-zone");
    cards.insertBefore(state.placeholder, anchor);
    cards.classList.add("is-drop-zone");
    this.animateCardReflow(affectedCards);
  }

  captureCardPositions(containers) {
    const positions = new Map();
    const draggedElement = this.cardDragState && this.cardDragState.element;
    new Set(containers.filter(Boolean)).forEach((container) => {
      container.querySelectorAll(".ot-card").forEach((card) => {
        if (card === draggedElement) return;
        positions.set(card, card.getBoundingClientRect());
      });
    });
    return positions;
  }

  animateCardReflow(positions) {
    if (this.contentEl.classList.contains("is-motion-disabled")) return;
    requestAnimationFrame(() => {
      positions.forEach((previous, card) => {
        if (!card.isConnected || typeof card.animate !== "function") return;
        const current = card.getBoundingClientRect();
        const offsetY = previous.top - current.top;
        if (Math.abs(offsetY) < 0.5) return;
        const running = this.cardReflowAnimations.get(card);
        if (running) running.cancel();
        const animation = card.animate(
          [{ transform: `translate3d(0, ${offsetY}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
          { duration: CARD_REFLOW_DURATION_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
        );
        this.cardReflowAnimations.set(card, animation);
      });
    });
  }

  autoScrollElement(element, pointerPosition, axis) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const start = axis === "vertical" ? rect.top : rect.left;
    const end = axis === "vertical" ? rect.bottom : rect.right;
    const delta = this.edgeScrollDelta(pointerPosition, start, end);
    if (!delta) return false;

    const previous = axis === "vertical" ? element.scrollTop : element.scrollLeft;
    if (axis === "vertical") element.scrollTop += delta;
    else element.scrollLeft += delta;
    return previous !== (axis === "vertical" ? element.scrollTop : element.scrollLeft);
  }

  edgeScrollDelta(pointerPosition, start, end) {
    if (pointerPosition < start + CARD_SCROLL_EDGE_PX) {
      const strength = Math.min(1, (start + CARD_SCROLL_EDGE_PX - pointerPosition) / CARD_SCROLL_EDGE_PX);
      return -CARD_SCROLL_MAX_STEP_PX * strength * strength;
    }
    if (pointerPosition > end - CARD_SCROLL_EDGE_PX) {
      const strength = Math.min(1, (pointerPosition - end + CARD_SCROLL_EDGE_PX) / CARD_SCROLL_EDGE_PX);
      return CARD_SCROLL_MAX_STEP_PX * strength * strength;
    }
    return 0;
  }

  cardIdAfterPlaceholder(placeholder, draggedCardId) {
    let sibling = placeholder.nextElementSibling;
    while (sibling) {
      if (sibling.dataset && sibling.dataset.cardId && sibling.dataset.cardId !== draggedCardId) return sibling.dataset.cardId;
      sibling = sibling.nextElementSibling;
    }
    return undefined;
  }

  async commitCardDrop(cards, clientX, clientY) {
    const state = this.cardDragState;
    if (!state) return;
    if (this.cardDragFrameId !== null) cancelAnimationFrame(this.cardDragFrameId);
    this.cardDragFrameId = null;
    Object.assign(state, { targetCards: cards, clientX, clientY });
    this.placeCardDropPreview(cards, clientY);
    if (!state.placeholder.parentElement) return;
    const targetList = state.placeholder.parentElement.closest(".ot-list");
    const move = {
      cardId: state.cardId,
      targetListId: targetList && targetList.dataset.listId,
      beforeCardId: this.cardIdAfterPlaceholder(state.placeholder, state.cardId),
    };
    this.finishCardDrag(true);
    if (!move.targetListId) return;

    this.cardDropRefreshBlockedUntil = Number.POSITIVE_INFINITY;
    try {
      await this.plugin.moveCard(move.cardId, move.targetListId, move.beforeCardId);
      this.cardDropRefreshBlockedUntil = Date.now() + CARD_DROP_REFRESH_GRACE_MS;
    } catch (error) {
      this.cardDropRefreshBlockedUntil = 0;
      console.error("Kanux: card move failed", error);
      new Notice("Could not move the card.");
      this.render();
    }
  }

  shouldDeferRefresh() {
    return Date.now() < this.cardDropRefreshBlockedUntil;
  }

  finishCardDrag(commit) {
    const state = this.cardDragState;
    if (!state) return;
    if (this.cardDragFrameId !== null) cancelAnimationFrame(this.cardDragFrameId);
    this.cardDragFrameId = null;

    const sourceCards = state.element.parentElement;
    const targetCards = state.placeholder.parentElement;
    const affectedCards = this.captureCardPositions([sourceCards, targetCards]);
    if (commit && state.placeholder.parentElement) {
      state.placeholder.parentElement.insertBefore(state.element, state.placeholder);
      state.element.classList.add("is-drag-settling");
      window.setTimeout(() => state.element.classList.remove("is-drag-settling"), 210);
    }
    state.element.classList.remove("is-dragging");
    state.placeholder.remove();
    if (state.preview) state.preview.remove();
    this.contentEl.classList.remove("is-card-drag-active");
    this.contentEl.querySelectorAll(".ot-cards.is-drop-zone").forEach((cards) => cards.classList.remove("is-drop-zone"));
    this.cardDragState = null;
    if (commit) this.updateVisibleCardCounts([sourceCards, targetCards]);
    this.animateCardReflow(affectedCards);
  }

  updateVisibleCardCounts(containers) {
    new Set(containers.filter(Boolean)).forEach((cards) => {
      const list = cards.closest(".ot-list");
      const count = list && list.querySelector(".ot-list-count");
      if (count) count.textContent = String(cards.querySelectorAll(".ot-card").length);
    });
  }

  renderCardAssignees(card) {
    const wrap = createElement("div", "ot-card-assignees");
    if (!this.plugin.isSyncDeckEnabled()) return wrap;
    const assignees = (card.assignees || []).filter((a) => a && a.email);
    const max = 3;
    assignees.slice(0, max).forEach((assignee) => wrap.append(this.buildAvatar(assignee)));
    if (assignees.length > max) {
      const more = createElement("span", "ot-card-avatar is-initials", `+${assignees.length - max}`);
      wrap.append(more);
    }
    return wrap;
  }

  buildAvatar(assignee) {
    const el = createElement("span", "ot-card-avatar");
    el.style.setProperty("--ot-avatar-color", assignee.color || "#8b5cf6");
    el.title = assignee.name || assignee.email;
    const picture = this.plugin.getMemberPicture(assignee.email);
    if (picture) {
      const img = createElement("img", "");
      img.src = picture;
      img.alt = "";
      el.append(img);
    } else {
      el.textContent = initials(assignee.name || assignee.email);
      el.classList.add("is-initials");
    }
    return el;
  }

  buildLockBadge(holder) {
    const badge = createElement("span", "ot-card-lock");
    badge.style.setProperty("--ot-lock-color", (holder && holder.color) || "#f59e0b");
    badge.append(createElement("span", "", `🔒 ${(holder && holder.name) || "Someone"}`));
    badge.title = `${(holder && holder.name) || "Someone"} is editing this card`;
    return badge;
  }

  notifyCardLocked(holder) {
    new Notice(`🔒 ${(holder && holder.name) || "Someone"} is editing this card`);
  }

  /**
   * Inline title editor used by the card edit button.
   */
  renderCardTitleEditor(card) {
    const form = createElement("form", "ot-card-title-form");
    const input = createElement("input", "ot-card-title-input");
    let finished = false;
    input.type = "text";
    input.value = card.title;
    input.placeholder = "Card title";

    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const title = textLine(input.value);
      this.editingCardId = null;
      if (save && title && title !== card.title) {
        await this.plugin.updateCard(card.id, { title });
      } else {
        this.render();
      }
    };

    form.addEventListener("click", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      finish(true).catch(console.error);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false).catch(console.error);
      }
    });
    input.addEventListener("blur", () => finish(true).catch(console.error));

    form.append(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return form;
  }

  /**
   * Builds the small date/checklist/details indicators shown on closed cards.
   */
  renderCardMeta(card) {
    const meta = createElement("div", "ot-card-meta");
    const dates = dateRangeLabel(card.startDate, card.dueDate);
    if (dates) meta.append(this.buildCardDateBadge(dates));
    const checklist = checklistItems(card.checklists);
    if (checklist.length) meta.append(this.buildCardChecklistBadge(checklist));
    if (card.details) meta.append(createElement("span", "ot-card-meta-item", "☰"));
    return meta;
  }

  buildCardDateBadge(dates) {
    const badge = createElement("span", "ot-card-meta-item ot-card-date-badge");
    const icon = createElement("span", "ot-card-date-icon");
    try {
      setIcon(icon, "clock");
    } catch (error) {
      icon.textContent = "";
    }
    badge.append(icon, createElement("span", "", dates));
    return badge;
  }

  buildCardChecklistBadge(checklist) {
    const stats = checklistStats(checklist);
    const badge = createElement("span", "ot-card-meta-item ot-card-checklist-badge");
    badge.classList.toggle("is-complete", stats.total > 0 && stats.done === stats.total);
    const icon = createElement("span", "ot-card-checklist-icon");
    try {
      setIcon(icon, "check-square");
    } catch (error) {
      icon.textContent = "☑";
    }
    badge.append(icon, createElement("span", "", `${stats.done}/${stats.total}`));
    return badge;
  }

  showCardMenu(event, card) {
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("Edit dates")
        .setIcon("calendar-days")
        .onClick(() => new CardDatesModal(this.app, this.plugin, card.id).open());
    });
    menu.addItem((item) => {
      item
        .setTitle("Delete card")
        .setIcon("trash")
        .onClick(async () => {
          const confirmed = await confirmAction(this.app, "Delete card", "Delete this card and its linked Markdown note?");
          if (!confirmed) return;
          await this.plugin.deleteCard(card.id);
        });
    });
    menu.showAtMouseEvent(event);
  }

  showListMenu(event, list) {
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("Rename list")
        .setIcon("pencil")
        .onClick(() => this.plugin.renameList(list.id));
    });
    menu.addItem((item) => {
      item
        .setTitle("Change list color")
        .setIcon("palette")
        .onClick(() => {
          new ListColorModal(this.app, list.title, list.color, (color) => this.plugin.setListColor(list.id, color)).open();
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Delete list")
        .setIcon("trash")
        .onClick(() => this.plugin.deleteList(list.id));
    });
    menu.showAtMouseEvent(event);
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

module.exports = { BoardView };
