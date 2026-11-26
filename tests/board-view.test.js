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

function makeMockDocument() {
  return {
    createElement(tagName) {
      const classSet = new Set();
      return {
        tagName,
        get className() {
          return Array.from(classSet).join(" ");
        },
        set className(value) {
          classSet.clear();
          String(value || "").split(/\s+/).filter(Boolean).forEach((name) => classSet.add(name));
        },
        textContent: "",
        children: [],
        get childElementCount() {
          return this.children.length;
        },
        classList: {
          add(...names) {
            names.forEach((n) => classSet.add(n));
          },
          toggle(name, force) {
            if (force === undefined) {
              if (classSet.has(name)) classSet.delete(name);
              else classSet.add(name);
            } else if (force) {
              classSet.add(name);
            } else {
              classSet.delete(name);
            }
          },
          contains(name) {
            return classSet.has(name);
          },
        },
        style: {
          setProperty() {},
          removeProperty() {},
        },
        dataset: {},
        attributes: {},
        setAttribute(k, v) {
          this.attributes[k] = v;
        },
        append(...nodes) {
          nodes.forEach((n) => {
            if (n) this.children.push(n);
          });
        },
        replaceChildren(...nodes) {
          this.children = [...nodes];
        },
        addEventListener() {},
        querySelectorAll(selector) {
          const results = [];
          const matchClass = selector.startsWith(".") ? selector.slice(1) : null;
          const walk = (node) => {
            if (matchClass && node.classList && node.classList.contains(matchClass)) {
              results.push(node);
            }
            if (node.children) {
              node.children.forEach(walk);
            }
          };
          walk(this);
          return results;
        },
      };
    },
  };
}

function testCardLabelsPlacementAndOverflow() {
  const oldDoc = global.document;
  global.document = makeMockDocument();

  const view = Object.create(BoardView.prototype);
  view.plugin = {
    getCardLockHolder: () => null,
    isSyncDeckEnabled: () => false,
    cardDependencyGate: () => ({ total: 0 }),
  };
  view.editingCardId = null;
  view.configureCardElement = () => {};
  view.bindCardInteractions = () => {};
  view.buildCardMain = () => {
    const el = makeMockDocument().createElement("div");
    el.classList.add("ot-card-main");
    return el;
  };
  view.buildCardFooter = () => {
    const el = makeMockDocument().createElement("div");
    el.classList.add("ot-card-footer");
    return el;
  };
  view.buildLockBadge = () => null;

  // Test A
  view.labelLook = { displayMode: "expanded", placement: "top", maxVisible: 2 };
  const cardA = { id: "c1", labels: [{ name: "Bug" }, { name: "UI" }, { name: "Urgent" }] };
  const elA = view.renderCard(cardA);

  assert.strictEqual(elA.children[0].classList.contains("ot-card-labels"), true);
  assert.strictEqual(elA.children[0].classList.contains("is-bottom"), false);
  assert.strictEqual(elA.children[1].classList.contains("ot-card-main"), true);
  assert.strictEqual(elA.children[2].classList.contains("ot-card-footer"), true);

  const labelsContainer = elA.children[0];
  const labelItems = labelsContainer.querySelectorAll(".ot-card-label");
  assert.strictEqual(labelItems.length, 2);
  assert.deepStrictEqual(labelItems.map((item) => item.textContent), ["Bug", "UI"]);
  const overflow = labelsContainer.querySelectorAll(".ot-card-labels-overflow");
  assert.strictEqual(overflow.length, 1);
  const more = labelsContainer.querySelectorAll(".ot-card-label-more");
  assert.strictEqual(more[0].textContent, "+1");
  const popoverItem = labelsContainer.querySelectorAll(".ot-card-label-popover-item");
  assert.strictEqual(popoverItem.length, 1);
  assert.strictEqual(popoverItem[0].textContent, "Urgent");

  // Test B
  view.labelLook = { displayMode: "expanded", placement: "bottom", maxVisible: 0 };
  const cardB = { id: "c2", labels: [{ name: "A" }, { name: "B" }, { name: "C" }] };
  const elB = view.renderCard(cardB);

  assert.strictEqual(elB.children[0].classList.contains("ot-card-main"), true);
  assert.strictEqual(elB.children[1].classList.contains("ot-card-footer"), true);
  assert.strictEqual(elB.children[2].classList.contains("ot-card-labels"), true);
  assert.strictEqual(elB.children[2].classList.contains("is-bottom"), true);
  assert.strictEqual(elB.children[2].querySelectorAll(".ot-card-label").length, 3);
  const overflowB = elB.children[2].querySelectorAll(".ot-card-labels-overflow");
  assert.strictEqual(overflowB.length, 0);

  global.document = oldDoc;
}

function testApplyAppearanceClassesTogglesLabelModes() {
  const root = makeMockDocument().createElement("div");
  const view = Object.create(BoardView.prototype);

  view.applyAppearanceClasses(root, {
    motion: { enabled: true },
    colorScheme: "theme",
    surfaceScheme: "theme",
    lists: { showColorDot: true },
    labels: { displayMode: "compact" },
  });
  assert.strictEqual(root.classList.contains("is-compact-labels"), true);
  assert.strictEqual(root.classList.contains("is-hover-labels"), false);
  assert.strictEqual(root.classList.contains("is-card-hover-labels"), false);

  view.applyAppearanceClasses(root, {
    motion: { enabled: true },
    colorScheme: "theme",
    surfaceScheme: "theme",
    lists: { showColorDot: true },
    labels: { displayMode: "hover" },
  });
  assert.strictEqual(root.classList.contains("is-compact-labels"), false);
  assert.strictEqual(root.classList.contains("is-hover-labels"), true);
  assert.strictEqual(root.classList.contains("is-card-hover-labels"), false);

  view.applyAppearanceClasses(root, {
    motion: { enabled: true },
    colorScheme: "theme",
    surfaceScheme: "theme",
    lists: { showColorDot: true },
    labels: { displayMode: "card-hover" },
  });
  assert.strictEqual(root.classList.contains("is-compact-labels"), false);
  assert.strictEqual(root.classList.contains("is-hover-labels"), false);
  assert.strictEqual(root.classList.contains("is-card-hover-labels"), true);
}

function testMembersAndAssigneeColumnWorkWithoutSyncDeck() {
  const oldDoc = global.document;
  global.document = makeMockDocument();

  const view = Object.create(BoardView.prototype);
  view.plugin = {
    isSyncDeckEnabled: () => false,
    resolveMember: (member) => member,
    getMemberPicture: (member) => (member && member.email === "alice" ? "app://vault/alice.png" : ""),
  };

  assert.ok(view.tableColumnDefs().some((def) => def.key === "assignee"));

  const wrap = view.renderCardAssignees({
    assignees: [
      { email: "alice", name: "Alice", color: "#3b82f6" },
      { email: "Bob", name: "Bob", color: "#22c55e" },
    ],
  });
  assert.strictEqual(wrap.children.length, 2);
  assert.strictEqual(String(wrap.children[0].children[0].tagName).toLowerCase(), "img");
  assert.strictEqual(wrap.children[0].children[0].src, "app://vault/alice.png");
  assert.strictEqual(wrap.children[1].textContent, "BO");

  global.document = oldDoc;
}

testCardLabelsPlacementAndOverflow();
testApplyAppearanceClassesTogglesLabelModes();
testMembersAndAssigneeColumnWorkWithoutSyncDeck();
console.log("board view tests passed");
