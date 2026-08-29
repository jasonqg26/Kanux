// Card operations: create/update/move/delete, completion, label deletion, and
// the undo snapshots that make each user mutation reversible.
const {
  VIEW_TYPE,
  cleanDate,
  clone,
  imageRefsFromMarkdown,
  isImagePath,
  labelKey,
  normalizeChecklists,
  normalizeDependencies,
  parseCardMarkdown,
  textLine,
  uid,
} = require("../helpers");
const { confirmAction } = require("../modals");
const { COMPLETION_SOUND_URL } = require("./completion-sound");

const cardOpsMethods = {
  async addCard(listId) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      await this.activateView();
      leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    }

    if (leaf && leaf.view && leaf.view.showCardComposer) {
      leaf.view.showCardComposer(listId);
    }
  },

  /**
   * Creates a card at the top of a list and immediately writes its note file.
   */
  async createCard(listId, title) {
    const board = this.data.boards.find((item) => item.lists.some((list) => list.id === listId));
    const list = this.findList(listId, board);
    if (!board || !list) return;

    const now = new Date().toISOString();
    const card = {
      id: uid("card"),
      boardId: board.id,
      title,
      listId,
      labels: [],
      assignees: [],
      details: "",
      checklists: normalizeChecklists(undefined, []),
      dependencies: [],
      completed: false,
      startDate: "",
      dueDate: "",
      filePath: await this.nextCardPath(title, null, board),
      createdAt: now,
      updatedAt: now,
    };

    this.data.cards[card.id] = card;
    list.cardIds.unshift(card.id);
    if (!this.applyingUndo) {
      const newId = card.id;
      this.recordUndo(async () => { await this.deleteCard(newId); });
    }
    // Inserting at the top shifts every other card's index, so rewrite the whole
    // list's files to keep their `position` frontmatter in sync (not just the new
    // card) — otherwise the new order wouldn't propagate to other devices.
    await this.writeListCardFiles(list);
    await this.savePluginData();
    this.refreshViews();
  },

  /**
   * Applies a card patch, including linked file renames when the title changes.
   */
  async updateCard(cardId, patch, globalLabels) {
    const card = this.data.cards[cardId];
    if (!card) return;

    // Snapshot the fields this patch touches so Cmd+Z can restore them.
    if (!this.applyingUndo) {
      const before = {};
      Object.keys(patch).forEach((key) => { before[key] = clone(card[key]); });
      const beforeGlobal = globalLabels ? clone(this.data.labels) : undefined;
      this.recordUndo(async () => { await this.updateCard(cardId, before, beforeGlobal); });
    }

    if (globalLabels) this.data.labels = this.normalizeGlobalLabels(globalLabels);
    if (patch.labels) patch.labels = this.normalizeCardLabels(patch.labels);
    if (Object.prototype.hasOwnProperty.call(patch, "assignees")) patch.assignees = this.normalizeAssignees(patch.assignees);
    if (Object.prototype.hasOwnProperty.call(patch, "completed")) patch.completed = !!patch.completed;
    if (Object.prototype.hasOwnProperty.call(patch, "startDate")) patch.startDate = cleanDate(patch.startDate);
    if (Object.prototype.hasOwnProperty.call(patch, "dueDate")) patch.dueDate = cleanDate(patch.dueDate);
    if (Object.prototype.hasOwnProperty.call(patch, "checklists")) {
      patch.checklists = normalizeChecklists(patch.checklists, []);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "dependencies")) {
      patch.dependencies = normalizeDependencies(patch.dependencies);
    }
    if (patch.title && textLine(patch.title) !== textLine(card.title)) {
      await this.renameCardFile(card, patch.title);
    }
    Object.assign(card, patch, { updatedAt: new Date().toISOString() });
    await this.writeCardFile(card);
    await this.savePluginData();
    this.refreshViews();
  },

  /**
   * Moves a card between lists or before another card, then updates its note
   * frontmatter with the new list id.
   *
   * Returns whether the card actually moved, so the board can repaint when an
   * unmet dependency (or an unusable target) refuses the drop.
   */
  async moveCard(cardId, targetListId, beforeCardId) {
    if (!cardId || cardId === beforeCardId) return false;
    const targetBoard = this.data.boards.find((board) => board.lists.some((list) => list.id === targetListId));
    const targetList = this.findList(targetListId, targetBoard);
    const card = this.data.cards[cardId];
    if (!targetBoard || !targetList || !card) return false;

    // Dependencies gate a real change of list only: reordering inside one list
    // is not progress, and an undo must always be able to put the card back.
    if (card.listId !== targetListId && !this.applyingUndo) {
      if (!await this.confirmDependencyGate(this.cardDependencyGate(card))) return false;
    }

    // Remember where it came from so we can rewrite that list's order too.
    const sourceList = this.data.boards.flatMap((board) => board.lists).find((list) => list.cardIds.includes(cardId)) || null;

    // Snapshot the old list + position so Cmd+Z can move it back exactly.
    if (!this.applyingUndo && sourceList) {
      const oldListId = sourceList.id;
      const oldIndex = sourceList.cardIds.indexOf(cardId);
      const oldBeforeId = sourceList.cardIds[oldIndex + 1];
      this.recordUndo(async () => { await this.moveCard(cardId, oldListId, oldBeforeId); });
    }

    this.data.boards.forEach((board) => board.lists.forEach((list) => {
      list.cardIds = list.cardIds.filter((id) => id !== cardId);
    }));

    const beforeIndex = beforeCardId ? targetList.cardIds.indexOf(beforeCardId) : -1;
    if (beforeIndex === -1) {
      targetList.cardIds.push(cardId);
    } else {
      targetList.cardIds.splice(beforeIndex, 0, cardId);
    }

    card.boardId = targetBoard.id;
    card.listId = targetListId;
    // Persist the new order: rewrite every card in the affected list(s) so their
    // `position` frontmatter reflects the new order and syncs to other devices.
    await this.writeListCardFiles(targetList);
    if (sourceList && sourceList.id !== targetList.id) await this.writeListCardFiles(sourceList);
    await this.savePluginData();
    this.refreshViews();
    return true;
  },

  async toggleCardCompleted(cardId) {
    const card = this.data.cards[cardId];
    if (!card) return;
    const completed = !card.completed;
    if (completed) {
      this.completedAnimationCardId = cardId;
      if (this.data.completionSound) this.playCompletionSound();
    } else if (this.completedAnimationCardId === cardId) {
      this.completedAnimationCardId = null;
    }
    await this.updateCard(cardId, { completed });
  },

  playCompletionSound() {
    try {
      const audio = new Audio(COMPLETION_SOUND_URL);
      audio.volume = 0.6;
      const play = audio.play();
      if (play && play.catch) play.catch(() => {});
    } catch (error) {
      // Sound is a small optional cue; completion should never fail because of it.
    }
  },

  /**
   * Removes a card from all lists and trashes its linked Markdown note.
   */
  async deleteCard(cardId, saveAndRefresh = true) {
    const card = this.data.cards[cardId];
    if (!card) return;

    // Snapshot the card + its note before deletion so Cmd+Z can bring it back.
    // Only for real user deletes (saveAndRefresh), not internal bulk cleanups.
    if (!this.applyingUndo && saveAndRefresh) {
      const cardCopy = clone(card);
      const srcList = this.data.boards.flatMap((board) => board.lists).find((list) => list.cardIds.includes(cardId)) || null;
      const listId = srcList ? srcList.id : null;
      const srcIndex = srcList ? srcList.cardIds.indexOf(cardId) : -1;
      const beforeId = srcIndex >= 0 ? srcList.cardIds[srcIndex + 1] : undefined;
      let fileContent = null;
      const noteFile = this.app.vault.getAbstractFileByPath(card.filePath);
      if (noteFile && noteFile.extension === "md") {
        try { fileContent = await this.app.vault.read(noteFile); } catch (error) { fileContent = null; }
      }
      if (listId) this.recordUndo(async () => { await this.restoreDeletedCard(cardCopy, listId, beforeId, fileContent); });
    }

    this.data.boards.forEach((board) => board.lists.forEach((list) => {
      list.cardIds = list.cardIds.filter((id) => id !== cardId);
    }));

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (file) await this.app.vault.trash(file, true);
    delete this.data.cards[cardId];

    if (saveAndRefresh) {
      await this.savePluginData();
      this.refreshViews();
    }
  },

  // Re-create a card deleted via deleteCard: restore its data, list position, and
  // note file from the snapshot captured before deletion.
  async restoreDeletedCard(cardCopy, listId, beforeCardId, fileContent) {
    let board = this.data.boards.find((item) => item.lists.some((list) => list.id === listId));
    let list = board ? board.lists.find((item) => item.id === listId) : null;
    if (!list) {
      // The original list is gone (removed after the delete). Fall back to the
      // card's board's first list so the card still comes back somewhere visible;
      // throw only if there's truly nowhere to put it (undoLast surfaces it).
      board = this.data.boards.find((item) => item.id === cardCopy.boardId) || this.data.boards[0] || null;
      list = board ? board.lists[0] : null;
    }
    if (!board || !list) throw new Error("no list available to restore the card into");
    const card = clone(cardCopy);
    card.boardId = board.id;
    card.listId = list.id;
    this.data.cards[card.id] = card;
    const idx = beforeCardId ? list.cardIds.indexOf(beforeCardId) : -1;
    if (idx === -1) list.cardIds.push(card.id);
    else list.cardIds.splice(idx, 0, card.id);
    try {
      const existing = this.app.vault.getAbstractFileByPath(card.filePath);
      if (fileContent != null && existing) await this.app.vault.modify(existing, fileContent);
      else if (fileContent != null) await this.app.vault.create(card.filePath, fileContent);
      else await this.writeCardFile(card);
      if (fileContent != null) this.diskSignatures.set(card.id, fileContent);
    } catch (error) {
      // The card is restored in data even if the note couldn't be rewritten.
    }
    await this.savePluginData();
    this.refreshViews();
  },

  /**
   * Deletes a global label and removes it from every card and Markdown note.
   * The full label state is captured so the operation remains undoable.
   */
  async deleteLabel(label) {
    const key = labelKey(label);
    if (!key) return false;

    const storedLabel = (this.data.labels || []).find((item) => labelKey(item) === key) || label;
    const affected = Object.values(this.data.cards)
      .filter((card) => (card.labels || []).some((item) => labelKey(item) === key));
    const warning = affected.length
      ? `Delete label "${storedLabel.name}"? It will be removed from ${affected.length} ${affected.length === 1 ? "card" : "cards"}.`
      : `Delete label "${storedLabel.name}"?`;
    if (!await confirmAction(this.app, "Delete label", warning)) return false;

    const previousGlobalLabels = clone(this.data.labels || []);
    const previousCardLabels = affected.map((card) => ({
      cardId: card.id,
      labels: clone(card.labels || []),
    }));

    if (!this.applyingUndo) {
      this.recordUndo(async () => {
        this.data.labels = this.normalizeGlobalLabels(previousGlobalLabels);
        for (const snapshot of previousCardLabels) {
          const card = this.data.cards[snapshot.cardId];
          if (!card) continue;
          card.labels = this.normalizeCardLabels(snapshot.labels);
          await this.writeCardFile(card);
        }
        await this.savePluginData();
        this.refreshViews();
      });
    }

    this.data.labels = (this.data.labels || []).filter((item) => labelKey(item) !== key);
    for (const card of affected) {
      card.labels = (card.labels || []).filter((item) => labelKey(item) !== key);
      card.updatedAt = new Date().toISOString();
      await this.writeCardFile(card);
    }
    await this.savePluginData();
    this.refreshViews();
    return true;
  },

  /**
   * Refreshes a card from its Markdown note before opening the edit modal.
   */
  async hydrateCardFromFile(card) {
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file || file.extension !== "md") return;

    const markdown = await this.app.vault.read(file);
    const parsed = parseCardMarkdown(markdown);
    card.title = parsed.title || card.title;
    card.labels = parsed.labels.length ? this.normalizeCardLabels(parsed.labels) : this.normalizeCardLabels(card.labels || []);
    if (parsed.assignees !== null) card.assignees = parsed.assignees;
    if (parsed.completed !== null) card.completed = parsed.completed;
    if (parsed.startDate !== null) card.startDate = parsed.startDate;
    if (parsed.dueDate !== null) card.dueDate = parsed.dueDate;
    if (parsed.position !== null) card.position = parsed.position;
    card.details = parsed.details;
    card.checklists = normalizeChecklists(parsed.checklists, []);
    if (parsed.dependencies !== null) card.dependencies = normalizeDependencies(parsed.dependencies);
    this.diskSignatures.set(card.id, markdown);
  },

  async openCardFile(cardId) {
    const card = this.data.cards[cardId];
    if (!card) return;

    await this.writeCardFile(card);
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file) return;

    await this.app.workspace.getLeaf(false).openFile(file);
  },

  cardImageRefs(card) {
    return imageRefsFromMarkdown(card && card.details);
  },

  resolveCardImage(card, ref) {
    const target = typeof ref === "string" ? ref : ref && ref.target;
    if (!target) return null;
    if (/^https?:\/\//i.test(target)) {
      return { src: target, name: target.split("/").pop() || "Image", file: null };
    }

    const sourcePath = (card && card.filePath) || "";
    let file = this.app.vault.getAbstractFileByPath(target);
    if (!file && this.app.metadataCache && this.app.metadataCache.getFirstLinkpathDest) {
      try {
        file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
      } catch (error) {
        file = null;
      }
    }
    if (!file || !isImagePath(file.path || file.name)) return null;
    return { src: this.app.vault.getResourcePath(file), name: file.name, file };
  },
};

module.exports = { cardOpsMethods };
