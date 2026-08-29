// The three blocking levels a dependency can take: how each one is presented,
// and the picker that swaps between them.
//
// A plain dropdown named the levels but never said what they do, which is the
// part that decides the choice — so the picker shows all three side by side and
// spells out the consequence of the one under the pointer.
const {
  DEPENDENCY_BLOCK_NONE,
  DEPENDENCY_BLOCK_TOTAL,
  DEPENDENCY_BLOCK_WARN,
  createElement,
  renderIcon,
} = require("../helpers");

// Strongest first, matching the order the dependency lists are drawn in.
// `badge` marks the levels worth an icon on the dependency card itself: a level
// that blocks nothing has nothing to warn about.
const DEPENDENCY_LEVELS = [
  {
    blocking: DEPENDENCY_BLOCK_TOTAL,
    title: "Blocking",
    icon: "lock",
    badge: true,
    summary: "Stops the action until this card is completed.",
  },
  {
    blocking: DEPENDENCY_BLOCK_WARN,
    title: "Warning",
    icon: "alert-triangle",
    badge: true,
    summary: "Asks for confirmation while this card is open.",
  },
  {
    blocking: DEPENDENCY_BLOCK_NONE,
    title: "Linked",
    icon: "link",
    badge: false,
    summary: "Never blocks anything. The link is only a reference.",
  },
];

const ARROW_STEPS = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
const PICKER_GAP_PX = 6;
const VIEWPORT_MARGIN_PX = 8;

function findLevel(blocking) {
  return DEPENDENCY_LEVELS.find((level) => level.blocking === blocking) || DEPENDENCY_LEVELS[0];
}

/**
 * Opens the level picker over `anchor` and calls `onPick` with the chosen
 * blocking level. Picking the level it already has closes without a change.
 */
function openDependencyLevelPicker(anchor, currentBlocking, onPick) {
  const picker = createElement("div", "ot-level-picker");
  const tiles = createElement("div", "ot-level-picker-tiles");
  tiles.setAttribute("role", "radiogroup");
  tiles.setAttribute("aria-label", "Blocking level");
  const hint = createElement("p", "ot-level-picker-hint", findLevel(currentBlocking).summary);
  picker.append(tiles, hint);

  const session = openSession(picker, anchor);
  const buttons = DEPENDENCY_LEVELS.map((level) => buildLevelTile(level, currentBlocking, {
    describe: () => { hint.textContent = level.summary; },
    pick: () => {
      session.close();
      if (level.blocking !== currentBlocking) onPick(level.blocking);
    },
  }));
  tiles.append(...buttons);

  session.open(buttons);
}

function buildLevelTile(level, currentBlocking, handlers) {
  const isCurrent = level.blocking === currentBlocking;
  const tile = createElement("button", `ot-level-tile is-${level.blocking}`);
  tile.type = "button";
  tile.setAttribute("role", "radio");
  tile.setAttribute("aria-checked", String(isCurrent));
  tile.title = level.summary;
  // Roving tab stop: the group is one stop, arrows move inside it.
  tile.tabIndex = isCurrent ? 0 : -1;
  if (isCurrent) tile.classList.add("is-current");

  const icon = createElement("span", "ot-level-tile-icon");
  icon.setAttribute("aria-hidden", "true");
  renderIcon(icon, level.icon);
  tile.append(icon, createElement("span", "", level.title));

  tile.addEventListener("click", handlers.pick);
  tile.addEventListener("pointerenter", handlers.describe);
  tile.addEventListener("focus", handlers.describe);
  return tile;
}

/**
 * The picker's lifetime: it lives on the body so no modal can clip it, and
 * closes on the first click outside, on Escape, or when the viewport moves
 * under it and its anchor is no longer where it was measured.
 */
function openSession(picker, anchor) {
  let closed = false;
  let tiles = [];

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", close);
    picker.remove();
    anchor.focus();
  };

  const onPointerDown = (event) => {
    if (!picker.contains(event.target)) close();
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      // Handled here so the first Escape closes the picker, not the card modal.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const step = ARROW_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    focusNeighbour(tiles, step);
  };

  return {
    close,

    open(buttons) {
      tiles = buttons;
      document.body.append(picker);
      positionPicker(picker, anchor);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("resize", close);
      (buttons.find((button) => button.classList.contains("is-current")) || buttons[0]).focus();
    },
  };
}

function focusNeighbour(buttons, step) {
  const current = buttons.indexOf(document.activeElement);
  const next = (current + step + buttons.length) % buttons.length;
  buttons[next].focus();
}

// Below the anchor when it fits, above it when it does not, always inside the
// viewport — the dependency cards sit near both edges of a tall modal.
function positionPicker(picker, anchor) {
  const anchorRect = anchor.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  const maxLeft = window.innerWidth - pickerRect.width - VIEWPORT_MARGIN_PX;
  const below = anchorRect.bottom + PICKER_GAP_PX;
  const fitsBelow = below + pickerRect.height <= window.innerHeight - VIEWPORT_MARGIN_PX;

  picker.style.left = `${Math.round(Math.min(Math.max(VIEWPORT_MARGIN_PX, anchorRect.left), maxLeft))}px`;
  picker.style.top = `${Math.round(fitsBelow
    ? below
    : Math.max(VIEWPORT_MARGIN_PX, anchorRect.top - pickerRect.height - PICKER_GAP_PX))}px`;
}

module.exports = {
  DEPENDENCY_LEVELS,
  openDependencyLevelPicker,
};
