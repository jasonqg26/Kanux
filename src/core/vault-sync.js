// Vault reconciliation: importing card notes from disk, reacting to vault
// events, pruning boards/cards whose files vanished, de-duplicating synced
// card files, and the one-time media layout migration.
const {
  cleanColor,
  cleanDate,
  decodeListMeta,
  normalizeChecklists,
  normalizeDependencies,
  parseCardMarkdown,
  uid,
} = require("../helpers");

const vaultSyncMethods = {
  /**
   * Heavy vault reconciliation: import card notes, restore boards from index
   * files, and rewrite files. Deferred to onLayoutReady and guarded so a startup
   * file error can never reject onload() — which would disable the plugin and
   * force a manual re-enable on every restart. The `reconciling` flag stops our
   * own writes here from re-triggering the folder-sync event handler.
   */
  async reconcileVaultFiles() {
    this.reconciling = true;
    try {
      const restored = await this.restoreBoardsFromIndexFiles();
      // A Sync Deck vault switch trashes the PREVIOUS vault's board folders, but
      // our per-device data.json still lists those boards. Drop any whose folder
      // is gone from disk BEFORE the writes below — otherwise writeBoardIndexFiles
      // re-creates their folders + indexes in the vault we just switched into, so
      // every switch bled the old vault's Kanux folders into the new one and
      // the user had to delete them by hand. (adopt just above re-added the boards
      // that DO have a folder here, so this only removes truly-vanished ones.)
      const prunedVanished = this.pruneVanishedBoards();
      const removedIndexCards = this.removeBoardIndexCards();
      this.data.activeBoardId = this.findBoard(this.data.activeBoardId)
        ? this.data.activeBoardId
        : (this.data.boards[0] && this.data.boards[0].id) || "";
      // Collapse any same-id duplicate card files (e.g. a sync split a move into
      // create+delete) BEFORE renaming, so a duplicate can't cause a name bump.
      const deduped = await this.dedupeCardFilesById();
      const renamed = await this.normalizeCardFilePaths();
      await this.syncCardsFromFolder();
      // One-time media tidy-up: move loose images/videos into <board>/attachments
      // and fix their card links. Runs after the folder sync (so details are
      // current) and before writeAllCardFiles (so the fixes get persisted).
      const migratedLayout = !this.data.layoutMigrated;
      if (migratedLayout) {
        await this.migrateExistingMedia();
        this.data.layoutMigrated = true;
      }
      await this.writeAllCardFiles();
      // bulk: the startup pass must not overwrite an index that's newer on disk
      // than our (possibly stale) data.json — adopt it instead of reverting it.
      await this.writeBoardIndexFiles({ bulk: true });
      await this.syncGraphColorGroups();
      this.updateExplorerColors();
      if (restored || prunedVanished || renamed || deduped || migratedLayout || this.loadNeedsSave || removedIndexCards) await this.saveData(this.data);
    } finally {
      this.reconciling = false;
    }

    // A write was skipped because the note on disk was newer than our memory
    // (a sync delivered it mid-reconcile, and its event was swallowed while
    // `reconciling`). Import it now that events flow again.
    if (this.pendingResync) {
      this.pendingResync = false;
      try {
        await this.syncCardsFromFolder();
        await this.saveData(this.data);
      } catch (error) {
        console.error("Kanux: post-reconcile resync failed", error);
      }
    }
    this.refreshViews();
  },

  isCardFile(file) {
    return !!this.boardForFile(file);
  },

  boardForFile(file) {
    if (!file || !file.path || file.extension !== "md") return null;
    return this.data.boards.find((board) => {
      return board.folderPath
        && file.path.startsWith(`${board.folderPath}/`)
        && !this.isChecklistItemPath(file.path, board)
        && file.path !== this.boardIndexPath(board)
        && file.path !== this.legacyBoardIndexPath(board);
    }) || null;
  },

  checklistItemsFolder(board) {
    return board && board.folderPath ? `${board.folderPath}/checklist-items` : "";
  },

  isChecklistItemPath(path, board) {
    const folder = this.checklistItemsFolder(board);
    return !!(folder && path && String(path).startsWith(`${folder}/`));
  },

  isBoardFolder(file) {
    return !!(file && file.path && this.data.boards.some((board) => board.folderPath === file.path));
  },

  /**
   * Re-import card notes from disk shortly after a write was skipped (or an event
   * was held back while a modal was open), so memory converges on what's actually
   * on disk. Waits until nothing is reconciling / being edited.
   */
  queueResync() {
    window.clearTimeout(this.resyncTimer);
    this.resyncTimer = window.setTimeout(async () => {
      if (this.reconciling || this.editingCardId) {
        this.queueResync(); // still busy — try again shortly
        return;
      }
      if (!this.pendingResync) return;
      this.pendingResync = false;
      try {
        await this.syncCardsFromFolder();
        await this.saveData(this.data);
      } catch (error) {
        console.error("Kanux: resync failed", error);
      }
      this.refreshViews();
    }, 1500);
  },

  /**
   * Debounces vault events so a save/rename burst only triggers one rescan.
   */
  queueCardFolderSync(file, eventName) {
    // Ignore the writes our own startup reconcile makes; it re-imports at the end.
    if (this.reconciling) return;
    // Never re-import (and never advance a card's disk signature) while a card
    // modal is open — the modal holds its own copy, so importing underneath it
    // would let its next save overwrite whatever just arrived. Catch up after.
    if (this.editingCardId) {
      this.pendingResync = true;
      this.queueResync();
      return;
    }
    // Also re-sync when the board INDEX file changes, so a list add/rename/reorder
    // made on another device (which only edits the index) is picked up here.
    if (!this.isCardFile(file) && !this.isBoardFolder(file) && !this.isBoardIndexFile(file)) return;

    // Accumulate deletes across the debounce window. A single timer keyed to the
    // LAST event would drop every delete but one in a multi-file delete burst
    // (e.g. deleting a board folder with many cards, or a pull that removes
    // several), leaving stale cards that writeAllCardFiles later resurrects.
    if (eventName === "delete") {
      this.pendingCardDeletes = this.pendingCardDeletes || [];
      this.pendingCardDeletes.push(file);
    }

    window.clearTimeout(this.cardFolderSyncTimer);
    this.cardFolderSyncTimer = window.setTimeout(async () => {
      const deletes = this.pendingCardDeletes || [];
      this.pendingCardDeletes = [];
      let changed = false;
      for (const deleted of deletes) {
        if (this.removeDeletedBoardFolder(deleted)) { changed = true; continue; } // whole board folder gone
        if (this.removeDeletedBoardIndex(deleted)) { changed = true; continue; }  // board's index gone -> deleted elsewhere
        if (this.removeDeletedCardFile(deleted)) changed = true;
      }
      // Persist ONCE, after every deleted board/card is pruned. Saving per item
      // ran writeBoardIndexFiles mid-loop, which re-created (via ensureBoardFolder)
      // the folder of a board still queued for deletion — so a vault switch that
      // trashes several board folders at once bled the old vault's Kanux
      // folders into the new one (the user had to delete them by hand).
      if (changed) await this.savePluginData();
      await this.syncCardsFromFolder();
      this.refreshViews();
    }, 250);
  },

  // Drop every board matching `predicate` and orphan-clean their cards. Returns
  // true if anything was removed.
  pruneBoardsMatching(predicate) {
    const removedBoardIds = new Set();
    this.data.boards = this.data.boards.filter((board) => {
      if (!predicate(board)) return true;
      removedBoardIds.add(board.id);
      return false;
    });
    if (!removedBoardIds.size) return false;

    Object.keys(this.data.cards).forEach((cardId) => {
      if (removedBoardIds.has(this.data.cards[cardId].boardId)) delete this.data.cards[cardId];
    });
    this.data.boards.forEach((board) => {
      board.lists.forEach((list) => {
        list.cardIds = list.cardIds.filter((cardId) => this.data.cards[cardId]);
      });
    });
    if (!this.findBoard(this.data.activeBoardId)) {
      this.data.activeBoardId = (this.data.boards[0] && this.data.boards[0].id) || "";
    }
    return true;
  },

  // Drop boards whose folder no longer exists on disk — they belong to a Sync
  // Deck vault we've switched away from. Safe because createBoard writes a board's
  // folder BEFORE its first save, so a board with no folder on disk was removed
  // externally (a switch, or a delete on another device), never a pending new one.
  pruneVanishedBoards() {
    return this.pruneBoardsMatching((board) =>
      !!board.folderPath && !this.app.vault.getAbstractFileByPath(board.folderPath));
  },

  removeDeletedBoardFolder(deletedFile) {
    const deletedPath = deletedFile && deletedFile.path;
    if (!deletedPath) return false;
    return this.pruneBoardsMatching((board) => board.folderPath === deletedPath);
  },

  // When a board's generated INDEX file is deleted, the board is gone — drop it.
  // This is the symmetric counterpart to restoreBoardsFromIndexFiles (adopt on an
  // index appearing): without it, a board deleted on one device is re-created here
  // from our own data.json and its index re-uploaded, resurrecting it for everyone
  // (Sync Deck delivers the deletion as an index-file delete, not a folder delete
  // — the emptied folder may not even be removed yet).
  //
  // Keyed ONLY on the CURRENT boardIndexPath — deliberately NOT the legacy path.
  // A board's live index is always the current path (writeBoardIndexFile writes it
  // there and cleanupBoardIndexFiles trashes the legacy `Kanux Board.md`
  // during an unguarded save); matching the legacy path here would let that
  // self-generated cleanup delete prune a live board. A genuine deletion still
  // trashes the current index (and the folder, caught by removeDeletedBoardFolder),
  // so no real deletion is missed. A rename's stale-index cleanup is at the old
  // path, and a user's own UI delete already removed the board — neither matches.
  removeDeletedBoardIndex(deletedFile) {
    const deletedPath = deletedFile && deletedFile.path;
    if (!deletedPath) return false;
    return this.pruneBoardsMatching((board) => this.boardIndexPath(board) === deletedPath);
  },

  // In-memory only (no save) so a burst of deletes can be pruned together and
  // persisted ONCE — see the delete loop in queueCardFolderSync.
  removeDeletedCardFile(file) {
    const deletedPath = file && file.path;
    if (!deletedPath) return false;
    const card = Object.values(this.data.cards).find((item) => item.filePath === deletedPath);
    if (!card) return false;

    const board = this.findBoard(card.boardId);
    if (board) {
      board.lists.forEach((list) => {
        list.cardIds = list.cardIds.filter((cardId) => cardId !== card.id);
      });
    }
    delete this.data.cards[card.id];
    return true;
  },

  async syncCardsFromFolder(board = null) {
    const restored = board ? false : await this.restoreBoardsFromIndexFiles();
    if (restored) {
      this.ensureListColors();
      if (!this.findBoard(this.data.activeBoardId)) {
        this.data.activeBoardId = (this.data.boards[0] && this.data.boards[0].id) || "";
      }
    }

    const boards = board ? [board] : this.data.boards;
    for (const item of boards) {
      await this.syncBoardCardsFromFolder(item);
    }

    if (restored) {
      await this.savePluginData();
    }
  },

  // Heal boards corrupted by an earlier bug that created a list titled with the
  // raw QUOTED frontmatter value (e.g. `"Todo"`) when a card's list id didn't
  // match. A real list title never has surrounding quotes, so such a list is
  // always spurious: merge its cards into the real same-named list (moving, not
  // deleting) and drop it; if there is no match, just strip the quotes.
  healQuotedDuplicateLists(board) {
    if (!board || !Array.isArray(board.lists)) return false;
    const isQuoted = (t) => /^".*"$|^'.*'$/.test(String(t == null ? "" : t).trim());
    const norm = (t) => String(t == null ? "" : t).replace(/^["']+|["']+$/g, "").trim().toLowerCase();
    let changed = false;
    for (const dup of board.lists.filter((l) => isQuoted(l.title))) {
      const target = board.lists.find((l) => l !== dup && !isQuoted(l.title) && norm(l.title) === norm(dup.title));
      if (target) {
        for (const cardId of dup.cardIds) {
          if (!target.cardIds.includes(cardId)) target.cardIds.push(cardId);
          const card = this.data.cards[cardId];
          if (card) card.listId = target.id;
        }
        board.lists = board.lists.filter((l) => l !== dup);
        changed = true;
      } else {
        dup.title = norm(dup.title) ? dup.title.replace(/^["']+|["']+$/g, "").trim() : dup.title;
        changed = true;
      }
    }
    return changed;
  },

  // Sync the board's list STRUCTURE from the index file (which carries list
  // id/title/color/order and syncs across devices): add lists present in the
  // index but missing here, update titles/colors, and apply the index order.
  // Conservative — it NEVER drops a list, so a device's own not-yet-synced lists
  // (and any list a delete didn't propagate) are kept, appended after the index
  // order. No list or its cards can be lost. Returns true if anything changed.
  async reconcileListsFromIndex(board) {
    if (!board || !Array.isArray(board.lists)) return false;
    const indexFile = this.app.vault.getAbstractFileByPath(this.boardIndexPath(board));
    if (!indexFile || indexFile.extension !== "md") return false;
    let markdown;
    try { markdown = await this.app.vault.read(indexFile); } catch (error) { return false; }
    const meta = decodeListMeta(markdown);
    if (!meta || !Array.isArray(meta.lists) || !meta.lists.length) return false;

    board.deletedListIds = Array.isArray(board.deletedListIds) ? board.deletedListIds : [];
    const tombstones = new Set([...board.deletedListIds, ...meta.deleted]);

    const byId = new Map(board.lists.map((l) => [l.id, l]));
    const ordered = [];
    const used = new Set();
    let changed = false;
    for (const entry of meta.lists) {
      if (!entry || !entry.i || used.has(entry.i) || tombstones.has(entry.i)) continue;
      used.add(entry.i);
      let list = byId.get(entry.i);
      if (list) {
        if (entry.t != null && list.title !== entry.t) { list.title = entry.t; changed = true; }
        const color = cleanColor(entry.c);
        if (color && list.color !== color) { list.color = color; changed = true; }
      } else {
        list = { id: entry.i, title: entry.t || "List", color: cleanColor(entry.c) || this.defaultListColor(ordered.length), cardIds: [] };
        changed = true;
      }
      ordered.push(list);
    }
    // Keep this device's own not-yet-synced lists; DROP a list deleted elsewhere.
    for (const list of board.lists) {
      if (used.has(list.id)) continue;
      if (tombstones.has(list.id)) { changed = true; continue; }
      ordered.push(list);
      used.add(list.id);
    }
    // Merge tombstone sets so deletion converges and no list resurrects. Sorted
    // so the persisted/encoded set is order-independent across devices.
    const merged = Array.from(tombstones).sort().slice(-200);
    if (merged.join("|") !== board.deletedListIds.join("|")) { board.deletedListIds = merged; changed = true; }

    const orderChanged = board.lists.map((l) => l.id).join("") !== ordered.map((l) => l.id).join("");
    if (changed || orderChanged) {
      board.lists = ordered;
      return true;
    }
    return false;
  },

  /**
   * Imports Markdown files from a board folder into that board.
   */
  async syncBoardCardsFromFolder(board) {
    if (!board || !board.folderPath) return;
    let changed = false;
    if (this.healQuotedDuplicateLists(board)) changed = true;
    if (await this.reconcileListsFromIndex(board)) changed = true;
    const files = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${board.folderPath}/`)) continue;
      if (this.isChecklistItemPath(file.path, board)) continue;
      if (file.path === this.boardIndexPath(board) || file.path === this.legacyBoardIndexPath(board)) continue;
      if (await this.isGeneratedBoardIndexFile(file)) continue;
      files.push(file);
    }
    if (!files.length) {
      if (changed) await this.savePluginData();
      return;
    }
    if (!board.lists.length) board.lists.push({ id: uid("list"), title: "TODO", cardIds: [] });

    for (const file of files) {
      const markdown = await this.app.vault.read(file);
      const parsed = parseCardMarkdown(markdown);
      const existingByPath = Object.values(this.data.cards).find((card) => card.filePath === file.path);
      const cardId = parsed.id || (existingByPath && existingByPath.id) || uid("card");
      const existing = this.data.cards[cardId] || existingByPath;
      // Resolve the card's list from its frontmatter id, falling back to the list
      // it is already in on this device, then the first list. We do NOT create a
      // new list from a mismatching id — list ids can differ between devices, and
      // creating one produces a duplicate list.
      const targetList = this.findList(parsed.listId, board) || this.findList(existing && existing.listId, board) || board.lists[0];
      const now = new Date().toISOString();
      const card = existing || { id: cardId, createdAt: now };

      Object.assign(card, {
        id: card.id || cardId,
        boardId: board.id,
        title: parsed.title || file.basename,
        listId: targetList.id,
        position: parsed.position !== null ? parsed.position : (card.position != null ? card.position : 0),
        labels: parsed.labels.length ? this.normalizeCardLabels(parsed.labels) : this.normalizeCardLabels(card.labels || []),
        assignees: this.normalizeAssignees(parsed.assignees !== null ? parsed.assignees : card.assignees || []),
        details: parsed.details,
        checklists: normalizeChecklists(parsed.checklists, []),
        dependencies: normalizeDependencies(parsed.dependencies !== null ? parsed.dependencies : card.dependencies),
        completed: parsed.completed !== null ? parsed.completed : !!card.completed,
        startDate: parsed.startDate !== null ? parsed.startDate : cleanDate(card.startDate),
        dueDate: parsed.dueDate !== null ? parsed.dueDate : cleanDate(card.dueDate),
        filePath: file.path,
        updatedAt: card.updatedAt || now,
      });
      // Remember exactly what this card's file looked like on disk, so a later
      // writeCardFile can tell "nothing changed" from "someone else changed it".
      this.diskSignatures.set(card.id, markdown);

      if (await this.normalizeCardFilePath(card)) changed = true;

      if (!this.data.cards[card.id]) {
        this.data.cards[card.id] = card;
        changed = true;
      }

      const currentList = this.findListByCard(card.id, board);
      if (currentList && currentList.id !== targetList.id) {
        currentList.cardIds = currentList.cardIds.filter((id) => id !== card.id);
      }
      if (!targetList.cardIds.includes(card.id)) {
        targetList.cardIds.push(card.id);
        changed = true;
      }
    }

    // Restore each list's order from the synced `position` frontmatter. Stable
    // sort, so cards that share a position (e.g. legacy files with no position)
    // keep their relative order. Only flags changed when the order actually moved.
    board.lists.forEach((list) => {
      const before = list.cardIds.join(",");
      list.cardIds.sort((a, b) => {
        const ca = this.data.cards[a];
        const cb = this.data.cards[b];
        const pa = ca && ca.position != null ? ca.position : 0;
        const pb = cb && cb.position != null ? cb.position : 0;
        return pa - pb;
      });
      if (list.cardIds.join(",") !== before) changed = true;
    });

    if (changed) await this.savePluginData();
  },

  /**
   * Two card files sharing one kanban-card-id are the SAME card — e.g. a move
   * that Sync Deck (a generic file syncer with no rename concept) split into a
   * create+delete across devices, leaving a duplicate. Keep one canonical file
   * and send the rest to the recoverable trash. The winner is chosen
   * deterministically (device-independent) so peers converge instead of fight.
   */
  async dedupeCardFilesById() {
    const byId = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.boardForFile(file)) continue; // only card files (never the index)
      let id = "";
      try { id = parseCardMarkdown(await this.app.vault.read(file)).id || ""; } catch (error) { id = ""; }
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(file);
    }

    let changed = false;
    for (const [id, files] of byId) {
      if (files.length < 2) continue;
      // Prefer a file under cards/, then the shortest path, then lexicographic —
      // all device-independent, so every device keeps the same one.
      files.sort((a, b) => {
        const aCards = /(^|\/)cards\//.test(a.path) ? 0 : 1;
        const bCards = /(^|\/)cards\//.test(b.path) ? 0 : 1;
        if (aCards !== bCards) return aCards - bCards;
        if (a.path.length !== b.path.length) return a.path.length - b.path.length;
        return a.path < b.path ? -1 : 1;
      });
      const keep = files[0];
      const card = this.data.cards[id];
      if (card) card.filePath = keep.path;
      for (let i = 1; i < files.length; i += 1) {
        try {
          await this.app.vault.trash(files[i], false); // recoverable vault .trash
          changed = true;
        } catch (error) {
          console.error("Kanux: could not de-duplicate card file", files[i].path, error);
        }
      }
    }
    return changed;
  },

  /**
   * One-time: moves loose board media (images/videos pasted before the
   * cards/attachments layout) into <board>/attachments and repoints the card
   * links that used a full path. Card notes are relocated separately by
   * normalizeCardFilePaths. Must run AFTER syncCardsFromFolder and BEFORE
   * writeAllCardFiles so the rewritten details are the ones persisted.
   */
  async migrateExistingMedia() {
    let moved = false;
    for (const board of this.data.boards) {
      if (await this.migrateBoardMedia(board)) moved = true;
    }
    return moved;
  },

  async migrateBoardMedia(board) {
    if (!board || !board.folderPath) return false;
    const root = this.app.vault.getAbstractFileByPath(board.folderPath);
    if (!root || !root.children) return false;
    const attachDir = `${board.folderPath}/attachments`;

    // Loose (non-Markdown) files sitting directly in the board root — don't
    // descend into subfolders (cards, attachments, nested boards, or media the
    // user organised themselves).
    const looseRoot = new Set(
      (root.children || [])
        .filter((child) => !child.children && child.extension && child.extension.toLowerCase() !== "md")
        .map((child) => child.path)
    );
    if (!looseRoot.size) return false;

    // Build the plan from EVERY embed (image or not) that still resolves to a
    // loose root file, resolving BEFORE moving so basename lookups can't drift.
    // We move ONLY files a card actually references here — so every moved file's
    // link can be fixed, and a file whose card already points into attachments/
    // (e.g. a peer already migrated it) is never re-moved.
    const embedRe = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
    const plan = [];
    const toMove = new Set();
    for (const card of Object.values(this.data.cards)) {
      if (!card || !card.details) continue;
      let match;
      embedRe.lastIndex = 0;
      while ((match = embedRe.exec(card.details))) {
        const isWiki = match[1] !== undefined;
        let target = (isWiki ? match[1] : match[2]) || "";
        target = target.split("|")[0].split("#")[0].trim();
        if (!isWiki) target = target.split(/\s+/)[0];
        const file = this.resolveEmbedFile(card, target);
        if (file && looseRoot.has(file.path)) {
          plan.push({ card, markup: match[0], oldPath: file.path });
          toMove.add(file.path);
        }
      }
    }
    if (!toMove.size) return false;

    if (!this.app.vault.getAbstractFileByPath(attachDir)) {
      await this.app.vault.createFolder(attachDir).catch(() => {});
    }

    // Move each referenced file into attachments/, recording old -> new. If a
    // file of that name is already there (e.g. a synced peer already migrated
    // it), leave the loose file alone rather than creating a deduped duplicate —
    // its link stays valid and sync converges on its own.
    const newPathByOld = {};
    let moved = false;
    for (const oldPath of toMove) {
      const file = this.app.vault.getAbstractFileByPath(oldPath);
      if (!file) continue;
      const dest = `${attachDir}/${file.name}`;
      if (dest === oldPath || this.app.vault.getAbstractFileByPath(dest)) continue;
      try {
        await this.app.vault.rename(file, dest);
        newPathByOld[oldPath] = dest;
        moved = true;
      } catch (error) {
        console.error("Kanux: could not move media", oldPath, error);
      }
    }

    // Repoint every referencing embed to its file's new path, by exact markup.
    plan.forEach(({ card, markup, oldPath }) => {
      const dest = newPathByOld[oldPath];
      if (!dest || dest === oldPath) return;
      card.details = card.details.split(markup).join(`![[${dest}]]`);
    });

    return moved;
  },

  // Resolve an embed target (any file type) to a vault TFile, tolerating
  // URL-encoded Markdown-link paths. Returns null for URLs / unresolved links.
  resolveEmbedFile(card, target) {
    if (!target || /^https?:\/\//i.test(target)) return null;
    const sourcePath = (card && card.filePath) || "";
    const lookup = (value) => {
      let file = this.app.vault.getAbstractFileByPath(value);
      if (!file && this.app.metadataCache && this.app.metadataCache.getFirstLinkpathDest) {
        try { file = this.app.metadataCache.getFirstLinkpathDest(value, sourcePath); } catch (error) { file = null; }
      }
      return file && file.path ? file : null;
    };
    let file = lookup(target);
    if (!file) {
      try { file = lookup(decodeURIComponent(target)); } catch (error) { file = null; }
    }
    return file;
  },
};

module.exports = { vaultSyncMethods };
