const { Menu, setIcon } = require("obsidian");

// Table view: one row per card across every list, List = the card's location.
// Row click opens a Description + Checklist card view; every other field
// (status, members, dates, labels) is edited inline from its cell.
const {
  DEPENDENCY_BLOCK_NONE,
  addButtonIcon,
  checklistItems,
  checklistStats,
  createElement,
  dateRangeLabel,
  hasDragType,
  textButton,
  textLine,
} = require("../helpers");
const { CardDatesModal, CardModal, LabelPickerModal } = require("../modals");

// Drag payload type for reordering table columns (kept distinct from card/list drags).
const TABLE_COL_DRAG_TYPE = "application/x-kanux-column";

const tableViewMethods = {
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
  },

  defaultColWidth(key) {
    return { status: 150, assignee: 175, dates: 155, labels: 190 }[key] || 150;
  },

  getTableConfig(board) {
    const validKeys = this.tableColumnDefs().map((def) => def.key);
    const raw = (this.plugin.data.tableConfigs && this.plugin.data.tableConfigs[board.id]) || {};
    const order = (Array.isArray(raw.order) ? raw.order : []).filter((key) => validKeys.includes(key));
    validKeys.forEach((key) => { if (!order.includes(key)) order.push(key); });
    const hidden = new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter((key) => validKeys.includes(key)));
    const widths = {};
    order.forEach((key) => { widths[key] = (raw.widths && raw.widths[key]) || this.defaultColWidth(key); });
    return { nameWidth: raw.nameWidth || 260, order, hidden, widths };
  },

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
  },

  reorderColumn(board, cfg, draggedKey, targetKey) {
    if (draggedKey === targetKey) return;
    cfg.order = cfg.order.filter((key) => key !== draggedKey);
    const targetIndex = cfg.order.indexOf(targetKey);
    cfg.order.splice(targetIndex < 0 ? cfg.order.length : targetIndex, 0, draggedKey);
    this.persistTableConfig(board, cfg);
    this.render();
  },

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
  },

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
  },

  buildTableGrid(context) {
    const wrap = createElement("div", "ot-table-wrap");
    const table = createElement("table", "ot-table");
    const columns = this.buildTableColumns(context.cfg, context.visible);
    table.append(columns.colgroup, this.buildTableHeader(context, columns));
    const tbody = createElement("tbody");
    table.append(tbody);
    wrap.append(table);
    return { wrap, tbody };
  },

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
  },

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
  },

  buildTableNameHeader(board, cfg, nameCol) {
    const header = createElement("th", "ot-th ot-th-name");
    const inner = createElement("div", "ot-th-inner");
    inner.append(createElement("span", "ot-th-label", "Card"));
    header.append(inner, this.buildColResize(nameCol, () => {
      cfg.nameWidth = parseInt(nameCol.style.width, 10) || cfg.nameWidth;
      this.persistTableConfig(board, cfg);
    }, 140));
    return header;
  },

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
  },

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
  },

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
  },

  renderTableRow(card, list, board, visible) {
    const lockHolder = this.plugin.getCardLockHolder(card.id);
    const row = createElement("tr", "ot-table-row");
    this.configureTableRow(row, card, list, lockHolder);
    row.append(this.buildTableNameCell(card, lockHolder));
    visible.forEach((key) => row.append(this.renderTableCell(key, card, list, board, lockHolder)));
    row.append(createElement("td", "ot-td ot-td-addcell"));
    return row;
  },

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
  },

  buildTableNameCell(card, lockHolder) {
    const nameCell = createElement("td", "ot-td ot-td-name");
    const nameInner = createElement("div", "ot-td-name-inner");
    nameInner.append(this.buildTableCompletionControl(card, lockHolder), createElement("span", "ot-td-title", card.title));
    const hints = this.buildTableCardHints(card);
    if (hints.childElementCount) nameInner.append(hints);
    if (lockHolder) nameInner.append(this.buildLockBadge(lockHolder));
    nameCell.append(nameInner);
    return nameCell;
  },

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
  },

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
    const dependencies = this.plugin.cardDependencyGate(card);
    if (dependencies.total) {
      const blocked = dependencies.mode !== DEPENDENCY_BLOCK_NONE;
      const dependencyHint = createElement("span", "ot-td-hint ot-td-dependency-hint");
      dependencyHint.classList.toggle("is-blocked", blocked);
      const dependencyIcon = createElement("span", "ot-td-hint-icon");
      try { setIcon(dependencyIcon, blocked ? "lock" : "link"); } catch (error) { dependencyIcon.textContent = ""; }
      dependencyHint.append(dependencyIcon, createElement("span", "", `${dependencies.met}/${dependencies.total}`));
      hints.append(dependencyHint);
    }
    if (card.details) {
      const detailsHint = createElement("span", "ot-td-hint");
      const detailsIcon = createElement("span", "ot-td-hint-icon");
      try { setIcon(detailsIcon, "align-left"); } catch (error) { detailsIcon.textContent = "≡"; }
      detailsHint.append(detailsIcon);
      hints.append(detailsHint);
    }
    return hints;
  },

  renderTableCell(key, card, list, board, lockHolder) {
    if (key === "status") return this.renderStatusCell(card, list, board, lockHolder);
    if (key === "assignee") return this.renderAssigneeCell(card, lockHolder);
    if (key === "dates") return this.renderDatesCell(card, lockHolder);
    if (key === "labels") return this.renderLabelsCell(card, lockHolder);
    return createElement("td", "ot-td");
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  openLabelPicker(card) {
    new LabelPickerModal(this.app, this.plugin.data.labels || [], card.labels || [], async (labels, selectedLabels, options = {}) => {
      if (options.persist === false) return;
      await this.plugin.updateCard(card.id, { labels: selectedLabels }, labels);
    }, (label) => this.plugin.deleteLabel(label)).open();
  },

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
  },
};

module.exports = { tableViewMethods };
