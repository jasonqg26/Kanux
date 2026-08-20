const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") return { setIcon() {} };
  return originalLoad.call(this, request, parent, isMain);
};

const {
  checklistItems,
  checklistStats,
  checklistsToMarkdown,
  parseCardMarkdown,
  parseChecklists,
} = require("../src/helpers");

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
      items: [
        { done: true, text: "Implement parser", assignee: null },
        { done: false, text: "Review", assignee: { email: "dev@example.com", name: "Dev", color: "#123456" } },
      ],
    },
    { title: "Release", items: [{ done: false, text: "Publish", assignee: null }] },
  ];
  const markdown = checklistsToMarkdown(source);
  const parsed = parseChecklists(markdown);

  assert.deepStrictEqual(parsed.map((group) => group.title), ["Development", "Release"]);
  assert.deepStrictEqual(parsed.map((group) => group.items.map((item) => item.text)), [
    ["Implement parser", "Review"],
    ["Publish"],
  ]);
  assert.strictEqual(parsed[0].items[1].assignee.email, "dev@example.com");

  const empty = parseChecklists(checklistsToMarkdown([{ title: "Empty group", items: [] }]));
  assert.strictEqual(empty.length, 1);
  assert.strictEqual(empty[0].title, "Empty group");
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
testNamedChecklistRoundTrip();
testCardParserAndAggregateStats();
console.log("helpers tests passed");
