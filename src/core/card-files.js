const { Notice } = require("obsidian");

// Card note persistence: folder/path bookkeeping, frontmatter/tag assembly,
// the optimistic-concurrency card writer, and the checklist item notes.
const {
  assigneesToFrontmatter,
  cardFileBaseName,
  checklistsToMarkdown,
  cleanColor,
  cleanDate,
  kanuxListTag,
  labelsToFrontmatter,
  parseCardMarkdown,
  serializeDependencies,
  textLine,
} = require("../helpers");

const cardFileMethods = {
  async ensureBoardFolder(board) {
    if (!board) return;
    if (!board.folderPath) board.folderPath = await this.nextBoardFolder(board.name);
    if (!this.app.vault.getAbstractFileByPath(board.folderPath)) {
      await this.app.vault.createFolder(board.folderPath);
    }
  },

  async nextBoardFolder(name, currentPath) {
    const base = cardFileBaseName(name || "Task Board");
    let path = base;
    let index = 2;
    while (path !== currentPath && this.app.vault.getAbstractFileByPath(path)) {
      path = `${base} ${index}`;
      index += 1;
    }
    return path;
  },

  /**
   * Finds a unique path in a board folder, allowing the current path during rename.
   */
  async nextCardPath(title, currentPath, board = null) {
    const targetBoard = board || this.findBoardForCard(Object.values(this.data.cards).find((card) => card.filePath === currentPath)) || this.getBoard();
    if (!targetBoard) return `${cardFileBaseName(title)}.md`;
    await this.ensureBoardFolder(targetBoard);

    // Card notes live in a "cards" subfolder so the board root stays tidy
    // (index + cards/ + attachments/), Trello-like.
    const cardsDir = `${targetBoard.folderPath}/cards`;
    if (!this.app.vault.getAbstractFileByPath(cardsDir)) {
      await this.app.vault.createFolder(cardsDir).catch(() => {});
    }

    const base = cardFileBaseName(title);
    let path = `${cardsDir}/${base}.md`;
    let index = 2;
    while (path !== currentPath && this.app.vault.getAbstractFileByPath(path)) {
      path = `${cardsDir}/${base} ${index}.md`;
      index += 1;
    }
    return path;
  },

  async normalizeCardFilePaths() {
    let changed = false;
    for (const card of Object.values(this.data.cards)) {
      if (await this.normalizeCardFilePath(card)) changed = true;
    }
    return changed;
  },

  async normalizeCardFilePath(card) {
    if (!card || !card.title || !card.filePath) return false;

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file || file.extension !== "md") return false;

    const board = this.findBoardForCard(card);

    // If a DIFFERENT file already sits at this card's plain target and carries THIS
    // card's id, it's the same card that arrived as a create+delete from a sync
    // (which has no rename concept). Adopt it and trash our copy — never bump to
    // "<title> 2.md", which would mint a permanent cross-device duplicate.
    const desired = board && board.folderPath
      ? `${board.folderPath}/cards/${cardFileBaseName(card.title)}.md`
      : `${cardFileBaseName(card.title)}.md`;
    if (desired !== card.filePath) {
      const occupant = this.app.vault.getAbstractFileByPath(desired);
      if (occupant && occupant.path !== card.filePath && occupant.extension === "md") {
        let occId = "";
        try { occId = parseCardMarkdown(await this.app.vault.read(occupant)).id || ""; } catch (error) { occId = ""; }
        if (occId && occId === card.id) {
          await this.app.vault.trash(file, false); // recoverable
          card.filePath = desired;
          return true;
        }
      }
    }

    const nextPath = await this.nextCardPath(card.title, card.filePath, board);
    if (nextPath === card.filePath) return false;

    await this.app.vault.rename(file, nextPath);
    card.filePath = nextPath;
    return true;
  },

  async renameCardFile(card, title) {
    const nextPath = await this.nextCardPath(title, card.filePath, this.findBoardForCard(card));
    if (nextPath === card.filePath) return;

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (file && file.extension === "md") {
      await this.app.vault.rename(file, nextPath);
    }
    card.filePath = nextPath;
  },

  cardWikiLink(card) {
    if (!card || !card.filePath) return "";

    const target = card.filePath.replace(/\.md$/i, "");
    const alias = textLine(card.title || target.split("/").pop()).replace(/[|[\]]/g, " ");
    return `[[${target}|${alias}]]`;
  },

  frontmatterText(value) {
    return JSON.stringify(textLine(value));
  },

  kanuxTag(board, list) {
    if (!board || !list) return "";
    return kanuxListTag(board.name, list.title);
  },

  extractTags(markdown) {
    const frontmatter = String(markdown || "").match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) return [];

    const lines = frontmatter[1].split(/\r?\n/);
    const tags = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^tags:\s*(.*)$/);
      if (!match) continue;

      const value = match[1].trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        value.slice(1, -1).split(",").forEach((part) => tags.push(part.trim().replace(/^["'#]+|["']+$/g, "")));
        break;
      }
      if (value) {
        value.split(/[,\s]+/).forEach((part) => tags.push(part.trim().replace(/^#/, "")));
        break;
      }
      for (let itemIndex = index + 1; itemIndex < lines.length; itemIndex += 1) {
        const item = lines[itemIndex].match(/^\s*-\s*(.+)$/);
        if (!item) break;
        tags.push(item[1].trim().replace(/^["'#]+|["']+$/g, ""));
      }
      break;
    }

    return tags.filter(Boolean);
  },

  async cardTags(card, taskTag) {
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    const existing = file && file.extension === "md" ? this.extractTags(await this.app.vault.read(file)) : [];
    const tags = existing.filter((tag) => !tag.startsWith("kanux/"));
    if (taskTag) tags.push(taskTag);
    return Array.from(new Set(tags));
  },

  tagFrontmatter(tags) {
    if (!tags.length) return "tags: []";
    return `tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`;
  },

  async writeCardsForList(list) {
    for (const cardId of list.cardIds) {
      const card = this.data.cards[cardId];
      if (card) await this.writeCardFile(card);
    }
  },

  // Rewrite the .md of every card in a list so their `position` frontmatter
  // matches the list's current order.
  async writeListCardFiles(list) {
    for (const id of list.cardIds) {
      const c = this.data.cards[id];
      if (c) await this.writeCardFile(c);
    }
  },

  async writeBoardCardFiles(board) {
    const cards = Object.values(this.data.cards).filter((card) => card.boardId === board.id);
    for (const card of cards) await this.writeCardFile(card);
  },

  async writeAllCardFiles() {
    for (const card of Object.values(this.data.cards)) {
      await this.writeCardFile(card, { bulk: true });
    }
  },

  /**
   * Writes the card note used by both Obsidian and Kanux.
   *
   * Frontmatter stores board metadata. The Details and Checklist sections stay
   * as normal Markdown so users can edit card content directly in the vault.
   */
  async writeCardFile(card, options = {}) {
    const board = this.findBoardForCard(card);
    if (board) card.boardId = board.id;
    await this.ensureBoardFolder(board);
    const list = this.findList(card.listId, board);
    const tags = await this.cardTags(card, this.kanuxTag(board, list));
    // Position within the list, from the live cardIds order. This is the ONLY
    // place card order is persisted to a synced file (data.json order does not
    // sync), so the other device can restore the same order.
    const position = list ? list.cardIds.indexOf(card.id) : -1;

    const markdown = [
      "---",
      `kanban-card-id: ${card.id}`,
      `kanban-board-id: ${card.boardId || ""}`,
      `kanban-list-id: ${card.listId || ""}`,
      `position: ${position >= 0 ? position : 0}`,
      this.tagFrontmatter(tags),
      `kanux-board: ${this.frontmatterText(board && board.name)}`,
      `kanux-list: ${this.frontmatterText(list && list.title)}`,
      `kanux-list-color: ${this.frontmatterText(cleanColor(list && list.color))}`,
      `labels: ${labelsToFrontmatter(card.labels)}`,
      `assignees: ${assigneesToFrontmatter(card.assignees)}`,
      `depends-on: ${serializeDependencies(card.dependencies)}`,
      `completed: ${card.completed ? "true" : "false"}`,
      `start: ${cleanDate(card.startDate)}`,
      `due: ${cleanDate(card.dueDate)}`,
      "---",
      "",
      `# ${textLine(card.title)}`,
      "",
      "## Details",
      card.details || "",
      "",
      "## Checklist",
      checklistsToMarkdown(card.checklists),
      "",
    ].join("\n");

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file || file.extension !== "md") {
      await this.app.vault.create(card.filePath, markdown);
      this.diskSignatures.set(card.id, markdown);
      return;
    }

    let current = null;
    try { current = await this.app.vault.read(file); } catch (error) { current = null; }

    // Already byte-identical: don't touch the file. Avoids a pointless mtime bump
    // that would make the sync push a needless copy.
    if (current === markdown) return;

    // The file changed on disk since we last read it — e.g. a sync just delivered
    // a newer note from another device (checklist assignees, labels, details…).
    // NEVER overwrite it with our possibly-stale in-memory card.
    const seen = this.diskSignatures.get(card.id);
    const changedUnderUs = current !== null && seen !== undefined && current !== seen;
    // A bulk rewrite must not blind-overwrite a file we never read this session:
    // we have no baseline, so we can't tell our memory from a fresh delivery.
    // (A user-initiated write still lands — dropping it would lose their edit.)
    const unknownDisk = options.bulk && current !== null && seen === undefined;

    if (changedUnderUs || unknownDisk) {
      this.diskSignatures.set(card.id, current);
      this.pendingResync = true;
      // Don't let a user's edit vanish silently; the resync below repaints the
      // board with what's actually on disk.
      if (!options.bulk && changedUnderUs) {
        new Notice("This card changed elsewhere — your edit wasn't saved. Reopen it to see the latest.");
      }
      this.queueResync();
      return;
    }

    await this.app.vault.modify(file, markdown);
    this.diskSignatures.set(card.id, markdown);
  },

  resolveChecklistItemFile(card, item) {
    const filePath = textLine(item && item.filePath);
    if (!filePath) return null;
    let file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file && this.app.metadataCache && this.app.metadataCache.getFirstLinkpathDest) {
      try {
        file = this.app.metadataCache.getFirstLinkpathDest(filePath.replace(/\.md$/i, ""), (card && card.filePath) || "");
      } catch (error) {
        file = null;
      }
    }
    return file && file.extension === "md" ? file : null;
  },

  async ensureChecklistItemFile(card, item) {
    const existing = this.resolveChecklistItemFile(card, item);
    if (existing) return existing;

    const board = this.findBoardForCard(card);
    if (!board) throw new Error("no board available for checklist item note");
    await this.ensureBoardFolder(board);
    const folder = this.checklistItemsFolder(board);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder).catch(() => {});
    }

    const base = cardFileBaseName((item && item.text) || "Checklist item");
    let path = `${folder}/${base}.md`;
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = `${folder}/${base} ${index}.md`;
      index += 1;
    }

    const markdown = [
      "---",
      "kanux-checklist-item: true",
      `kanux-card-id: ${card.id}`,
      "---",
      "",
      `# ${textLine(item && item.text) || "Checklist item"}`,
      "",
      `Card: ${this.cardWikiLink(card)}`,
      "",
    ].join("\n");
    return this.app.vault.create(path, markdown);
  },

  async openChecklistItemFile(filePath) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || file.extension !== "md") return;
    await this.app.workspace.getLeaf(false).openFile(file);
  },

  async deleteChecklistItemFile(card, item) {
    const file = this.resolveChecklistItemFile(card, item);
    if (!file) return;
    await this.app.vault.trash(file, true);
  },

  async deleteChecklistItemFiles(card, items) {
    for (const item of Array.isArray(items) ? items : []) {
      if (item && item.filePath) await this.deleteChecklistItemFile(card, item);
    }
  },
};

module.exports = { cardFileMethods };
