const { setIcon } = require("obsidian");
const { cardFileBaseName, createElement, textLine } = require("../helpers");

// Small shared UI utilities and timing constants for the modal modules.
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

/**
 * Fills a surface with the compact stand-in for a board card, used wherever a
 * card is referenced instead of opened: the title as it wraps, an optional
 * leading badge, and the list it sits in painted with that list's color.
 *
 * `summary` comes from KanuxPlugin#dependencyCardSummary, which already hides
 * the board name while the card lives on the board being looked at.
 */
function fillMiniCard(surface, summary, badge) {
  surface.classList.add("ot-mini-card");
  if (summary.completed) surface.classList.add("is-done");

  const meta = createElement("div", "ot-mini-card-meta");
  if (badge) meta.append(badge);
  if (summary.listTitle) meta.append(miniCardListPill(summary));
  if (summary.boardName) meta.append(createElement("span", "ot-mini-card-board", summary.boardName));

  surface.append(createElement("span", "ot-mini-card-title", summary.title));
  if (meta.childElementCount) surface.append(meta);
  return surface;
}

function miniCardListPill(summary) {
  const pill = createElement("span", "ot-mini-card-list");
  const dot = createElement("span", "ot-mini-card-dot");
  if (summary.listColor) dot.style.setProperty("--ot-mini-card-color", summary.listColor);
  pill.append(dot, createElement("span", "", summary.listTitle));
  return pill;
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

module.exports = {
  IMG_BLOCK_DRAG_TYPE,
  SAVE_DEBOUNCE_MS,
  LOCK_HEARTBEAT_MS,
  setIconSafe,
  fillMiniCard,
  colorSwatchGrid,
  imageRunAround,
  imageFilesFromTransfer,
  imageStamp,
  safeImageFileName,
  isBlankMdSegment,
  isBlankTextBlock,
};
