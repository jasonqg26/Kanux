const { Menu, Notice, setIcon } = require("obsidian");

// Board-mode rendering: list columns, cards, composers, badges, avatars, and
// the card/list context menus.
const {
  DEPENDENCY_BLOCK_NONE,
  LIST_DRAG_TYPE,
  addButtonIcon,
  checklistItems,
  checklistStats,
  createElement,
  dateRangeLabel,
  hasDragType,
  iconButton,
  initials,
  textButton,
  textLine,
} = require("../helpers");
const { CardDatesModal, CardModal, ListColorModal, confirmAction } = require("../modals");

const listCardMethods = {
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
  },

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
  },

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
  },

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
  },

  buildListFooter(list) {
    if (this.addingCardListId === list.id) return null;
    const footer = createElement("div", "ot-list-footer");
    footer.append(textButton("plus", "Add card", () => this.showCardComposer(list.id)));
    return footer;
  },

  showCardComposer(listId) {
    this.addingCardListId = listId;
    this.render();
  },

  hideCardComposer() {
    this.addingCardListId = null;
    this.render();
  },

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
  },

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
  },

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
  },

  bindCardInteractions(element, card) {
    element.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      event.dataTransfer.setData("text/plain", card.id);
      event.dataTransfer.effectAllowed = "move";
      this.startCardDrag(event, element, card.id);
    });
    element.addEventListener("dragend", () => this.finishCardDrag(false));
    element.addEventListener("click", () => new CardModal(this.app, this.plugin, card.id).open());
  },

  buildCardLabels(card) {
    const labels = createElement("div", "ot-card-labels");
    (card.labels || []).forEach((label) => {
      const pill = createElement("span", "ot-card-label", label.name);
      pill.style.backgroundColor = label.color;
      pill.title = label.name;
      labels.append(pill);
    });
    return labels;
  },

  buildCardMain(card, { isRenaming, lockHolder }) {
    const main = createElement("div", "ot-card-main");
    const title = isRenaming ? this.renderCardTitleEditor(card) : createElement("div", "ot-card-title", card.title);
    main.append(this.buildCardCompleteButton(card, lockHolder), title, this.buildCardActions(card, lockHolder));
    return main;
  },

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
  },

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
  },

  buildCardFooter(card) {
    const meta = this.renderCardMeta(card);
    const assignees = this.renderCardAssignees(card);
    if (!meta.childElementCount && !assignees.childElementCount) return null;
    const footer = createElement("div", "ot-card-footer");
    footer.append(meta, assignees);
    return footer;
  },

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
  },

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
  },

  buildLockBadge(holder) {
    const badge = createElement("span", "ot-card-lock");
    badge.style.setProperty("--ot-lock-color", (holder && holder.color) || "#f59e0b");
    badge.append(createElement("span", "", `🔒 ${(holder && holder.name) || "Someone"}`));
    badge.title = `${(holder && holder.name) || "Someone"} is editing this card`;
    return badge;
  },

  notifyCardLocked(holder) {
    new Notice(`🔒 ${(holder && holder.name) || "Someone"} is editing this card`);
  },

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
  },

  /**
   * Builds the small date/checklist/details indicators shown on closed cards.
   */
  renderCardMeta(card) {
    const meta = createElement("div", "ot-card-meta");
    const dates = dateRangeLabel(card.startDate, card.dueDate);
    if (dates) meta.append(this.buildCardDateBadge(dates));
    const checklist = checklistItems(card.checklists);
    if (checklist.length) meta.append(this.buildCardChecklistBadge(checklist));
    const dependencies = this.plugin.cardDependencyGate(card);
    if (dependencies.total) meta.append(this.buildCardDependencyBadge(dependencies));
    if (card.details) meta.append(createElement("span", "ot-card-meta-item", "☰"));
    return meta;
  },

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
  },

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
  },

  // Shows how many dependencies are met, and locks up when one of them still
  // blocks the card from moving on.
  buildCardDependencyBadge(gate) {
    const blocked = gate.mode !== DEPENDENCY_BLOCK_NONE;
    const badge = createElement("span", "ot-card-meta-item ot-card-dependency-badge");
    badge.classList.toggle("is-blocked", blocked);
    badge.title = blocked
      ? `Blocked by ${gate.pending.length} unfinished ${gate.pending.length === 1 ? "dependency" : "dependencies"}`
      : "Dependencies";
    const icon = createElement("span", "ot-card-dependency-icon");
    try {
      setIcon(icon, blocked ? "lock" : "link");
    } catch (error) {
      icon.textContent = "";
    }
    badge.append(icon, createElement("span", "", `${gate.met}/${gate.total}`));
    return badge;
  },

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
  },

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
  },
};

module.exports = { listCardMethods };
