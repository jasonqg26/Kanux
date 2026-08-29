const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
class ObsidianBase {
  constructor(app) {
    this.app = app;
  }
}

Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      FuzzySuggestModal: ObsidianBase,
      MarkdownRenderer: { render() {} },
      Menu: ObsidianBase,
      Modal: ObsidianBase,
      Notice: class {},
      Setting: ObsidianBase,
      arrayBufferToBase64() {},
      getIcon() { return null; },
      setIcon() {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { CardModal, detailsMdToHtml, autoformatCommandForPrefix, inlineAutoformatMatch, splitDetailSegments } = require("../src/modals");
const { createEmbeddedMarkdownEditor } = require("../src/editor/embedded-editor");

function testEmptyDescriptionCanStayClosed() {
  const modal = Object.create(CardModal.prototype);
  modal.localDetails = "";
  modal.readOnly = false;
  modal.editingDetails = false;
  modal.detailsEditDismissed = false;

  assert.strictEqual(modal.shouldEditDetails(), true);
  modal.detailsEditDismissed = true;
  assert.strictEqual(modal.shouldEditDetails(), false);
  modal.editingDetails = true;
  assert.strictEqual(modal.shouldEditDetails(), true);
  modal.readOnly = true;
  assert.strictEqual(modal.shouldEditDetails(), false);
}

function testChecklistNoteDraftLifecycle() {
  const modal = Object.create(CardModal.prototype);
  modal.checklistNoteDrafts = new Map();
  modal.editingChecklistNotes = new Set();

  modal.beginChecklistNoteEdit("Checklist item.md", "Original");
  modal.updateChecklistNoteDraft("Checklist item.md", "Unsaved **change**");
  assert.strictEqual(modal.checklistNoteDrafts.get("Checklist item.md"), "Unsaved **change**");
  assert.strictEqual(modal.editingChecklistNotes.has("Checklist item.md"), true);

  modal.finishChecklistNoteEdit("Checklist item.md");
  assert.strictEqual(modal.checklistNoteDrafts.has("Checklist item.md"), false);
  assert.strictEqual(modal.editingChecklistNotes.has("Checklist item.md"), false);
}

function testDescriptionMarkdownFormatting() {
  const html = detailsMdToHtml([
    "### Plan",
    "",
    "1. First",
    "2. **Second**",
    "",
    "> Review <unsafe>",
  ].join("\n"));

  assert.ok(html.includes("<h3>Plan</h3>"));
  assert.ok(html.includes("<ol><li>First</li><li><strong>Second</strong></li></ol>"));
  assert.ok(html.includes("&lt;unsafe&gt;"));
  assert.ok(!html.includes("<unsafe>"));

  const windowsLineEndings = detailsMdToHtml("### Windows\r\n\r\n- First\r\n- Second");
  assert.strictEqual(windowsLineEndings, "<h3>Windows</h3><ul><li>First</li><li>Second</li></ul>");

  assert.strictEqual(detailsMdToHtml("Keep ~~dropped~~ text"), "<p>Keep <s>dropped</s> text</p>");
}

function testDescriptionAutoformatTriggers() {
  assert.strictEqual(autoformatCommandForPrefix("-").command, "insertUnorderedList");
  assert.strictEqual(autoformatCommandForPrefix("*").command, "insertUnorderedList");
  assert.strictEqual(autoformatCommandForPrefix("1.").command, "insertOrderedList");
  assert.strictEqual(autoformatCommandForPrefix("1)").command, "insertOrderedList");
  assert.deepStrictEqual(autoformatCommandForPrefix(">"), { command: "formatBlock", value: "blockquote" });
  assert.deepStrictEqual(autoformatCommandForPrefix("##"), { command: "formatBlock", value: "h2" });
  assert.strictEqual(autoformatCommandForPrefix("2."), null);
  assert.strictEqual(autoformatCommandForPrefix("mid-line -"), null);
  assert.strictEqual(autoformatCommandForPrefix(""), null);
}

function testInlineAutoformatMatching() {
  assert.deepStrictEqual(inlineAutoformatMatch("Note **bold**"), { tag: "strong", span: "**bold**", content: "bold" });
  assert.deepStrictEqual(inlineAutoformatMatch("Note *italic*"), { tag: "em", span: "*italic*", content: "italic" });
  assert.deepStrictEqual(inlineAutoformatMatch("Note ~~gone~~"), { tag: "s", span: "~~gone~~", content: "gone" });
  assert.deepStrictEqual(inlineAutoformatMatch("Note `code`"), { tag: "code", span: "`code`", content: "code" });

  assert.strictEqual(inlineAutoformatMatch("Unfinished **bold"), null);
  assert.strictEqual(inlineAutoformatMatch("Half-closed **bold*"), null);
  assert.strictEqual(inlineAutoformatMatch("Empty ****"), null);
  assert.strictEqual(inlineAutoformatMatch("Whitespace-only ** **"), null);
  assert.strictEqual(inlineAutoformatMatch(""), null);
}

function testEmbeddedEditorFallsBackWithoutInternalApi() {
  assert.strictEqual(createEmbeddedMarkdownEditor({ embedRegistry: undefined }, null, {}), null);
  // After the internal API is found missing, it stays disabled for the session.
  assert.strictEqual(createEmbeddedMarkdownEditor({}, null, {}), null);
}

function testDescriptionImageSegmentation() {
  const segments = splitDetailSegments([
    "Before",
    "![[attachments/image.png|320]]",
    "[ordinary link](note.md)",
    "![Remote](https://example.com/photo.jpg)",
  ].join("\n\n"));

  assert.deepStrictEqual(segments.filter((segment) => segment.type === "img").map((segment) => segment.target), [
    "attachments/image.png",
    "https://example.com/photo.jpg",
  ]);
  assert.ok(segments.some((segment) => segment.type === "md" && segment.text.includes("[ordinary link](note.md)")));
}

async function testExplicitSaveReportsFailureWithoutPoisoningQueue() {
  const modal = Object.create(CardModal.prototype);
  modal.saveTimer = null;
  modal.readOnly = false;
  modal.card = { id: "card-1" };
  modal.localGlobalLabels = [];
  modal.cardPatch = () => ({ details: "Draft" });
  modal.savePromise = Promise.resolve();
  modal.plugin = { updateCard: async () => { throw new Error("save failed"); } };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => modal.saveNow({ propagateError: true }), /save failed/);
    await modal.savePromise;
  } finally {
    console.error = originalConsoleError;
  }

  let saved = false;
  modal.plugin.updateCard = async () => { saved = true; };
  await modal.saveNow({ propagateError: true });
  assert.strictEqual(saved, true);
}

async function testDescriptionSaveRollsBackAfterFailure() {
  const modal = Object.create(CardModal.prototype);
  modal.localDetails = "Saved description";
  modal.detailsDraft = "Unsaved description";
  modal.editingDetails = true;
  modal.detailsEditDismissed = false;
  modal.saveNow = async () => { throw new Error("save failed"); };

  await assert.rejects(() => modal.persistDetailsDraft("Unsaved description"), /save failed/);
  assert.strictEqual(modal.localDetails, "Saved description");
  assert.strictEqual(modal.detailsDraft, "Unsaved description");
  assert.strictEqual(modal.editingDetails, true);

  modal.saveNow = async () => {};
  await modal.persistDetailsDraft("Saved on retry");
  assert.strictEqual(modal.localDetails, "Saved on retry");
  assert.strictEqual(modal.detailsDraft, "");
  assert.strictEqual(modal.editingDetails, false);
}

async function testPendingDescriptionAttachmentsFollowSaveAndCancel() {
  const trashed = [];
  const modal = Object.create(CardModal.prototype);
  modal.pendingDetailAttachments = new Set([
    "Board/attachments/kept.png",
    "Board/attachments/removed.png",
  ]);
  modal.app = {
    vault: {
      getAbstractFileByPath(path) { return { path }; },
      async trash(file) { trashed.push(file.path); },
    },
  };

  await modal.finalizePendingDetailAttachments("![[Board/attachments/kept.png]]");
  assert.deepStrictEqual(trashed, ["Board/attachments/removed.png"]);
  assert.strictEqual(modal.pendingDetailAttachments.size, 0);

  modal.pendingDetailAttachments.add("Board/attachments/cancelled.png");
  await modal.discardPendingDetailAttachments();
  assert.deepStrictEqual(trashed, [
    "Board/attachments/removed.png",
    "Board/attachments/cancelled.png",
  ]);
  assert.strictEqual(modal.pendingDetailAttachments.size, 0);
}

async function run() {
  testEmptyDescriptionCanStayClosed();
  testChecklistNoteDraftLifecycle();
  testDescriptionMarkdownFormatting();
  testDescriptionAutoformatTriggers();
  testInlineAutoformatMatching();
  testEmbeddedEditorFallsBackWithoutInternalApi();
  testDescriptionImageSegmentation();
  await testExplicitSaveReportsFailureWithoutPoisoningQueue();
  await testDescriptionSaveRollsBackAfterFailure();
  await testPendingDescriptionAttachmentsFollowSaveAndCancel();
  console.log("modals tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
