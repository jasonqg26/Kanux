const { FuzzySuggestModal, MarkdownRenderer, Menu, Modal, Notice, Setting, arrayBufferToBase64, setIcon } = require("obsidian");

// Modal UIs for cards, labels, dates, prompts, and the short about panel.
const {
  DEFAULT_LABEL_COLOR,
  LABEL_COLORS,
  LIST_COLORS,
  addMonths,
  addButtonIcon,
  checklistItemNoteBody,
  checklistItemNoteWithBody,
  checklistStats,
  cardFileBaseName,
  cleanDate,
  cleanColor,
  cleanLabelName,
  clone,
  createElement,
  dateFromISO,
  dateRangeLabel,
  fieldDateLabel,
  hasDragType,
  iconButton,
  imageSizeFromMarkup,
  imageMarkupWithSize,
  isImagePath,
  isoFromDate,
  labelKey,
  normalizeChecklists,
  textButton,
  textLine,
  initials,
  uid,
} = require("./helpers");

const { createEmbeddedMarkdownEditor } = require("./embedded-editor");

// ---- Markdown <-> HTML for the WYSIWYG description blocks ----
// A deliberately SMALL, symmetric subset (paragraphs, line breaks, #-headings,
// -/1. lists, > quotes, ---, **bold**, *italic*, ~~strike~~, `code`, [link](url)) so that
// md -> html -> md round-trips bytes for everything these converters produce.
// Unrecognized markdown stays literal text and survives untouched.
function escapeDetailsHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMdToHtml(text) {
  let out = escapeDetailsHtml(text);
  out = out.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (match, target, alias) => {
    const hasAlias = alias != null;
    const label = hasAlias ? alias : target.split("/").pop();
    return `<a class="internal-link" data-wikilink="true" data-has-alias="${hasAlias ? "true" : "false"}" data-href="${target}" href="${target}">${label}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function detailsMdToHtml(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let para = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(inlineMdToHtml).join("<br>")}</p>`);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flushPara(); i += 1; continue; }
    if (/^-{3,}\s*$/.test(line)) { flushPara(); html.push("<hr>"); i += 1; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${inlineMdToHtml(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^\d+[.)]\s+/, ""))}</li>`);
        i += 1;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(inlineMdToHtml(lines[i].replace(/^>\s?/, "")));
        i += 1;
      }
      // One <p> per quoted line (empty lines keep a <br> so they hold a caret):
      // per-line wrappers are what lets the editor's Enter-on-empty-line escape
      // detect the current line inside the quote.
      html.push(`<blockquote>${quoted.map((q) => `<p>${q || "<br>"}</p>`).join("")}</blockquote>`);
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return html.join("");
}

// Serialize a contenteditable's DOM back to the same markdown subset. Unknown
// wrappers (span/font/...) are flattened to their text, so pasted styling can't
// leak HTML into the note.
function detailsHtmlToMd(root) {
  const BLOCK_TAGS = /^(P|DIV|UL|OL|BLOCKQUOTE|HR|H[1-6])$/;
  const inline = (node) => {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { out += child.textContent; return; }
      if (child.nodeType !== 1) return;
      // Live-preview markers (the "#" shown while the caret is on a heading
      // line) are visual only — the heading tag already encodes them.
      if (child.classList && child.classList.contains("ot-md-token")) return;
      const tag = child.tagName;
      if (tag === "BR") { out += "\n"; return; }
      const inner = inline(child);
      if (tag === "B" || tag === "STRONG") out += inner.trim() ? `**${inner}**` : inner;
      else if (tag === "I" || tag === "EM") out += inner.trim() ? `*${inner}*` : inner;
      else if (tag === "S" || tag === "DEL" || tag === "STRIKE") out += inner.trim() ? `~~${inner}~~` : inner;
      else if (tag === "CODE") out += inner.trim() ? `\`${inner}\`` : inner;
      else if (tag === "A" && child.dataset.wikilink === "true") {
        const target = child.dataset.href || child.getAttribute("href") || "";
        out += child.dataset.hasAlias === "true" ? `[[${target}|${inner || target}]]` : `[[${target}]]`;
      }
      else if (tag === "A") out += `[${inner || child.getAttribute("href") || "link"}](${child.getAttribute("href") || ""})`;
      else out += inner;
    });
    return out;
  };
  // Chromium freely nests blocks (a <ul> inside the caret's <p>, a quote inside
  // a <div>...), so serialization must RECURSE into containers — flattening a
  // wrapped list through inline() used to glue every item into one word.
  const serializeChildren = (node, parts) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        if (child.textContent.trim()) parts.push(child.textContent);
        return;
      }
      if (child.nodeType !== 1) return;
      if (BLOCK_TAGS.test(child.tagName)) serializeBlock(child, parts);
      else {
        const text = inline({ childNodes: [child] });
        if (text.trim()) parts.push(text);
      }
    });
  };
  const serializeBlock = (el, parts) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      parts.push(`${"#".repeat(Number(tag[1]))} ${inline(el)}`);
      return;
    }
    if (tag === "UL" || tag === "OL") {
      const lines = [];
      let n = 1;
      el.querySelectorAll(":scope > li").forEach((li) => {
        const nestedBlocks = Array.from(li.children).filter((c) => BLOCK_TAGS.test(c.tagName));
        const inlineOnly = { childNodes: Array.from(li.childNodes).filter((c) => !(c.nodeType === 1 && BLOCK_TAGS.test(c.tagName))) };
        lines.push(tag === "UL" ? `- ${inline(inlineOnly)}` : `${n++}. ${inline(inlineOnly)}`);
        // Nested lists/blocks inside an item flatten to sibling lines.
        nestedBlocks.forEach((nested) => {
          const sub = [];
          serializeBlock(nested, sub);
          sub.forEach((line) => lines.push(line));
        });
      });
      parts.push(lines.join("\n"));
      return;
    }
    if (tag === "BLOCKQUOTE") {
      const sub = [];
      serializeChildren(el, sub);
      const flat = sub.length ? sub.join("\n") : inline(el);
      parts.push(flat.split("\n").map((l) => `> ${l}`).join("\n"));
      return;
    }
    if (tag === "HR") { parts.push("---"); return; }
    // P/DIV: a real paragraph when it only holds inline content; a transparent
    // container when Chromium nested block elements inside it.
    const hasBlockChild = Array.from(el.children || []).some((c) => BLOCK_TAGS.test(c.tagName));
    if (hasBlockChild) { serializeChildren(el, parts); return; }
    const text = inline(el);
    if (text.trim()) parts.push(text);
  };
  const parts = [];
  serializeChildren(root, parts);
  return parts.join("\n\n").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Notion-style autoformat triggers for the description editor: typing one of
// these at the start of a line and pressing Space converts the line into the
// matching block instead of leaving raw markdown markers in the text.
const DETAILS_AUTOFORMAT_COMMANDS = {
  "-": { command: "insertUnorderedList" },
  "*": { command: "insertUnorderedList" },
  "1.": { command: "insertOrderedList" },
  "1)": { command: "insertOrderedList" },
  ">": { command: "formatBlock", value: "blockquote" },
  "#": { command: "formatBlock", value: "h1" },
  "##": { command: "formatBlock", value: "h2" },
  "###": { command: "formatBlock", value: "h3" },
};

function autoformatCommandForPrefix(prefix) {
  return DETAILS_AUTOFORMAT_COMMANDS[prefix] || null;
}

// Inline live-preview triggers: finishing "**bold**", "*italic*", "~~strike~~"
// or "`code`" right before the caret formats the run in place, Obsidian-style.
const INLINE_AUTOFORMAT_RULES = [
  { pattern: /\*\*([^*\n]+)\*\*$/, tag: "strong" },
  { pattern: /~~([^~\n]+)~~$/, tag: "s" },
  { pattern: /`([^`\n]+)`$/, tag: "code" },
  { pattern: /(?<!\*)\*([^*\n]+)\*$/, tag: "em" },
];

function inlineAutoformatMatch(textBeforeCaret) {
  for (const rule of INLINE_AUTOFORMAT_RULES) {
    const match = String(textBeforeCaret || "").match(rule.pattern);
    if (!match || !match[1].trim()) continue;
    return { tag: rule.tag, span: match[0], content: match[1] };
  }
  return null;
}

// Drag payload type for reordering image blocks inside the description editor.
const IMG_BLOCK_DRAG_TYPE = "application/x-kanux-image-block";

// Debounce for keystroke-driven card saves.
const SAVE_DEBOUNCE_MS = 350;
// Re-acquire the card lock well within its server TTL so it never lapses mid-edit.
const LOCK_HEARTBEAT_MS = 5000;

// setIcon throws when an icon name is unknown to the running Obsidian version;
// fall back to plain text so the control still reads.
function setIconSafe(el, icon, fallbackText = "") {
  try {
    setIcon(el, icon);
  } catch (error) {
    el.textContent = fallbackText;
  }
}

// Grid of clickable color swatches; the selected color is marked with a check.
function colorSwatchGrid(colors, selectedColor, onPick) {
  const swatches = createElement("div", "ot-label-color-grid");
  colors.forEach((color) => {
    const swatch = createElement("button", "ot-label-color-swatch");
    swatch.type = "button";
    swatch.style.backgroundColor = color;
    swatch.setAttribute("aria-label", color);
    if (color === selectedColor) {
      swatch.classList.add("is-selected");
      setIconSafe(swatch, "check", "✓");
    }
    swatch.addEventListener("click", () => onPick(color));
    swatches.append(swatch);
  });
  return swatches;
}

// The run of consecutive image entries around `index` (entries matching isGap
// between images don't break the run) — the group a grid layout applies to.
function imageRunAround(items, index, isGap) {
  if (!items[index] || items[index].type !== "img") return [];
  let start = index;
  while (start - 1 >= 0) {
    if (items[start - 1].type === "img") { start -= 1; continue; }
    if (isGap(items[start - 1]) && start - 2 >= 0 && items[start - 2].type === "img") { start -= 2; continue; }
    break;
  }
  const run = [];
  for (let i = start; i < items.length; i += 1) {
    if (items[i].type === "img") { run.push(items[i]); continue; }
    if (isGap(items[i]) && items[i + 1] && items[i + 1].type === "img") continue;
    break;
  }
  return run;
}

const isBlankMdSegment = (seg) => seg.type === "md" && !seg.text.trim();
const isBlankTextBlock = (block) => block.type === "text" && !block.value.trim();

// Pull image files out of a paste/drop DataTransfer (empty if none).
function imageFilesFromTransfer(dt) {
  if (!dt) return [];
  const out = [];
  if (dt.files && dt.files.length) {
    for (const file of Array.from(dt.files)) {
      if (file && file.type && file.type.startsWith("image/")) out.push(file);
    }
  }
  if (!out.length && dt.items && dt.items.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) out.push(file);
      }
    }
  }
  return out;
}

// Timestamp for auto-named pasted images, e.g. 20260706T....
function imageStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeImageFileName(rawName, fallbackExt) {
  const clean = textLine(rawName);
  const match = clean.match(/\.([a-z0-9]+)$/i);
  const ext = textLine(match ? match[1] : fallbackExt || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const base = match ? clean.slice(0, -match[0].length) : clean;
  return `${cardFileBaseName(base || `Pasted image ${imageStamp()}`)}.${ext}`;
}

/**
 * Small reusable text prompt for list names and other one-field actions.
 */
class TextPromptModal extends Modal {
  constructor(app, title, placeholder, initialValue, onSubmit) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.initialValue = initialValue || "";
    this.onSubmit = onSubmit;
    this.submitting = false;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-prompt-modal");

    this.contentEl.append(createElement("h2", "", this.title));

    const input = createElement("input", "ot-input");
    input.type = "text";
    input.placeholder = this.placeholder;
    input.value = this.initialValue;
    this.contentEl.append(input);

    const actions = createElement("div", "ot-modal-actions");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta ot-save-button", "Save");
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");
    cancel.type = "button";
    save.type = "button";

    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", () => this.submit(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit(input.value);
      }
    });

    actions.append(cancel, save);
    this.contentEl.append(actions);

    requestAnimationFrame(() => input.focus());
  }

  submit(value) {
    if (this.submitting) return;
    const cleanValue = textLine(value);
    if (!cleanValue) {
      new Notice("Name cannot be empty.");
      return;
    }

    this.submitting = true;
    this.close();
    Promise.resolve(this.onSubmit(cleanValue)).catch((error) => {
      console.error(error);
      new Notice("Could not save.");
    });
  }
}

class ConfirmModal extends Modal {
  constructor(app, title, message, resolve) {
    super(app);
    this.title = title;
    this.message = message;
    this.resolve = resolve;
    this.settled = false;
  }

  onOpen() {
    this.modalEl.addClass("ot-confirm-modal-shell");
    this.contentEl.addClass("ot-confirm-modal");
    const heading = createElement("div", "ot-confirm-heading");
    heading.append(createElement("h2", "", this.title));

    const message = createElement("p", "ot-confirm-message", this.message);
    const warning = createElement("p", "ot-confirm-warning", "This action cannot be undone.");
    const actions = createElement("div", "ot-confirm-actions");
    const cancel = createElement("button", "", "Cancel");
    const confirm = createElement("button", "mod-warning", "Delete");
    cancel.type = "button";
    confirm.type = "button";
    addButtonIcon(cancel, "x");
    addButtonIcon(confirm, "trash-2");
    cancel.addEventListener("click", () => this.finish(false));
    confirm.addEventListener("click", () => this.finish(true));
    actions.append(cancel, confirm);
    this.contentEl.replaceChildren(heading, message, warning, actions);
    requestAnimationFrame(() => cancel.focus());
  }

  finish(confirmed) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }

  onClose() {
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
  }
}

function confirmAction(app, title, message) {
  if (!app || !app.workspace) return Promise.resolve(true);
  return new Promise((resolve) => new ConfirmModal(app, title, message, resolve).open());
}

/** Lets the description editor link any Markdown note already in the vault. */
class VaultNoteSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Search Markdown notes in this vault...");
  }

  getItems() {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file) {
    return file.path.replace(/\.md$/i, "");
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

/**
 * Label picker and label editor.
 *
 * The modal keeps local copies of global labels and selected labels, then sends
 * both back through onChange so the card modal can save them together.
 */
class LabelPickerModal extends Modal {
  constructor(app, labels, selectedLabels, onChange, onDelete = null) {
    super(app);
    this.labels = clone(labels || []);
    this.selectedLabels = clone(selectedLabels || []);
    this.onChange = onChange;
    this.onDelete = onDelete;
    this.resetCreateForm();
  }

  onOpen() {
    this.render();
  }

  resetCreateForm() {
    this.creating = false;
    this.editingKey = null;
    this.query = "";
    this.createName = "";
    this.createColor = DEFAULT_LABEL_COLOR;
  }

  isSelected(label) {
    const key = labelKey(label);
    return this.selectedLabels.some((item) => labelKey(item) === key);
  }

  emitChange(options = {}) {
    this.onChange(clone(this.labels), clone(this.selectedLabels), options);
  }

  dedupeLabels(labels) {
    const seen = new Set();
    return (labels || []).filter((label) => {
      const key = labelKey(label);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  toggleLabel(label) {
    if (this.isSelected(label)) {
      this.selectedLabels = this.selectedLabels.filter((item) => labelKey(item) !== labelKey(label));
    } else {
      this.selectedLabels.push(clone(label));
    }
    this.emitChange();
    this.render();
  }

  /**
   * Creates or updates a global label and keeps selected labels in sync.
   */
  createLabel(name, color) {
    const cleanName = textLine(name);
    if (!cleanName) return;

    const label = { name: cleanName, color: color || DEFAULT_LABEL_COLOR };
    if (this.editingKey) {
      const oldKey = this.editingKey;
      const update = (item) => (labelKey(item) === oldKey ? clone(label) : item);
      this.labels = this.dedupeLabels(this.labels.map(update));
      this.selectedLabels = this.dedupeLabels(this.selectedLabels.map(update));
    } else {
      const existing = this.labels.find((item) => labelKey(item) === labelKey(cleanName));
      const nextLabel = existing || label;
      if (!existing) this.labels.push(nextLabel);
      if (!this.isSelected(nextLabel)) this.selectedLabels.push(clone(nextLabel));
    }

    this.resetCreateForm();
    this.emitChange();
    this.render();
  }

  editLabel(label) {
    this.creating = true;
    this.editingKey = labelKey(label);
    this.createName = label.name;
    this.createColor = label.color || DEFAULT_LABEL_COLOR;
    this.render();
  }

  async deleteLabel(label) {
    if (!label || !this.onDelete) return false;
    const deleted = await this.onDelete(clone(label));
    if (!deleted) return false;
    const key = labelKey(label);
    this.labels = this.labels.filter((item) => labelKey(item) !== key);
    this.selectedLabels = this.selectedLabels.filter((item) => labelKey(item) !== key);
    this.resetCreateForm();
    this.emitChange({ persist: false });
    this.render();
    return true;
  }

  render() {
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-label-modal-shell");
    this.contentEl.addClass("ot-label-modal");

    if (this.creating) {
      this.renderCreateScreen();
      return;
    }

    const header = createElement("div", "ot-label-modal-header");
    header.append(createElement("h2", "", "Labels"));

    const search = createElement("input", "ot-label-search");
    search.type = "text";
    search.placeholder = "Search labels";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      renderList();
    });

    const labelTitle = createElement("h3", "ot-label-modal-subtitle", "Labels");
    const list = createElement("div", "ot-label-picker-list");
    const createArea = createElement("div", "ot-label-create-area");

    const renderList = () => {
      const query = this.query.trim().toLowerCase();
      list.replaceChildren();

      this.labels
        .filter((label) => !query || label.name.toLowerCase().includes(query))
        .forEach((label) => {
          const row = createElement("div", "ot-label-option-row");
          const checkbox = createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = this.isSelected(label);

          const labelButton = createElement("button", "ot-label-option", label.name);
          labelButton.type = "button";
          labelButton.style.backgroundColor = label.color || DEFAULT_LABEL_COLOR;

          const edit = iconButton("pencil", "Edit label", (event) => {
            event.stopPropagation();
            this.editLabel(label);
          });

          checkbox.addEventListener("change", () => this.toggleLabel(label));
          labelButton.addEventListener("click", () => this.toggleLabel(label));
          row.append(checkbox, labelButton, edit);
          list.append(row);
        });
    };

    const renderCreateArea = () => {
      createArea.replaceChildren();

      const create = createElement("button", "ot-label-create-button", "Create new label");
      addButtonIcon(create, "plus");
      create.type = "button";
      create.addEventListener("click", () => {
        this.creating = true;
        this.editingKey = null;
        this.createName = this.query;
        this.createColor = DEFAULT_LABEL_COLOR;
        this.render();
      });
      createArea.append(create);
    };

    this.contentEl.append(header, search, labelTitle, list, createArea);
    renderList();
    renderCreateArea();
    requestAnimationFrame(() => search.focus());
  }

  renderCreateScreen() {
    const header = createElement("div", "ot-label-modal-header");
    const back = iconButton("arrow-left", "Back", () => {
      this.creating = false;
      this.editingKey = null;
      this.render();
    });
    back.classList.add("ot-label-back");
    header.append(back, createElement("h2", "", this.editingKey ? "Edit label" : "Create label"));

    const previewBand = createElement("div", "ot-label-create-preview-band");
    const preview = createElement("div", "ot-label-preview-pill", this.createName || "Label preview");
    preview.style.backgroundColor = this.createColor;
    previewBand.append(preview);

    const form = createElement("form", "ot-label-create-screen");
    const titleField = createElement("label", "ot-field");
    titleField.append(createElement("span", "", "Title"));
    const title = createElement("input", "ot-label-create-title");
    title.type = "text";
    title.value = this.createName;
    title.placeholder = "Label name";
    titleField.append(title);

    const colorField = createElement("div", "ot-field");
    colorField.append(createElement("span", "", "Choose color"));
    colorField.append(colorSwatchGrid(LABEL_COLORS, this.createColor, (color) => {
      this.createColor = color;
      this.render();
    }));

    const removeColor = textButton("x", "Remove color", () => {
      this.createColor = "#6f737a";
      this.render();
    });
    removeColor.classList.add("ot-remove-color-button");

    const footer = createElement("div", "ot-label-create-footer");
    const create = createElement("button", this.editingKey ? "mod-cta ot-save-button" : "mod-cta", this.editingKey ? "Save" : "Create");
    addButtonIcon(create, this.editingKey ? "check" : "plus");
    create.type = "submit";
    if (this.editingKey && this.onDelete) {
      const original = this.labels.find((label) => labelKey(label) === this.editingKey);
      const remove = createElement("button", "mod-warning", "Delete label");
      remove.type = "button";
      addButtonIcon(remove, "trash");
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          const deleted = await this.deleteLabel(original);
          if (!deleted) remove.disabled = false;
        } catch (error) {
          console.error(error);
          new Notice("Could not delete the label.");
          remove.disabled = false;
        }
      });
      footer.append(remove);
    }
    footer.append(create);

    title.addEventListener("input", () => {
      this.createName = title.value;
      preview.textContent = this.createName || "Label preview";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.createLabel(title.value, this.createColor);
    });

    form.append(titleField, colorField, removeColor, footer);
    this.contentEl.append(header, previewBand, form);
    requestAnimationFrame(() => title.focus());
  }
}

class ListColorModal extends Modal {
  constructor(app, title, currentColor, onSelect, kind = "List") {
    super(app);
    this.title = title;
    this.currentColor = cleanColor(currentColor) || LIST_COLORS[0];
    this.onSelect = onSelect;
    this.kind = kind;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-label-modal-shell");
    this.contentEl.addClass("ot-label-modal", "ot-list-color-modal");

    const header = createElement("div", "ot-label-modal-header");
    header.append(createElement("h2", "", `${this.kind} color`));

    const previewBand = createElement("div", "ot-label-create-preview-band");
    const preview = createElement("div", "ot-label-preview-pill", this.title || this.kind);
    preview.style.backgroundColor = this.currentColor;
    previewBand.append(preview);

    const field = createElement("div", "ot-field");
    field.append(createElement("span", "", "Choose color"));
    field.append(colorSwatchGrid(LIST_COLORS, this.currentColor, async (color) => {
      await this.onSelect(color);
      this.close();
    }));

    const customField = createElement("label", "ot-field");
    customField.append(createElement("span", "", "Custom color"));
    const custom = createElement("input", "ot-color-input");
    custom.type = "color";
    custom.value = this.currentColor;
    custom.addEventListener("input", () => {
      this.currentColor = custom.value;
      preview.style.backgroundColor = this.currentColor;
    });
    customField.append(custom);

    const actions = createElement("div", "ot-modal-actions");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta ot-save-button", "Save");
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");
    cancel.type = "button";
    save.type = "button";
    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", async () => {
      await this.onSelect(custom.value);
      this.close();
    });
    actions.append(cancel, save);

    this.contentEl.append(header, previewBand, field, customField, actions);
  }
}

class VaultBackgroundSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Choose an image from the vault");
  }

  getItems() {
    return this.app.vault.getFiles().filter((file) => isImagePath(file.path));
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

class BoardAppearanceModal extends Modal {
  constructor(app, plugin, boardId) {
    super(app);
    this.plugin = plugin;
    this.boardId = boardId;
  }

  onOpen() {
    this.render(false);
  }

  async update(patch, rerender = false) {
    await this.plugin.updateBoardAppearance(this.boardId, patch);
    if (rerender) this.render();
  }

  chooseComputerImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp,image/avif,image/x-icon";
    input.style.display = "none";
    document.body.append(input);
    const cleanup = () => input.remove();
    input.addEventListener("cancel", cleanup, { once: true });
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      try {
        if (!file) return;
        const imagePath = await this.plugin.importAppearanceBackground(file);
        await this.update({
          background: { type: "image", imageSource: "plugin", imagePath, imageFit: "original" },
        }, true);
        new Notice("Background image imported into Kanux's private data folder.");
      } catch (error) {
        new Notice(error && error.message ? error.message : "The background image could not be imported.");
      } finally {
        cleanup();
      }
    }, { once: true });
    try {
      if (typeof input.showPicker === "function") input.showPicker();
      else input.click();
    } catch (error) {
      input.click();
    }
  }

  render(preserveScroll = true) {
    const board = this.plugin.findBoard(this.boardId);
    if (!board) { this.close(); return; }
    const appearance = this.plugin.getBoardAppearance(this.boardId);
    const scrollTop = preserveScroll ? this.contentEl.scrollTop : 0;
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-appearance-modal-shell");
    this.contentEl.addClass("ot-appearance-modal");
    this.contentEl.append(createElement("h2", "", `${board.name} appearance`));
    this.contentEl.append(createElement("p", "ot-appearance-modal-intro", "These settings apply only to this board."));

    new Setting(this.contentEl)
      .setName("Visual preset")
      .addDropdown((dropdown) => dropdown
        .addOption("obsidian", "Obsidian theme")
        .addOption("trello-dark", "Trello dark")
        .addOption("trello-light", "Trello light")
        .addOption("transparent", "Transparent")
        .addOption("high-contrast", "High contrast")
        .addOption("custom", "Custom")
        .setValue(appearance.preset)
        .onChange(async (value) => {
          if (value === "custom") await this.update({ preset: "custom" });
          else {
            await this.plugin.applyBoardAppearancePreset(this.boardId, value);
            this.render();
          }
        }));

    new Setting(this.contentEl).setName("Saved appearances").setHeading();
    const presets = this.plugin.getAppearancePresets();
    let selectedPresetId = presets[0] ? presets[0].id : "";
    const presetSetting = new Setting(this.contentEl)
      .setName("Custom preset")
      .setDesc(presets.length ? "Apply or delete a saved appearance." : "No custom appearances saved yet.")
      .addDropdown((dropdown) => {
        if (!presets.length) dropdown.addOption("", "No saved presets");
        presets.forEach((preset) => dropdown.addOption(preset.id, preset.name));
        dropdown.setValue(selectedPresetId).onChange((value) => { selectedPresetId = value; });
      })
      .addButton((button) => button.setButtonText("Apply").setDisabled(!presets.length).onClick(async () => {
        if (!selectedPresetId) return;
        await this.plugin.applyCustomAppearancePreset(this.boardId, selectedPresetId);
        this.render();
      }))
      .addButton((button) => button.setButtonText("Delete").setWarning().setDisabled(!presets.length).onClick(async () => {
        if (!selectedPresetId) return;
        const selected = presets.find((preset) => preset.id === selectedPresetId);
        if (!selected) return;
        const confirmed = await confirmAction(this.app, "Delete appearance preset", `Delete appearance preset "${selected.name}"?`);
        if (!confirmed) return;
        await this.plugin.deleteAppearancePreset(selectedPresetId);
        this.render();
      }));
    presetSetting.addButton((button) => {
      button.setButtonText("Save current").setCta();
      button.buttonEl.addClass("ot-save-button");
      button.onClick(() => {
        new TextPromptModal(this.app, "Save appearance", "Preset name", "", async (name) => {
          const saved = await this.plugin.saveAppearancePreset(name, this.plugin.getBoardAppearance(this.boardId));
          if (saved) {
            new Notice(`Appearance preset "${saved.name}" saved.`);
            this.render();
          }
        }).open();
      });
    });

    const sourceBoards = this.plugin.data.boards.filter((item) => item.id !== this.boardId);
    let sourceBoardId = sourceBoards[0] ? sourceBoards[0].id : "";
    new Setting(this.contentEl)
      .setName("Copy from another board")
      .setDesc(sourceBoards.length ? "Replace this board's appearance with another board's settings." : "Create another board to use this option.")
      .addDropdown((dropdown) => {
        if (!sourceBoards.length) dropdown.addOption("", "No other boards");
        sourceBoards.forEach((item) => dropdown.addOption(item.id, item.name));
        dropdown.setValue(sourceBoardId).onChange((value) => { sourceBoardId = value; });
      })
      .addButton((button) => button.setButtonText("Copy appearance").setDisabled(!sourceBoards.length).onClick(async () => {
        if (!sourceBoardId) return;
        await this.plugin.copyBoardAppearance(this.boardId, sourceBoardId);
        this.render();
      }));

    new Setting(this.contentEl).setName("Background").setHeading();
    new Setting(this.contentEl)
      .setName("Background type")
      .addDropdown((dropdown) => dropdown
        .addOption("theme", "Obsidian theme")
        .addOption("solid", "Solid color")
        .addOption("gradient", "Gradient")
        .addOption("image", "Image")
        .setValue(appearance.background.type)
        .onChange((value) => this.update({ background: { type: value } }, true)));

    if (appearance.background.type === "solid") {
      new Setting(this.contentEl).setName("Background color").addColorPicker((picker) => picker
        .setValue(appearance.background.color)
        .onChange((value) => this.update({ background: { color: value } })));
    }
    if (appearance.background.type === "gradient") {
      new Setting(this.contentEl).setName("Gradient start").addColorPicker((picker) => picker
        .setValue(appearance.background.gradientStart)
        .onChange((value) => this.update({ background: { gradientStart: value } })));
      new Setting(this.contentEl).setName("Gradient end").addColorPicker((picker) => picker
        .setValue(appearance.background.gradientEnd)
        .onChange((value) => this.update({ background: { gradientEnd: value } })));
    }
    if (appearance.background.type === "image") {
      const imageSetting = new Setting(this.contentEl)
        .setName("Background image")
        .setDesc(appearance.background.imagePath ? appearance.background.imagePath.split("/").pop() : "No image selected")
        .addButton((button) => button.setButtonText("From vault").onClick(() => {
          new VaultBackgroundSuggestModal(this.app, async (file) => {
            await this.update({ background: { imageSource: "vault", imagePath: file.path, imageFit: "original" } }, true);
          }).open();
        }))
        .addButton((button) => button.setButtonText("From computer").setCta().onClick(() => this.chooseComputerImage()));
      if (appearance.background.imagePath) {
        imageSetting.addButton((button) => button.setButtonText("Clear").onClick(() => this.update({ background: { imagePath: "" } }, true)));
      }
      new Setting(this.contentEl)
        .setName("Image fit")
        .setDesc("Cover fills the board without stretching the image; edges may be cropped.")
        .addDropdown((dropdown) => dropdown
          .addOption("original", "Original size — no enlargement")
          .addOption("cover", "Cover — fill board and crop edges")
          .addOption("contain", "Contain — show complete image")
          .addOption("repeat", "Repeat at original size")
          .setValue(appearance.background.imageFit)
          .onChange((value) => this.update({ background: { imageFit: value } })));
      new Setting(this.contentEl)
        .setName("Image darkening")
        .addSlider((slider) => slider.setLimits(0, 0.85, 0.05)
          .setValue(appearance.background.overlayOpacity).setDynamicTooltip()
          .onChange((value) => this.update({ background: { overlayOpacity: value } })));
    }

    new Setting(this.contentEl).setName("Cards").setHeading();
    let cardColor = null;
    new Setting(this.contentEl).setName("Use theme card color").addToggle((toggle) => toggle
      .setValue(appearance.cards.useTheme).onChange(async (value) => {
        await this.update({ cards: { useTheme: value } });
        if (cardColor) cardColor.setDisabled(value);
      }));
    new Setting(this.contentEl).setName("Card color").addColorPicker((picker) => {
      cardColor = picker;
      picker.setValue(appearance.cards.background).setDisabled(appearance.cards.useTheme)
        .onChange((value) => this.update({ cards: { background: value } }));
    });
    new Setting(this.contentEl).setName("Hover color").setDesc("Card color while the pointer is over it.")
      .addColorPicker((picker) => picker.setValue(appearance.cards.hoverBackground)
        .onChange((value) => this.update({ cards: { hoverBackground: value } })));
    new Setting(this.contentEl).setName("Vertical spacing").setDesc("Space between cards inside each list.")
      .addSlider((slider) => slider.setLimits(0, 28, 1).setValue(appearance.cards.verticalGap).setDynamicTooltip()
        .onChange((value) => this.update({ cards: { verticalGap: value } })));
    new Setting(this.contentEl).setName("Title size").addSlider((slider) => slider
      .setLimits(12, 30, 1).setValue(appearance.cards.titleSize).setDynamicTooltip()
      .onChange((value) => this.update({ cards: { titleSize: value } })));

    new Setting(this.contentEl).setName("Labels").setHeading();
    new Setting(this.contentEl)
      .setName("Label display")
      .setDesc("Choose when card labels reveal their names.")
      .addDropdown((dropdown) => dropdown
        .addOption("compact", "Always compact")
        .addOption("expanded", "Always expanded")
        .addOption("hover", "Expand hovered label")
        .addOption("card-hover", "Expand when card is hovered")
        .setValue(appearance.labels.displayMode)
        .onChange((value) => this.update({ labels: { displayMode: value } })));

    new Setting(this.contentEl).setName("Columns").setHeading();
    let columnColor = null;
    new Setting(this.contentEl).setName("Use theme list color").addToggle((toggle) => toggle
      .setValue(appearance.lists.useTheme).onChange(async (value) => {
        await this.update({ lists: { useTheme: value } });
        if (columnColor) columnColor.setDisabled(value);
      }));
    new Setting(this.contentEl).setName("Column color").addColorPicker((picker) => {
      columnColor = picker;
      picker.setValue(appearance.lists.background).setDisabled(appearance.lists.useTheme)
        .onChange((value) => this.update({ lists: { background: value } }));
    });
    new Setting(this.contentEl).setName("Column spacing").addSlider((slider) => slider
      .setLimits(0, 40, 1).setValue(appearance.lists.columnGap).setDynamicTooltip()
      .onChange((value) => this.update({ lists: { columnGap: value } })));
    new Setting(this.contentEl).setName("Top border thickness").addSlider((slider) => slider
      .setLimits(0, 12, 1).setValue(appearance.lists.topBorderWidth).setDynamicTooltip()
      .onChange((value) => this.update({ lists: { topBorderWidth: value } })));
    new Setting(this.contentEl).setName("Show color dot").addToggle((toggle) => toggle
      .setValue(appearance.lists.showColorDot)
      .onChange((value) => this.update({ lists: { showColorDot: value } })));

    new Setting(this.contentEl).setName("Layout and typography").setHeading();
    new Setting(this.contentEl).setName("Content contrast").addDropdown((dropdown) => dropdown
      .addOption("theme", "Follow Obsidian theme").addOption("dark", "Light text").addOption("light", "Neutral dark text")
      .setValue(appearance.colorScheme).onChange((value) => this.update({ colorScheme: value })));
    new Setting(this.contentEl).setName("Density").addDropdown((dropdown) => dropdown
      .addOption("compact", "Compact").addOption("normal", "Normal").addOption("comfortable", "Comfortable")
      .setValue(appearance.density).onChange((value) => this.update({ density: value })));
    new Setting(this.contentEl).setName("Text scale").addSlider((slider) => slider
      .setLimits(0.85, 1.4, 0.05).setValue(appearance.fontScale).setDynamicTooltip()
      .onChange((value) => this.update({ fontScale: value })));
    new Setting(this.contentEl).setName("Card corners").addSlider((slider) => slider
      .setLimits(0, 24, 1).setValue(appearance.cards.borderRadius).setDynamicTooltip()
      .onChange((value) => this.update({ cards: { borderRadius: value } })));
    new Setting(this.contentEl).setName("Column corners").addSlider((slider) => slider
      .setLimits(0, 24, 1).setValue(appearance.lists.borderRadius).setDynamicTooltip()
      .onChange((value) => this.update({ lists: { borderRadius: value } })));
    new Setting(this.contentEl).setName("Card shadow").addDropdown((dropdown) => dropdown
      .addOption("none", "None").addOption("small", "Small").addOption("medium", "Medium").addOption("large", "Large")
      .setValue(appearance.cards.shadow).onChange((value) => this.update({ cards: { shadow: value } })));
    new Setting(this.contentEl).setName("Animations").addToggle((toggle) => toggle
      .setValue(appearance.motion.enabled).onChange((value) => this.update({ motion: { enabled: value } })));

    const actions = createElement("div", "ot-modal-actions");
    const reset = createElement("button", "mod-warning", "Reset this board");
    const close = createElement("button", "mod-cta", "Done");
    reset.type = "button";
    close.type = "button";
    reset.addEventListener("click", async () => {
      await this.plugin.applyBoardAppearancePreset(this.boardId, "obsidian");
      this.render();
    });
    close.addEventListener("click", () => this.close());
    actions.append(reset, close);
    this.contentEl.append(actions);
    if (preserveScroll) requestAnimationFrame(() => { this.contentEl.scrollTop = scrollTop; });
  }
}

/**
 * Compact start/due date picker for a single card.
 */
class CardDatesModal extends Modal {
  constructor(app, plugin, cardId) {
    super(app);
    this.plugin = plugin;
    this.cardId = cardId;
    this.activeField = "due";
    this.startDate = "";
    this.dueDate = "";
    this.visibleMonth = new Date();
  }

  onOpen() {
    const card = this.plugin.data.cards[this.cardId];
    if (!card) {
      this.close();
      return;
    }

    this.card = card;
    this.startDate = cleanDate(card.startDate);
    this.dueDate = cleanDate(card.dueDate);
    this.activeField = this.startDate && !this.dueDate ? "start" : "due";
    const seed = dateFromISO(this.dueDate || this.startDate) || new Date();
    this.visibleMonth = new Date(seed.getFullYear(), seed.getMonth(), 1);
    this.render();
  }

  render() {
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-date-modal-shell");
    this.contentEl.addClass("ot-date-modal");
    this.contentEl.append(createElement("h2", "", "Dates"));

    this.contentEl.append(this.renderCalendar(), this.renderDateFields(), this.renderActions());
  }

  renderCalendar() {
    const calendar = createElement("div", "ot-date-calendar");
    const nav = createElement("div", "ot-date-calendar-nav");
    const title = createElement("div", "ot-date-month-title");
    title.textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(this.visibleMonth);

    nav.append(
      iconButton("chevrons-left", "Previous year", () => {
        this.visibleMonth = addMonths(this.visibleMonth, -12);
        this.render();
      }),
      iconButton("chevron-left", "Previous month", () => {
        this.visibleMonth = addMonths(this.visibleMonth, -1);
        this.render();
      }),
      title,
      iconButton("chevron-right", "Next month", () => {
        this.visibleMonth = addMonths(this.visibleMonth, 1);
        this.render();
      }),
      iconButton("chevrons-right", "Next year", () => {
        this.visibleMonth = addMonths(this.visibleMonth, 12);
        this.render();
      })
    );

    const weekdays = createElement("div", "ot-date-weekdays");
    const monday = new Date(2024, 0, 1);
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
      weekdays.append(createElement("span", "", new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date).replace(/\.$/, "")));
    }

    const grid = createElement("div", "ot-date-grid");
    const firstDay = new Date(this.visibleMonth.getFullYear(), this.visibleMonth.getMonth(), 1);
    const mondayOffset = (firstDay.getDay() + 6) % 7;
    const firstCell = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() - mondayOffset);

    for (let index = 0; index < 42; index += 1) {
      const date = new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index);
      const iso = isoFromDate(date);
      const button = createElement("button", "ot-date-day", String(date.getDate()));
      button.type = "button";
      if (date.getMonth() !== this.visibleMonth.getMonth()) button.classList.add("is-outside");
      if (iso === this.startDate || iso === this.dueDate) button.classList.add("is-selected");
      if (this.startDate && this.dueDate && iso > this.startDate && iso < this.dueDate) button.classList.add("is-range");
      button.addEventListener("click", () => this.selectDate(iso));
      grid.append(button);
    }

    calendar.append(nav, weekdays, grid);
    return calendar;
  }

  renderDateFields() {
    const fields = createElement("div", "ot-date-fields");
    fields.append(
      this.renderDateField("start", "Start date", this.startDate),
      this.renderDateField("due", "Due date", this.dueDate)
    );
    return fields;
  }

  renderDateField(field, label, value) {
    const wrap = createElement("div", "ot-date-field");
    wrap.append(createElement("span", "ot-date-field-label", label));

    const row = createElement("div", "ot-date-field-row");
    const checkbox = createElement("input", "ot-date-checkbox");
    checkbox.type = "checkbox";
    checkbox.checked = !!value;
    checkbox.addEventListener("change", () => {
      this.activeField = field;
      if (!checkbox.checked) this[field === "start" ? "startDate" : "dueDate"] = "";
      this.render();
    });

    const dateButton = createElement("button", `ot-date-field-button${value ? "" : " is-empty"}`, fieldDateLabel(value));
    dateButton.type = "button";
    if (this.activeField === field) dateButton.classList.add("is-active");
    dateButton.addEventListener("click", () => {
      this.activeField = field;
      this.render();
    });

    row.append(checkbox, dateButton);
    wrap.append(row);
    return wrap;
  }

  renderActions() {
    const actions = createElement("div", "ot-modal-actions");
    const clear = createElement("button", "", "Clear dates");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta ot-save-button", "Save");
    addButtonIcon(clear, "x");
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");

    [clear, cancel, save].forEach((button) => {
      button.type = "button";
    });

    clear.addEventListener("click", async () => {
      await this.plugin.updateCard(this.card.id, { startDate: "", dueDate: "" });
      this.close();
    });
    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", async () => {
      await this.plugin.updateCard(this.card.id, {
        startDate: this.startDate,
        dueDate: this.dueDate,
      });
      this.close();
    });

    actions.append(clear, cancel, save);
    return actions;
  }

  /**
   * Applies the clicked calendar day to whichever date field is active.
   */
  selectDate(date) {
    if (this.activeField === "start") {
      this.startDate = date;
      if (this.dueDate && this.dueDate < date) this.dueDate = "";
    } else {
      this.dueDate = date;
      if (this.startDate && this.startDate > date) this.startDate = "";
    }
    this.render();
  }
}

/**
 * Short in-app about panel with settings, sync, and close actions.
 */
class AboutModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-about-modal-shell");
    this.contentEl.addClass("ot-about-modal");
    this.contentEl.append(
      createElement("h2", "", "Kanux"),
      createElement("p", "", "A Trello-style board for Obsidian with Markdown-backed cards, labels, dates, and checklist tasks.")
    );

    const actions = createElement("div", "ot-modal-actions");
    const openSettings = createElement("button", "", "Open settings");
    const sync = createElement("button", "", "Re-import notes");
    const close = createElement("button", "mod-cta", "Close");
    addButtonIcon(openSettings, "settings");
    addButtonIcon(sync, "refresh-cw");
    addButtonIcon(close, "x");
    [openSettings, sync, close].forEach((button) => {
      button.type = "button";
    });
    openSettings.addEventListener("click", () => {
      this.app.setting.open();
      this.app.setting.openTabById(this.plugin.manifest.id);
      this.close();
    });
    sync.addEventListener("click", async () => {
      await this.plugin.syncCardsFromFolder();
      this.plugin.refreshViews();
      new Notice("Kanux notes re-imported.");
    });
    close.addEventListener("click", () => this.close());
    actions.append(openSettings, sync, close);
    this.contentEl.append(actions);
  }
}

/**
 * Full card editor.
 *
 * Card edits are persisted while the modal is open so closing the editor never
 * drops checklist, label, title, or details changes.
 */
class CardModal extends Modal {
  constructor(app, plugin, cardId, options = {}) {
    super(app);
    this.plugin = plugin;
    this.cardId = cardId;
    // notesOnly: show just the title + Description + Checklist (used by the table
    // view, where labels / members / dates / status are edited inline in the cells).
    this.notesOnly = !!options.notesOnly;
    this.localTitle = "";
    this.localLabels = [];
    this.localGlobalLabels = [];
    this.localDetails = "";
    this.detailsDraft = "";
    this.editingDetails = false;
    this.detailsEditDismissed = false;
    this.pendingDetailAttachments = new Set();
    this.localChecklists = [];
    this.expandedChecklistNotes = new Set();
    this.checklistNoteDrafts = new Map();
    this.editingChecklistNotes = new Set();
    this.detailsTextarea = null;
    this.addingChecklistId = null;
    this.saveTimer = null;
    this.savePromise = Promise.resolve();
    this.readOnly = false;
    this.lockHolder = null;
    this.lockAcquired = false;
    this.lockBoardId = null;
    this.lockHeartbeat = null;
  }

  onOpen() {
    this.contentEl.replaceChildren(createElement("div", "ot-loading", "Opening card..."));
    this.load().catch((error) => {
      console.error(error);
      new Notice("Could not open card.");
      this.close();
    });
  }

  /**
   * Pulls the latest Markdown note content before rendering the editor.
   */
  async load() {
    const card = this.plugin.data.cards[this.cardId];
    if (!card) {
      new Notice("Card not found.");
      this.close();
      return;
    }

    await this.plugin.hydrateCardFromFile(card);
    this.card = card;
    this.localTitle = card.title || "";
    this.localLabels = clone(card.labels || []);
    this.localGlobalLabels = clone(this.plugin.data.labels || []);
    this.localLabels.forEach((label) => this.ensureLocalGlobalLabel(label));
    this.localDetails = card.details || "";
    this.detailsDraft = "";
    this.editingDetails = false;
    this.detailsEditDismissed = false;
    this.localChecklists = normalizeChecklists(clone(card.checklists || []), []);
    this.localAssignees = clone(card.assignees || []);
    await this.setupCardLock();
    this.render();
  }

  /**
   * Decide whether this card can be edited. If someone else already holds the
   * lock we open read-only; otherwise we take the lock and keep it warm with a
   * heartbeat until the modal closes. Offline / no-SyncDeck falls open (editable).
   */
  async setupCardLock() {
    const board = this.plugin.getBoard();
    this.lockBoardId = board && board.id;

    const holder = this.plugin.getCardLockHolder && this.plugin.getCardLockHolder(this.cardId);
    if (holder) {
      this.readOnly = true;
      this.lockHolder = holder;
      return;
    }
    if (!this.lockBoardId || !this.plugin.acquireCardLock) return;

    const result = await this.plugin.acquireCardLock(this.lockBoardId, this.cardId);
    if (result && result.ok === false) {
      this.readOnly = true;
      this.lockHolder = result.lock || null;
      return;
    }
    this.lockAcquired = !!(result && result.ok && !result.offline);
    this.plugin.editingCardId = this.cardId;
    this.startLockHeartbeat();
  }

  startLockHeartbeat() {
    this.stopLockHeartbeat();
    // If the server now reports someone else holds the lock (we opened while
    // offline, or another editor took over), drop this modal to read-only.
    this.lockHeartbeat = window.setInterval(async () => {
      if (!this.lockBoardId || this.readOnly) return;
      const result = await this.plugin.acquireCardLock(this.lockBoardId, this.cardId).catch(() => null);
      if (result && result.ok === false) this.enterReadOnly(result.lock);
    }, LOCK_HEARTBEAT_MS);
  }

  // Convert an open editable modal into a read-only view after losing the lock.
  // Unsaved edits are dropped rather than saved, so we never persist a write that
  // would conflict with the real editor's changes.
  enterReadOnly(holder) {
    if (this.readOnly) return;
    this.readOnly = true;
    this.lockHolder = holder || this.lockHolder;
    this.lockAcquired = false;
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.stopLockHeartbeat();
    this.discardPendingDetailAttachments().catch(console.error);
    if (this.plugin.editingCardId === this.cardId) this.plugin.editingCardId = null;
    new Notice(`🔒 ${(holder && holder.name) || "Someone"} is editing this card`);
    this.render();
  }

  stopLockHeartbeat() {
    if (this.lockHeartbeat) {
      window.clearInterval(this.lockHeartbeat);
      this.lockHeartbeat = null;
    }
  }

  /**
   * Ensures labels found on a card are available in the modal's label picker.
   */
  ensureLocalGlobalLabel(label) {
    const name = cleanLabelName(label);
    if (!name) return null;

    const key = labelKey(name);
    const existing = this.localGlobalLabels.find((item) => labelKey(item) === key);
    if (existing) return existing;

    const globalLabel = { name, color: label.color || "#d43c35" };
    this.localGlobalLabels.push(globalLabel);
    return globalLabel;
  }

  isSelectedLabel(label) {
    const key = labelKey(label);
    return this.localLabels.some((item) => labelKey(item) === key);
  }

  // Avatar chip for a member: profile picture when available, else initials.
  memberAvatar(member) {
    const avatar = createElement("span", "ot-card-avatar");
    avatar.style.setProperty("--ot-avatar-color", member.color || "#8b5cf6");
    const picture = this.plugin.getMemberPicture(member.email);
    if (picture) {
      const img = createElement("img", "");
      img.src = picture;
      img.alt = "";
      avatar.append(img);
    } else {
      avatar.textContent = initials(member.name || member.email);
      avatar.classList.add("is-initials");
    }
    return avatar;
  }

  renderAssigneesField() {
    const field = createElement("div", "ot-field ot-assignee-editor");
    field.append(createElement("span", "", "Members"));
    const row = createElement("div", "ot-assignee-row");

    const rebuild = () => {
      row.replaceChildren();
      (this.localAssignees || []).forEach((assignee) => {
        const chip = createElement("span", "ot-assignee-chip");
        const avatar = this.memberAvatar(assignee);
        const remove = iconButton("x", "Remove member", () => {
          this.localAssignees = (this.localAssignees || []).filter((a) => a.email !== assignee.email);
          rebuild();
          this.queueSave();
        });
        remove.classList.add("ot-assignee-remove");
        chip.append(avatar, createElement("span", "ot-assignee-name", assignee.name || assignee.email), remove);
        row.append(chip);
      });
      const addButton = iconButton("plus", "Assign a member", (event) => this.showMemberMenu(event, rebuild));
      addButton.classList.add("ot-assignee-add");
      row.append(addButton);
    };

    rebuild();
    field.append(row);
    return field;
  }

  showMemberMenu(event, rebuild) {
    const members = this.plugin.getVaultMembers();
    const menu = new Menu();
    if (!members.length) {
      menu.addItem((item) => item.setTitle("No members — sign in to Sync Deck").setDisabled(true));
    } else {
      members.forEach((member) => {
        const assigned = (this.localAssignees || []).some((a) => a.email === member.email);
        menu.addItem((item) => {
          item.setTitle(member.name || member.email).setChecked(assigned).onClick(() => {
            if (assigned) {
              this.localAssignees = (this.localAssignees || []).filter((a) => a.email !== member.email);
            } else {
              this.localAssignees = [...(this.localAssignees || []), { email: member.email, name: member.name, color: member.color }];
            }
            rebuild();
            this.queueSave();
          });
        });
      });
    }
    menu.showAtMouseEvent(event);
  }

  // Single-member picker for one checklist item (leftmost circle).
  showChecklistMemberMenu(event, item, rerender) {
    const members = this.plugin.getVaultMembers();
    const menu = new Menu();
    menu.addItem((mi) => mi
      .setTitle("Unassigned")
      .setChecked(!(item.assignee && item.assignee.email))
      .onClick(() => {
        item.assignee = null;
        rerender();
        this.saveNow().catch(console.error);
      }));
    if (!members.length) {
      menu.addItem((mi) => mi.setTitle("No members — sign in to Sync Deck").setDisabled(true));
    } else {
      members.forEach((member) => {
        const current = !!(item.assignee && item.assignee.email === member.email);
        menu.addItem((mi) => mi
          .setTitle(member.name || member.email)
          .setChecked(current)
          .onClick(() => {
            item.assignee = { email: member.email, name: member.name, color: member.color };
            rerender();
            this.saveNow().catch(console.error);
          }));
      });
    }
    menu.showAtMouseEvent(event);
  }

  render() {
    const card = this.card;
    const previousBody = this.contentEl.querySelector(".ot-card-modal-body");
    const bodyScrollTop = previousBody ? previousBody.scrollTop : 0;
    this.destroyEmbeddedEditors();
    this.closeSideSheet();
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-card-modal-shell");
    this.contentEl.addClass("ot-card-modal");
    const collaborationEnabled = this.plugin.isSyncDeckEnabled();
    this.contentEl.classList.toggle("is-sync-disabled", !collaborationEnabled);

    const title = createElement("input", "ot-title-input");
    title.type = "text";
    title.value = this.localTitle;
    title.placeholder = "Card title";
    title.addEventListener("input", () => {
      this.localTitle = title.value;
      this.queueSave();
    });

    const board = this.plugin.findBoardForCard(card);
    const list = board && board.lists.find((item) => item.id === card.listId);
    // Centered document-style header: title, then where the card lives.
    const header = createElement("header", "ot-card-modal-header");
    const location = createElement("div", "ot-card-modal-location");
    if (list) location.append(createElement("span", "ot-card-modal-location-pill", list.title));
    if (list && board) location.append(createElement("span", "ot-card-modal-location-sep", "·"));
    if (board) location.append(createElement("span", "", board.name));
    if (!list && !board) location.append(createElement("span", "", "Kanux card"));
    header.append(title, location);

    const labelsField = this.notesOnly ? null : this.renderLabelsField();
    const assigneesField = this.notesOnly || !collaborationEnabled ? null : this.renderAssigneesField();
    const detailsField = this.renderDetailsField();
    const checklistField = this.renderChecklistField();

    const actions = createElement("div", "ot-modal-actions");
    const deleteButton = createElement("button", "mod-warning", "Delete");
    const openNote = createElement("button", "", "Open note");
    const exportPdf = createElement("button", "", "PDF");
    const close = createElement("button", "mod-cta", "Close");
    addButtonIcon(deleteButton, "trash");
    addButtonIcon(openNote, "file-text");
    addButtonIcon(exportPdf, "download");
    addButtonIcon(close, "x");

    [deleteButton, openNote, exportPdf, close].forEach((button) => {
      button.type = "button";
    });

    deleteButton.addEventListener("click", async () => {
      const confirmed = await confirmAction(this.app, "Delete card", "Delete this card and its linked Markdown note?");
      if (!confirmed) return;
      await this.plugin.deleteCard(card.id);
      this.close();
    });

    openNote.addEventListener("click", async () => {
      await this.saveNow();
      await this.plugin.openCardFile(card.id);
      this.close();
    });

    // Works in read-only too — exporting doesn't modify the card.
    exportPdf.addEventListener("click", () => this.exportCardPdf().catch(console.error));

    close.addEventListener("click", async () => {
      await this.saveNow();
      this.close();
    });

    actions.append(deleteButton, openNote, exportPdf, close);

    const editableFields = (this.notesOnly
      ? [detailsField, checklistField]
      : [labelsField, assigneesField, detailsField, checklistField]).filter(Boolean);
    const mainColumn = createElement("main", "ot-card-modal-main");
    mainColumn.append(detailsField, checklistField);
    const body = createElement("div", "ot-card-modal-body");
    body.append(mainColumn);
    // Labels and members live in captioned sidebar cards, so each has an
    // unmistakable home; with nothing to show, content takes the full width.
    if (!this.notesOnly && (labelsField || assigneesField)) {
      const sidebar = createElement("aside", "ot-card-modal-sidebar");
      if (labelsField) sidebar.append(labelsField);
      if (assigneesField) sidebar.append(assigneesField);
      body.append(sidebar);
    } else {
      body.classList.add("is-notes-only");
    }
    const children = [header, body, actions];
    if (this.readOnly) {
      this.contentEl.addClass("ot-card-readonly");
      const holderName = (this.lockHolder && this.lockHolder.name) || "Someone";
      children.unshift(createElement("div", "ot-card-lock-banner", `🔒 ${holderName} is editing this card — read only`));
    }
    this.contentEl.append(...children);
    if (bodyScrollTop) requestAnimationFrame(() => { body.scrollTop = bodyScrollTop; });

    if (this.readOnly) {
      title.disabled = true;
      deleteButton.disabled = true;
      this.disableEditing(editableFields);
    } else if (!this.editingDetails) {
      requestAnimationFrame(() => title.focus());
    }
  }

  // Freeze every editable control inside the given fields so a read-only viewer
  // can look but not change anything (Open note / Close stay usable).
  disableEditing(fields) {
    fields.forEach((field) => {
      field.querySelectorAll("input, textarea, button, [contenteditable]").forEach((el) => {
        if (el.classList.contains("ot-image-tile") || el.classList.contains("ot-checklist-note-action")) return;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON") {
          el.disabled = true;
        } else {
          el.setAttribute("contenteditable", "false");
        }
        el.classList.add("is-disabled");
      });
    });
  }

  onClose() {
    this.stopLockHeartbeat();
    this.destroyEmbeddedEditors();
    this.closeSideSheet();
    this.discardPendingDetailAttachments().catch(console.error);
    if (!this.readOnly && this.lockBoardId && this.plugin.releaseCardLock) {
      this.plugin.releaseCardLock(this.lockBoardId, this.cardId).catch(() => {});
    }
    if (this.plugin.editingCardId === this.cardId) this.plugin.editingCardId = null;
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveNow().catch(console.error);
    }
    this.contentEl.replaceChildren();
  }

  renderLabelsField() {
    const field = createElement("div", "ot-field ot-label-editor");
    field.append(createElement("span", "", "Labels"));
    const labelsWrap = createElement("div", "ot-selected-labels");
    const addButton = iconButton("plus", "Choose labels", () => {
      new LabelPickerModal(this.app, this.localGlobalLabels, this.localLabels, (labels, selectedLabels, options = {}) => {
        this.localGlobalLabels = labels;
        this.localLabels = selectedLabels;
        renderLabels();
        if (options.persist !== false) this.saveNow().catch(console.error);
      }, (label) => this.plugin.deleteLabel(label)).open();
    });
    addButton.classList.add("ot-label-add-button");

    const renderLabels = () => {
      labelsWrap.replaceChildren();

      this.localLabels.forEach((label, index) => {
        const pill = createElement("button", "ot-large-label-pill");
        pill.type = "button";
        pill.textContent = label.name;
        pill.style.backgroundColor = label.color;
        pill.title = "Remove label";
        pill.addEventListener("click", () => {
          this.localLabels.splice(index, 1);
          renderLabels();
          this.saveNow().catch(console.error);
        });
        labelsWrap.append(pill);
      });

      labelsWrap.append(addButton);
    };
    renderLabels();
    field.append(labelsWrap);
    return field;
  }

  // The embedded Obsidian editors hold keymap scopes and a patched workspace
  // method, so instances discarded by a re-render must be destroyed, not just
  // dropped with their DOM.
  trackEmbeddedEditor(editorInstance) {
    if (!this.embeddedEditors) this.embeddedEditors = [];
    this.embeddedEditors = this.embeddedEditors.filter((tracked) => {
      if (tracked.containerEl && tracked.containerEl.isConnected) return true;
      try { tracked.destroy(); } catch (error) { console.error(error); }
      return false;
    });
    this.embeddedEditors.push(editorInstance);
  }

  destroyEmbeddedEditors() {
    (this.embeddedEditors || []).forEach((tracked) => {
      try { tracked.destroy(); } catch (error) { console.error(error); }
    });
    this.embeddedEditors = [];
  }

  // ---- Side editing sheet ----
  // Editing the description slides the modal left and opens a page-like panel
  // beside it, so the card (labels, checklist, dates) stays visible while
  // writing. Only used when the viewport has room for both.
  openDetailsSideSheet(titleText, ownerKey) {
    if (!this.modalEl) return null;
    // One sheet at a time: whoever claimed it keeps it; a second editor
    // (e.g. a checklist note while the description is open) edits inline.
    if (this.sideSheet && this.sideSheet.isConnected && this.sideSheetOwner !== ownerKey) return null;
    this.closeSideSheet();
    const SHEET_WIDTH = 440;
    const SHEET_GAP = 18;
    const modalWidth = this.modalEl.getBoundingClientRect().width;
    if (!modalWidth || window.innerWidth < modalWidth + SHEET_WIDTH + SHEET_GAP + 32) return null;
    this.sideSheetOwner = ownerKey;
    const sheet = createElement("aside", "ot-side-sheet");
    const header = createElement("div", "ot-side-sheet-header");
    const icon = createElement("span", "ot-details-heading-icon");
    setIconSafe(icon, "align-left");
    header.append(icon, createElement("span", "", titleText));
    const content = createElement("div", "ot-side-sheet-content");
    sheet.append(header, content);
    this.modalEl.append(sheet);
    this.modalEl.classList.add("ot-side-editing");
    this.sideSheet = sheet;
    return content;
  }

  closeSideSheet(ownerKey) {
    if (ownerKey && this.sideSheetOwner && this.sideSheetOwner !== ownerKey) return;
    const sheet = this.sideSheet;
    this.sideSheet = null;
    this.sideSheetOwner = null;
    if (this.modalEl) this.modalEl.classList.remove("ot-side-editing");
    if (!sheet) return;
    // Let the sheet tuck back behind the modal before leaving the DOM; the
    // timeout covers environments where animation events never fire.
    sheet.classList.add("is-closing");
    const removeSheet = () => sheet.remove();
    sheet.addEventListener("animationend", removeSheet, { once: true });
    window.setTimeout(removeSheet, 400);
  }

  currentDetailsText() {
    return this.editingDetails ? this.detailsDraft : this.localDetails;
  }

  shouldEditDetails() {
    const emptyDescription = !String(this.localDetails || "").trim();
    return !this.readOnly && (this.editingDetails || (emptyDescription && !this.detailsEditDismissed));
  }

  async persistDetailsDraft(markdown) {
    const previousDetails = this.localDetails;
    const nextDetails = String(markdown || "").trim();
    this.localDetails = nextDetails;
    try {
      await this.saveNow({ propagateError: true });
    } catch (error) {
      this.localDetails = previousDetails;
      throw error;
    }
    await this.finalizePendingDetailAttachments(nextDetails);
    this.detailsDraft = "";
    this.editingDetails = false;
    this.detailsEditDismissed = !nextDetails;
  }

  async discardPendingDetailAttachment(path) {
    if (!this.pendingDetailAttachments || !this.pendingDetailAttachments.has(path)) return;
    const attachment = this.app.vault.getAbstractFileByPath(path);
    this.pendingDetailAttachments.delete(path);
    try {
      if (attachment) await this.app.vault.trash(attachment, false);
    } catch (error) {
      this.pendingDetailAttachments.add(path);
      throw error;
    }
  }

  async discardPendingDetailAttachments() {
    if (!this.pendingDetailAttachments) return;
    for (const path of [...this.pendingDetailAttachments]) {
      await this.discardPendingDetailAttachment(path);
    }
  }

  async finalizePendingDetailAttachments(markdown) {
    if (!this.pendingDetailAttachments || !this.pendingDetailAttachments.size) return;
    const referencedPaths = new Set(
      this.splitDetailSegments(markdown)
        .filter((segment) => segment.type === "img")
        .map((segment) => segment.target)
    );

    for (const path of [...this.pendingDetailAttachments]) {
      if (referencedPaths.has(path)) {
        this.pendingDetailAttachments.delete(path);
        continue;
      }
      try {
        await this.discardPendingDetailAttachment(path);
      } catch (error) {
        console.error(`Could not remove unused attachment: ${path}`, error);
      }
    }
  }

  /**
   * Splits details Markdown into ordered segments so text and images render
   * inline, in the order they appear: [{type:'md',text} | {type:'img',target}].
   */
  splitDetailSegments(markdown) {
    const text = String(markdown || "");
    const re = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
    const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(\?|#|$)/i;
    const segments = [];
    let last = 0;
    let match;
    while ((match = re.exec(text))) {
      const isWiki = match[1] !== undefined;
      let target = (isWiki ? match[1] : match[2]) || "";
      target = target.split("|")[0].split("#")[0].trim();
      if (!isWiki) target = target.split(/\s+/)[0]; // md link: drop optional "title"
      if (!IMG_EXT.test(target)) continue; // not an image link — leave it in the text
      if (match.index > last) segments.push({ type: "md", text: text.slice(last, match.index) });
      // Keep the exact original markup so an editor rebuilding the markdown from
      // segments round-trips wiki AND ![](url) embeds byte-identically. start/end
      // let callers splice a resized embed back into the source string safely.
      segments.push({ type: "img", target, markup: match[0], start: match.index, end: match.index + match[0].length });
      last = match.index + match[0].length;
    }
    if (last < text.length) segments.push({ type: "md", text: text.slice(last) });
    if (!segments.length) segments.push({ type: "md", text });
    return segments;
  }

  /**
   * Shows rendered Markdown by default, with a textarea editor on demand.
   */
  renderDetailsField(options = {}) {
    const noteMode = !!options.noteMode;
    // Identifies this editor as a side-sheet owner; empty means inline only.
    const sheetKey = noteMode ? textLine(options.sheetKey || "") : "details";
    const fieldTitle = textLine(options.title) || "Description";
    const placeholder = textLine(options.placeholder) || "Write a description...";
    const initialMarkdown = noteMode ? String(options.markdown || "") : this.localDetails;
    const savedMarkdown = noteMode ? String(options.savedMarkdown ?? initialMarkdown) : this.localDetails;
    let draftMarkdown = noteMode ? initialMarkdown : this.detailsDraft;
    // Reset the block-editor caret hook; the edit branch below re-installs it.
    if (!noteMode) this.insertDetailAtCaret = null;
    const field = createElement("section", "ot-field ot-details-field");
    const header = createElement("div", "ot-details-heading");
    const heading = createElement("div", "ot-details-heading-title");
    const headingIcon = createElement("span", "ot-details-heading-icon");
    setIconSafe(headingIcon, "align-left");
    heading.append(headingIcon, createElement("span", "", fieldTitle));
    const preview = createElement("div", "ot-markdown-preview markdown-rendered");
    const editor = createElement("textarea", "ot-textarea ot-details-editor is-hidden");
    const isEditing = noteMode || this.shouldEditDetails();

    if (isEditing && !noteMode && !this.editingDetails) {
      this.editingDetails = true;
      this.detailsDraft = this.localDetails;
      draftMarkdown = this.detailsDraft;
    }

    editor.placeholder = placeholder;
    editor.value = isEditing ? draftMarkdown : this.localDetails;
    if (!noteMode) {
      this.detailsTextarea = editor;
      this.detailsPreview = preview;
    }

    // Images are saved one at a time so concurrent inserts don't race the caret.
    const insertImagesSequentially = async (images) => {
      for (const file of images) await this.insertImageFromFile(file);
      // When adding from the read view, re-render so the new image shows inline.
      if (!this.editingDetails) renderPreview();
    };

    // Hidden file input backing the "Add image" button (works on mobile too).
    const imageInput = createElement("input", "ot-hidden-file-input");
    imageInput.type = "file";
    imageInput.accept = "image/*";
    imageInput.multiple = true;
    imageInput.addEventListener("change", () => {
      const files = Array.from(imageInput.files || []);
      imageInput.value = "";
      if (files.length) insertImagesSequentially(files).catch(console.error);
    });

    const COLLAPSED_MAX = 340;
    const renderPreview = () => {
      preview.replaceChildren();
      preview.classList.remove("is-hidden");
      const markdown = this.currentDetailsText();
      if (!markdown.trim()) {
        preview.append(createElement("span", "ot-empty-text", "No description"));
        return;
      }

      // Render the note as ONE flowing document: split into ordered text/image
      // segments, render text via Markdown and images ourselves (MarkdownRenderer
      // doesn't reliably turn ![[img]] into a real image inside a modal). This
      // keeps each image exactly where it was added, inline with the text.
      const body = createElement("div", "ot-details-body");
      preview.append(body);
      const segs = this.splitDetailSegments(markdown);
      // Grid layout for the run of images around segIndex: writes an even column
      // width into every embed of the run (descending offsets, so earlier
      // splices can't shift later ones), saves, and re-renders.
      const applyGridToSegRun = async (segIndex, columns) => {
        const run = imageRunAround(segs, segIndex, isBlankMdSegment);
        if (!run.length) return;
        const width = columns ? this.gridColumnWidth(preview.clientWidth || 640, columns) : 0;
        let source = this.localDetails;
        [...run].sort((a, b) => b.start - a.start).forEach((s) => {
          source = source.slice(0, s.start) + imageMarkupWithSize(s.markup, width) + source.slice(s.end);
        });
        this.localDetails = source;
        await this.saveNow();
        renderPreview();
      };
      segs.forEach((seg, segIndex) => {
        if (seg.type === "img") {
          const resolved = this.plugin.resolveCardImage(this.card, seg.target);
          const wrap = createElement("div", "ot-inline-image");
          if (resolved && resolved.src) {
            const img = createElement("img", "");
            img.src = resolved.src;
            img.alt = resolved.name || "";
            img.loading = "lazy";
            // No click action on the image itself — opening the underlying note
            // on every stray click was irritating. The preview's click-to-edit
            // guard already ignores images, so a click here simply does nothing;
            // copying is the hover chip's job.
            wrap.append(img);
            // Hover chip: copy the image to the clipboard without entering edit
            // mode (and without opening the file).
            const copyButton = iconButton("copy", "Copy image", async (event) => {
              event.preventDefault();
              event.stopPropagation();
              try {
                await this.copyImageToClipboard(img);
                new Notice("Image copied");
              } catch (error) {
                new Notice("Could not copy the image on this platform.");
              }
            });
            copyButton.classList.add("ot-image-copy");
            wrap.append(copyButton);
            this.applyStoredImageWidth(img, seg.markup);
            // Resize straight from the read view — the width is stored in the
            // note's embed markup (Obsidian's |300 syntax), so it renders the
            // same when the card note opens in Obsidian.
            if (!this.readOnly) {
              this.enableImageResize(wrap, img, {
                getMarkup: () => seg.markup,
                onCommit: async (width) => {
                  const next = imageMarkupWithSize(seg.markup, width);
                  if (next === seg.markup) return;
                  // Splice at the segment's own offsets — replacing by string
                  // would hit the wrong copy when the same image (and size)
                  // appears twice in one note.
                  const source = this.localDetails;
                  this.localDetails = source.slice(0, seg.start) + next + source.slice(seg.end);
                  seg.markup = next;
                  await this.saveNow();
                  renderPreview();
                },
              });
              // Grid chip: lay the surrounding image run out as 2/3/4 columns.
              const gridChip = iconButton("layout-grid", "Arrange images side by side", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const menu = new Menu();
                [2, 3, 4].forEach((columns) => {
                  menu.addItem((item) => item.setTitle(`${columns} side by side`).onClick(() => {
                    applyGridToSegRun(segIndex, columns).catch(console.error);
                  }));
                });
                menu.addItem((item) => item.setTitle("Full width").onClick(() => {
                  applyGridToSegRun(segIndex, 0).catch(console.error);
                }));
                menu.showAtMouseEvent(event);
              });
              gridChip.classList.add("ot-image-grid-chip");
              wrap.append(gridChip);
            }
          } else {
            wrap.append(createElement("span", "ot-image-missing", seg.target.split("/").pop() || "image"));
          }
          body.append(wrap);
          return;
        }
        const text = seg.text.trim();
        if (!text) return;
        const chunk = createElement("div", "ot-md-chunk");
        body.append(chunk);
        try {
          Promise.resolve(
            MarkdownRenderer.render(this.app, text, chunk, this.card.filePath || "", this)
          ).catch((error) => {
            console.error(error);
            chunk.textContent = text;
          });
        } catch (error) {
          chunk.textContent = text;
        }
      });

      // Collapse a long description behind a "Show more" toggle. Re-checked once
      // more after a moment so late-loading images are counted.
      const applyClamp = () => {
        if (preview.querySelector(".ot-details-more")) return;
        if (body.scrollHeight <= COLLAPSED_MAX + 48) return;
        body.classList.add("is-clamped");
        const more = createElement("button", "ot-details-more", "Show more");
        more.type = "button";
        more.addEventListener("click", (event) => {
          event.stopPropagation();
          const collapsed = body.classList.toggle("is-clamped");
          more.textContent = collapsed ? "Show more" : "Show less";
        });
        preview.append(more);
      };
      requestAnimationFrame(applyClamp);
      window.setTimeout(applyClamp, 400);
    };

    const showEditor = () => {
      if (this.readOnly) return;
      this.detailsEditDismissed = false;
      this.editingDetails = true;
      this.detailsDraft = this.localDetails;
      this.render();
    };

    const saveDetails = async () => {
      if (saving || !hasUnsavedChanges()) return;
      saving = true;
      updateEditorState("Saving…");
      try {
        if (noteMode) {
          await options.onSave(draftMarkdown);
          this.closeSideSheet(sheetKey);
          return;
        }
        await this.persistDetailsDraft(draftMarkdown);
        this.render();
      } catch (error) {
        saving = false;
        updateEditorState("Could not save");
        throw error;
      }
    };

    const cancelDetails = async () => {
      if (noteMode) {
        options.onCancel();
        this.closeSideSheet(sheetKey);
        return;
      }
      try {
        await this.discardPendingDetailAttachments();
      } catch (error) {
        console.error(error);
        new Notice("The description was discarded, but an unused attachment could not be removed.");
      } finally {
        this.detailsDraft = "";
        this.editingDetails = false;
        this.detailsEditDismissed = true;
        this.render();
      }
    };

    // Toolbar buttons must not steal focus from the contenteditable on mousedown,
    // or the user's selection collapses before the command can format it.
    const keepEditorSelection = (button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      return button;
    };

    const makeTool = (icon, label, onClick) => {
      const button = iconButton(icon, label, (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event);
      });
      button.classList.add("ot-details-tool");
      return keepEditorSelection(button);
    };

    const makeTextTool = (label, title, onClick) => {
      const button = createElement("button", "ot-details-tool ot-details-text-tool", label);
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event);
      });
      return keepEditorSelection(button);
    };

    // ---- Block editor (Notion/Trello-style WYSIWYG) ----
    // Editing splits the markdown into TEXT blocks (contenteditable surfaces
    // where bold/italic/lists render LIVE) and IMAGE blocks (real thumbnails
    // with a remove chip) — the user never sees raw markdown markers. `blocks`
    // is the source of truth while editing; each input serializes its block back
    // to markdown (detailsHtmlToMd) and syncDraft() re-joins the whole note into
    // the hidden master textarea (`editor`) that saveDetails/saveNow already read.
    const blocksHost = createElement("div", "ot-block-editor");
    let blocks = [];
    let activeText = null; // { block, ce } of the focused text block
    let saveButton = null;
    let cancelButton = null;
    let editorStatus = null;
    let saving = false;

    const normalizedMarkdown = (value) => String(value || "").replace(/\r\n/g, "\n").trim();
    const hasUnsavedChanges = () => normalizedMarkdown(draftMarkdown) !== normalizedMarkdown(savedMarkdown);
    const updateEditorState = (message = "") => {
      const changed = hasUnsavedChanges();
      if (saveButton) saveButton.disabled = saving || !changed;
      if (cancelButton) cancelButton.disabled = saving;
      if (!editorStatus) return;
      editorStatus.textContent = message || (changed ? "Unsaved changes" : "Saved");
      editorStatus.classList.toggle("is-dirty", changed && !saving && !message);
      editorStatus.classList.toggle("is-error", message === "Could not save");
    };

    const buildBlocks = (markdown) => {
      const built = [];
      this.splitDetailSegments(String(markdown || "")).forEach((seg) => {
        if (seg.type === "img") {
          // Guarantee a text slot before an image so there's always somewhere
          // to type between/around pictures.
          if (!built.length || built[built.length - 1].type === "img") built.push({ type: "text", value: "" });
          built.push({ type: "img", target: seg.target, markup: seg.markup || `![[${seg.target}]]` });
          return;
        }
        const value = seg.text.replace(/^\n+/, "").replace(/\n+$/, "");
        if (built.length && built[built.length - 1].type === "text") {
          const prev = built[built.length - 1];
          prev.value = prev.value && value ? `${prev.value}\n${value}` : (prev.value || value);
        } else {
          built.push({ type: "text", value });
        }
      });
      if (!built.length || built[0].type === "img") built.unshift({ type: "text", value: "" });
      if (built[built.length - 1].type === "img") built.push({ type: "text", value: "" });
      return built;
    };

    const joinBlocks = () => {
      const parts = [];
      blocks.forEach((block) => {
        if (block.type === "img") parts.push(block.markup);
        else if (block.value.trim()) parts.push(block.value.replace(/\n{3,}/g, "\n\n"));
      });
      return parts.join("\n\n");
    };

    const syncDraft = () => {
      draftMarkdown = joinBlocks();
      if (!noteMode) this.detailsDraft = draftMarkdown;
      editor.value = draftMarkdown;
      if (noteMode && options.onDraftChange) options.onDraftChange(draftMarkdown);
      updateEditorState();
    };

    const placeCaret = (ce, atStart) => {
      ce.focus();
      const range = document.createRange();
      range.selectNodeContents(ce);
      range.collapse(!!atStart);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };

    const focusedText = () => {
      if (activeText && blocks.includes(activeText.block) && activeText.ce && activeText.ce.isConnected) return activeText;
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        if (blocks[i].type === "text" && blocks[i]._ce) return { block: blocks[i], ce: blocks[i]._ce };
      }
      return null;
    };

    // Obsidian live-preview markers: a heading shows its literal "#" prefix
    // while the caret sits on that line and hides it once the caret leaves
    // (Enter, click elsewhere, arrows). The marker is ordinary editable text
    // that the serializer skips, so the saved markdown never doubles the "#".
    const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
    const showHeadingMarker = (heading) => {
      if (heading.querySelector(":scope > .ot-md-token")) return;
      const token = createElement("span", "ot-md-token", `${"#".repeat(Number(heading.tagName[1]))} `);
      heading.prepend(token);
      // Prepending shifts a caret anchored on the heading element itself (an
      // empty heading right after "# " + Space) to BEFORE the marker, so the
      // next keystroke would land behind the "#". Re-anchor it in a text node
      // right after the marker, where the heading text belongs.
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!range.collapsed || range.startContainer !== heading || range.startOffset > 1) return;
      let textSlot = token.nextSibling;
      if (!textSlot || textSlot.nodeType !== 3) {
        textSlot = document.createTextNode("");
        token.after(textSlot);
      }
      const caret = document.createRange();
      caret.setStart(textSlot, 0);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
    };
    const hideHeadingMarker = (heading) => {
      heading.querySelectorAll(":scope > .ot-md-token").forEach((token) => token.remove());
    };
    // Rebuilds a block element under a new tag while keeping its children and
    // the caret in place — the primitive behind live heading retagging.
    const replaceBlockTag = (el, tagName) => {
      const selection = window.getSelection();
      const caret = selection && selection.rangeCount ? { node: selection.anchorNode, offset: selection.anchorOffset } : null;
      const replacement = document.createElement(tagName);
      while (el.firstChild) replacement.append(el.firstChild);
      el.replaceWith(replacement);
      if (!caret || !replacement.contains(caret.node)) return;
      const limit = caret.node.nodeType === 3 ? caret.node.textContent.length : caret.node.childNodes.length;
      const range = document.createRange();
      range.setStart(caret.node, Math.min(caret.offset, limit));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    // The marker is ordinary editable text, so "### " can be reworked in
    // place: deleting or adding a "#" retags the heading level live, and
    // breaking the "#… " shape turns the line back into literal paragraph
    // text — the editor never blocks the caret around the markers.
    const normalizeEditedHeadingMarkers = (ce) => {
      ce.querySelectorAll(".ot-md-token").forEach((token) => {
        const heading = token.closest(HEADING_SELECTOR);
        const marker = (token.textContent || "").match(/^(#{1,6})[  ]$/);
        if (heading && marker) {
          const level = marker[1].length;
          if (Number(heading.tagName[1]) !== level) replaceBlockTag(heading, `h${level}`);
          return;
        }
        if (!heading && marker) {
          token.remove();
          return;
        }
        token.replaceWith(document.createTextNode(token.textContent || ""));
        if (heading) replaceBlockTag(heading, "p");
      });
    };
    const refreshHeadingMarkers = () => {
      const selection = window.getSelection();
      const anchor = selection && selection.rangeCount ? selection.anchorNode : null;
      const el = anchor ? (anchor.nodeType === 1 ? anchor : anchor.parentElement) : null;
      const active = el && blocksHost.contains(el) ? el.closest(HEADING_SELECTOR) : null;
      blocksHost.querySelectorAll(HEADING_SELECTOR).forEach((heading) => {
        if (heading === active) showHeadingMarker(heading);
        else hideHeadingMarker(heading);
      });
    };
    ["keyup", "mouseup", "focusin"].forEach((type) => blocksHost.addEventListener(type, refreshHeadingMarkers));
    blocksHost.addEventListener("focusout", (event) => {
      if (event.relatedTarget && blocksHost.contains(event.relatedTarget)) return;
      blocksHost.querySelectorAll(HEADING_SELECTOR).forEach(hideHeadingMarker);
    });

    const syncBlockFromDom = (t) => {
      t.block.value = detailsHtmlToMd(t.ce);
      syncDraft();
      refreshHeadingMarkers();
    };

    // Toolbar commands run against the focused contenteditable via execCommand,
    // so bold/italic/lists render LIVE in the editor (and Enter continues a
    // list natively) instead of inserting raw markdown markers.
    const runCommand = (mutate) => {
      const t = focusedText();
      if (!t) return;
      t.ce.focus();
      mutate(t);
      syncBlockFromDom(t);
    };
    const execCmd = (command, value) => runCommand(() => document.execCommand(command, false, value || null));
    const toggleBlockFormat = (tag) => runCommand(() => {
      const current = String(document.queryCommandValue("formatBlock") || "").toLowerCase();
      document.execCommand("formatBlock", false, current === tag ? "p" : tag);
    });
    // Heading picker: the Obsidian menu steals focus from the contenteditable,
    // so the caret's range is captured before it opens and restored on pick —
    // the same dance insertLink already does.
    const openHeadingMenu = (event) => {
      const t = focusedText();
      if (!t) return;
      const selection = window.getSelection();
      const savedRange = selection && selection.rangeCount && t.ce.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
      const applyBlockTag = (tag) => {
        t.ce.focus();
        if (savedRange) {
          const restore = window.getSelection();
          restore.removeAllRanges();
          restore.addRange(savedRange);
        }
        document.execCommand("formatBlock", false, tag);
        syncBlockFromDom(t);
      };
      const menu = new Menu();
      [["Heading 1", "h1"], ["Heading 2", "h2"], ["Heading 3", "h3"], ["Normal text", "p"]].forEach(([title, tag]) => {
        menu.addItem((item) => item.setTitle(title).onClick(() => applyBlockTag(tag)));
      });
      menu.showAtMouseEvent(event);
    };
    // Space right after a line-start markdown trigger ("-", "1.", "#"–"###",
    // ">") converts the line into that block. Only plain paragraphs qualify —
    // inside lists, quotes, headings, or code the Space stays literal.
    const applyAutoformatTrigger = (ce) => {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
      const range = selection.getRangeAt(0);
      const caretNode = range.startContainer;
      if (!ce.contains(caretNode) || caretNode.nodeType !== 3) return false;
      const host = caretNode.parentElement;
      if (!host || host.closest("li, blockquote, h1, h2, h3, h4, h5, h6, code")) return false;
      const lineHost = host.closest("p, div") || ce;
      const beforeCaret = document.createRange();
      beforeCaret.selectNodeContents(lineHost);
      beforeCaret.setEnd(caretNode, range.startOffset);
      const prefix = beforeCaret.toString();
      const trigger = autoformatCommandForPrefix(prefix);
      if (!trigger || range.startOffset < prefix.length) return false;
      const removal = document.createRange();
      removal.setStart(caretNode, range.startOffset - prefix.length);
      removal.setEnd(caretNode, range.startOffset);
      selection.removeAllRanges();
      selection.addRange(removal);
      document.execCommand("delete");
      document.execCommand(trigger.command, false, trigger.value || null);
      return true;
    };
    // Live inline preview: Space right after a completed **bold**, *italic*,
    // ~~strike~~ or `code` run swaps the markers for the real formatting.
    const applyInlineAutoformat = (ce) => {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
      const range = selection.getRangeAt(0);
      const caretNode = range.startContainer;
      if (!ce.contains(caretNode) || caretNode.nodeType !== 3) return false;
      const host = caretNode.parentElement;
      if (!host || host.closest("code")) return false;
      const match = inlineAutoformatMatch(caretNode.textContent.slice(0, range.startOffset));
      if (!match) return false;
      const markerRange = document.createRange();
      markerRange.setStart(caretNode, range.startOffset - match.span.length);
      markerRange.setEnd(caretNode, range.startOffset);
      selection.removeAllRanges();
      selection.addRange(markerRange);
      // The trailing &nbsp; is the consumed Space AND lands the caret outside
      // the new element, so typing continues unformatted; the serializer folds
      // it back into a plain space on save.
      document.execCommand("insertHTML", false, `<${match.tag}>${escapeDetailsHtml(match.content)}</${match.tag}>&nbsp;`);
      return true;
    };
    const wrapCode = () => runCommand(() => {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || selection.isCollapsed) {
        document.execCommand("insertText", false, "`code`");
        return;
      }
      const range = selection.getRangeAt(0);
      try {
        range.surroundContents(document.createElement("code"));
      } catch (error) {
        document.execCommand("insertText", false, `\`${selection.toString()}\``);
      }
    });
    const insertLink = () => {
      const t = focusedText();
      if (!t) return;
      const selection = window.getSelection();
      const hasSelection = !!(selection && selection.rangeCount && !selection.isCollapsed && t.ce.contains(selection.anchorNode));
      const savedRange = hasSelection ? selection.getRangeAt(0).cloneRange() : null;
      new TextPromptModal(this.app, "Link", "https://...", "https://", (url) => {
        const target = textLine(url);
        if (!target || target === "https://") return;
        t.ce.focus();
        if (savedRange) {
          const restore = window.getSelection();
          restore.removeAllRanges();
          restore.addRange(savedRange);
          document.execCommand("createLink", false, target);
        } else {
          document.execCommand("insertHTML", false, `<a href="${escapeDetailsHtml(target)}">${escapeDetailsHtml(target)}</a>`);
        }
        syncBlockFromDom(t);
      }).open();
    };

    const insertVaultNote = () => {
      const t = focusedText();
      if (!t) return;
      const selection = window.getSelection();
      const hasSelection = !!(selection && selection.rangeCount && !selection.isCollapsed && t.ce.contains(selection.anchorNode));
      const selectedText = hasSelection ? selection.toString() : "";
      const savedRange = selection && selection.rangeCount && t.ce.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
      new VaultNoteSuggestModal(this.app, (file) => {
        const target = file.path.replace(/\.md$/i, "");
        const label = selectedText || file.basename;
        t.ce.focus();
        if (savedRange) {
          const restore = window.getSelection();
          restore.removeAllRanges();
          restore.addRange(savedRange);
          if (hasSelection) restore.deleteFromDocument();
        }
        document.execCommand(
          "insertHTML",
          false,
          `<a class="internal-link" data-wikilink="true" data-has-alias="${hasSelection ? "true" : "false"}" data-href="${escapeDetailsHtml(target)}" href="${escapeDetailsHtml(target)}">${escapeDetailsHtml(label)}</a>`
        );
        syncBlockFromDom(t);
      }).open();
    };

    const applyGridToBlockRun = (index, columns) => {
      const run = imageRunAround(blocks, index, isBlankTextBlock);
      if (!run.length) return;
      const width = columns ? this.gridColumnWidth(blocksHost.clientWidth || 640, columns) : 0;
      run.forEach((b) => { b.markup = imageMarkupWithSize(b.markup, width); });
      syncDraft();
      renderBlocks();
    };

    const renderBlocks = () => {
      blocksHost.replaceChildren();
      blocks.forEach((block, index) => {
        if (block.type === "text") {
          // A real WYSIWYG surface: markdown renders as formatted content and
          // serializes back on every input — the user never sees the markers.
          // markdown-rendered pulls the active Obsidian theme's typography, so
          // headings/quotes/code preview live with the vault's own look.
          const ce = createElement("div", "ot-block-text markdown-rendered");
          ce.contentEditable = String(!this.readOnly);
          ce.spellcheck = true;
          ce.setAttribute("aria-label", `${fieldTitle} editor`);
          ce.innerHTML = detailsMdToHtml(block.value);
          if (index === 0 && blocks.length === 1) ce.dataset.placeholder = placeholder;
          const refreshEmpty = () => { ce.dataset.empty = ce.textContent.trim() ? "false" : "true"; };
          refreshEmpty();
          // An empty text slot wedged between two images collapses to a slim
          // clickable strip so consecutive images sit side by side like a grid;
          // typing in it expands it back to a full row — matching the read
          // view, where text between two embeds breaks the image flow.
          const betweenImages = !!(blocks[index - 1] && blocks[index - 1].type === "img" && blocks[index + 1] && blocks[index + 1].type === "img");
          const refreshSlim = () => { ce.classList.toggle("ot-block-text--slim", betweenImages && !ce.textContent.trim()); };
          refreshSlim();
          ce.addEventListener("input", () => {
            normalizeEditedHeadingMarkers(ce);
            block.value = detailsHtmlToMd(ce);
            syncDraft();
            refreshEmpty();
            refreshSlim();
          });
          ce.addEventListener("focus", () => { activeText = { block, ce }; });
          // Escape hatch for quotes and lists (Notion behavior): pressing Enter
          // on an EMPTY line inside a blockquote or list item exits it and drops
          // the caret into a normal paragraph below — otherwise contenteditable
          // keeps every new line trapped inside the quote forever.
          const syncAfterStructuralEdit = () => {
            normalizeEditedHeadingMarkers(ce);
            block.value = detailsHtmlToMd(ce);
            syncDraft();
            refreshEmpty();
            refreshHeadingMarkers();
          };
          ce.addEventListener("keydown", (event) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === " ") {
              if (applyAutoformatTrigger(ce) || applyInlineAutoformat(ce)) {
                event.preventDefault();
                syncAfterStructuralEdit();
              }
              return;
            }
            if (event.key !== "Enter" || event.shiftKey) return;
            const selection = window.getSelection();
            if (!selection || !selection.rangeCount || !selection.isCollapsed) return;
            const anchor = selection.anchorNode;
            if (!anchor || !ce.contains(anchor)) return;
            const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
            if (!el) return;
            // Enter inside a heading exits to a normal paragraph (Notion and
            // Obsidian behavior) — Chromium would otherwise continue the same
            // heading forever, leaving every following line big and bold.
            const heading = el.closest("h1, h2, h3, h4, h5, h6");
            if (heading && ce.contains(heading)) {
              event.preventDefault();
              document.execCommand("insertParagraph");
              document.execCommand("formatBlock", false, "p");
              syncAfterStructuralEdit();
              return;
            }
            const listItem = el.closest("li");
            const quote = el.closest("blockquote");
            // "---" + Enter becomes a real divider, matching the markdown shorthand.
            const dividerLine = !listItem && !quote ? el.closest("p, div") : null;
            if (dividerLine && dividerLine !== ce && ce.contains(dividerLine) && /^-{3,}$/.test((dividerLine.textContent || "").trim())) {
              event.preventDefault();
              const lineRange = document.createRange();
              lineRange.selectNodeContents(dividerLine);
              selection.removeAllRanges();
              selection.addRange(lineRange);
              document.execCommand("delete");
              document.execCommand("insertHorizontalRule");
              syncAfterStructuralEdit();
              return;
            }
            if (!listItem && !quote) return;
            // The "current line" must be a wrapper INSIDE the quote - closest()
            // can walk past a structureless quote up to the editor root, whose
            // textContent is the whole block (the escape would never fire there).
            let line = listItem;
            if (!line) {
              const candidate = el.closest("p, div");
              line = candidate && quote.contains(candidate) && candidate !== quote ? candidate : quote;
            }
            if ((line.textContent || "").replace(/\u00a0/g, " ").trim()) return; // line has content — normal Enter
            event.preventDefault();
            document.execCommand("outdent");
            syncAfterStructuralEdit();
          });
          ce.addEventListener("paste", (event) => {
            const images = imageFilesFromTransfer(event.clipboardData);
            if (images.length) {
              event.preventDefault();
              if (!noteMode) insertImagesSequentially(images).catch(console.error);
              return;
            }
            // Paste as plain text so foreign HTML styling can't leak into the note.
            const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
            event.preventDefault();
            if (text) document.execCommand("insertText", false, text);
          });
          block._ce = ce;
          blocksHost.append(ce);
          return;
        }
        const wrap = createElement("div", "ot-block-image");
        const resolved = this.plugin.resolveCardImage(this.card, block.target);
        if (resolved && resolved.src) {
          const img = createElement("img", "");
          img.src = resolved.src;
          img.alt = resolved.name || "";
          img.loading = "lazy";
          wrap.append(img);
          this.applyStoredImageWidth(img, block.markup);
          // Drag-resize rewrites the block's markup in place; joinBlocks picks
          // it up on the next keystroke, and Save persists it like any edit.
          this.enableImageResize(wrap, img, {
            getMarkup: () => block.markup,
            onCommit: (width) => {
              block.markup = imageMarkupWithSize(block.markup, width);
              syncDraft();
            },
          });
        } else {
          wrap.append(createElement("span", "ot-image-missing", block.target.split("/").pop() || "image"));
        }
        const remove = iconButton("trash", "Remove image", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const at = blocks.indexOf(block);
          if (at === -1) return;
          blocks.splice(at, 1);
          // Merge the text blocks the image used to separate.
          if (at > 0 && at < blocks.length && blocks[at - 1].type === "text" && blocks[at].type === "text") {
            const merged = [blocks[at - 1].value, blocks[at].value].filter((part) => part.trim());
            blocks[at - 1].value = merged.join("\n\n");
            blocks.splice(at, 1);
          }
          syncDraft();
          renderBlocks();
          this.discardPendingDetailAttachment(block.target).catch(console.error);
        });
        remove.classList.add("ot-block-image-remove");
        wrap.append(remove);

        // Grid chip: lay the surrounding image run out as 2/3/4 columns.
        const gridChip = iconButton("layout-grid", "Arrange images side by side", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const menu = new Menu();
          [2, 3, 4].forEach((columns) => {
            menu.addItem((item) => item.setTitle(`${columns} side by side`).onClick(() => {
              applyGridToBlockRun(blocks.indexOf(block), columns);
            }));
          });
          menu.addItem((item) => item.setTitle("Full width").onClick(() => {
            applyGridToBlockRun(blocks.indexOf(block), 0);
          }));
          menu.showAtMouseEvent(event);
        });
        gridChip.classList.add("ot-image-grid-chip");
        wrap.append(gridChip);

        // Move an image by dragging it: drop on another image's left/right half
        // to land before/after it. Structure re-normalizes from the markdown so
        // the text slots around images stay consistent after any move.
        wrap.draggable = true;
        wrap.addEventListener("dragstart", (event) => {
          if (event.target.closest(".ot-img-resize, .ot-block-image-remove, .ot-image-grid-chip")) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData(IMG_BLOCK_DRAG_TYPE, String(blocks.indexOf(block)));
          event.dataTransfer.effectAllowed = "move";
          wrap.classList.add("is-dragging");
        });
        wrap.addEventListener("dragend", () => wrap.classList.remove("is-dragging"));
        wrap.addEventListener("dragover", (event) => {
          if (!hasDragType(event, IMG_BLOCK_DRAG_TYPE)) return;
          event.preventDefault();
          const rect = wrap.getBoundingClientRect();
          const before = event.clientX < rect.left + rect.width / 2;
          wrap.classList.toggle("is-img-drop-before", before);
          wrap.classList.toggle("is-img-drop-after", !before);
        });
        wrap.addEventListener("dragleave", () => wrap.classList.remove("is-img-drop-before", "is-img-drop-after"));
        wrap.addEventListener("drop", (event) => {
          if (!hasDragType(event, IMG_BLOCK_DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          const before = wrap.classList.contains("is-img-drop-before");
          wrap.classList.remove("is-img-drop-before", "is-img-drop-after");
          const fromIndex = parseInt(event.dataTransfer.getData(IMG_BLOCK_DRAG_TYPE), 10);
          const dragged = blocks[fromIndex];
          if (!dragged || dragged === block || dragged.type !== "img") return;
          blocks.splice(fromIndex, 1);
          let to = blocks.indexOf(block);
          if (to === -1) return;
          if (!before) to += 1;
          blocks.splice(to, 0, dragged);
          blocks = buildBlocks(joinBlocks());
          syncDraft();
          renderBlocks();
        });

        blocksHost.append(wrap);
      });
    };

    // Clicking the frame's empty space puts the caret in the nearest text block.
    blocksHost.addEventListener("click", (event) => {
      if (event.target !== blocksHost) return;
      const t = focusedText();
      if (t && t.ce) placeCaret(t.ce, false);
    });

    // Paste or drop an image straight into the notes: it's saved into the vault
    // (respecting the attachment-folder setting) and embedded compactly.
    const isFileDrag = (event) => {
      const types = event.dataTransfer && Array.from(event.dataTransfer.types || []);
      return !!(types && types.includes("Files"));
    };
    const handlePaste = (event) => {
      const images = imageFilesFromTransfer(event.clipboardData);
      if (!images.length) return; // plain text paste — leave it alone
      event.preventDefault();
      if (!noteMode) insertImagesSequentially(images).catch(console.error);
    };
    const handleDrop = (event) => {
      if (noteMode || this.readOnly || !isFileDrag(event)) return; // not a file drop — leave it
      // We invited this drop, so consume it whether or not it's an image, else a
      // stray file would fall through to Obsidian's own handling.
      event.preventDefault();
      event.stopPropagation();
      field.classList.remove("is-image-drag");
      const images = imageFilesFromTransfer(event.dataTransfer);
      if (!images.length) {
        new Notice("Only images can be embedded here.");
        return;
      }
      insertImagesSequentially(images).catch(console.error);
    };
    // Handlers live on the whole field so crossing between the preview/editor and
    // their own children (e.g. an embedded image) never flickers the hint.
    field.addEventListener("dragover", (event) => {
      if (noteMode || this.readOnly || !isFileDrag(event)) return;
      event.preventDefault();
      field.classList.add("is-image-drag");
    });
    field.addEventListener("dragleave", (event) => {
      if (!field.contains(event.relatedTarget)) field.classList.remove("is-image-drag");
    });
    field.addEventListener("drop", handleDrop);

    if (isEditing) {
      // Prefer Obsidian's OWN Live Preview editor (real CodeMirror 6: syntax
      // hides and reveals around the caret exactly like in a note, with the
      // vault's theme and settings). When its internal API is unavailable, the
      // WYSIWYG block editor below takes over unchanged.
      const embeddedHost = createElement("div", "ot-embedded-editor");
      const embeddedEditor = createEmbeddedMarkdownEditor(this.app, embeddedHost, {
        value: draftMarkdown,
        placeholder,
        cursorLocation: { anchor: draftMarkdown.length, head: draftMarkdown.length },
        onChange: (value) => {
          draftMarkdown = value;
          if (!noteMode) this.detailsDraft = value;
          editor.value = value;
          if (noteMode && options.onDraftChange) options.onDraftChange(value);
          updateEditorState();
        },
        onSubmit: () => saveDetails().catch(console.error),
        onEscape: () => cancelDetails().catch(console.error),
        onPaste: (event) => {
          const images = imageFilesFromTransfer(event.clipboardData);
          if (!images.length || noteMode) return false;
          insertImagesSequentially(images).catch(console.error);
          return true;
        },
      });
      if (embeddedEditor) {
        this.trackEmbeddedEditor(embeddedEditor);
        editor.value = draftMarkdown;
        if (!noteMode) {
          this.insertDetailAtCaret = (markup) => {
            embeddedEditor.insertAtCursor(markup);
            return true;
          };
        }

        const editorFrame = createElement("div", "ot-trello-editor");
        const toolbar = createElement("div", "ot-details-toolbar");
        toolbar.setAttribute("role", "toolbar");
        toolbar.setAttribute("aria-label", `${fieldTitle} formatting`);
        const stripLineMarkers = (text) => text.replace(/^\s*(#{1,6}\s+|[-*]\s+|\d+[.)]\s+|>\s+)/, "");
        const setHeadingLevel = (level) => embeddedEditor.setLinePrefix((text) => `${level ? `${"#".repeat(level)} ` : ""}${stripLineMarkers(text)}`);
        const openCmHeadingMenu = (event) => {
          const menu = new Menu();
          [1, 2, 3].forEach((level) => {
            menu.addItem((item) => item.setTitle(`Heading ${level}`).onClick(() => setHeadingLevel(level)));
          });
          menu.addItem((item) => item.setTitle("Normal text").onClick(() => setHeadingLevel(0)));
          menu.showAtMouseEvent(event);
        };
        const insertCmLink = () => {
          new TextPromptModal(this.app, "Link", "https://...", "https://", (url) => {
            const target = textLine(url);
            if (!target || target === "https://") return;
            const label = embeddedEditor.selectionText;
            embeddedEditor.insertAtCursor(`[${label || target}](${target})`);
          }).open();
        };
        const insertCmVaultNote = () => {
          const label = embeddedEditor.selectionText;
          new VaultNoteSuggestModal(this.app, (file) => {
            const target = file.path.replace(/\.md$/i, "");
            embeddedEditor.insertAtCursor(label ? `[[${target}|${label}]]` : `[[${target}]]`);
          }).open();
        };
        const leftTools = createElement("div", "ot-details-toolbar-group");
        leftTools.append(
          makeTextTool("Tt", "Heading", openCmHeadingMenu),
          makeTextTool("B", "Bold", () => embeddedEditor.wrapSelection("**")),
          makeTextTool("I", "Italic", () => embeddedEditor.wrapSelection("*")),
          makeTextTool("S", "Strikethrough", () => embeddedEditor.wrapSelection("~~")),
          makeTool("quote", "Quote", () => embeddedEditor.setLinePrefix((text) => `> ${text}`)),
          makeTool("list", "Bulleted list", () => embeddedEditor.setLinePrefix((text) => `- ${stripLineMarkers(text)}`)),
          makeTool("list-ordered", "Numbered list", () => embeddedEditor.setLinePrefix((text, index) => `${index + 1}. ${stripLineMarkers(text)}`)),
          makeTool("link", "Link", insertCmLink),
          makeTool("file-text", "Link vault note", insertCmVaultNote),
          ...(!noteMode ? [makeTool("image", "Add image", () => imageInput.click())] : []),
          makeTool("minus", "Divider", () => embeddedEditor.insertAtCursor("\n---\n"))
        );
        const rightTools = createElement("div", "ot-details-toolbar-group");
        rightTools.append(makeTool("code-2", "Inline code", () => embeddedEditor.wrapSelection("`")));
        rightTools.append(makeTool("help-circle", "Formatting help", () => new Notice("Obsidian's Live Preview editor: write Markdown (# headings, **bold**, - lists, [[links]]) and it renders as you type. Ctrl/⌘+S or Ctrl/⌘+Enter saves, Esc cancels.")));
        toolbar.append(leftTools, rightTools);
        editorFrame.append(toolbar, embeddedHost);

        const actions = createElement("div", "ot-details-actions");
        const actionInfo = createElement("div", "ot-details-action-info");
        editorStatus = createElement("span", "ot-details-status", "Saved");
        editorStatus.setAttribute("aria-live", "polite");
        actionInfo.append(
          editorStatus,
          createElement("span", "ot-details-shortcut", "Ctrl/⌘ + S to save · Esc to cancel"),
        );
        const actionButtons = createElement("div", "ot-details-action-buttons");
        saveButton = createElement("button", "mod-cta ot-save-button", "Save");
        cancelButton = createElement("button", "", "Cancel");
        addButtonIcon(saveButton, "check");
        addButtonIcon(cancelButton, "x");
        saveButton.type = "button";
        cancelButton.type = "button";
        saveButton.addEventListener("click", () => saveDetails().catch(console.error));
        cancelButton.addEventListener("click", () => cancelDetails().catch(console.error));
        actionButtons.append(saveButton, cancelButton);
        actions.append(actionInfo, actionButtons);
        updateEditorState();

        header.append(heading);
        // With room beside the modal, the editor opens as a page-like side
        // sheet and the card stays fully visible; otherwise it edits inline.
        const sheetContent = sheetKey ? this.openDetailsSideSheet(fieldTitle, sheetKey) : null;
        if (sheetContent) {
          editorFrame.classList.add("ot-side-sheet-editor");
          sheetContent.append(editorFrame, actions);
          const sideNote = createElement("div", "ot-side-editing-note", "Editing in the side panel");
          field.append(header, sideNote, imageInput, editor);
        } else {
          field.append(header, editorFrame, actions, imageInput, editor);
        }
        requestAnimationFrame(() => embeddedEditor.focusEditor());
        return field;
      }

      const toolbar = createElement("div", "ot-details-toolbar");
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", `${fieldTitle} formatting`);
      const leftTools = createElement("div", "ot-details-toolbar-group");
      leftTools.append(
        makeTextTool("Tt", "Heading", openHeadingMenu),
        makeTextTool("B", "Bold (Ctrl+B)", () => execCmd("bold")),
        makeTextTool("I", "Italic (Ctrl+I)", () => execCmd("italic")),
        makeTextTool("S", "Strikethrough (Ctrl+Shift+X)", () => execCmd("strikeThrough")),
        makeTool("quote", "Quote", () => toggleBlockFormat("blockquote")),
        makeTool("list", "Bulleted list", () => execCmd("insertUnorderedList")),
        makeTool("list-ordered", "Numbered list", () => execCmd("insertOrderedList")),
        makeTool("link", "Link (Ctrl+K)", insertLink),
        makeTool("file-text", "Link vault note", insertVaultNote),
        ...(!noteMode ? [makeTool("image", "Add image", () => imageInput.click())] : []),
        makeTool("minus", "Divider", () => execCmd("insertHorizontalRule"))
      );

      const rightTools = createElement("div", "ot-details-toolbar-group");
      rightTools.append(makeTool("code-2", "Inline code (Ctrl+E)", wrapCode));
      rightTools.append(makeTool("help-circle", "Formatting help", () => new Notice('Type "- ", "1. ", "# " or "> " plus Space at a line start for lists, headings and quotes. Type **bold**, *italic*, `code` or ~~strike~~ plus Space to format inline. Shortcuts: Ctrl/⌘+B bold, I italic, K link, E code, Shift+X strikethrough, S save.')));
      toolbar.append(leftTools, rightTools);

      const editorFrame = createElement("div", "ot-trello-editor ot-block-frame");
      // The master textarea stays hidden: it only mirrors the joined markdown so
      // saveDetails / insertImageFromFile keep reading the same place as before.
      blocks = buildBlocks(draftMarkdown);
      syncDraft();
      renderBlocks();

      // An image pasted/attached while editing lands at the active block's caret,
      // splitting the text so the picture renders inline immediately — the user
      // never sees ![[...]] markup.
      const insertDetailAtCaret = (markup) => {
        const t = focusedText();
        if (!t) return false;
        const at = blocks.indexOf(t.block);
        if (at === -1) return false;
        // Split the focused contenteditable at the caret: serialize what's
        // before and after it, so the image lands exactly where you're typing.
        let beforeText = t.block.value;
        let afterText = "";
        const selection = window.getSelection();
        if (selection && selection.rangeCount && t.ce.contains(selection.anchorNode)) {
          const range = selection.getRangeAt(0);
          const beforeRange = document.createRange();
          beforeRange.selectNodeContents(t.ce);
          beforeRange.setEnd(range.startContainer, range.startOffset);
          const afterRange = document.createRange();
          afterRange.selectNodeContents(t.ce);
          afterRange.setStart(range.endContainer, range.endOffset);
          const beforeHost = document.createElement("div");
          beforeHost.append(beforeRange.cloneContents());
          const afterHost = document.createElement("div");
          afterHost.append(afterRange.cloneContents());
          beforeText = detailsHtmlToMd(beforeHost);
          afterText = detailsHtmlToMd(afterHost);
        }
        const seg = this.splitDetailSegments(markup).find((s) => s.type === "img");
        blocks.splice(
          at,
          1,
          { type: "text", value: beforeText },
          { type: "img", target: (seg && seg.target) || markup, markup },
          { type: "text", value: afterText }
        );
        syncDraft();
        renderBlocks();
        const nextBlock = blocks[at + 2];
        requestAnimationFrame(() => {
          if (nextBlock && nextBlock._ce) placeCaret(nextBlock._ce, true);
        });
        return true;
      };
      if (!noteMode) this.insertDetailAtCaret = insertDetailAtCaret;

      const actions = createElement("div", "ot-details-actions");
      const actionInfo = createElement("div", "ot-details-action-info");
      editorStatus = createElement("span", "ot-details-status", "Saved");
      editorStatus.setAttribute("aria-live", "polite");
      actionInfo.append(
        editorStatus,
        createElement("span", "ot-details-shortcut", "Ctrl/⌘ + S to save · Esc to cancel"),
      );

      const actionButtons = createElement("div", "ot-details-action-buttons");
      saveButton = createElement("button", "mod-cta ot-save-button", "Save");
      cancelButton = createElement("button", "", "Cancel");
      addButtonIcon(saveButton, "check");
      addButtonIcon(cancelButton, "x");
      saveButton.type = "button";
      cancelButton.type = "button";
      saveButton.addEventListener("click", () => saveDetails().catch(console.error));
      cancelButton.addEventListener("click", () => cancelDetails().catch(console.error));
      actionButtons.append(saveButton, cancelButton);
      actions.append(actionInfo, actionButtons);
      updateEditorState();

      editorFrame.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          saveDetails().catch(console.error);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancelDetails().catch(console.error);
          return;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          const key = event.key.toLowerCase();
          const shortcut = event.shiftKey
            ? (key === "x" ? () => execCmd("strikeThrough") : null)
            : {
              b: () => execCmd("bold"),
              i: () => execCmd("italic"),
              e: wrapCode,
              k: insertLink,
              s: () => saveDetails().catch(console.error),
            }[key];
          if (shortcut) {
            event.preventDefault();
            shortcut();
          }
        }
      });

      header.append(heading);
      editorFrame.append(toolbar, blocksHost);
      field.append(header, editorFrame, actions, imageInput, editor);
      requestAnimationFrame(() => {
        // Enter should produce clean <p> paragraphs (matches the serializer).
        try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (error) { /* older engines */ }
        const t = focusedText();
        if (t && t.ce) placeCaret(t.ce, false);
      });
      return field;
    }

    header.append(heading);
    if (!this.readOnly) header.append(textButton("pencil", "Edit", showEditor, "ot-details-edit-button"));
    // Click-to-edit: clicking the description opens the editor directly — no
    // trip to the Edit button. Guards keep the read view copy-friendly:
    // - a click that ends a TEXT SELECTION (drag-select, double-click a word)
    //   must select/copy, not switch to the editor;
    // - images, links, and buttons (Copy image, Show more) keep their own click
    //   behavior and never flip to edit.
    preview.addEventListener("click", (event) => {
      const internalLink = event.target.closest("a.internal-link");
      if (internalLink) {
        event.preventDefault();
        event.stopPropagation();
        const target = internalLink.dataset.href || internalLink.getAttribute("data-href") || internalLink.getAttribute("href");
        if (!target) return;
        const sourcePath = (this.card && this.card.filePath) || "";
        const newLeaf = event.ctrlKey || event.metaKey;
        this.close();
        Promise.resolve(this.app.workspace.openLinkText(target, sourcePath, newLeaf)).catch((error) => {
          console.error(error);
          new Notice("Could not open the linked note.");
        });
        return;
      }
      if (this.readOnly) return;
      if (event.target.closest("img, a, button, .ot-inline-image")) return;
      const selection = window.getSelection();
      if (selection && selection.toString()) return;
      showEditor();
    });
    renderPreview();
    field.append(preview, editor, imageInput);
    field.prepend(header);
    return field;
  }

  // Copy a rendered <img> to the system clipboard as PNG. Draws through a canvas
  // because the source is a vault resource URL (same-origin in Obsidian, so the
  // canvas is not tainted). ClipboardItem exists on desktop (Electron); on a
  // platform without it this throws and the caller shows a notice.
  async copyImageToClipboard(img) {
    if (!img.complete || !(img.naturalWidth > 0)) throw new Error("image not loaded");
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob || typeof ClipboardItem === "undefined" || !navigator.clipboard || !navigator.clipboard.write) {
      throw new Error("clipboard image write unsupported");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }

  // Applies the width stored in an embed's markup (Obsidian's |300 syntax) to a
  // rendered <img>. An explicit width lifts the height cap: the size is the
  // user's choice, so tall images must not be letterboxed by max-height.
  applyStoredImageWidth(img, markup) {
    const width = imageSizeFromMarkup(markup);
    if (width) {
      img.style.width = `${width}px`;
      img.style.maxHeight = "none";
    }
  }

  // Even column width for a K-across image grid inside a container.
  gridColumnWidth(containerWidth, columns) {
    const width = Math.floor((Math.max(320, containerWidth) - 28 - columns * 10) / columns);
    return Math.max(100, width);
  }

  /**
   * Notion-style image resize: a grip on the image's right edge. Dragging
   * resizes the live <img> (with a px chip); on release the width is committed
   * through onCommit(width) — 0 meaning "clear the size" when dragged to full
   * width — which rewrites the embed markup via imageMarkupWithSize, so the
   * size persists in the note and renders identically in Obsidian. Consecutive
   * images flow side by side, so sizing two down makes an instant grid.
   */
  enableImageResize(wrap, img, options) {
    const { getMarkup, onCommit } = options;
    const handle = createElement("div", "ot-img-resize");
    handle.title = "Drag to resize";
    handle.setAttribute("aria-label", "Resize image");
    const chip = createElement("div", "ot-img-size-chip is-hidden");
    wrap.append(handle, chip);

    let drag = null;
    const finishDrag = (commit) => {
      if (!drag) return;
      const { width, maxWidth } = drag;
      drag = null;
      handle.classList.remove("is-dragging");
      chip.classList.add("is-hidden");
      if (!commit) {
        // Interrupted drag — fall back to whatever the markup still says.
        img.style.width = "";
        img.style.maxHeight = "";
        this.applyStoredImageWidth(img, getMarkup());
        return;
      }
      // At (practically) the container's width, storing no size renders the
      // same — and keeps big future layouts full-width.
      const finalWidth = width >= maxWidth - 2 ? 0 : width;
      if (!finalWidth) {
        img.style.width = "";
        img.style.maxHeight = "";
      }
      Promise.resolve(onCommit(finalWidth)).catch(console.error);
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const container = wrap.parentElement;
      const maxWidth = Math.max(160, (container ? container.clientWidth : 1200) - 4);
      const startWidth = img.getBoundingClientRect().width;
      drag = { startX: event.clientX, startWidth, maxWidth, width: Math.round(startWidth) };
      handle.classList.add("is-dragging");
      chip.classList.remove("is-hidden");
      chip.textContent = `${drag.width}px`;
      try { handle.setPointerCapture(event.pointerId); } catch (error) { /* older engines */ }
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      event.preventDefault();
      const width = Math.min(drag.maxWidth, Math.max(100, Math.round(drag.startWidth + event.clientX - drag.startX)));
      if (width === drag.width) return;
      drag.width = width;
      img.style.width = `${width}px`;
      img.style.maxHeight = "none";
      chip.textContent = `${width}px`;
    });
    handle.addEventListener("pointerup", (event) => {
      try { handle.releasePointerCapture(event.pointerId); } catch (error) { /* not captured */ }
      finishDrag(true);
    });
    handle.addEventListener("pointercancel", () => finishDrag(false));
  }

  // Export this card as a clean, print-styled PDF (title, board/list, labels,
  // members, dates, description with embedded images, checklist). Desktop only:
  // renders self-contained HTML in a hidden BrowserWindow, then saves the PDF
  // through Obsidian's vault API without direct filesystem access.
  async exportCardPdf() {
    let remote = null;
    try { remote = window.require && window.require("@electron/remote"); } catch (error) { remote = null; }
    if (!remote) {
      try { remote = window.require && window.require("electron").remote; } catch (error) { remote = null; }
    }
    if (!remote || !remote.BrowserWindow) {
      new Notice("PDF export needs the Obsidian desktop app.");
      return;
    }
    try {
      if (!this.readOnly) await this.saveNow();
      const card = this.card;
      const board = this.plugin.findBoardForCard(card);
      const list = board && board.lists.find((item) => item.id === card.listId);
      const esc = escapeDetailsHtml;

      // Description: markdown via the shared converter; images inlined as data
      // URLs so the hidden window needs no access to the vault's app:// protocol.
      // Consecutive images form a RUN (whitespace between embeds doesn't break
      // it) and print as a flex row with PERCENTAGE widths derived from the
      // stored px sizes (relative to the ~800px modal they were sized in). Raw
      // px would overflow the narrower A4 content box and wrap the grid into a
      // single column — percentages keep 2-across as 2-across on any page.
      const descriptionParts = [];
      let imageRun = [];
      const flushImageRun = () => {
        if (!imageRun.length) return;
        if (imageRun.length === 1) {
          const only = imageRun[0];
          const sizing = only.width ? ` style="width:${Math.min(only.width, 660)}px"` : "";
          descriptionParts.push(`<img src="${only.src}"${sizing}>`);
        } else {
          const cells = imageRun.map((item) => {
            const percent = Math.min(100, Math.max(12, Math.round(((item.width || 380) / 8) * 10) / 10));
            return `<img src="${item.src}" style="width: calc(${percent}% - 8px)">`;
          }).join("");
          descriptionParts.push(`<div class="imgrow">${cells}</div>`);
        }
        imageRun = [];
      };
      for (const seg of this.splitDetailSegments(this.currentDetailsText())) {
        if (seg.type === "img") {
          const resolved = this.plugin.resolveCardImage(card, seg.target);
          if (resolved && resolved.file) {
            try {
              const bin = await this.app.vault.readBinary(resolved.file);
              const ext = (resolved.file.extension || "png").toLowerCase();
              const mime = ext === "svg" ? "image/svg+xml" : (ext === "jpg" ? "image/jpeg" : `image/${ext}`);
              imageRun.push({
                src: `data:${mime};base64,${arrayBufferToBase64(bin)}`,
                width: imageSizeFromMarkup(seg.markup),
              });
            } catch (error) {
              // unreadable image — skip it rather than fail the export
            }
          }
          continue;
        }
        if (!seg.text.trim()) continue; // whitespace gap — keep the image run going
        flushImageRun();
        descriptionParts.push(detailsMdToHtml(seg.text));
      }
      flushImageRun();

      const labelsHtml = (this.localLabels || [])
        .map((label) => `<span class="pill" style="background:${esc(label.color || DEFAULT_LABEL_COLOR)}">${esc(label.name)}</span>`)
        .join("");
      const collaborationEnabled = this.plugin.isSyncDeckEnabled();
      const membersText = collaborationEnabled
        ? (this.localAssignees || []).map((a) => a.name || a.email).filter(Boolean).join(", ")
        : "";
      const datesText = dateRangeLabel(card.startDate, card.dueDate) || "";
      const checklistHtml = (this.localChecklists || [])
        .map((group) => {
          const stats = checklistStats(group.items);
          const items = (group.items || [])
            .map((item) => `<div class="chk"><span class="box">${item.done ? "☑" : "☐"}</span><span class="${item.done ? "done" : ""}">${esc(item.text || "")}</span>${collaborationEnabled && item.assignee && (item.assignee.name || item.assignee.email) ? `<span class="who"> — ${esc(item.assignee.name || item.assignee.email)}</span>` : ""}</div>`)
            .join("");
          const color = cleanColor(group.color) || LIST_COLORS[1];
          return `<div class="checklist-group" style="border-left:3px solid ${esc(color)};padding-left:10px"><h3 style="color:${esc(color)}">${esc(group.title || "Checklist")}</h3><div class="checklist-progress">${stats.percent}% · ${stats.done}/${stats.total}</div>${items}</div>`;
        })
        .join("");
      const metaBits = [
        board ? esc(board.name) : "",
        list ? esc(list.title) : "",
        card.completed ? "Completed" : "",
        datesText ? esc(datesText) : "",
      ].filter(Boolean).join(" • ");

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(this.localTitle || "Card")}</title><style>
        body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328; margin: 42px; line-height: 1.5; }
        h1 { font-size: 24px; margin: 0 0 6px; }
        .meta { color: #667085; font-size: 13px; margin-bottom: 12px; }
        .pill { display: inline-block; color: #fff; border-radius: 4px; padding: 2px 10px; font-size: 12px; font-weight: 700; margin: 0 6px 6px 0; }
        .section { margin-top: 22px; }
        .section h2 { font-size: 15px; margin: 0 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
        .checklist-group + .checklist-group { margin-top: 18px; }
        .checklist-group h3 { font-size: 14px; margin: 0 0 2px; }
        .checklist-progress { color: #667085; font-size: 11px; margin-bottom: 6px; }
        img { max-width: 100%; border-radius: 8px; margin: 10px 0; }
        .imgrow { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; margin: 10px 0; }
        .imgrow img { margin: 0; }
        .chk { margin: 4px 0; }
        .box { margin-right: 7px; }
        .done { text-decoration: line-through; color: #98a2b3; }
        .who { color: #667085; font-size: 12px; }
        blockquote { border-left: 3px solid #e5e7eb; margin: 8px 0; padding: 2px 12px; color: #667085; }
        code { background: #f2f4f7; padding: 1px 5px; border-radius: 4px; }
        ul, ol { padding-left: 22px; }
        p { margin: 0 0 0.6em; }
      </style></head><body>
        <h1>${esc(this.localTitle || "Card")}</h1>
        ${metaBits ? `<div class="meta">${metaBits}</div>` : ""}
        ${labelsHtml ? `<div>${labelsHtml}</div>` : ""}
        ${membersText ? `<div class="meta" style="margin-top:8px">Members: ${esc(membersText)}</div>` : ""}
        ${descriptionParts.length ? `<div class="section"><h2>Description</h2>${descriptionParts.join("")}</div>` : ""}
        ${checklistHtml ? `<div class="section"><h2>Checklist</h2>${checklistHtml}</div>` : ""}
      </body></html>`;

      const baseName = String(this.localTitle || "card").replace(/[\\/:*?"<>|]/g, "-").trim() || "card";
      let pdfPath = `${baseName}.pdf`;
      let suffix = 2;
      while (this.app.vault.getAbstractFileByPath(pdfPath)) {
        pdfPath = `${baseName} ${suffix}.pdf`;
        suffix += 1;
      }

      const win = new remote.BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        const htmlBytes = new TextEncoder().encode(html);
        await win.loadURL(`data:text/html;charset=utf-8;base64,${arrayBufferToBase64(htmlBytes.buffer)}`);
        // Give layout a beat to settle (data-URI images decode synchronously,
        // but pagination measures after first paint).
        await new Promise((resolve) => setTimeout(resolve, 150));
        const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
        const bytes = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
        await this.app.vault.createBinary(pdfPath, bytes);
        new Notice(`PDF saved to ${pdfPath}.`);
      } finally {
        win.destroy();
      }
    } catch (error) {
      console.error(error);
      new Notice("Could not export the PDF.");
    }
  }

  /**
   * Inserts text at the details caret, switching from preview to the editor if
   * needed, and queues a save. Embeds land on their own line.
   */
  insertDetailText(text) {
    if (this.readOnly) return false;
    // Block editor open: let it place the embed at the active block's caret and
    // render it as a real image immediately.
    if (this.editingDetails && this.insertDetailAtCaret) return this.insertDetailAtCaret(text);
    const ta = this.detailsTextarea;
    // In the editor, drop the embed at the caret so it lands where you're typing.
    if (this.editingDetails && ta && !ta.classList.contains("is-hidden")) {
      const start = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
      const end = typeof ta.selectionEnd === "number" ? ta.selectionEnd : ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const prefix = before && !before.endsWith("\n") ? "\n" : "";
      const suffix = after && !after.startsWith("\n") ? "\n" : "";
      const inserted = `${prefix}${text}${suffix}`;
      ta.value = before + inserted + after;
      const caret = start + inserted.length;
      ta.selectionStart = ta.selectionEnd = caret;
      this.detailsDraft = ta.value;
      ta.focus();
      return true;
    }
    // From the read view, append the embed on its own line.
    const base = String(this.localDetails || "");
    const sep = !base ? "" : (base.endsWith("\n") ? "\n" : "\n\n");
    this.localDetails = `${base}${sep}${text}`;
    return true;
  }

  /**
   * Saves a pasted/dropped image into the vault (via the attachment-folder
   * setting) and inserts a compact embed at the caret.
   */
  async insertImageFromFile(file) {
    if (this.readOnly || !file) return;
    try {
      const data = await file.arrayBuffer();
      const type = file.type || "image/png";
      let ext = (type.split("/")[1] || "png").split("+")[0].toLowerCase();
      if (ext === "jpeg") ext = "jpg";
      const rawName = (file.name || "").trim();
      // Keep a real, human filename; replace empty/generic/UUID names (typical of
      // clipboard pastes) with a tidy "Pasted image <timestamp>".
      const realName = rawName
        && /\.[a-z0-9]+$/i.test(rawName)
        && rawName.toLowerCase() !== "image.png"
        && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i.test(rawName);
      const fileName = safeImageFileName(realName ? rawName : `Pasted image ${imageStamp()}.${ext}`, ext);
      const sourcePath = (this.card && this.card.filePath) || "";
      // Card media lives in <board>/attachments so the board folder stays tidy.
      const board = this.plugin.findBoardForCard(this.card);
      let targetPath;
      if (board && board.folderPath) {
        targetPath = this.uniqueVaultPath(`${board.folderPath}/attachments/${fileName}`);
      } else {
        const fm = this.app.fileManager;
        targetPath = fm && typeof fm.getAvailablePathForAttachment === "function"
          ? await fm.getAvailablePathForAttachment(fileName, sourcePath)
          : fileName;
      }
      const parent = targetPath.split("/").slice(0, -1).join("/");
      if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
        await this.app.vault.createFolder(parent).catch(() => {});
      }
      // The card lock can be lost during the awaits above; don't write a binary
      // we can no longer reference into the note.
      if (this.readOnly || !this.detailsTextarea) return;
      await this.app.vault.createBinary(targetPath, data);
      const previousDetails = this.localDetails;
      const inserted = this.insertDetailText(`![[${targetPath}]]`);
      if (!inserted) {
        // Couldn't place the reference — trash the orphan instead of leaving it.
        const created = this.app.vault.getAbstractFileByPath(targetPath);
        if (created) await this.app.vault.trash(created, false).catch(() => {});
        return;
      }
      if (this.editingDetails) {
        this.pendingDetailAttachments.add(targetPath);
        return;
      }

      try {
        await this.saveNow({ propagateError: true });
      } catch (error) {
        this.localDetails = previousDetails;
        const created = this.app.vault.getAbstractFileByPath(targetPath);
        if (created) await this.app.vault.trash(created, false).catch(console.error);
        throw error;
      }
    } catch (error) {
      console.error(error);
      new Notice("Couldn't add the image.");
    }
  }

  // Returns `path`, or the next free "name N.ext" variant if it already exists.
  uniqueVaultPath(path) {
    if (!this.app.vault.getAbstractFileByPath(path)) return path;
    const dot = path.lastIndexOf(".");
    const base = dot > 0 ? path.slice(0, dot) : path;
    const ext = dot > 0 ? path.slice(dot) : "";
    let i = 1;
    let candidate = `${base} ${i}${ext}`;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      i += 1;
      candidate = `${base} ${i}${ext}`;
    }
    return candidate;
  }

  async persistChecklistNote(filePath, body) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || file.extension !== "md") throw new Error("Checklist item note not found");
    const current = await this.app.vault.read(file);
    const updated = checklistItemNoteWithBody(current, body);
    if (updated !== current) await this.app.vault.modify(file, updated);
  }

  beginChecklistNoteEdit(filePath, body) {
    this.editingChecklistNotes.add(filePath);
    if (!this.checklistNoteDrafts.has(filePath)) this.checklistNoteDrafts.set(filePath, String(body || ""));
  }

  updateChecklistNoteDraft(filePath, draft) {
    this.checklistNoteDrafts.set(filePath, String(draft || ""));
  }

  finishChecklistNoteEdit(filePath) {
    this.checklistNoteDrafts.delete(filePath);
    this.editingChecklistNotes.delete(filePath);
  }

  /**
   * Renders every named checklist as an independent progress bar.
   */
  renderChecklistField() {
    const field = createElement("div", "ot-checklists-field");
    const checklistRenderers = new Map();
    let draggedChecklistItem = null;

    const clearChecklistDropState = () => {
      field.querySelectorAll(".is-checklist-drop-before, .is-checklist-drop-after, .is-checklist-drop-end, .is-checklist-dragging")
        .forEach((element) => element.classList.remove(
          "is-checklist-drop-before",
          "is-checklist-drop-after",
          "is-checklist-drop-end",
          "is-checklist-dragging",
        ));
    };

    const moveChecklistItem = async (targetGroup, insertionIndex) => {
      if (!draggedChecklistItem || !targetGroup) return;
      const sourceGroup = this.localChecklists.find((candidate) => candidate.id === draggedChecklistItem.groupId);
      if (!sourceGroup) return;
      const sourceIndex = sourceGroup.items.indexOf(draggedChecklistItem.item);
      if (sourceIndex < 0) return;

      let nextIndex = insertionIndex;
      sourceGroup.items.splice(sourceIndex, 1);
      if (sourceGroup === targetGroup && sourceIndex < nextIndex) nextIndex -= 1;
      nextIndex = Math.max(0, Math.min(nextIndex, targetGroup.items.length));
      targetGroup.items.splice(nextIndex, 0, draggedChecklistItem.item);

      const sourceRenderer = checklistRenderers.get(sourceGroup.id);
      const targetRenderer = checklistRenderers.get(targetGroup.id);
      if (sourceRenderer) sourceRenderer();
      if (targetRenderer && targetRenderer !== sourceRenderer) targetRenderer();
      await this.saveNow();
    };

    const renderGroup = (group) => {
      const section = createElement("div", "ot-field ot-checklist-group");
      const groupColor = cleanColor(group.color) || LIST_COLORS[1];
      section.style.setProperty("--ot-checklist-color", groupColor);
      section.style.setProperty("border", `1px solid ${groupColor}`, "important");
      const header = createElement("div", "ot-checklist-header");
      const heading = createElement("div", "ot-checklist-heading");
      const headingIcon = createElement("span", "ot-checklist-heading-icon");
      headingIcon.style.setProperty("color", groupColor, "important");
      setIconSafe(headingIcon, "check-square", "☑");
      const name = createElement("input", "ot-checklist-name");
      name.type = "text";
      name.value = group.title || "Checklist";
      name.placeholder = "Checklist name";
      name.setAttribute("aria-label", "Checklist name");
      name.addEventListener("input", () => {
        group.title = name.value;
        this.queueSave();
      });
      name.addEventListener("blur", () => {
        group.title = textLine(name.value) || "Checklist";
        name.value = group.title;
        this.saveNow().catch(console.error);
      });
      heading.append(headingIcon, name);
      header.append(heading);

      const colorButton = createElement("button", "ot-checklist-color");
      colorButton.type = "button";
      colorButton.title = "Choose checklist color";
      colorButton.setAttribute("aria-label", "Choose checklist color");
      colorButton.style.backgroundColor = groupColor;
      colorButton.addEventListener("click", () => {
        new ListColorModal(this.app, group.title || "Checklist", groupColor, async (color) => {
          group.color = cleanColor(color) || LIST_COLORS[1];
          this.render();
          await this.saveNow();
        }, "Checklist").open();
      });
      header.append(colorButton);

      if (this.localChecklists.length > 1) {
        const removeGroup = iconButton("trash", "Delete checklist", async () => {
          const items = group.items || [];
          const linkedNotes = items.filter((item) => item && item.filePath).length;
          const warning = linkedNotes
            ? `Delete "${group.title || "Checklist"}" and its items? This will also move ${linkedNotes} linked Markdown ${linkedNotes === 1 ? "note" : "notes"} to the trash.`
            : `Delete "${group.title || "Checklist"}" and its items?`;
          if (items.length) {
            const confirmed = await confirmAction(this.app, "Delete checklist", warning);
            if (!confirmed) return;
          }
          try {
            await this.plugin.deleteChecklistItemFiles(this.card, items);
            items.forEach((item) => {
              if (!item || !item.filePath) return;
              this.finishChecklistNoteEdit(item.filePath);
              this.expandedChecklistNotes.delete(item.filePath);
            });
            this.localChecklists = this.localChecklists.filter((item) => item.id !== group.id);
            if (this.addingChecklistId === group.id) this.addingChecklistId = null;
            this.render();
            await this.saveNow();
          } catch (error) {
            console.error(error);
            new Notice("Could not delete the linked checklist notes.");
          }
        });
        removeGroup.classList.add("ot-checklist-delete");
        header.append(removeGroup);
      }

      const progress = createElement("div", "ot-checklist-progress");
      const progressText = createElement("span", "ot-checklist-percent", "0%");
      const progressTrack = createElement("div", "ot-progress-track");
      const progressFill = createElement("div", "ot-progress-fill");
      progressFill.style.setProperty("background", groupColor, "important");
      progressTrack.append(progressFill);
      progress.append(progressText, progressTrack);

      const list = createElement("div", "ot-checklist");
      list.addEventListener("dragover", (event) => {
        if (!draggedChecklistItem || this.readOnly) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        list.classList.add("is-checklist-drop-end");
      });
      list.addEventListener("dragleave", (event) => {
        if (!list.contains(event.relatedTarget)) list.classList.remove("is-checklist-drop-end");
      });
      list.addEventListener("drop", async (event) => {
        if (!draggedChecklistItem || this.readOnly) return;
        event.preventDefault();
        list.classList.remove("is-checklist-drop-end");
        await moveChecklistItem(group, group.items.length);
        draggedChecklistItem = null;
        clearChecklistDropState();
      });
      const updateProgress = () => {
        const stats = checklistStats(group.items);
        progressText.textContent = `${stats.percent}%`;
        progressFill.style.width = `${stats.percent}%`;
      };

      const renderItems = () => {
        list.replaceChildren();
        if (!group.items.length) list.append(createElement("span", "ot-empty-text", "No checklist items"));

        group.items.forEach((item, index) => {
          const itemWrap = createElement("div", "ot-checklist-item");
          const row = createElement("div", "ot-checklist-row");
          const dragHandle = createElement("span", "ot-checklist-drag-handle");
          dragHandle.draggable = !this.readOnly;
          dragHandle.title = "Drag to reorder checklist item";
          dragHandle.setAttribute("aria-label", "Drag to reorder checklist item");
          setIconSafe(dragHandle, "grip-vertical", "⋮⋮");
          dragHandle.addEventListener("dragstart", (event) => {
            if (this.readOnly) {
              event.preventDefault();
              return;
            }
            draggedChecklistItem = { groupId: group.id, item };
            itemWrap.classList.add("is-checklist-dragging");
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.text || "Checklist item");
            }
          });
          dragHandle.addEventListener("dragend", () => {
            draggedChecklistItem = null;
            clearChecklistDropState();
          });
          itemWrap.addEventListener("dragover", (event) => {
            if (!draggedChecklistItem || this.readOnly) return;
            event.preventDefault();
            event.stopPropagation();
            if (draggedChecklistItem.item === item) return;
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            const after = event.clientY >= itemWrap.getBoundingClientRect().top + (itemWrap.offsetHeight / 2);
            itemWrap.classList.toggle("is-checklist-drop-before", !after);
            itemWrap.classList.toggle("is-checklist-drop-after", after);
          });
          itemWrap.addEventListener("dragleave", () => {
            itemWrap.classList.remove("is-checklist-drop-before", "is-checklist-drop-after");
          });
          itemWrap.addEventListener("drop", async (event) => {
            if (!draggedChecklistItem || this.readOnly) return;
            event.preventDefault();
            event.stopPropagation();
            if (draggedChecklistItem.item === item) {
              clearChecklistDropState();
              return;
            }
            const targetIndex = group.items.indexOf(item);
            const after = itemWrap.classList.contains("is-checklist-drop-after");
            itemWrap.classList.remove("is-checklist-drop-before", "is-checklist-drop-after");
            await moveChecklistItem(group, targetIndex + (after ? 1 : 0));
            draggedChecklistItem = null;
            clearChecklistDropState();
          });
          const checkbox = createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = !!item.done;
          const input = createElement("textarea", "ot-checklist-title");
          input.rows = 1;
          input.value = item.text || "";
          input.setAttribute("aria-label", "Checklist item");
          const resizeTitle = () => {
            input.style.height = "auto";
            input.style.height = `${input.scrollHeight}px`;
          };
          requestAnimationFrame(resizeTitle);
          const actions = createElement("div", "ot-checklist-item-actions");
          const createNoteButton = !item.filePath ? iconButton("file-plus", "Create Markdown note", async () => {
            createNoteButton.disabled = true;
            try {
              const file = await this.plugin.ensureChecklistItemFile(this.card, item);
              item.filePath = file.path;
              await this.saveNow();
              this.expandedChecklistNotes.add(file.path);
              this.render();
            } catch (error) {
              console.error(error);
              new Notice("Could not create the checklist item note.");
              createNoteButton.disabled = false;
            }
          }) : null;

          if (createNoteButton) createNoteButton.classList.add("ot-checklist-note");

          const noteKey = item.filePath || "";
          let notePanel = null;
          let noteToggle = null;
          let noteContent = null;
          let noteRenderVersion = 0;

          const showNoteBody = async () => {
            const renderVersion = ++noteRenderVersion;
            noteContent.replaceChildren(createElement("span", "ot-checklist-note-status", "Loading Markdown description..."));
            try {
              const file = this.plugin.resolveChecklistItemFile(this.card, item);
              if (!file) throw new Error("Checklist item note not found");
              const markdown = await this.app.vault.read(file);
              if (renderVersion !== noteRenderVersion || !this.expandedChecklistNotes.has(noteKey) || !noteContent.isConnected) return;
              const body = checklistItemNoteBody(markdown);
              const draft = this.checklistNoteDrafts.get(file.path);
              const editing = this.editingChecklistNotes.has(file.path);
              const noteActions = createElement("div", "ot-checklist-note-actions");
              const editButton = createElement("button", "", "Edit");
              editButton.type = "button";
              editButton.disabled = this.readOnly;
              addButtonIcon(editButton, "pencil");
              const beginEditing = () => {
                if (this.readOnly) return;
                this.beginChecklistNoteEdit(file.path, body);
                showNoteBody().catch(console.error);
              };
              editButton.addEventListener("click", beginEditing);
              noteContent.replaceChildren();
              if (!editing) {
                const preview = createElement("div", "ot-markdown-preview ot-checklist-note-preview markdown-rendered");
                if (!body) preview.append(createElement("span", "ot-checklist-note-status", "This note has no description."));
                else {
                  await MarkdownRenderer.render(this.app, body, preview, file.path, this);
                  if (renderVersion !== noteRenderVersion || !noteContent.isConnected) return;
                }
                preview.addEventListener("click", (event) => {
                  if (event.target.closest("a, button, img")) return;
                  const selection = window.getSelection();
                  if (selection && selection.toString()) return;
                  beginEditing();
                });
                noteActions.append(editButton);
                noteContent.append(preview, noteActions);
                return;
              }

              const noteEditor = this.renderDetailsField({
                noteMode: true,
                sheetKey: file.path,
                title: "Checklist item note",
                placeholder: "Write details for this checklist item...",
                markdown: draft !== undefined ? draft : body,
                savedMarkdown: body,
                onDraftChange: (nextDraft) => this.updateChecklistNoteDraft(file.path, nextDraft),
                onSave: async (markdown) => {
                  try {
                    await this.persistChecklistNote(file.path, markdown);
                  } catch (error) {
                    new Notice("Could not save the Markdown description.");
                    throw error;
                  }
                  this.finishChecklistNoteEdit(file.path);
                  await showNoteBody();
                },
                onCancel: () => {
                  this.finishChecklistNoteEdit(file.path);
                  showNoteBody().catch(console.error);
                },
              });
              noteContent.replaceChildren(noteEditor);
            } catch (error) {
              console.error(error);
              if (renderVersion !== noteRenderVersion || !this.expandedChecklistNotes.has(noteKey) || !noteContent.isConnected) return;
              noteContent.replaceChildren(createElement("span", "ot-checklist-note-status is-error", "Could not read the Markdown description."));
            }
          };

          if (item.filePath) {
            noteToggle = textButton("file-text", "Markdown", () => {
              const expanded = !this.expandedChecklistNotes.has(noteKey);
              if (expanded) this.expandedChecklistNotes.add(noteKey);
              else this.expandedChecklistNotes.delete(noteKey);
              notePanel.hidden = !expanded;
              noteToggle.classList.toggle("is-expanded", expanded);
              noteToggle.setAttribute("aria-expanded", String(expanded));
              noteToggle.title = expanded ? "Hide Markdown description" : "Show Markdown description";
              setIcon(noteToggle.querySelector(".ot-checklist-note-chevron"), expanded ? "chevron-up" : "chevron-down");
              if (expanded) showNoteBody();
            }, "ot-checklist-note-toggle ot-checklist-note-action");
            noteToggle.title = "Show Markdown description";
            noteToggle.setAttribute("aria-expanded", "false");
            const chevron = createElement("span", "ot-checklist-note-chevron");
            setIcon(chevron, "chevron-down");
            noteToggle.append(chevron);

            const openNoteButton = iconButton("file-text", "Open Markdown note", async () => {
              openNoteButton.disabled = true;
              try {
                const file = this.plugin.resolveChecklistItemFile(this.card, item);
                if (!file) throw new Error("Checklist item note not found");
                await this.plugin.openChecklistItemFile(file.path);
                this.close();
              } catch (error) {
                console.error(error);
                new Notice("Could not open the checklist item note.");
                openNoteButton.disabled = false;
              }
            });
            openNoteButton.classList.add("ot-checklist-note-open", "ot-checklist-note-action");
            actions.append(noteToggle, openNoteButton);

            notePanel = createElement("div", "ot-checklist-note-panel");
            notePanel.hidden = true;
            noteContent = createElement("div", "ot-checklist-note-content");
            notePanel.append(noteContent);
          }
          const remove = iconButton("x", "Remove item", async () => {
            if (item.filePath) {
              const confirmed = await confirmAction(
                this.app,
                "Remove checklist item",
                `Remove "${item.text || "Checklist item"}"? Its linked Markdown note will also be moved to the trash.`,
              );
              if (!confirmed) return;
            }
            try {
              await this.plugin.deleteChecklistItemFile(this.card, item);
              if (item.filePath) {
                this.finishChecklistNoteEdit(item.filePath);
                this.expandedChecklistNotes.delete(item.filePath);
              }
              group.items.splice(index, 1);
              renderItems();
              await this.saveNow();
            } catch (error) {
              console.error(error);
              new Notice("Could not delete the linked checklist note.");
            }
          });
          remove.addEventListener("click", (event) => event.stopPropagation());

          checkbox.addEventListener("change", () => {
            item.done = checkbox.checked;
            updateProgress();
            this.saveNow().catch(console.error);
          });
          input.addEventListener("input", () => {
            item.text = input.value;
            resizeTitle();
            this.queueSave();
          });
          input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") event.preventDefault();
          });
          input.addEventListener("blur", () => {
            item.text = textLine(input.value);
            input.value = item.text;
            resizeTitle();
            this.saveNow().catch(console.error);
          });

          let assigneeBtn = null;
          if (this.plugin.isSyncDeckEnabled()) {
            assigneeBtn = createElement("button", "ot-checklist-assignee");
            assigneeBtn.type = "button";
            const paintAssignee = () => {
              assigneeBtn.replaceChildren();
              const a = item.assignee;
              if (a && a.email) {
                assigneeBtn.classList.add("is-assigned");
                assigneeBtn.title = a.name || a.email;
                assigneeBtn.append(this.memberAvatar(a));
              } else {
                assigneeBtn.classList.remove("is-assigned");
                assigneeBtn.title = "Assign member";
                assigneeBtn.append(createElement("span", "ot-checklist-assignee-empty"));
              }
            };
            paintAssignee();
            assigneeBtn.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              this.showChecklistMemberMenu(event, item, paintAssignee);
            });
          }

          if (createNoteButton) actions.append(createNoteButton);
          actions.append(remove);
          if (assigneeBtn) {
            row.append(dragHandle, assigneeBtn, checkbox, input, actions);
          } else {
            row.style.setProperty("grid-template-columns", "18px 20px minmax(0, 1fr) auto", "important");
            row.append(dragHandle, checkbox, input, actions);
          }
          itemWrap.append(row);
          if (notePanel) {
            itemWrap.append(notePanel);
            if (this.expandedChecklistNotes.has(noteKey)) {
              notePanel.hidden = false;
              noteToggle.classList.add("is-expanded");
              noteToggle.setAttribute("aria-expanded", "true");
              noteToggle.title = "Hide Markdown description";
              setIcon(noteToggle.querySelector(".ot-checklist-note-chevron"), "chevron-up");
              showNoteBody();
            }
          }
          list.append(itemWrap);
        });
        updateProgress();
      };
      checklistRenderers.set(group.id, renderItems);

      const addArea = createElement("div", "ot-checklist-add");
      const renderAddArea = () => {
        addArea.replaceChildren();
        if (this.addingChecklistId !== group.id) {
          addArea.append(textButton("plus", "Add item", () => {
            this.addingChecklistId = group.id;
            renderAddArea();
          }));
          return;
        }

        const addForm = createElement("form", "ot-checklist-add-form");
        const addInput = createElement("input", "ot-input");
        addInput.type = "text";
        addInput.placeholder = "Checklist item";
        const addButton = createElement("button", "mod-cta", "Add");
        addButtonIcon(addButton, "plus");
        const cancel = iconButton("x", "Cancel", () => {
          this.addingChecklistId = null;
          renderAddArea();
        });
        addButton.type = "submit";
        addForm.append(addInput, addButton, cancel);
        addForm.addEventListener("submit", (event) => {
          event.preventDefault();
          const text = textLine(addInput.value);
          if (!text) {
            addInput.focus();
            return;
          }
          group.items.push({ done: false, text, filePath: "", assignee: null });
          this.addingChecklistId = null;
          renderItems();
          renderAddArea();
          this.saveNow().catch(console.error);
        });
        addInput.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            this.addingChecklistId = null;
            renderAddArea();
          }
        });
        addArea.append(addForm);
        requestAnimationFrame(() => addInput.focus());
      };

      renderItems();
      renderAddArea();
      section.append(header, progress, list, addArea);
      return section;
    };

    this.localChecklists.forEach((group) => field.append(renderGroup(group)));
    const addChecklist = textButton("plus", "Add checklist", () => {
      new TextPromptModal(this.app, "Add checklist", "Checklist name", "", (title) => {
        const color = LIST_COLORS[this.localChecklists.length % LIST_COLORS.length] || LIST_COLORS[1];
        this.localChecklists.push({ id: uid("checklist"), title, color, items: [] });
        this.render();
        return this.saveNow();
      }).open();
    }, "ot-add-checklist");
    field.append(addChecklist);
    return field;
  }

  /**
   * Sanitizes modal state and writes it through the plugin's card updater.
   */
  cardPatch() {
    return {
      title: textLine(this.localTitle) || this.card.title,
      labels: clone(this.localLabels),
      assignees: clone(this.localAssignees || []),
      details: this.localDetails.trim(),
      checklists: this.localChecklists.map((group, index) => ({
        id: group.id || uid("checklist"),
        title: textLine(group.title) || `Checklist ${index + 1}`,
        color: cleanColor(group.color) || LIST_COLORS[1],
        items: (group.items || [])
          .map((item) => ({
            done: !!item.done,
            text: textLine(item.text),
            filePath: textLine(item.filePath),
            assignee: item.assignee && item.assignee.email
              ? { email: item.assignee.email, name: item.assignee.name || "", color: item.assignee.color || "" }
              : null,
          }))
          .filter((item) => item.text),
      })),
    };
  }

  queueSave() {
    if (this.readOnly) return;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveNow().catch(console.error);
    }, SAVE_DEBOUNCE_MS);
  }

  async saveNow(options = {}) {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.readOnly) return;

    const card = this.card;
    if (!card) return;

    const patch = this.cardPatch();
    const globalLabels = clone(this.localGlobalLabels);
    const saveOperation = this.savePromise.then(() => this.plugin.updateCard(card.id, patch, globalLabels));
    this.savePromise = saveOperation.catch((error) => {
        console.error(error);
        new Notice("Could not save card.");
      });

    if (options.propagateError) return saveOperation;
    await this.savePromise;
  }
}

module.exports = {
  ConfirmModal,
  TextPromptModal,
  LabelPickerModal,
  ListColorModal,
  BoardAppearanceModal,
  CardDatesModal,
  AboutModal,
  CardModal,
  confirmAction,
  detailsMdToHtml,
  autoformatCommandForPrefix,
  inlineAutoformatMatch,
};
