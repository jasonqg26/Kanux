const { Notice } = require("obsidian");
const { createElement, imageSizeFromMarkup, imageMarkupWithSize } = require("../helpers");
const { imageStamp, safeImageFileName } = require("./modal-ui");

// Image handling for the card details field: display sizing, interactive
// resize, clipboard copy, and inserting pasted/dropped files as attachments.
// Copy a rendered <img> to the system clipboard as PNG. Draws through a canvas
// because the source is a vault resource URL (same-origin in Obsidian, so the
// canvas is not tainted). ClipboardItem exists on desktop (Electron); on a
// platform without it this throws and the caller shows a notice.
async function copyImageToClipboard(modal, img) {
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
function applyStoredImageWidth(modal, img, markup) {
  const width = imageSizeFromMarkup(markup);
  if (width) {
    img.style.width = `${width}px`;
    img.style.maxHeight = "none";
  }
}

// Even column width for a K-across image grid inside a container.
function gridColumnWidth(modal, containerWidth, columns) {
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
function enableImageResize(modal, wrap, img, options) {
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
      applyStoredImageWidth(modal, img, getMarkup());
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

/**
 * Inserts text at the details caret, switching from preview to the editor if
 * needed, and queues a save. Embeds land on their own line.
 */
function insertDetailText(modal, text) {
  if (modal.readOnly) return false;
  // Block editor open: let it place the embed at the active block's caret and
  // render it as a real image immediately.
  if (modal.editingDetails && modal.insertDetailAtCaret) return modal.insertDetailAtCaret(text);
  const ta = modal.detailsTextarea;
  // In the editor, drop the embed at the caret so it lands where you're typing.
  if (modal.editingDetails && ta && !ta.classList.contains("is-hidden")) {
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
    modal.detailsDraft = ta.value;
    ta.focus();
    return true;
  }
  // From the read view, append the embed on its own line.
  const base = String(modal.localDetails || "");
  const sep = !base ? "" : (base.endsWith("\n") ? "\n" : "\n\n");
  modal.localDetails = `${base}${sep}${text}`;
  return true;
}

/**
 * Saves a pasted/dropped image into the vault (via the attachment-folder
 * setting) and inserts a compact embed at the caret.
 */
async function insertImageFromFile(modal, file) {
  if (modal.readOnly || !file) return;
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
    const sourcePath = (modal.card && modal.card.filePath) || "";
    // Card media lives in <board>/attachments so the board folder stays tidy.
    const board = modal.plugin.findBoardForCard(modal.card);
    let targetPath;
    if (board && board.folderPath) {
      targetPath = uniqueVaultPath(modal, `${board.folderPath}/attachments/${fileName}`);
    } else {
      const fm = modal.app.fileManager;
      targetPath = fm && typeof fm.getAvailablePathForAttachment === "function"
        ? await fm.getAvailablePathForAttachment(fileName, sourcePath)
        : fileName;
    }
    const parent = targetPath.split("/").slice(0, -1).join("/");
    if (parent && !modal.app.vault.getAbstractFileByPath(parent)) {
      await modal.app.vault.createFolder(parent).catch(() => {});
    }
    // The card lock can be lost during the awaits above; don't write a binary
    // we can no longer reference into the note.
    if (modal.readOnly || !modal.detailsTextarea) return;
    await modal.app.vault.createBinary(targetPath, data);
    const previousDetails = modal.localDetails;
    const inserted = insertDetailText(modal, `![[${targetPath}]]`);
    if (!inserted) {
      // Couldn't place the reference — trash the orphan instead of leaving it.
      const created = modal.app.vault.getAbstractFileByPath(targetPath);
      if (created) await modal.app.vault.trash(created, false).catch(() => {});
      return;
    }
    if (modal.editingDetails) {
      modal.pendingDetailAttachments.add(targetPath);
      return;
    }

    try {
      await modal.saveNow({ propagateError: true });
    } catch (error) {
      modal.localDetails = previousDetails;
      const created = modal.app.vault.getAbstractFileByPath(targetPath);
      if (created) await modal.app.vault.trash(created, false).catch(console.error);
      throw error;
    }
  } catch (error) {
    console.error(error);
    new Notice("Couldn't add the image.");
  }
}

// Returns `path`, or the next free "name N.ext" variant if it already exists.
function uniqueVaultPath(modal, path) {
  if (!modal.app.vault.getAbstractFileByPath(path)) return path;
  const dot = path.lastIndexOf(".");
  const base = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  let i = 1;
  let candidate = `${base} ${i}${ext}`;
  while (modal.app.vault.getAbstractFileByPath(candidate)) {
    i += 1;
    candidate = `${base} ${i}${ext}`;
  }
  return candidate;
}

module.exports = {
  copyImageToClipboard,
  applyStoredImageWidth,
  gridColumnWidth,
  enableImageResize,
  insertDetailText,
  insertImageFromFile,
  uniqueVaultPath,
};
