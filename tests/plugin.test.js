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
  plugin.undoStack = [];
  return plugin;
}

function createDependencyBoard(blocking) {
  const doing = { id: "list-1", title: "Doing", cardIds: ["card-1"] };
  const done = { id: "list-2", title: "Done", cardIds: [] };
  const board = { id: "board-1", name: "Project", folderPath: "Project", lists: [doing, done] };
  const blocker = { id: "card-2", title: "Design QA", boardId: board.id, listId: doing.id, completed: false };
  const card = {
    id: "card-1",
    title: "Deploy",
    boardId: board.id,
    listId: doing.id,
    dependencies: [{ cardId: blocker.id, blocking }],
  };
  const plugin = createPlugin({
    activeBoardId: board.id,
    boards: [board],
    cards: { [card.id]: card, [blocker.id]: blocker },
  });
  plugin.writeListCardFiles = async () => {};
  return { plugin, board, doing, done, card, blocker };
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

async function testMoveCardIsRefusedByATotalBlock() {
  const { plugin, doing, done, card, blocker } = createDependencyBoard("block");

  assert.strictEqual(await plugin.moveCard(card.id, done.id), false);
  assert.deepStrictEqual(doing.cardIds, [card.id]);
  assert.deepStrictEqual(done.cardIds, []);
  assert.strictEqual(card.listId, doing.id);

  blocker.completed = true;
  assert.strictEqual(await plugin.moveCard(card.id, done.id), true);
  assert.deepStrictEqual(done.cardIds, [card.id]);
  assert.strictEqual(card.listId, done.id);
}

async function testBlockedCardStillReordersInsideItsList() {
  const { plugin, doing, card } = createDependencyBoard("block");
  doing.cardIds = ["card-0", card.id];

  // Same list: no progress is being claimed, so the dependency stays out of it.
  assert.strictEqual(await plugin.moveCard(card.id, doing.id, "card-0"), true);
  assert.deepStrictEqual(doing.cardIds, [card.id, "card-0"]);
}

async function testUndoIgnoresTheDependencyGate() {
  const { plugin, doing, done, card } = createDependencyBoard("block");
  plugin.applyingUndo = true;

  assert.strictEqual(await plugin.moveCard(card.id, done.id), true);
  assert.deepStrictEqual(done.cardIds, [card.id]);
  assert.deepStrictEqual(doing.cardIds, []);
}

async function testDeletingATemplateTrashesOnlyItsNote() {
  const board = { id: "board-1", name: "Project", folderPath: "Project", lists: [] };
  const file = { path: "Project/templates/Bug report.md" };
  const plugin = createPlugin({ boards: [board], cards: {} }, { [file.path]: file });
  const trashed = [];
  plugin.app.vault.trash = async (target) => { trashed.push(target.path); };

  assert.strictEqual(await plugin.deleteCardTemplate({ title: "Bug report", filePath: file.path }), true);
  assert.deepStrictEqual(trashed, [file.path]);

  // A template whose note has already gone is still gone: nothing left to
  // trash, and no reason to report a failure the library cannot act on.
  assert.strictEqual(await plugin.deleteCardTemplate({ title: "Stale", filePath: "Project/templates/Stale.md" }), true);
  assert.deepStrictEqual(trashed, [file.path]);
}

const TEMPLATE_NOTE = `---
kanux-template: true
kanban-list-id: list-1
kanux-id-prefix: BUG
kanux-id-next: 7
kanux-id-pad: 3
---

# Bug report

## Details
As a [ ]
`;

function createTemplateBoard() {
  const list = { id: "list-1", title: "Backlog", cardIds: [] };
  const board = { id: "board-1", name: "Project", folderPath: "Project", lists: [list] };
  const file = { path: "Project/templates/Bug report.md" };
  const plugin = createPlugin({ activeBoardId: board.id, boards: [board], cards: {} }, { [file.path]: file });
  plugin.writeListCardFiles = async () => {};
  plugin.notes = { [file.path]: TEMPLATE_NOTE };
  // Stands in for Vault.process, which the counter uses for its read-modify-write.
  plugin.app.vault.process = async (target, mutate) => {
    plugin.notes[target.path] = mutate(plugin.notes[target.path]);
    return plugin.notes[target.path];
  };
  const template = { title: "Bug report", filePath: file.path, listId: list.id, labels: [], assignees: [], details: "", checklists: [], numbering: { prefix: "BUG", next: 7, pad: 3 } };
  return { plugin, board, list, template, file };
}

async function testTemplateNumberingStampsTheCardAndAdvances() {
  const { plugin, list, template } = createTemplateBoard();
  const created = [];
  plugin.createCard = async (listId, title, seed) => {
    created.push({ listId, title, code: seed.code });
    return "card-1";
  };

  assert.strictEqual(await plugin.createCardFromTemplate(template, list.id), "card-1");
  // The code goes to the card's own field; the title stays the template's name,
  // so renaming the card later cannot take the identifier with it.
  assert.deepStrictEqual(created, [{ listId: list.id, title: "Bug report", code: "BUG-007" }]);
  // The counter moves in the note, so the next card gets 008 after a reload.
  assert.match(plugin.notes[template.filePath], /kanux-id-next: 8/);
  assert.strictEqual(template.numbering.next, 8);

  await plugin.createCardFromTemplate(template, list.id);
  assert.strictEqual(created[1].code, "BUG-008");
  assert.strictEqual(created[1].title, "Bug report");
}

async function testAFailedCardDoesNotBurnANumber() {
  const { plugin, list, template } = createTemplateBoard();
  // createCard returns "" when the list is gone; nothing was named, so the
  // number has to still be on offer.
  plugin.createCard = async () => "";

  assert.strictEqual(await plugin.createCardFromTemplate(template, list.id), "");
  assert.match(plugin.notes[template.filePath], /kanux-id-next: 7/);
  assert.strictEqual(template.numbering.next, 7);
}

async function testAnUnnumberedTemplateHandsOutNoCode() {
  const { plugin, list, template } = createTemplateBoard();
  template.numbering = null;
  const created = [];
  plugin.createCard = async (listId, title, seed) => {
    created.push({ title, code: seed.code });
    return "card-1";
  };

  await plugin.createCardFromTemplate(template, list.id);
  assert.deepStrictEqual(created, [{ title: "Bug report", code: "" }]);
  assert.match(plugin.notes[template.filePath], /kanux-id-next: 7/);
}

async function testRestartingNumberingRewindsTheCounter() {
  const { plugin, template } = createTemplateBoard();
  // Codes are read from the card's own field, so a card merely *named* after a
  // code is not mistaken for one that carries it.
  plugin.data.cards = {
    "card-1": { id: "card-1", code: "BUG-003", title: "Older bug" },
    "card-2": { id: "card-2", code: "", title: "BUG-004 not really a code" },
    "card-3": { id: "card-3", code: "TASK-003", title: "Another template's card" },
  };

  // No workspace in the harness, so confirmAction resolves true: this exercises
  // the write, not the dialog.
  assert.strictEqual(await plugin.resetTemplateNumbering(template), true);
  assert.match(plugin.notes[template.filePath], /kanux-id-next: 1/);
  assert.strictEqual(template.numbering.next, 1);
  assert.deepStrictEqual(plugin.cardsCarryingCode(template).map((card) => card.id), ["card-1"]);
}

function cardNote(fields) {
  return [
    "---",
    "kanban-card-id: card-1",
    "kanban-list-id: list-1",
    `kanux-card-code: ${fields.code}`,
    `depends-on: ${fields.depends}`,
    "position: 0",
    "labels: ",
    "---",
    "",
    "# Deploy",
    "",
  ].join("\n");
}

/**
 * A peer running a version that predates these keys writes them blank. Blank
 * must never win: a card code and a dependency live only in the note and in
 * this device's memory, so an overwrite would be unrecoverable.
 */
async function importNoteOverCard(noteFields) {
  const list = { id: "list-1", title: "Doing", cardIds: ["card-1"] };
  const board = { id: "board-1", name: "Project", folderPath: "Project", lists: [list] };
  const card = {
    id: "card-1",
    title: "Deploy",
    boardId: board.id,
    listId: list.id,
    filePath: "Project/cards/Deploy.md",
    code: "BUG-014",
    dependencies: [{ cardId: "card-2", blocking: "block" }],
  };
  const file = { path: card.filePath, basename: "Deploy", extension: "md" };
  const plugin = createPlugin({ activeBoardId: board.id, boards: [board], cards: { "card-1": card } }, { [file.path]: file });

  plugin.app.vault.getMarkdownFiles = () => [file];
  plugin.app.vault.read = async () => cardNote(noteFields);
  plugin.healQuotedDuplicateLists = () => false;
  plugin.reconcileListsFromIndex = async () => false;
  plugin.isGeneratedBoardIndexFile = async () => false;
  plugin.normalizeCardFilePath = async () => false;
  plugin.writeListCardFiles = async () => {};

  await plugin.syncBoardCardsFromFolder(board);
  return plugin.data.cards["card-1"];
}

async function testAnEmptyKeyCannotEraseACodeOrADependency() {
  const kept = await importNoteOverCard({ code: "", depends: "" });
  assert.strictEqual(kept.code, "BUG-014");
  assert.deepStrictEqual(kept.dependencies, [{ cardId: "card-2", blocking: "block" }]);
}

async function testARealValueInTheNoteStillWins() {
  const updated = await importNoteOverCard({ code: "TASK-002", depends: "card-9|warn" });
  assert.strictEqual(updated.code, "TASK-002");
  assert.deepStrictEqual(updated.dependencies, [{ cardId: "card-9", blocking: "warn" }]);
}

async function run() {
  await testMoveCardIsRefusedByATotalBlock();
  await testBlockedCardStillReordersInsideItsList();
  await testUndoIgnoresTheDependencyGate();
  await testRenameBoardMovesFolderAndUpdatesPaths();
  await testRenameBoardRollsBackWhenFolderMoveFails();
  await testDeleteBoardTrashesFolderAndCleansState();
  await testDeletingATemplateTrashesOnlyItsNote();
  await testTemplateNumberingStampsTheCardAndAdvances();
  await testAFailedCardDoesNotBurnANumber();
  await testAnUnnumberedTemplateHandsOutNoCode();
  await testRestartingNumberingRewindsTheCounter();
  await testAnEmptyKeyCannotEraseACodeOrADependency();
  await testARealValueInTheNoteStillWins();
  testRefreshViewsHonorsTemporaryViewGuard();
  console.log("plugin tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
