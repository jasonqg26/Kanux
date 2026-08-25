const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
class ObsidianBase {}

Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      FuzzySuggestModal: ObsidianBase,
      ItemView: ObsidianBase,
      MarkdownRenderer: {},
      Menu: ObsidianBase,
      Modal: ObsidianBase,
      Notice: class {},
      Plugin: ObsidianBase,
      PluginSettingTab: ObsidianBase,
      Setting: ObsidianBase,
      addIcon() {},
      arrayBufferToBase64() {},
      setIcon() {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const KanuxPlugin = require("../src/plugin");

function createPlugin(data, files = {}) {
  const plugin = Object.create(KanuxPlugin.prototype);
  plugin.data = data;
  plugin.diskSignatures = new Map();
  plugin.indexSignatures = new Map();
  plugin.app = {
    vault: {
      getAbstractFileByPath(path) {
        return files[path] || null;
      },
    },
  };
  plugin.refreshViews = () => {};
  plugin.savePluginData = async () => {};
  return plugin;
}

async function testRenameBoardMovesFolderAndUpdatesPaths() {
  const board = { id: "board-1", name: "Old", folderPath: "Old", lists: [] };
  const card = {
    id: "card-1",
    boardId: board.id,
    filePath: "Old/cards/Card.md",
    checklists: [{ items: [{ filePath: "Old/checklist-items/Item.md" }] }],
  };
  const folder = { path: "Old" };
  const plugin = createPlugin({ boards: [board], cards: { [card.id]: card } }, { Old: folder });
  plugin.nextBoardFolder = async () => "New";
  plugin.writeBoardCardFiles = async (renamedBoard) => {
    assert.strictEqual(renamedBoard.name, "New");
  };
  plugin.app.vault.rename = async (source, nextPath) => {
    assert.strictEqual(source, folder);
    assert.strictEqual(nextPath, "New");
    assert.strictEqual(board.folderPath, "New");
    assert.strictEqual(card.filePath, "New/cards/Card.md");
  };

  await plugin.renameBoardTo(board, "New");

  assert.strictEqual(board.name, "New");
  assert.strictEqual(board.folderPath, "New");
  assert.strictEqual(card.filePath, "New/cards/Card.md");
  assert.strictEqual(card.checklists[0].items[0].filePath, "New/checklist-items/Item.md");
}

async function testRenameBoardRollsBackWhenFolderMoveFails() {
  const board = { id: "board-1", name: "Old", folderPath: "Old", lists: [] };
  const card = { id: "card-1", boardId: board.id, filePath: "Old/cards/Card.md", checklists: [] };
  const plugin = createPlugin({ boards: [board], cards: { [card.id]: card } }, { Old: { path: "Old" } });
  plugin.nextBoardFolder = async () => "New";
  plugin.app.vault.rename = async () => { throw new Error("move failed"); };

  await assert.rejects(() => plugin.renameBoardTo(board, "New"), /move failed/);
  assert.strictEqual(board.name, "Old");
  assert.strictEqual(board.folderPath, "Old");
  assert.strictEqual(card.filePath, "Old/cards/Card.md");
}

async function testDeleteBoardTrashesFolderAndCleansState() {
  const board = { id: "board-1", name: "Project", folderPath: "Project", lists: [] };
  const otherBoard = { id: "board-2", name: "Other", folderPath: "Other", lists: [] };
  const card = { id: "card-1", boardId: board.id, filePath: "Project/cards/Card.md" };
  const folder = { path: "Project" };
  const data = {
    activeBoardId: board.id,
    boards: [board, otherBoard],
    cards: { [card.id]: card },
    viewModes: { [board.id]: "table" },
    tableConfigs: { [board.id]: { columns: [] } },
  };
  const plugin = createPlugin(data, { Project: folder });
  let trashed = null;
  let saved = false;
  plugin.app.vault.trash = async (...args) => { trashed = args; };
  plugin.savePluginData = async () => { saved = true; };
  plugin.diskSignatures.set(card.id, "markdown");
  plugin.indexSignatures.set(board.id, "index");
  global.window = { confirm: () => true };

  await plugin.deleteBoard(board.id);

  assert.deepStrictEqual(trashed, [folder, true]);
  assert.deepStrictEqual(data.boards, [otherBoard]);
  assert.deepStrictEqual(data.cards, {});
  assert.strictEqual(data.activeBoardId, otherBoard.id);
  assert.strictEqual(data.viewModes[board.id], undefined);
  assert.strictEqual(data.tableConfigs[board.id], undefined);
  assert.strictEqual(plugin.diskSignatures.has(card.id), false);
  assert.strictEqual(plugin.indexSignatures.has(board.id), false);
  assert.strictEqual(saved, true);
}

function testRefreshViewsHonorsTemporaryViewGuard() {
  const plugin = createPlugin({ boards: [], cards: {} });
  plugin.refreshViews = KanuxPlugin.prototype.refreshViews.bind(plugin);
  let guardedRenders = 0;
  let regularRenders = 0;
  plugin.updateExplorerColors = () => {};
  plugin.app.workspace = {
    getLeavesOfType: () => [
      { view: { shouldDeferRefresh: () => true, render: () => { guardedRenders += 1; } } },
      { view: { shouldDeferRefresh: () => false, render: () => { regularRenders += 1; } } },
    ],
  };

  plugin.refreshViews();

  assert.strictEqual(guardedRenders, 0);
  assert.strictEqual(regularRenders, 1);
}

async function run() {
  await testRenameBoardMovesFolderAndUpdatesPaths();
  await testRenameBoardRollsBackWhenFolderMoveFails();
  await testDeleteBoardTrashesFolderAndCleansState();
  testRefreshViewsHonorsTemporaryViewGuard();
  console.log("plugin tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
