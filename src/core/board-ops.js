const { LIST_COLORS, VIEW_TYPE, cleanColor, uid } = require("../helpers");

// Board and list operations: lookups plus the user-facing create/rename/
// delete/move flows for boards and lists.
const { TextPromptModal, confirmAction } = require("../modals");

const boardOpsMethods = {
  getBoard() {
    return this.findBoard(this.data.activeBoardId) || this.data.boards[0] || null;
  },

  findBoard(boardId) {
    return this.data.boards.find((board) => board.id === boardId) || null;
  },

  boardIdForList(listId) {
    const board = this.data.boards.find((item) => item.lists.some((list) => list.id === listId));
    return board ? board.id : "";
  },

  findBoardForCard(card) {
    if (!card) return this.getBoard();
    return this.findBoard(card.boardId) || this.findBoard(this.boardIdForList(card.listId)) || this.getBoard();
  },

  findList(listId, board = this.getBoard()) {
    if (!listId) return null;
    const boards = board ? [board] : this.data.boards;
    for (const item of boards) {
      const list = item.lists.find((candidate) => candidate.id === listId);
      if (list) return list;
    }
    return null;
  },

  findListByCard(cardId, board = this.getBoard()) {
    if (!cardId || !board) return null;
    return board.lists.find((list) => list.cardIds.includes(cardId)) || null;
  },

  defaultListColor(index) {
    return LIST_COLORS[index % LIST_COLORS.length];
  },

  promptText(title, placeholder, initialValue, onSubmit) {
    new TextPromptModal(this.app, title, placeholder, initialValue, onSubmit).open();
  },

  createBoardPrompt() {
    if (this.boardLimitReached(true)) return;
    this.promptText("Create board", "Board name", "", async (name) => {
      await this.createBoard(name);
    });
  },

  async createBoard(name) {
    // Safety net: never exceed the free board limit even via a non-prompt caller.
    if (this.boardLimitReached(true)) return null;
    const board = {
      id: uid("board"),
      name,
      folderPath: await this.nextBoardFolder(name),
      lists: [],
    };

    // Most people run a To do / Doing / Done flow, so seed those three lists by
    // default (grey / blue / green via defaultListColor). Opt out in settings.
    if (this.data.seedDefaultLists !== false) {
      ["To do", "Doing", "Done"].forEach((title, index) => {
        board.lists.push({ id: uid("list"), title, color: this.defaultListColor(index), cardIds: [] });
      });
    }

    this.data.boards.push(board);
    this.data.activeBoardId = board.id;
    await this.ensureBoardFolder(board);
    await this.savePluginData();
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view) leaf.view.showingBoardHome = false;
    });
    this.refreshViews();
  },

  async setActiveBoard(boardId) {
    if (!this.findBoard(boardId)) return;
    this.data.activeBoardId = boardId;
    await this.syncCardsFromFolder(this.getBoard());
    await this.savePluginData();
    this.refreshViews();
  },

  renameBoard(boardId) {
    const board = this.findBoard(boardId);
    if (!board) return;

    this.promptText("Rename board", "Board name", board.name, async (name) => {
      await this.renameBoardTo(board, name);
    });
  },

  async renameBoardTo(board, name) {
    const previousName = board.name;
    const previousFolder = board.folderPath;
    const nextFolder = await this.nextBoardFolder(name, previousFolder);
    const folder = this.app.vault.getAbstractFileByPath(previousFolder);

    board.name = name;
    board.folderPath = nextFolder;
    this.replaceBoardFolderPaths(board.id, previousFolder, nextFolder);

    try {
      if (nextFolder !== previousFolder) {
        if (!folder) throw new Error("Board folder not found");
        await this.app.vault.rename(folder, nextFolder);
      }
    } catch (error) {
      board.name = previousName;
      board.folderPath = previousFolder;
      this.replaceBoardFolderPaths(board.id, nextFolder, previousFolder);
      throw error;
    }

    await this.writeBoardCardFiles(board);
    await this.savePluginData();
    this.refreshViews();
  },

  replaceBoardFolderPaths(boardId, previousFolder, nextFolder) {
    if (!previousFolder || previousFolder === nextFolder) return;
    Object.values(this.data.cards).forEach((card) => {
      if (card.boardId !== boardId) return;
      card.filePath = this.replaceFolderPrefix(card.filePath, previousFolder, nextFolder);
      (card.checklists || []).forEach((checklist) => {
        (checklist.items || []).forEach((item) => {
          item.filePath = this.replaceFolderPrefix(item.filePath, previousFolder, nextFolder);
        });
      });
    });
  },

  replaceFolderPrefix(filePath, previousFolder, nextFolder) {
    if (!filePath || !filePath.startsWith(`${previousFolder}/`)) return filePath;
    return `${nextFolder}/${filePath.slice(previousFolder.length + 1)}`;
  },

  async deleteBoard(boardId) {
    const board = this.findBoard(boardId);
    if (!board) return;

    const cards = Object.values(this.data.cards).filter((card) => card.boardId === board.id);
    const cardSummary = cards.length === 1 ? "1 linked card" : `${cards.length} linked cards`;
    const warning = `Delete "${board.name}" and its entire folder, including ${cardSummary}? The folder will be moved to the trash.`;
    if (!await confirmAction(this.app, "Delete board", warning)) return;

    const folder = this.app.vault.getAbstractFileByPath(board.folderPath);
    if (folder) await this.app.vault.trash(folder, true);

    this.pruneBoardsMatching((item) => item.id === board.id);
    cards.forEach((card) => this.diskSignatures.delete(card.id));
    this.indexSignatures.delete(board.id);
    if (this.data.viewModes) delete this.data.viewModes[board.id];
    if (this.data.tableConfigs) delete this.data.tableConfigs[board.id];
    await this.savePluginData();
    this.refreshViews();
  },

  addList() {
    if (!this.getBoard()) {
      this.createBoardPrompt();
      return;
    }

    this.promptText("Add list", "List name", "", async (title) => {
      const board = this.getBoard();
      board.lists.push({ id: uid("list"), title, color: this.defaultListColor(board.lists.length), cardIds: [] });
      await this.savePluginData();
      this.refreshViews();
    });
  },

  renameList(listId) {
    const list = this.findList(listId);
    if (!list) return;

    this.promptText("Rename list", "List name", list.title, async (title) => {
      list.title = title;
      await this.writeCardsForList(list);
      await this.savePluginData();
      this.refreshViews();
    });
  },

  async cycleListColor(listId) {
    const list = this.findList(listId);
    if (!list) return;

    const current = LIST_COLORS.indexOf(cleanColor(list.color));
    await this.setListColor(listId, LIST_COLORS[(current + 1) % LIST_COLORS.length]);
  },

  async setListColor(listId, color) {
    const list = this.findList(listId);
    const clean = cleanColor(color);
    if (!list || !clean) return;

    list.color = clean;
    await this.writeCardsForList(list);
    await this.savePluginData();
    this.refreshViews();
  },

  async deleteList(listId) {
    const board = this.getBoard();
    const list = this.findList(listId);
    if (!board || !list) return;

    const message = list.cardIds.length
      ? `Delete "${list.title}" and its ${list.cardIds.length} cards?`
      : `Delete "${list.title}"?`;
    if (!await confirmAction(this.app, "Delete list", message)) return;

    for (const cardId of list.cardIds) {
      await this.deleteCard(cardId, false);
    }
    board.lists = board.lists.filter((item) => item.id !== listId);
    // Tombstone the deletion so it syncs (via the index) and the list never
    // resurrects from another device that still has it.
    board.deletedListIds = Array.isArray(board.deletedListIds) ? board.deletedListIds : [];
    if (!board.deletedListIds.includes(listId)) board.deletedListIds = [...board.deletedListIds, listId].slice(-200);
    await this.savePluginData();
    this.refreshViews();
  },

  async moveList(listId, targetListId, afterTarget = false) {
    if (!listId || listId === targetListId) return;

    const board = this.getBoard();
    if (!board) return;
    const fromIndex = board.lists.findIndex((list) => list.id === listId);
    if (fromIndex === -1) return;

    const [list] = board.lists.splice(fromIndex, 1);
    const targetIndex = board.lists.findIndex((item) => item.id === targetListId);
    if (targetIndex === -1) {
      board.lists.push(list);
    } else {
      board.lists.splice(targetIndex + (afterTarget ? 1 : 0), 0, list);
    }

    await this.savePluginData();
    this.refreshViews();
  },
};

module.exports = { boardOpsMethods };
