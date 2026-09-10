// Generated board index files: the per-board Markdown index that links every
// card (keeping the graph connected), carries the synced list structure, and
// lets a board be adopted on another device.
const {
  BOARD_INDEX_MARKER,
  LEGACY_BOARD_INDEX_SUFFIX,
  cardFileBaseName,
  cleanColor,
  decodeListMeta,
  encodeListMeta,
  parseCardMarkdown,
  textLine,
  uid,
} = require("../helpers");

const boardIndexMethods = {
  boardIndexPath(board) {
    const name = cardFileBaseName(board.name || (board.folderPath || "").split("/").pop() || "Board");
    return `${board.folderPath}/${name}.md`;
  },

  legacyBoardIndexPath(board) {
    return `${board.folderPath}/${LEGACY_BOARD_INDEX_SUFFIX}`;
  },

  isPotentialBoardIndexFile(file) {
    if (!file || file.extension !== "md" || !file.path.includes("/")) return false;
    if (file.name === LEGACY_BOARD_INDEX_SUFFIX) return true;
    const parts = file.path.split("/");
    const parent = parts[parts.length - 2];
    return file.basename === parent || file.basename.endsWith(" Board");
  },

  async isGeneratedBoardIndexFile(file, markdown = null) {
    if (!this.isPotentialBoardIndexFile(file)) return false;
    const text = markdown === null ? await this.app.vault.read(file) : markdown;
    return text.includes("kanux-board: true") || text.includes(BOARD_INDEX_MARKER);
  },

  isBoardIndexFile(file) {
    return !!(file && file.path && file.extension === "md"
      && this.data.boards.some((board) => file.path === this.boardIndexPath(board) || file.path === this.legacyBoardIndexPath(board)));
  },

  async restoreBoardsFromIndexFiles() {
    const knownFolders = new Set(this.data.boards.map((board) => board.folderPath).filter(Boolean));
    const indexFiles = this.app.vault.getMarkdownFiles().filter((file) => this.isPotentialBoardIndexFile(file));
    let changed = false;

    for (const indexFile of indexFiles) {
      const markdown = await this.app.vault.read(indexFile);
      if (!(await this.isGeneratedBoardIndexFile(indexFile, markdown))) continue;

      const folderPath = indexFile.path.split("/").slice(0, -1).join("/");
      if (!folderPath || knownFolders.has(folderPath)) continue;

      const explicitIndex = markdown.includes("kanux-board: true");
      const heading = markdown.match(/^#\s+(.+?)(?:\s+Board)?\s*$/m);
      const board = {
        id: uid("board"),
        name: textLine(heading && heading[1]) || folderPath.split("/").pop(),
        folderPath,
        lists: [],
      };
      // The index frontmatter carries the board's real id. Prefer it so a board
      // adopted from a synced index keeps the SAME id on every device — including
      // a board that has lists but no cards yet. Without this the adopter mints a
      // fresh uid, and since each device then regenerates the index with its own
      // id, the two devices rewrite the id back and forth on every sync forever.
      // (A card's kanban-board-id below agrees, and is the fallback for legacy
      // indexes written before this frontmatter line existed.)
      const fmBoardId = markdown.match(/^kanux-board-id:\s*(.+?)\s*$/m);
      if (fmBoardId && textLine(fmBoardId[1])) board.id = textLine(fmBoardId[1]);
      const listsById = new Map();
      // Build the list structure from the synced metadata (correct ids/titles/
      // colors/order) so a board discovered here matches other devices; cards
      // then attach by their list id below. Legacy indexes (no meta) keep the
      // old heading/card-derived reconstruction.
      const listMeta = decodeListMeta(markdown);
      const metaLists = listMeta && Array.isArray(listMeta.lists) ? listMeta.lists : null;
      const metaTombstones = new Set(listMeta && Array.isArray(listMeta.deleted) ? listMeta.deleted : []);
      board.deletedListIds = Array.from(metaTombstones);
      if (metaLists && metaLists.length) {
        for (const entry of metaLists) {
          if (!entry || !entry.i || listsById.has(entry.i) || metaTombstones.has(entry.i)) continue;
          const list = { id: entry.i, title: entry.t || "List", color: cleanColor(entry.c) || this.defaultListColor(board.lists.length), cardIds: [] };
          listsById.set(entry.i, list);
          board.lists.push(list);
        }
      }
      const sectionMatches = Array.from(markdown.matchAll(/^##\s+(.+)$/gm));
      let restoredCards = 0;

      for (let index = 0; index < sectionMatches.length; index += 1) {
        const match = sectionMatches[index];
        const next = sectionMatches[index + 1];
        const title = textLine(match[1]) || "Untitled list";
        const body = markdown.slice(match.index + match[0].length, next ? next.index : markdown.length);
        const links = Array.from(body.matchAll(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g));
        const fallbackList = { id: uid("list"), title, color: this.defaultListColor(board.lists.length), cardIds: [] };
        const listCountBefore = board.lists.length;

        for (const link of links) {
          const target = link[1].endsWith(".md") ? link[1] : `${link[1]}.md`;
          const cardFile = this.app.vault.getAbstractFileByPath(target);
          if (!cardFile || cardFile.extension !== "md") continue;

          const parsed = parseCardMarkdown(await this.app.vault.read(cardFile));
          if (parsed.boardId) board.id = parsed.boardId;
          const listId = parsed.listId || uid("list");
          // With metadata present, NEVER create a list from a card link — the
          // meta is authoritative, and a card with a divergent list id must not
          // spawn a duplicate. It falls back to a real list on card import.
          if (!metaLists && !listsById.has(listId)) {
            const list = { id: listId, title, color: this.defaultListColor(board.lists.length), cardIds: [] };
            listsById.set(listId, list);
            board.lists.push(list);
          }
          restoredCards += 1;
        }

        if (!metaLists && explicitIndex && board.lists.length === listCountBefore) board.lists.push(fallbackList);
      }

      if (!explicitIndex && !restoredCards && !(metaLists && metaLists.length)) continue;
      this.data.boards.push(board);
      knownFolders.add(folderPath);
      changed = true;
    }

    return changed;
  },

  removeBoardIndexCards() {
    const indexPaths = new Set();
    this.data.boards.forEach((board) => {
      indexPaths.add(this.boardIndexPath(board));
      indexPaths.add(this.legacyBoardIndexPath(board));
    });

    let changed = false;
    Object.values(this.data.cards).forEach((card) => {
      if (!indexPaths.has(card.filePath)) return;
      delete this.data.cards[card.id];
      changed = true;
    });
    if (!changed) return false;

    this.data.boards.forEach((board) => {
      board.lists.forEach((list) => {
        list.cardIds = list.cardIds.filter((cardId) => this.data.cards[cardId]);
      });
    });
    return true;
  },

  /**
   * Keeps card notes connected in Obsidian's graph without adding extra text to
   * every card file.
   */
  async writeBoardIndexFiles(options = {}) {
    for (const board of this.data.boards) {
      await this.writeBoardIndexFile(board, options);
    }
    await this.cleanupOrphanBoardIndexFiles();
    this.updateExplorerColors();
  },

  // Adopt a KNOWN board's list structure (ids/titles/colours/order + deleted-list
  // tombstones) from an index file that changed on disk under us — used when a
  // newer index arrived (e.g. Sync Deck pulled it) so we DON'T revert it. Cards
  // re-attach to their lists by frontmatter on the next folder sync.
  importListStructureFromIndex(board, markdown) {
    const listMeta = decodeListMeta(markdown);
    const metaLists = listMeta && Array.isArray(listMeta.lists) ? listMeta.lists : null;
    if (!metaLists || !metaLists.length) return false;
    const tombstones = new Set(listMeta && Array.isArray(listMeta.deleted) ? listMeta.deleted : []);
    const existingById = new Map(board.lists.map((list) => [list.id, list]));
    const next = [];
    metaLists.forEach((entry, index) => {
      if (!entry || !entry.i || tombstones.has(entry.i)) return;
      const existing = existingById.get(entry.i);
      next.push({
        id: entry.i,
        title: entry.t || (existing && existing.title) || "List",
        color: cleanColor(entry.c) || (existing && existing.color) || this.defaultListColor(index),
        cardIds: existing ? existing.cardIds : [],
      });
    });
    if (!next.length) return false;
    board.lists = next;
    board.deletedListIds = Array.from(tombstones);
    return true;
  },

  async writeBoardIndexFile(board, options = {}) {
    if (!board) return;
    await this.ensureBoardFolder(board);

    const lines = [
      "---",
      "kanux-board: true",
      `kanux-board-id: ${board.id}`,
      "---",
      "",
      `# ${textLine(board.name)}`,
      "",
      BOARD_INDEX_MARKER,
      // Machine-readable list structure (id/title/color/order) + deleted-list
      // tombstones so lists sync (incl. deletion) across devices. Invisible in
      // preview; the headings below stay readable.
      `<!--kanux-lists:${encodeListMeta(board.lists, board.deletedListIds)}-->`,
      "",
    ];

    board.lists.forEach((list) => {
      lines.push(`## ${textLine(list.title) || "Untitled list"}`, "");
      const cards = list.cardIds.map((cardId) => this.data.cards[cardId]).filter(Boolean);
      if (cards.length) {
        cards.forEach((card) => lines.push(`- ${this.cardWikiLink(card)}`));
      } else {
        lines.push("- No cards");
      }
      lines.push("");
    });

    const markdown = lines.join("\n");
    const file = this.app.vault.getAbstractFileByPath(this.boardIndexPath(board));
    if (!file || file.extension !== "md") {
      if (!file) {
        await this.app.vault.create(this.boardIndexPath(board), markdown);
        this.indexSignatures.set(board.id, markdown);
      }
      await this.cleanupBoardIndexFiles(board);
      return;
    }

    let current = null;
    try { current = await this.app.vault.read(file); } catch (error) { current = null; }
    // Identical already — record the signature and stop (rewriting it would just
    // churn the index back and forth between devices).
    if (current === markdown) {
      this.indexSignatures.set(board.id, markdown);
      await this.cleanupBoardIndexFiles(board);
      return;
    }

    // Optimistic concurrency (mirrors writeCardFile): NEVER overwrite an index
    // that changed on disk under us — that stale rewrite is exactly what reverted
    // everyone's board on open (a Sync Deck pull delivers a newer index, and our
    // startup regenerate-from-stale-data.json used to clobber it and re-upload the
    // revert). Instead adopt the newer structure and re-import; only write when
    // the on-disk index is the one WE last touched.
    const seen = this.indexSignatures.get(board.id);
    const changedUnderUs = current !== null && seen !== undefined && current !== seen;
    const unknownDisk = options.bulk && current !== null && seen === undefined;
    if (changedUnderUs || unknownDisk) {
      this.indexSignatures.set(board.id, current);
      if (this.importListStructureFromIndex(board, current)) {
        this.pendingResync = true;
        this.queueResync();
      }
      await this.cleanupBoardIndexFiles(board);
      return;
    }

    await this.app.vault.modify(file, markdown);
    this.indexSignatures.set(board.id, markdown);
    await this.cleanupBoardIndexFiles(board);
  },

  async cleanupBoardIndexFiles(board) {
    const currentPath = this.boardIndexPath(board);
    const files = this.app.vault.getMarkdownFiles().filter((file) => {
      return file.path.startsWith(`${board.folderPath}/`) && file.path !== currentPath;
    });

    for (const file of files) {
      if (await this.isGeneratedBoardIndexFile(file)) await this.app.vault.trash(file, true);
    }
  },

  async cleanupOrphanBoardIndexFiles() {
    // A generated board index whose folder has no board in THIS device's
    // data.json is almost always a board just delivered by sync that we haven't
    // imported yet — NOT junk. We used to trash it here, which was catastrophic:
    // it destroyed the only cross-device carrier of the board's definition, and
    // because Sync Deck propagates local deletes, that delete flowed back to the
    // server and every other device — leaving the board's cards behind as an
    // invisible, board-less folder everywhere. (restoreBoardsFromIndexFiles only
    // runs in the one-time reconcile, so an index that syncs in later, or a
    // savePluginData that races ahead of the reconcile, hit this cleanup first.)
    //
    // Adopt the orphan instead: restore the board from its index. It reuses the
    // board id from the cards, so the adopted board matches other devices. A real
    // board deletion removes the folder + index explicitly and propagates, so
    // nothing legitimately orphaned lingers here for us to clean.
    const activeFolders = new Set(this.data.boards.map((board) => board.folderPath).filter(Boolean));
    const orphanGenerated = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isPotentialBoardIndexFile(file)) continue;
      const folderPath = file.path.split("/").slice(0, -1).join("/");
      if (activeFolders.has(folderPath)) continue;
      if (await this.isGeneratedBoardIndexFile(file)) orphanGenerated.push(file);
    }
    if (!orphanGenerated.length) return;

    const restored = await this.restoreBoardsFromIndexFiles();
    if (restored) {
      await this.saveData(this.data);
      this.refreshViews();
    }
  },
};

module.exports = { boardIndexMethods };
