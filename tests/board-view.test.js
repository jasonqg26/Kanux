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
      Setting: ObsidianBase,
      arrayBufferToBase64() {},
      setIcon() {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { BoardView } = require("../src/board-view");

function card(top, height, cardId) {
  return {
    dataset: { cardId },
    getBoundingClientRect: () => ({ top, height }),
  };
}

function testDropAnchorUsesCardMidpoints() {
  const first = card(10, 40, "first");
  const second = card(58, 60, "second");
  const cards = { querySelectorAll: () => [first, second] };
  const view = Object.create(BoardView.prototype);

  assert.strictEqual(view.findCardDropAnchor(cards, 20), first);
  assert.strictEqual(view.findCardDropAnchor(cards, 40), second);
  assert.strictEqual(view.findCardDropAnchor(cards, 100), null);
}

function testEdgeScrollAcceleratesNearBoundaries() {
  const view = Object.create(BoardView.prototype);

  assert.strictEqual(view.edgeScrollDelta(100, 0, 200), 0);
  assert.ok(view.edgeScrollDelta(10, 0, 200) < 0);
  assert.ok(view.edgeScrollDelta(195, 0, 200) > 0);
  assert.strictEqual(view.edgeScrollDelta(-100, 0, 200), -18);
  assert.strictEqual(view.edgeScrollDelta(300, 0, 200), 18);
}

function testNextCardIgnoresDraggedCard() {
  const dragged = { dataset: { cardId: "dragged" }, nextElementSibling: null };
  const target = { dataset: { cardId: "target" }, nextElementSibling: null };
  dragged.nextElementSibling = target;
  const placeholder = { nextElementSibling: dragged };
  const view = Object.create(BoardView.prototype);

  assert.strictEqual(view.cardIdAfterPlaceholder(placeholder, "dragged"), "target");
  assert.strictEqual(view.cardIdAfterPlaceholder({ nextElementSibling: null }, "dragged"), undefined);
}

function testDragStartKeepsOriginalCardInLayout() {
  const placeholder = { style: {}, parentElement: null };
  global.document = { createElement: () => placeholder };
  let insertions = 0;
  const classList = { add() {} };
  const parentElement = { classList, insertBefore() { insertions += 1; } };
  const element = {
    classList,
    parentElement,
    getBoundingClientRect: () => ({ height: 80, width: 260 }),
  };
  const view = Object.create(BoardView.prototype);
  view.cardDragState = null;
  view.contentEl = { classList };
  view.finishCardDrag = () => {};
  view.createCardDragPreview = () => null;
  global.requestAnimationFrame = () => 1;

  view.startCardDrag({ dataTransfer: {} }, element, "card-1");

  assert.strictEqual(insertions, 0);
  assert.strictEqual(view.cardDragState.placeholder.parentElement, null);
}

function testDropRefreshGuardExpires() {
  const view = Object.create(BoardView.prototype);
  view.cardDropRefreshBlockedUntil = Date.now() + 1000;
  assert.strictEqual(view.shouldDeferRefresh(), true);
  view.cardDropRefreshBlockedUntil = Date.now() - 1;
  assert.strictEqual(view.shouldDeferRefresh(), false);
}

function testTableSearchIsAccentInsensitive() {
  const view = Object.create(BoardView.prototype);
  assert.strictEqual(view.normalizeTableSearch("Revisión ÚRGENTE"), "revision urgente");
}

function testTableRowsFilterAndSortIndependently() {
  const view = Object.create(BoardView.prototype);
  const rows = [
    {
      card: { title: "Later", details: "Revisión", labels: [], assignees: [], checklists: [], dueDate: "2026-09-10" },
      list: { id: "todo", title: "Todo" },
      boardOrder: 0,
    },
    {
      card: { title: "Soon", details: "Revisión", labels: [], assignees: [], checklists: [], dueDate: "2026-08-26" },
      list: { id: "todo", title: "Todo" },
      boardOrder: 1,
    },
    {
      card: { title: "Hidden", details: "Different", labels: [], assignees: [], checklists: [] },
      list: { id: "done", title: "Done" },
      boardOrder: 2,
    },
  ];
  const state = { query: "revision", listId: "todo", completion: "all", labelKeys: [], sort: "due" };

  const filtered = view.filterAndSortTableRows(rows, state);

  assert.deepStrictEqual(filtered.map((row) => row.card.title), ["Soon", "Later"]);
}

testDropAnchorUsesCardMidpoints();
testEdgeScrollAcceleratesNearBoundaries();
testNextCardIgnoresDraggedCard();
testDragStartKeepsOriginalCardInLayout();
testDropRefreshGuardExpires();
testTableSearchIsAccentInsensitive();
testTableRowsFilterAndSortIndependently();
console.log("board view tests passed");
