const { MarkdownRenderer, Menu, Notice } = require("obsidian");
const {
  addButtonIcon,
  createElement,
  hasDragType,
  iconButton,
  imageMarkupWithSize,
  textButton,
  textLine,
} = require("../helpers");
const { createEmbeddedMarkdownEditor } = require("../editor/embedded-editor");
const {
  escapeDetailsHtml,
  detailsMdToHtml,
  detailsHtmlToMd,
  autoformatCommandForPrefix,
  inlineAutoformatMatch,
  splitDetailSegments,
} = require("./details-markdown");
const {
  DETAILS_AUTOSAVE_MS,
  IMG_BLOCK_DRAG_TYPE,
  setIconSafe,
  imageRunAround,
  imageFilesFromTransfer,
  isBlankMdSegment,
  isBlankTextBlock,
} = require("./modal-ui");
const { TextPromptModal } = require("./prompt-modals");
const { VaultNoteSuggestModal } = require("./vault-suggest-modals");
const {
  copyImageToClipboard,
  applyStoredImageWidth,
  gridColumnWidth,
  enableImageResize,
  insertImageFromFile,
} = require("./card-detail-images");

// Builds the card details field: rendered Markdown by default with an
// embedded WYSIWYG editor, image runs, autoformat, and attachment handling.
/**
 * Shows rendered Markdown by default, with a textarea editor on demand.
 */
function buildDetailsField(modal, options = {}) {
  const noteMode = !!options.noteMode;
  // Identifies this editor as a side-sheet owner; empty means inline only.
  const sheetKey = noteMode ? textLine(options.sheetKey || "") : "details";
  const fieldTitle = textLine(options.title) || "Description";
  const placeholder = textLine(options.placeholder) || "Write a description...";
  const initialMarkdown = noteMode ? String(options.markdown || "") : modal.localDetails;
  // Moves forward with every autosave, so the status line tells the truth.
  let savedMarkdown = noteMode ? String(options.savedMarkdown ?? initialMarkdown) : modal.localDetails;
  let draftMarkdown = noteMode ? initialMarkdown : modal.detailsDraft;
  // Reset the block-editor caret hook; the edit branch below re-installs it.
  if (!noteMode) modal.insertDetailAtCaret = null;
  const field = createElement("section", "ot-field ot-details-field");
  const header = createElement("div", "ot-details-heading");
  const heading = createElement("div", "ot-details-heading-title");
  const headingIcon = createElement("span", "ot-details-heading-icon");
  setIconSafe(headingIcon, "align-left");
  heading.append(headingIcon, createElement("span", "", fieldTitle));
  const preview = createElement("div", "ot-markdown-preview markdown-rendered");
  const editor = createElement("textarea", "ot-textarea ot-details-editor is-hidden");
  const isEditing = noteMode || modal.shouldEditDetails();

  if (isEditing && !noteMode && !modal.editingDetails) {
    modal.editingDetails = true;
    modal.detailsDraft = modal.localDetails;
    draftMarkdown = modal.detailsDraft;
    if (modal.sheetPlacements) modal.sheetPlacements.delete(sheetKey);
  }

  editor.placeholder = placeholder;
  editor.value = isEditing ? draftMarkdown : modal.localDetails;
  if (!noteMode) {
    modal.detailsTextarea = editor;
    modal.detailsPreview = preview;
  }

  // Images are saved one at a time so concurrent inserts don't race the caret.
  const insertImagesSequentially = async (images) => {
    for (const file of images) await insertImageFromFile(modal, file);
    // When adding from the read view, re-render so the new image shows inline.
    if (!modal.editingDetails) renderPreview();
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
    const markdown = modal.currentDetailsText();
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
    const segs = splitDetailSegments(markdown);
    // Grid layout for the run of images around segIndex: writes an even column
    // width into every embed of the run (descending offsets, so earlier
    // splices can't shift later ones), saves, and re-renders.
    const applyGridToSegRun = async (segIndex, columns) => {
      const run = imageRunAround(segs, segIndex, isBlankMdSegment);
      if (!run.length) return;
      const width = columns ? gridColumnWidth(modal, preview.clientWidth || 640, columns) : 0;
      let source = modal.localDetails;
      [...run].sort((a, b) => b.start - a.start).forEach((s) => {
        source = source.slice(0, s.start) + imageMarkupWithSize(s.markup, width) + source.slice(s.end);
      });
      modal.localDetails = source;
      await modal.saveNow();
      renderPreview();
    };
    segs.forEach((seg, segIndex) => {
      if (seg.type === "img") {
        const resolved = modal.plugin.resolveCardImage(modal.card, seg.target);
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
              await copyImageToClipboard(modal, img);
              new Notice("Image copied");
            } catch (error) {
              new Notice("Could not copy the image on this platform.");
            }
          });
          copyButton.classList.add("ot-image-copy");
          wrap.append(copyButton);
          applyStoredImageWidth(modal, img, seg.markup);
          // Resize straight from the read view — the width is stored in the
          // note's embed markup (Obsidian's |300 syntax), so it renders the
          // same when the card note opens in Obsidian.
          if (!modal.readOnly) {
            enableImageResize(modal, wrap, img, {
              getMarkup: () => seg.markup,
              onCommit: async (width) => {
                const next = imageMarkupWithSize(seg.markup, width);
                if (next === seg.markup) return;
                // Splice at the segment's own offsets — replacing by string
                // would hit the wrong copy when the same image (and size)
                // appears twice in one note.
                const source = modal.localDetails;
                modal.localDetails = source.slice(0, seg.start) + next + source.slice(seg.end);
                seg.markup = next;
                await modal.saveNow();
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
          MarkdownRenderer.render(modal.app, text, chunk, modal.card.filePath || "", this)
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
    if (modal.readOnly) return;
    modal.detailsEditDismissed = false;
    modal.editingDetails = true;
    modal.detailsDraft = modal.localDetails;
    if (modal.sheetPlacements) modal.sheetPlacements.delete(sheetKey);
    modal.render();
  };

  /**
   * Leaves the editing session, writing anything the autosave has not caught
   * up with yet. There is no discard path: what was typed is already on disk.
   */
  const finishEditing = async () => {
    if (saving) return;
    saving = true;
    cancelAutoSave();
    updateEditorState("Saving…");
    try {
      if (noteMode) {
        await options.onSave(draftMarkdown);
        modal.closeSideSheet(sheetKey);
        return;
      }
      await modal.persistDetailsDraft(draftMarkdown);
      modal.render();
    } catch (error) {
      saving = false;
      updateEditorState("Could not save");
      throw error;
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
  // the hidden master textarea (`editor`) that finishEditing/saveNow already read.
  const blocksHost = createElement("div", "ot-block-editor");
  let blocks = [];
  let activeText = null; // { block, ce } of the focused text block
  let saveButton = null;
  let editorStatus = null;
  let saving = false;
  let autoSaving = false;
  let autoSaveTimer = null;

  const normalizedMarkdown = (value) => String(value || "").replace(/\r\n/g, "\n").trim();
  const hasUnsavedChanges = () => normalizedMarkdown(draftMarkdown) !== normalizedMarkdown(savedMarkdown);
  const updateEditorState = (message = "") => {
    const changed = hasUnsavedChanges();
    if (saveButton) saveButton.disabled = saving;
    if (!editorStatus) return;
    // Nothing is ever left unsaved on purpose, so a dirty draft is one the
    // autosave has not reached yet, not one waiting for the user.
    editorStatus.textContent = message || (changed ? "Saving…" : "Saved");
    editorStatus.classList.toggle("is-dirty", changed && !saving && !message);
    editorStatus.classList.toggle("is-error", message === "Could not save");
  };

  const cancelAutoSave = () => {
    if (!autoSaveTimer) return;
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  };

  // Typing is written on its own once it pauses. Restarting the timer on every
  // keystroke keeps a fast typist to one write instead of one per word.
  const queueAutoSave = () => {
    if (modal.readOnly || !hasUnsavedChanges()) return;
    cancelAutoSave();
    autoSaveTimer = window.setTimeout(() => {
      autoSaveTimer = null;
      autoSave().catch(console.error);
    }, DETAILS_AUTOSAVE_MS);
  };

  /**
   * Writes the draft without ending the session, so the caret, the selection
   * and the side sheet all stay exactly where the writer left them.
   */
  const autoSave = async () => {
    // A re-render replaced this editor: its pending write belongs to the new one.
    if (autoSaving || saving || !field.isConnected || !hasUnsavedChanges()) return;
    const pending = draftMarkdown;
    autoSaving = true;
    updateEditorState("Saving…");
    try {
      if (noteMode) await options.onAutoSave(pending);
      else await modal.autoSaveDetails(pending);
      savedMarkdown = pending;
      autoSaving = false;
      updateEditorState();
    } catch (error) {
      autoSaving = false;
      updateEditorState("Could not save");
      throw error;
    }
  };

  /**
   * Leaving the editor writes straight away instead of waiting the pause out.
   * Clicking the modal's close button blurs the editor first, so the sentence
   * being typed is never lost to a timer that had not fired yet.
   */
  const flushOnBlur = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if (!autoSaveTimer) return;
    cancelAutoSave();
    autoSave().catch(console.error);
  };

  // One "Done" control: everything typed is written as it is typed, so there is
  // nothing left to confirm and nothing to cancel back to.
  const buildEditorActions = () => {
    const actions = createElement("div", "ot-details-actions");
    const actionInfo = createElement("div", "ot-details-action-info");
    editorStatus = createElement("span", "ot-details-status", "Saved");
    editorStatus.setAttribute("aria-live", "polite");
    actionInfo.append(
      editorStatus,
      createElement("span", "ot-details-shortcut", "Saves as you type · Ctrl/⌘ + S or Esc to close"),
    );

    const actionButtons = createElement("div", "ot-details-action-buttons");
    saveButton = createElement("button", "mod-cta ot-save-button", "Done");
    addButtonIcon(saveButton, "check");
    saveButton.type = "button";
    saveButton.addEventListener("click", () => finishEditing().catch(console.error));
    actionButtons.append(saveButton);
    actions.append(actionInfo, actionButtons);
    updateEditorState();
    return actions;
  };

  const buildBlocks = (markdown) => {
    const built = [];
    splitDetailSegments(String(markdown || "")).forEach((seg) => {
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

  // The single funnel every edit passes through, whichever editor produced it.
  const applyDraft = (value) => {
    draftMarkdown = value;
    if (!noteMode) modal.detailsDraft = value;
    editor.value = value;
    if (noteMode && options.onDraftChange) options.onDraftChange(value);
    updateEditorState();
    queueAutoSave();
  };

  const syncDraft = () => applyDraft(joinBlocks());

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
    new TextPromptModal(modal.app, "Link", "https://...", "https://", (url) => {
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
    new VaultNoteSuggestModal(modal.app, (file) => {
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
    const width = columns ? gridColumnWidth(modal, blocksHost.clientWidth || 640, columns) : 0;
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
        ce.contentEditable = String(!modal.readOnly);
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
      const resolved = modal.plugin.resolveCardImage(modal.card, block.target);
      if (resolved && resolved.src) {
        const img = createElement("img", "");
        img.src = resolved.src;
        img.alt = resolved.name || "";
        img.loading = "lazy";
        wrap.append(img);
        applyStoredImageWidth(modal, img, block.markup);
        // Drag-resize rewrites the block's markup in place; joinBlocks picks
        // it up on the next keystroke, and Save persists it like any edit.
        enableImageResize(modal, wrap, img, {
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
        modal.discardPendingDetailAttachment(block.target).catch(console.error);
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
    if (noteMode || modal.readOnly || !isFileDrag(event)) return; // not a file drop — leave it
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
    if (noteMode || modal.readOnly || !isFileDrag(event)) return;
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
    const embeddedEditor = createEmbeddedMarkdownEditor(modal.app, embeddedHost, {
      value: draftMarkdown,
      placeholder,
      cursorLocation: { anchor: draftMarkdown.length, head: draftMarkdown.length },
      onChange: (value) => applyDraft(value),
      onSubmit: () => finishEditing().catch(console.error),
      onEscape: () => finishEditing().catch(console.error),
      onPaste: (event) => {
        const images = imageFilesFromTransfer(event.clipboardData);
        if (!images.length || noteMode) return false;
        insertImagesSequentially(images).catch(console.error);
        return true;
      },
    });
    if (embeddedEditor) {
      modal.trackEmbeddedEditor(embeddedEditor);
      editor.value = draftMarkdown;
      if (!noteMode) {
        modal.insertDetailAtCaret = (markup) => {
          embeddedEditor.insertAtCursor(markup);
          return true;
        };
      }

      const editorFrame = createElement("div", "ot-trello-editor");
      editorFrame.addEventListener("focusout", flushOnBlur);
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
        new TextPromptModal(modal.app, "Link", "https://...", "https://", (url) => {
          const target = textLine(url);
          if (!target || target === "https://") return;
          const label = embeddedEditor.selectionText;
          embeddedEditor.insertAtCursor(`[${label || target}](${target})`);
        }).open();
      };
      const insertCmVaultNote = () => {
        const label = embeddedEditor.selectionText;
        new VaultNoteSuggestModal(modal.app, (file) => {
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
      rightTools.append(makeTool("help-circle", "Formatting help", () => new Notice("Obsidian's Live Preview editor: write Markdown (# headings, **bold**, - lists, [[links]]) and it renders as you type. Everything saves as you type; Ctrl/⌘+S, Ctrl/⌘+Enter or Esc closes the editor.")));
      toolbar.append(leftTools, rightTools);
      editorFrame.append(toolbar, embeddedHost);

      const actions = buildEditorActions();

      header.append(heading);
      // With room beside the modal, the editor opens as a page-like side
      // sheet and the card stays fully visible; otherwise it edits inline.
      // Placement is pinned for the whole editing session: a later modal
      // re-render (e.g. opening a checklist description) must not migrate an
      // inline editor into the sheet — the panel would seem to open itself.
      const pinnedInline = !!(sheetKey && modal.sheetPlacements && modal.sheetPlacements.get(sheetKey) === "inline");
      const sheetContent = sheetKey && !pinnedInline ? modal.openDetailsSideSheet(fieldTitle, sheetKey) : null;
      if (sheetKey && modal.sheetPlacements && !sheetContent) modal.sheetPlacements.set(sheetKey, "inline");
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
    editorFrame.addEventListener("focusout", flushOnBlur);
    // The master textarea stays hidden: it only mirrors the joined markdown so
    // finishEditing / insertImageFromFile keep reading the same place as before.
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
      const seg = splitDetailSegments(markup).find((s) => s.type === "img");
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
    if (!noteMode) modal.insertDetailAtCaret = insertDetailAtCaret;

    const actions = buildEditorActions();

    editorFrame.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finishEditing().catch(console.error);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        finishEditing().catch(console.error);
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
            s: () => finishEditing().catch(console.error),
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
  if (!modal.readOnly) header.append(textButton("pencil", "Edit", showEditor, "ot-details-edit-button"));
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
      const sourcePath = (modal.card && modal.card.filePath) || "";
      const newLeaf = event.ctrlKey || event.metaKey;
      modal.close();
      Promise.resolve(modal.app.workspace.openLinkText(target, sourcePath, newLeaf)).catch((error) => {
        console.error(error);
        new Notice("Could not open the linked note.");
      });
      return;
    }
    if (modal.readOnly) return;
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

module.exports = {
  buildDetailsField,
};
