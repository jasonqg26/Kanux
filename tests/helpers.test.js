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
  checklistItemNoteWithBody,
  checklistStats,
  checklistsToMarkdown,
  dependencyGate,
  iconButton,
  normalizeChecklists,
  normalizeDependencies,
  parseCardMarkdown,
  parseChecklists,
  parseDependencies,
  serializeDependencies,
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

  const managedWithNewBody = checklistItemNoteWithBody(managed, "## Acceptance criteria\n\n- Keep links working");
  assert.ok(managedWithNewBody.startsWith("---\nkanux-checklist-item: true\n"));
  assert.ok(managedWithNewBody.includes("# Review implementation\n\nCard: [[Board/Card|Card title]]"));
  assert.ok(managedWithNewBody.endsWith("## Acceptance criteria\n\n- Keep links working\n"));

  const externalWithNewBody = checklistItemNoteWithBody(external, "# Updated heading\n\nUpdated paragraph.");
  assert.ok(externalWithNewBody.startsWith("---\nowner: docs\n---\n"));
  assert.ok(externalWithNewBody.endsWith("# Updated heading\n\nUpdated paragraph.\n"));
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

function testChecklistIdentityRoundTrip() {
  const [group] = normalizeChecklists([
    {
      title: "Development",
      items: [
        { done: false, text: "Implement parser" },
        { done: true, text: "Review", assignee: { email: "dev@example.com", name: "Dev", color: "#123456" } },
      ],
    },
  ], []);
  assert.ok(/^checklist-/.test(group.id));
  assert.ok(group.items.every((item) => /^item-/.test(item.id)));

  const markdown = checklistsToMarkdown([group]);
  assert.ok(markdown.includes(`<!--kanux-checklist-id:${group.id}-->`));
  group.items.forEach((item) => assert.ok(markdown.includes(`<!--kanux-item-id:${item.id}-->`)));

  const [parsed] = normalizeChecklists(parseChecklists(markdown), []);
  assert.strictEqual(parsed.id, group.id);
  assert.deepStrictEqual(parsed.items.map((item) => item.id), group.items.map((item) => item.id));
  assert.strictEqual(parsed.title, "Development");
  assert.deepStrictEqual(parsed.items.map((item) => item.text), ["Implement parser", "Review"]);
  assert.strictEqual(parsed.items[1].assignee.email, "dev@example.com");
}

function testChecklistDescriptionRoundTrip() {
  const markdown = checklistsToMarkdown([{
    title: "Release",
    description: "Steps before shipping.\n# Not a heading\n- Not an item",
    items: [{ done: false, text: "Publish" }],
  }]);
  assert.ok(markdown.includes("Steps before shipping."));
  assert.ok(markdown.includes("\\# Not a heading"));
  assert.ok(markdown.includes("\\- Not an item"));

  const [parsed] = parseChecklists(markdown);
  assert.strictEqual(parsed.description, "Steps before shipping.\n# Not a heading\n- Not an item");
  assert.deepStrictEqual(parsed.items.map((item) => item.text), ["Publish"]);

  const handWritten = parseChecklists("### Notes\nContext paragraph.\n\n- [ ] Task\nTrailing loose line");
  assert.strictEqual(handWritten[0].description, "Context paragraph.");
  assert.deepStrictEqual(handWritten[0].items.map((item) => item.text), ["Task", "Trailing loose line"]);

  const descriptionOnly = parseChecklists("### Empty\nOnly context, no items yet.");
  assert.strictEqual(descriptionOnly[0].description, "Only context, no items yet.");
  assert.deepStrictEqual(descriptionOnly[0].items, []);

  const [normalized] = normalizeChecklists([{ title: "Plain", items: [] }], []);
  assert.strictEqual(normalized.description, "");
}

function testChecklistIdDeduplicationAndSanitizing() {
  const groups = normalizeChecklists([
    { id: "checklist-dup", title: "A", items: [{ id: "item-dup", text: "One" }, { id: "item-dup", text: "Two" }] },
    { id: "checklist-dup", title: "B", items: [{ id: "bad id!", text: "Three" }] },
  ], []);

  assert.strictEqual(groups[0].id, "checklist-dup");
  assert.notStrictEqual(groups[1].id, "checklist-dup");
  assert.strictEqual(groups[0].items[0].id, "item-dup");
  assert.notStrictEqual(groups[0].items[1].id, "item-dup");
  assert.ok(/^item-/.test(groups[1].items[0].id));
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
    "depends-on: card-1|warn,card-2|block",
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
  assert.deepStrictEqual(card.dependencies, [
    { cardId: "card-1", blocking: "warn" },
    { cardId: "card-2", blocking: "block" },
  ]);
  assert.strictEqual(card.completed, true);
  assert.strictEqual(card.startDate, "2026-08-25");
  assert.strictEqual(card.dueDate, "");

  const missing = parseCardMarkdown("# Card without metadata");
  assert.strictEqual(missing.position, null);
  assert.strictEqual(missing.assignees, null);
  assert.strictEqual(missing.dependencies, null);
  assert.strictEqual(missing.completed, null);
  assert.strictEqual(missing.startDate, null);
  assert.strictEqual(missing.dueDate, null);
}

function testDependencyNormalizationAndRoundTrip() {
  const dependencies = normalizeDependencies([
    { cardId: "card-1", blocking: "block" },
    { cardId: "card-1", blocking: "warn" },
    { cardId: "", blocking: "warn" },
    { cardId: "card 2", blocking: "warn" },
    { cardId: "card-3", blocking: "nonsense" },
  ]);

  // Duplicates keep the first entry, unusable ids are dropped, and an unknown
  // blocking mode falls back to the harmless default.
  assert.deepStrictEqual(dependencies, [
    { cardId: "card-1", blocking: "block" },
    { cardId: "card-3", blocking: "none" },
  ]);
  assert.strictEqual(serializeDependencies(dependencies), "card-1|block,card-3|none");
  assert.deepStrictEqual(parseDependencies("card-1|block, card-3|none"), dependencies);
  assert.deepStrictEqual(parseDependencies(""), []);
}

function testChecklistDependencyRoundTrip() {
  const markdown = checklistsToMarkdown([{
    id: "checklist-1",
    title: "Release",
    color: "#3b82f6",
    dependencies: [{ cardId: "card-9", blocking: "block" }],
    items: [{ id: "item-1", text: "Tag the build", done: false }],
  }]);
  assert.ok(markdown.includes("<!--kanux-checklist-depends:card-9|block-->"));

  const parsed = parseChecklists(markdown);
  assert.strictEqual(parsed[0].title, "Release");
  assert.deepStrictEqual(parsed[0].dependencies, [{ cardId: "card-9", blocking: "block" }]);
  assert.deepStrictEqual(parseChecklists("### Plain <!--kanux-checklist-id:checklist-2-->")[0].dependencies, []);
}

function testDependencyGateResolvesTheStrongestUnmetMode() {
  const cards = {
    "card-done": { id: "card-done", title: "Design QA", completed: true },
    "card-open": { id: "card-open", title: "Ship docs", completed: false },
  };
  const resolveCard = (cardId) => cards[cardId];

  const unmet = dependencyGate([{ cardId: "card-open", blocking: "none" }], resolveCard);
  assert.strictEqual(unmet.mode, "none");
  assert.deepStrictEqual(unmet.pending.map((entry) => entry.title), ["Ship docs"]);

  // The missing card is counted but never blocks, so the warning wins.
  const mixed = dependencyGate([
    { cardId: "card-open", blocking: "warn" },
    { cardId: "card-gone", blocking: "block" },
  ], resolveCard);
  assert.strictEqual(mixed.mode, "warn");
  assert.strictEqual(mixed.total, 2);
  assert.strictEqual(mixed.met, 0);
  assert.strictEqual(mixed.entries[1].status, "missing");

  const met = dependencyGate([{ cardId: "card-done", blocking: "block" }], resolveCard);
  assert.strictEqual(met.mode, "none");
  assert.strictEqual(met.met, 1);
  assert.strictEqual(met.entries[0].status, "done");
}

testLegacyChecklistMigration();
testRegisteredIconAndGenericFallback();
testChecklistItemNoteBody();
testNamedChecklistRoundTrip();
testChecklistIdentityRoundTrip();
testChecklistDescriptionRoundTrip();
testChecklistIdDeduplicationAndSanitizing();
testCardParserAndAggregateStats();
testCardMetadataParsing();
testDependencyNormalizationAndRoundTrip();
testChecklistDependencyRoundTrip();
testDependencyGateResolvesTheStrongestUnmetMode();
console.log("helpers tests passed");
