const { setIcon } = require("obsidian");

// Table view filtering: per-board filter state, the controls row, the
// search/sort predicates, and the shared anchored popover used by the pickers.
const { addButtonIcon, checklistItems, createElement, labelKey } = require("../helpers");

const tableFilterMethods = {
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
  },

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
  },

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
  },

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
  },

  buildTableSelect(ariaLabel, options, value) {
    const select = createElement("select", "ot-table-filter");
    select.setAttribute("aria-label", ariaLabel);
    options.forEach((option) => select.append(new Option(option.label, option.value)));
    select.value = value;
    return select;
  },

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
  },

  bindTableControl({ control, eventName, state, stateKey, onChange }) {
    control.addEventListener(eventName, () => {
      state[stateKey] = control.value;
      onChange();
    });
  },

  resetTableFilters(state, controls, onChange) {
    Object.assign(state, { query: "", listId: "all", completion: "all", sort: "board", labelKeys: [] });
    controls.search.value = "";
    controls.listFilter.value = "all";
    controls.completionFilter.value = "all";
    controls.sort.value = "board";
    onChange();
    controls.search.focus();
  },

  normalizeTableSearch(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase();
  },

  filterAndSortTableRows(rows, state) {
    const queryTerms = this.normalizeTableSearch(state.query).split(/\s+/).filter(Boolean);
    const filtered = rows.filter((row) => this.tableRowMatches(row, state, queryTerms));
    return this.sortTableRows(filtered, state.sort);
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  closeTablePopover() {
    if (!this._tablePopover) return;
    if (this._tablePopover._cleanup) this._tablePopover._cleanup();
    this._tablePopover.remove();
    this._tablePopover = null;
    if (this._tablePopoverAnchor) this._tablePopoverAnchor.setAttribute("aria-expanded", "false");
    this._tablePopoverAnchor = null;
  },

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
  },
};

module.exports = { tableFilterMethods };
