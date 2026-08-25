const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      getIcon(iconName) {
        return ["trash-2", "circle-help"].includes(iconName) ? { iconName } : null;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  checklistItems,
  checklistItemNoteBody,
  checklistStats,
  checklistsToMarkdown,
  iconButton,
  parseCardMarkdown,
  parseChecklists,
} = require("../src/helpers");

function createFakeElement(tagName) {
  return {
    tagName,
    attributes: {},
    children: [],
    classList: { add() {} },
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(...children) { this.children = children; },
  };
}

function testRegisteredIconAndGenericFallback() {
  global.document = { createElement: createFakeElement };

  const aliasedButton = iconButton("trash", "Delete", () => {});
  assert.strictEqual(aliasedButton.children[0].iconName, "trash-2");
  assert.strictEqual(aliasedButton.attributes["aria-label"], "Delete");

  const fallbackButton = iconButton("not-registered", "Unknown", () => {});
  assert.strictEqual(fallbackButton.children[0].iconName, "circle-help");
}

function testChecklistItemNoteBody() {
  const managed = [
    "---",
    "kanux-checklist-item: true",
    "kanux-card-id: card-1",
    "---",
    "",
    "# Review implementation",
    "",
    "Card: [[Board/Card|Card title]]",
    "",
    "Review the parser and keep [[Architecture]] in sync.",
    "",
    "- Confirm lists",
    "- Confirm links",
  ].join("\n");
  assert.strictEqual(
    checklistItemNoteBody(managed),
    "Review the parser and keep [[Architecture]] in sync.\n\n- Confirm lists\n- Confirm links",
  );

  const external = [
    "---",
    "owner: docs",
    "---",
    "",
    "# External heading",
    "",
    "Paragraph with [[Reference]].",
    "",
    "- First",
    "- Second",
  ].join("\n");
  assert.strictEqual(
    checklistItemNoteBody(external),
    "# External heading\n\nParagraph with [[Reference]].\n\n- First\n- Second",
  );
}

function testLegacyChecklistMigration() {
  const groups = parseChecklists("- [x] Existing item\n- [ ] Pending item");
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].title, "Checklist");
  assert.deepStrictEqual(groups[0].items.map((item) => [item.done, item.text]), [
    [true, "Existing item"],
    [false, "Pending item"],
  ]);
}

function testNamedChecklistRoundTrip() {
  const source = [
    {
      title: "Development",
      color: "#ef4444",
      items: [
        { done: true, text: "Implement parser", assignee: null },
        {
          done: false,
          text: "Review",
          filePath: "Project/checklist-items/Review.md",
          assignee: { email: "dev@example.com", name: "Dev", color: "#123456" },
        },
      ],
    },
    { title: "Release", items: [{ done: false, text: "Publish", assignee: null }] },
  ];
  const markdown = checklistsToMarkdown(source);
  const parsed = parseChecklists(markdown);

  assert.deepStrictEqual(parsed.map((group) => group.title), ["Development", "Release"]);
  assert.strictEqual(parsed[0].color, "#ef4444");
  assert.ok(markdown.includes("<!--kanux-checklist-color:#ef4444-->"));
  assert.deepStrictEqual(parsed.map((group) => group.items.map((item) => item.text)), [
    ["Implement parser", "Review"],
    ["Publish"],
  ]);
  assert.strictEqual(parsed[0].items[1].assignee.email, "dev@example.com");
  assert.strictEqual(parsed[0].items[1].filePath, "Project/checklist-items/Review.md");
  assert.ok(markdown.includes("[[Project/checklist-items/Review|Review]]"));

  const empty = parseChecklists(checklistsToMarkdown([{ title: "Empty group", color: "#22c55e", items: [] }]));
  assert.strictEqual(empty.length, 1);
  assert.strictEqual(empty[0].title, "Empty group");
  assert.strictEqual(empty[0].color, "#22c55e");
  assert.deepStrictEqual(empty[0].items, []);
}

function testCardParserAndAggregateStats() {
  const markdown = [
    "---",
    "kanban-card-id: card-1",
    "---",
    "",
    "# Card",
    "",
    "## Details",
    "Body",
    "",
    "## Checklist",
    "### First",
    "- [x] A",
    "",
    "### Second",
    "- [ ] B",
    "- [x] C",
  ].join("\n");
  const card = parseCardMarkdown(markdown);
  const items = checklistItems(card.checklists);
  assert.strictEqual(card.checklists.length, 2);
  assert.deepStrictEqual(checklistStats(items), { done: 2, total: 3, percent: 67 });
  assert.deepStrictEqual(checklistStats(card.checklists), { done: 2, total: 3, percent: 67 });
}

function testCardMetadataParsing() {
  const markdown = [
    "---",
    "kanban-card-id: card-7",
    "kanban-board-id: board-2",
    "kanban-list-id: list-3",
    "kanux-list: Doing: Today",
    "position: 4",
    "labels: Urgent|#ef4444, Docs|#3b82f6",
    "assignees: dev@example.com|Dev User|#123456",
    "completed: yes",
    "start: 2026-08-25",
    "due: invalid",
    "---",
    "",
    "# Metadata card",
    "",
    "position: 99",
  ].join("\n");

  const card = parseCardMarkdown(markdown);
  assert.strictEqual(card.id, "card-7");
  assert.strictEqual(card.boardId, "board-2");
  assert.strictEqual(card.listId, "list-3");
  assert.strictEqual(card.listTitle, "Doing: Today");
  assert.strictEqual(card.position, 4);
  assert.deepStrictEqual(card.labels.map((label) => label.name), ["Urgent", "Docs"]);
  assert.strictEqual(card.assignees[0].email, "dev@example.com");
  assert.strictEqual(card.completed, true);
  assert.strictEqual(card.startDate, "2026-08-25");
  assert.strictEqual(card.dueDate, "");

  const missing = parseCardMarkdown("# Card without metadata");
  assert.strictEqual(missing.position, null);
  assert.strictEqual(missing.assignees, null);
  assert.strictEqual(missing.completed, null);
  assert.strictEqual(missing.startDate, null);
  assert.strictEqual(missing.dueDate, null);
}

testLegacyChecklistMigration();
testRegisteredIconAndGenericFallback();
testChecklistItemNoteBody();
testNamedChecklistRoundTrip();
testCardParserAndAggregateStats();
testCardMetadataParsing();
console.log("helpers tests passed");
