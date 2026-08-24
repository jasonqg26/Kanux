const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") return { setIcon() {} };
  return originalLoad.call(this, request, parent, isMain);
};

const {
  checklistItems,
  checklistItemNoteBody,
  checklistStats,
  checklistsToMarkdown,
  parseCardMarkdown,
  parseChecklists,
} = require("../src/helpers");

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

testLegacyChecklistMigration();
testChecklistItemNoteBody();
testNamedChecklistRoundTrip();
testCardParserAndAggregateStats();
console.log("helpers tests passed");
