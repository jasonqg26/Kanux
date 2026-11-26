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

const {
  BoardAppearanceModal,
  CardModal,
  CardTemplateModal,
  openMemberPickerPopover,
  closeMemberPickerPopover,
  detailsMdToHtml,
  autoformatCommandForPrefix,
  inlineAutoformatMatch,
  splitDetailSegments,
} = require("../src/modals");
const { createEmbeddedMarkdownEditor } = require("../src/editor/embedded-editor");

/**
 * The Customize preview strip is painted by the board view's own painters. An
 * image background routes through a second helper on that mixin, so the strip
 * has to be painted with the whole mixin in hand, not a bare object that only
 * holds the plugin.
 */
function testAppearancePreviewPaintsImageBackground() {
  const properties = {};
  const root = {
    style: {
      setProperty(name, value) { properties[name] = value; },
      removeProperty(name) { delete properties[name]; },
    },
    classList: { toggle() {} },
    querySelectorAll() { return []; },
  };
  const modal = Object.create(BoardAppearanceModal.prototype);
  modal.codeStyleGroup = null;
  modal.plugin = { getAppearanceBackgroundResource: (background) => `app://vault/${background.imagePath}` };
  const appearance = {
    density: "normal",
    fontScale: 1,
    colorScheme: "theme",
    surfaceScheme: "theme",
    motion: { enabled: true },
    cards: { useTheme: true, background: "#25262a", hoverBackground: "#30343b", verticalGap: 8, borderRadius: 8, titleSize: 14, shadow: "medium" },
    lists: { useTheme: true, background: "#161719", columnGap: 12, topBorderWidth: 3, borderRadius: 8, showColorDot: true },
    codes: { style: "outline", color: "", placement: "inline" },
    labels: { displayMode: "compact", placement: "top", maxVisible: 3 },
    background: { type: "image", imagePath: "bg.png", imageSource: "vault", imageFit: "cover", overlayOpacity: 0.2 },
  };

  assert.doesNotThrow(() => modal.paintPreview(appearance, root));
  assert.ok(properties["background-image"].includes("url(\"app://vault/bg.png\")"));
  // A theme-coloured card hovers in a theme colour, never in the stored hex.
  assert.ok(properties["--ot-card-hover-background"].startsWith("color-mix("));
}

function testAppearancePreviewAppliesLabelDisplayMode() {
  const classes = new Set();
  const root = {
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      toggle(cls, force) {
        if (force) classes.add(cls);
        else classes.delete(cls);
      },
    },
    querySelectorAll(selector) {
      if (selector.includes("ot-card-code")) return [];
      if (selector.includes("data-has-preview-labels")) {
        return [{ querySelector() { return null; }, append() {}, prepend() {} }];
      }
      return [];
    },
  };
  const modal = Object.create(BoardAppearanceModal.prototype);
  modal.codeStyleGroup = null;
  modal.plugin = null;
  modal.syncPreviewLabels = function() {};

  for (const mode of ["compact", "hover", "card-hover", "expanded"]) {
    classes.clear();
    const appearance = {
      density: "normal",
      fontScale: 1,
      colorScheme: "theme",
      surfaceScheme: "theme",
      motion: { enabled: true },
      cards: { useTheme: true, background: "", hoverBackground: "", verticalGap: 8, borderRadius: 8, titleSize: 14, shadow: "none" },
      lists: { useTheme: true, background: "", columnGap: 12, topBorderWidth: 3, borderRadius: 8, showColorDot: true },
      codes: { style: "outline", color: "", placement: "inline" },
      labels: { displayMode: mode, placement: "top", maxVisible: 3 },
      background: { type: "none" },
    };
    modal.paintPreview(appearance, root);
    if (mode === "compact") assert.ok(classes.has("is-compact-labels"));
    if (mode === "hover") assert.ok(classes.has("is-hover-labels"));
    if (mode === "card-hover") assert.ok(classes.has("is-card-hover-labels"));
    if (mode === "expanded") {
      assert.strictEqual(classes.has("is-compact-labels"), false);
      assert.strictEqual(classes.has("is-hover-labels"), false);
      assert.strictEqual(classes.has("is-card-hover-labels"), false);
    }
  }
}

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

async function testAutoSaveKeepsTheEditingSessionOpen() {
  const modal = Object.create(CardModal.prototype);
  modal.localDetails = "Original";
  modal.detailsDraft = "Original and more";
  modal.editingDetails = true;
  modal.detailsEditDismissed = false;
  const written = [];
  modal.saveNow = async () => { written.push(modal.localDetails); };

  await modal.autoSaveDetails("  Original and more  ");

  // The text lands, but the session it was typed in carries on: the draft, the
  // editor and the caret all stay where the writer left them.
  assert.deepStrictEqual(written, ["Original and more"]);
  assert.strictEqual(modal.localDetails, "Original and more");
  assert.strictEqual(modal.editingDetails, true);
  assert.strictEqual(modal.detailsDraft, "Original and more");

  await modal.persistDetailsDraft("Original and more");
  assert.strictEqual(modal.editingDetails, false);
  assert.strictEqual(modal.detailsDraft, "");
  assert.strictEqual(modal.detailsEditDismissed, false);
}

/**
 * Autosave fires on every typing pause. If each one took an undo snapshot, a
 * paragraph would push every real board action off the 50-deep stack, so only
 * the first save of a session records one.
 */
async function testAutoSaveRecordsOneUndoPerEditingSession() {
  const modal = Object.create(CardModal.prototype);
  modal.localDetails = "";
  modal.detailsDraft = "";
  modal.editingDetails = true;
  modal.detailsEditDismissed = false;
  modal.detailsUndoRecorded = false;
  const snapshots = [];
  modal.saveNow = async (options) => { snapshots.push(options.recordUndo); };

  await modal.autoSaveDetails("One");
  await modal.autoSaveDetails("One two");
  await modal.autoSaveDetails("One two three");
  assert.deepStrictEqual(snapshots, [true, false, false]);

  // The closing save belongs to the session it closes, so it does not snapshot
  // either; only the edit that comes after does. Undo therefore steps back one
  // description at a time rather than one keystroke at a time.
  await modal.persistDetailsDraft("One two three");
  assert.strictEqual(modal.detailsUndoRecorded, false);
  await modal.autoSaveDetails("A second session");
  assert.deepStrictEqual(snapshots, [true, false, false, false, true]);
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

function makePopoverMockDom() {
  const createNode = (tagName) => {
    const classes = new Set();
    const listeners = {};
    const node = {
      tagName: String(tagName || "div").toUpperCase(),
      children: [],
      textContent: "",
      value: "",
      type: "",
      placeholder: "",
      attributes: {},
      style: { properties: {}, setProperty(k, v) { this.properties[k] = v; } },
      classList: {
        add(...names) { names.forEach((n) => classes.add(n)); },
        remove(...names) { names.forEach((n) => classes.delete(n)); },
        toggle(name, force) {
          if (force === undefined) {
            if (classes.has(name)) classes.delete(name);
            else classes.add(name);
            return classes.has(name);
          }
          if (force) classes.add(name);
          else classes.delete(name);
          return force;
        },
        contains(name) { return classes.has(name); },
      },
      set className(val) {
        classes.clear();
        String(val || "").split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
      },
      get className() { return Array.from(classes).join(" "); },
      append(...items) { items.forEach((item) => { if (item) node.children.push(item); }); },
      prepend(...items) { items.slice().reverse().forEach((item) => { if (item) node.children.unshift(item); }); },
      replaceChildren(...items) { node.children = items.filter(Boolean); },
      setAttribute(k, v) { node.attributes[k] = v; },
      addEventListener(eventName, fn) {
        listeners[eventName] = listeners[eventName] || [];
        listeners[eventName].push(fn);
      },
      dispatch(eventName, event = {}) {
        (listeners[eventName] || []).forEach((fn) => fn(Object.assign({ preventDefault() {}, stopPropagation() {} }, event)));
      },
      click() { node.dispatch("click"); },
      focus() {},
      remove() {
        const idx = body.children.indexOf(node);
        if (idx >= 0) body.children.splice(idx, 1);
      },
      contains(target) {
        if (target === node) return true;
        return node.children.some((child) => child && typeof child.contains === "function" && child.contains(target));
      },
      getBoundingClientRect() { return { top: 40, bottom: 60, left: 20, right: 120, width: 100, height: 120 }; },
      querySelector(selector) {
        return node.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        const out = [];
        const cls = selector.startsWith(".") ? selector.slice(1) : "";
        const walk = (curr) => {
          if (cls && curr.classList && curr.classList.contains(cls)) out.push(curr);
          (curr.children || []).forEach(walk);
        };
        walk(node);
        return out;
      },
    };
    return node;
  };
  const body = createNode("body");
  return {
    body,
    createElement: createNode,
    addEventListener() {},
    removeEventListener() {},
  };
}

async function testMemberPickerFiltersAndCreatesInlineMembers() {
  const prevDoc = global.document;
  global.document = makePopoverMockDom();

  const members = [{ email: "alice", name: "Alice", color: "#3b82f6", picture: "" }];
  let selected = [];
  const plugin = {
    getVaultMembers: () => members,
    resolveMember: (m) => m,
    getMemberPicture: () => "",
  };
  const anchor = global.document.createElement("button");

  const pop = openMemberPickerPopover({
    anchor,
    plugin,
    getSelected: () => selected,
    multiSelect: true,
    onToggle: (member) => {
      selected = selected.some((s) => s.email === member.email)
        ? selected.filter((s) => s.email !== member.email)
        : [...selected, member];
    },
    onCreateMember: async (name) => {
      const created = { email: name, name, color: "#22c55e", picture: "" };
      members.push(created);
      selected.push(created);
    },
  });

  const search = pop.querySelectorAll(".ot-member-picker-search")[0];
  assert.ok(search);
  assert.strictEqual(pop.querySelectorAll(".ot-member-picker-row").length, 1);

  search.value = "Bob";
  search.dispatch("input");
  const createRows = pop.querySelectorAll(".ot-member-picker-create");
  assert.strictEqual(createRows.length, 1);
  assert.ok(createRows[0].children[1].textContent.includes("Bob"));

  await createRows[0].click();
  assert.strictEqual(members.length, 2);
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].name, "Bob");

  closeMemberPickerPopover();
  global.document = prevDoc;
}

function testCardAndTemplateModalsRenderMembersWithoutSyncDeck() {
  const prevDoc = global.document;
  global.document = makePopoverMockDom();

  const modal = Object.create(CardModal.prototype);
  modal.plugin = {
    isSyncDeckEnabled: () => false,
    getVaultMembers: () => [],
    resolveMember: (m) => m,
    getMemberPicture: () => "",
    findBoardForCard: () => null,
    cardDependencyGate: () => ({ entries: [], pending: [], total: 0, met: 0, mode: "none" }),
  };
  modal.card = { id: "c1", title: "Task", checklists: [], labels: [], assignees: [{ email: "Alice", name: "Alice", color: "#3b82f6" }] };
  modal.localTitle = "Task";
  modal.localLabels = [];
  modal.localGlobalLabels = [];
  modal.localAssignees = [{ email: "Alice", name: "Alice", color: "#3b82f6" }];
  modal.localDetails = "";
  modal.detailsDraft = "";
  modal.editingDetails = false;
  modal.localChecklists = [];
  modal.localDependencies = [];
  modal.notesOnly = false;
  modal.embeddedEditors = [];
  modal.destroyEmbeddedEditors = () => {};
  modal.closeSideSheet = () => {};
  modal.contentEl = global.document.createElement("div");
  modal.contentEl.addClass = (c) => modal.contentEl.classList.add(c);
  modal.modalEl = global.document.createElement("div");
  modal.modalEl.addClass = (c) => modal.modalEl.classList.add(c);
  modal.renderDetailsField = () => global.document.createElement("div");
  modal.renderChecklistField = () => global.document.createElement("div");
  modal.renderDependenciesField = () => global.document.createElement("div");

  const prevRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = () => {};
  modal.render();
  assert.strictEqual(modal.contentEl.classList.contains("is-sync-disabled"), false);
  assert.strictEqual(modal.contentEl.querySelectorAll(".ot-assignee-editor").length, 1);
  assert.strictEqual(modal.contentEl.querySelectorAll(".ot-assignee-chip").length, 1);

  const tpl = Object.create(CardTemplateModal.prototype);
  tpl.plugin = modal.plugin;
  tpl.board = { id: "b1", lists: [{ id: "l1", title: "Todo" }] };
  tpl.template = { title: "Bug", listId: "l1", labels: [], assignees: [{ email: "Bob", name: "Bob", color: "#22c55e" }], details: "", checklists: [], numbering: null };
  tpl.globalLabels = [];
  tpl.numberingDraft = { prefix: "", separator: "dash", next: 1, pad: 3 };
  tpl.contentEl = global.document.createElement("div");
  tpl.contentEl.addClass = (c) => tpl.contentEl.classList.add(c);
  tpl.modalEl = global.document.createElement("div");
  tpl.modalEl.addClass = (c) => tpl.modalEl.classList.add(c);
  tpl.buildHeader = () => global.document.createElement("div");
  tpl.buildActions = () => global.document.createElement("div");
  tpl.titleInput = { focus() {} };
  tpl.onOpen();
  global.requestAnimationFrame = prevRaf;

  assert.strictEqual(tpl.contentEl.querySelectorAll(".ot-assignee-row").length, 1);
  assert.strictEqual(tpl.contentEl.querySelectorAll(".ot-assignee-chip").length, 1);
  global.document = prevDoc;
}

async function run() {
  testEmptyDescriptionCanStayClosed();
  testChecklistNoteDraftLifecycle();
  testDescriptionMarkdownFormatting();
  testDescriptionAutoformatTriggers();
  testInlineAutoformatMatching();
  testEmbeddedEditorFallsBackWithoutInternalApi();
  testDescriptionImageSegmentation();
  testAppearancePreviewPaintsImageBackground();
  testAppearancePreviewAppliesLabelDisplayMode();
  await testExplicitSaveReportsFailureWithoutPoisoningQueue();
  await testDescriptionSaveRollsBackAfterFailure();
  await testAutoSaveKeepsTheEditingSessionOpen();
  await testAutoSaveRecordsOneUndoPerEditingSession();
  await testPendingDescriptionAttachmentsFollowSaveAndCancel();
  await testMemberPickerFiltersAndCreatesInlineMembers();
  testCardAndTemplateModalsRenderMembersWithoutSyncDeck();
  console.log("modals tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
