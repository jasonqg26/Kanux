// The one "depends on another card" editor. The card modal renders it for the
// card itself and every checklist group renders the same thing for its items,
// so a dependency is added and read the same way wherever it lives.
const {
  DEPENDENCY_BLOCK_NONE,
  DEPENDENCY_BLOCK_TOTAL,
  DEPENDENCY_BLOCK_WARN,
  DEPENDENCY_STATUS_DONE,
  DEPENDENCY_STATUS_MISSING,
  DEPENDENCY_STATUS_PENDING,
  createElement,
  iconButton,
  renderIcon,
} = require("../helpers");
const { fillMiniCard } = require("./modal-ui");
const { CardPickerModal } = require("./card-picker-modal");
const { DEPENDENCY_LEVELS, openDependencyLevelPicker } = require("./dependency-level-picker");

const MISSING_CARD_NAME = "Missing card";

const STATUS_LABELS = {
  [DEPENDENCY_STATUS_DONE]: "Completed",
  [DEPENDENCY_STATUS_PENDING]: "Pending",
  [DEPENDENCY_STATUS_MISSING]: "No longer in this vault",
};

const MISSING_CARD_SUMMARY = {
  title: MISSING_CARD_NAME,
  boardName: "",
  listTitle: "",
  listColor: "",
  completed: false,
};

function quoted(value) {
  return `“${value}”`;
}

function levelPosition(blocking) {
  return DEPENDENCY_LEVELS.findIndex((level) => level.blocking === blocking);
}

/**
 * Builds a dependency editor over `dependencies`, a live array of
 * { cardId, blocking } entries mutated in place so its owner — the card modal
 * state, or one checklist group — keeps the same array. Every change repaints
 * the cards and saves.
 */
function buildDependenciesField(modal, dependencies) {
  const field = createElement("div", "ot-field ot-dependencies-field");

  // The add control sits beside the caption, the way a section header reads,
  // instead of trailing behind however many dependencies happen to be listed.
  const header = createElement("div", "ot-field-row");
  const addButton = iconButton("plus", "Add dependency", () => {
    openCardPicker(modal, dependencies, save);
  });
  addButton.classList.add("ot-dependency-add");
  header.append(createElement("span", "", "Dependencies"), addButton);

  const sections = createElement("div", "ot-dependency-sections");
  // The summary changes as a side effect of the card controls, so it announces
  // itself rather than leaving screen reader users to re-read the whole field.
  const summary = createElement("div", "ot-dependency-summary");
  summary.setAttribute("aria-live", "polite");

  const repaint = () => {
    const gate = modal.plugin.dependencyGateFor(dependencies);
    sections.replaceChildren();
    if (!gate.total) sections.append(createElement("span", "ot-empty-text", "No dependencies yet"));
    DEPENDENCY_LEVELS.forEach((level) => {
      const entries = gate.entries.filter((entry) => entry.blocking === level.blocking);
      if (entries.length) sections.append(buildLevel(context, level, entries));
    });
    paintSummary(summary, gate);
  };

  // Repainting drops the control the user was on, so focus follows the card
  // that changed, or falls back to the one button that always survives.
  const save = (focusCardId) => {
    repaint();
    const moved = focusCardId && sections.querySelector(`[data-card-id="${focusCardId}"] .ot-dependency-card-main`);
    (moved || addButton).focus();
    modal.saveNow().catch(console.error);
  };

  const context = { modal, dependencies, save, drag: createLevelDrag(sections, dependencies, save) };

  repaint();
  field.append(header, sections, summary);
  return field;
}

/**
 * Moving a dependency between levels by dragging it there. Changing the level
 * from the card's own menu stays the pointer-free path, so the gesture never
 * becomes the only way to do this.
 */
function createLevelDrag(sections, dependencies, save) {
  let draggedCardId = null;

  const finish = () => {
    draggedCardId = null;
    sections.querySelectorAll(".is-drop-target").forEach((element) => element.classList.remove("is-drop-target"));
    sections.querySelectorAll(".is-empty-level").forEach((element) => element.remove());
  };

  const drag = {
    isActive: () => draggedCardId !== null,
    finish,

    start(cardId) {
      draggedCardId = cardId;
      // Deferred by a tick on purpose: Chromium cancels a drag whose dragstart
      // handler mutates the DOM around the dragged element, and revealing the
      // missing levels inserts siblings right next to it. That is why this only
      // ever failed where levels were missing — a list already showing all
      // three inserts nothing and dragged fine.
      window.setTimeout(() => {
        if (draggedCardId === cardId) revealEmptyLevels(sections, drag);
      }, 0);
    },

    dropOn(blocking) {
      const dependency = dependencies.find((item) => item.cardId === draggedCardId);
      const movedCardId = draggedCardId;
      finish();
      if (!dependency || dependency.blocking === blocking) return;
      dependency.blocking = blocking;
      save(movedCardId);
    },
  };
  return drag;
}

// An empty level is not drawn, so the drag reveals it: with only blocking
// dependencies there would otherwise be nowhere to drop one to demote it.
function revealEmptyLevels(sections, drag) {
  const drawn = new Set(Array.from(sections.children).map((child) => child.dataset.blocking));
  DEPENDENCY_LEVELS.forEach((level, position) => {
    if (drawn.has(level.blocking)) return;
    const placeholder = createLevelSection(level, "0");
    placeholder.classList.add("is-empty-level");
    placeholder.append(createElement("div", "ot-dependency-drop-hint", "Drop here"));
    bindLevelDropTarget(placeholder, level, drag);
    sections.insertBefore(placeholder, sectionAfter(sections, position));
  });
}

function sectionAfter(sections, position) {
  return Array.from(sections.children)
    .find((child) => levelPosition(child.dataset.blocking) > position) || null;
}

function createLevelSection(level, countText) {
  const section = createElement("div", `ot-dependency-group is-${level.blocking}`);
  section.dataset.blocking = level.blocking;
  const header = createElement("div", "ot-dependency-group-header");
  header.append(
    createElement("span", "ot-dependency-group-title", level.title),
    createElement("span", "ot-dependency-group-count", countText),
  );
  section.append(header);
  return section;
}

function buildLevel(context, level, entries) {
  const section = createLevelSection(level, String(entries.length));
  const cards = createElement("ul", "ot-dependency-cards");
  cards.setAttribute("aria-label", `${level.title} dependencies`);
  entries.forEach((entry) => cards.append(buildDependencyCard(context, entry, level)));
  section.append(cards);
  bindLevelDropTarget(section, level, context.drag);
  return section;
}

function bindLevelDropTarget(section, level, drag) {
  section.addEventListener("dragover", (event) => {
    if (!drag.isActive()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    section.classList.add("is-drop-target");
  });
  section.addEventListener("dragleave", (event) => {
    if (!section.contains(event.relatedTarget)) section.classList.remove("is-drop-target");
  });
  section.addEventListener("drop", (event) => {
    if (!drag.isActive()) return;
    event.preventDefault();
    event.stopPropagation();
    drag.dropOn(level.blocking);
  });
}

function buildDependencyCard(context, entry, level) {
  const summary = dependencySummary(context.modal, entry);
  const item = createElement("li", "ot-dependency-card");
  item.dataset.cardId = entry.cardId;
  if (entry.status === DEPENDENCY_STATUS_MISSING) item.classList.add("is-missing");
  bindCardDrag(item, entry, summary, context);
  item.append(
    buildCardTrigger(context, { entry, level, summary }),
    buildCardRemove(context, entry, summary.title),
  );
  return item;
}

function bindCardDrag(item, entry, summary, context) {
  item.draggable = !context.modal.readOnly;
  item.addEventListener("dragstart", (event) => {
    if (context.modal.readOnly) {
      event.preventDefault();
      return;
    }
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", summary.title);
    }
    item.classList.add("is-dragging");
    context.drag.start(entry.cardId);
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("is-dragging");
    context.drag.finish();
  });
}

/**
 * The card body: it changes the blocking level on click, and it is what the
 * user grabs to drag the dependency to another level.
 *
 * Deliberately not a <button>: a browser hands a drag to the nearest draggable
 * ancestor only from ordinary content, never from a form control, so a card
 * made of buttons can be clicked but never dragged. It carries the button role,
 * a tab stop and the Enter/Space keys instead, so nothing is lost.
 */
function buildCardTrigger(context, row) {
  const { entry, level, summary } = row;
  const status = STATUS_LABELS[entry.status] || STATUS_LABELS[DEPENDENCY_STATUS_PENDING];
  const trigger = createElement("div", "ot-dependency-card-main");
  trigger.setAttribute("role", "button");
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-label", `${summary.title}: ${status}. Level: ${level.title}. Change level.`);
  trigger.title = `${summary.title} — ${status}. Change level, or drag to another one.`;
  trigger.tabIndex = context.modal.readOnly ? -1 : 0;
  // Not a form control, so the modal read-only sweep cannot disable it for us.
  if (context.modal.readOnly) trigger.classList.add("is-disabled");
  fillMiniCard(trigger, summary, levelBadge(level));

  const openPicker = () => {
    if (context.modal.readOnly) return;
    openDependencyLevelPicker(trigger, entry.blocking, (blocking) => changeLevel(context, entry, blocking));
  };
  trigger.addEventListener("click", openPicker);
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openPicker();
  });
  return trigger;
}

function changeLevel(context, entry, blocking) {
  const dependency = context.dependencies.find((candidate) => candidate.cardId === entry.cardId);
  if (!dependency) return;
  dependency.blocking = blocking;
  context.save(entry.cardId);
}

function levelBadge(level) {
  if (!level.badge) return null;
  const badge = createElement("span", `ot-mini-card-badge is-${level.blocking}`);
  badge.setAttribute("aria-hidden", "true");
  renderIcon(badge, level.icon);
  return badge;
}

function buildCardRemove(context, entry, name) {
  const remove = iconButton("x", `Remove dependency on ${quoted(name)}`, () => {
    const index = context.dependencies.findIndex((dependency) => dependency.cardId === entry.cardId);
    if (index >= 0) context.dependencies.splice(index, 1);
    context.save();
  });
  remove.classList.add("ot-dependency-card-remove");
  remove.title = "Remove dependency";
  remove.draggable = false;
  return remove;
}

function dependencySummary(modal, entry) {
  const card = modal.plugin.data.cards[entry.cardId];
  if (!card) return MISSING_CARD_SUMMARY;
  return modal.plugin.dependencyCardSummary(card, modal.card && modal.card.boardId);
}

function openCardPicker(modal, dependencies, save) {
  const chosen = dependencies.map((dependency) => dependency.cardId);
  const candidates = modal.plugin.dependencyCandidates(modal.cardId, chosen);
  new CardPickerModal(
    modal.app,
    candidates,
    (card) => modal.plugin.dependencyCardSummary(card, modal.card && modal.card.boardId),
    (card) => {
      // A new dependency starts harmless: the user promotes it to a warning or
      // a block from the card itself.
      dependencies.push({ cardId: card.id, blocking: DEPENDENCY_BLOCK_NONE });
      save(card.id);
    },
  ).open();
}

function paintSummary(summary, gate) {
  summary.replaceChildren();
  summary.classList.remove("is-blocked", "is-warning");
  if (!gate.total) return;

  const pending = gate.pending.length;
  const noun = pending === 1 ? "dependency" : "dependencies";
  const verb = pending === 1 ? "is" : "are";
  if (gate.mode === DEPENDENCY_BLOCK_TOTAL) {
    summary.classList.add("is-blocked");
    summary.textContent = `Blocked until ${pending} ${noun} ${verb} completed.`;
    return;
  }
  if (gate.mode === DEPENDENCY_BLOCK_WARN) {
    summary.classList.add("is-warning");
    summary.textContent = `Asks for confirmation while ${pending} ${noun} ${verb} open.`;
    return;
  }
  summary.textContent = `${gate.met}/${gate.total} completed.`;
}

module.exports = {
  buildDependenciesField,
};
