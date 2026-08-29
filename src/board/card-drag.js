const { Notice } = require("obsidian");

// Card drag & drop: placeholder preview, edge auto-scroll, reflow animation,
// and the final drop commit back to the plugin.
const { createElement } = require("../helpers");

const CARD_REFLOW_DURATION_MS = 170;
const CARD_SCROLL_EDGE_PX = 56;
const CARD_SCROLL_MAX_STEP_PX = 18;
const CARD_DROP_REFRESH_GRACE_MS = 750;

const cardDragMethods = {
  startCardDrag(event, element, cardId) {
    this.finishCardDrag(false);
    const rect = element.getBoundingClientRect();
    const placeholder = createElement("div", "ot-card-drop-placeholder");
    placeholder.style.height = `${rect.height}px`;

    const preview = this.createCardDragPreview(element, rect.width);
    if (preview && event.dataTransfer.setDragImage) {
      event.dataTransfer.setDragImage(preview, Math.min(32, rect.width / 2), 24);
    }

    this.cardDragState = { cardId, element, placeholder, preview, targetCards: element.parentElement, clientX: 0, clientY: 0 };
    requestAnimationFrame(() => {
      if (!this.cardDragState || this.cardDragState.element !== element) return;
      element.classList.add("is-dragging");
      this.contentEl.classList.add("is-card-drag-active");
    });
  },

  createCardDragPreview(element, width) {
    if (!document.body) return null;
    const preview = element.cloneNode(true);
    preview.classList.remove("is-dragging");
    preview.classList.add("ot-card-drag-preview");
    preview.style.width = `${width}px`;
    preview.setAttribute("aria-hidden", "true");
    document.body.append(preview);
    return preview;
  },

  scheduleCardDropPreview(cards, clientX, clientY) {
    if (!this.cardDragState) return;
    Object.assign(this.cardDragState, { targetCards: cards, clientX, clientY });
    if (this.cardDragFrameId !== null) return;
    this.cardDragFrameId = requestAnimationFrame(() => this.updateCardDropPreview());
  },

  updateCardDropPreview() {
    this.cardDragFrameId = null;
    const state = this.cardDragState;
    if (!state || !state.targetCards) return;

    const verticalScroll = this.autoScrollElement(state.targetCards, state.clientY, "vertical");
    const horizontalScroll = this.autoScrollElement(state.targetCards.closest(".ot-board-scroll"), state.clientX, "horizontal");
    this.placeCardDropPreview(state.targetCards, state.clientY);

    if (verticalScroll || horizontalScroll) {
      this.cardDragFrameId = requestAnimationFrame(() => this.updateCardDropPreview());
    }
  },

  placeCardDropPreview(cards, clientY) {
    const anchor = this.findCardDropAnchor(cards, clientY);
    this.moveCardPlaceholder(cards, anchor);
  },

  findCardDropAnchor(cards, clientY) {
    const draggedElement = this.cardDragState && this.cardDragState.element;
    const candidates = Array.from(cards.querySelectorAll(".ot-card")).filter((card) => card !== draggedElement);
    return candidates.find((card) => {
      const rect = card.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    }) || null;
  },

  moveCardPlaceholder(cards, anchor) {
    const state = this.cardDragState;
    if (!state || (state.placeholder.parentElement === cards && state.placeholder.nextElementSibling === anchor)) return;

    const previousCards = state.placeholder.parentElement;
    const affectedCards = this.captureCardPositions([previousCards, cards]);
    if (previousCards) previousCards.classList.remove("is-drop-zone");
    cards.insertBefore(state.placeholder, anchor);
    cards.classList.add("is-drop-zone");
    this.animateCardReflow(affectedCards);
  },

  captureCardPositions(containers) {
    const positions = new Map();
    const draggedElement = this.cardDragState && this.cardDragState.element;
    new Set(containers.filter(Boolean)).forEach((container) => {
      container.querySelectorAll(".ot-card").forEach((card) => {
        if (card === draggedElement) return;
        positions.set(card, card.getBoundingClientRect());
      });
    });
    return positions;
  },

  animateCardReflow(positions) {
    if (this.contentEl.classList.contains("is-motion-disabled")) return;
    requestAnimationFrame(() => {
      positions.forEach((previous, card) => {
        if (!card.isConnected || typeof card.animate !== "function") return;
        const current = card.getBoundingClientRect();
        const offsetY = previous.top - current.top;
        if (Math.abs(offsetY) < 0.5) return;
        const running = this.cardReflowAnimations.get(card);
        if (running) running.cancel();
        const animation = card.animate(
          [{ transform: `translate3d(0, ${offsetY}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
          { duration: CARD_REFLOW_DURATION_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
        );
        this.cardReflowAnimations.set(card, animation);
      });
    });
  },

  autoScrollElement(element, pointerPosition, axis) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const start = axis === "vertical" ? rect.top : rect.left;
    const end = axis === "vertical" ? rect.bottom : rect.right;
    const delta = this.edgeScrollDelta(pointerPosition, start, end);
    if (!delta) return false;

    const previous = axis === "vertical" ? element.scrollTop : element.scrollLeft;
    if (axis === "vertical") element.scrollTop += delta;
    else element.scrollLeft += delta;
    return previous !== (axis === "vertical" ? element.scrollTop : element.scrollLeft);
  },

  edgeScrollDelta(pointerPosition, start, end) {
    if (pointerPosition < start + CARD_SCROLL_EDGE_PX) {
      const strength = Math.min(1, (start + CARD_SCROLL_EDGE_PX - pointerPosition) / CARD_SCROLL_EDGE_PX);
      return -CARD_SCROLL_MAX_STEP_PX * strength * strength;
    }
    if (pointerPosition > end - CARD_SCROLL_EDGE_PX) {
      const strength = Math.min(1, (pointerPosition - end + CARD_SCROLL_EDGE_PX) / CARD_SCROLL_EDGE_PX);
      return CARD_SCROLL_MAX_STEP_PX * strength * strength;
    }
    return 0;
  },

  cardIdAfterPlaceholder(placeholder, draggedCardId) {
    let sibling = placeholder.nextElementSibling;
    while (sibling) {
      if (sibling.dataset && sibling.dataset.cardId && sibling.dataset.cardId !== draggedCardId) return sibling.dataset.cardId;
      sibling = sibling.nextElementSibling;
    }
    return undefined;
  },

  async commitCardDrop(cards, clientX, clientY) {
    const state = this.cardDragState;
    if (!state) return;
    if (this.cardDragFrameId !== null) cancelAnimationFrame(this.cardDragFrameId);
    this.cardDragFrameId = null;
    Object.assign(state, { targetCards: cards, clientX, clientY });
    this.placeCardDropPreview(cards, clientY);
    if (!state.placeholder.parentElement) return;
    const targetList = state.placeholder.parentElement.closest(".ot-list");
    const move = {
      cardId: state.cardId,
      targetListId: targetList && targetList.dataset.listId,
      beforeCardId: this.cardIdAfterPlaceholder(state.placeholder, state.cardId),
    };
    this.finishCardDrag(true);
    if (!move.targetListId) return;

    this.cardDropRefreshBlockedUntil = Number.POSITIVE_INFINITY;
    try {
      const moved = await this.plugin.moveCard(move.cardId, move.targetListId, move.beforeCardId);
      this.cardDropRefreshBlockedUntil = moved ? Date.now() + CARD_DROP_REFRESH_GRACE_MS : 0;
      // An unmet dependency refused the move, but the card already sits where
      // it was dropped: repaint the board from the state that actually holds.
      if (!moved) this.render();
    } catch (error) {
      this.cardDropRefreshBlockedUntil = 0;
      console.error("Kanux: card move failed", error);
      new Notice("Could not move the card.");
      this.render();
    }
  },

  shouldDeferRefresh() {
    return Date.now() < this.cardDropRefreshBlockedUntil;
  },

  finishCardDrag(commit) {
    const state = this.cardDragState;
    if (!state) return;
    if (this.cardDragFrameId !== null) cancelAnimationFrame(this.cardDragFrameId);
    this.cardDragFrameId = null;

    const sourceCards = state.element.parentElement;
    const targetCards = state.placeholder.parentElement;
    const affectedCards = this.captureCardPositions([sourceCards, targetCards]);
    if (commit && state.placeholder.parentElement) {
      state.placeholder.parentElement.insertBefore(state.element, state.placeholder);
      state.element.classList.add("is-drag-settling");
      window.setTimeout(() => state.element.classList.remove("is-drag-settling"), 210);
    }
    state.element.classList.remove("is-dragging");
    state.placeholder.remove();
    if (state.preview) state.preview.remove();
    this.contentEl.classList.remove("is-card-drag-active");
    this.contentEl.querySelectorAll(".ot-cards.is-drop-zone").forEach((cards) => cards.classList.remove("is-drop-zone"));
    this.cardDragState = null;
    if (commit) this.updateVisibleCardCounts([sourceCards, targetCards]);
    this.animateCardReflow(affectedCards);
  },

  updateVisibleCardCounts(containers) {
    new Set(containers.filter(Boolean)).forEach((cards) => {
      const list = cards.closest(".ot-list");
      const count = list && list.querySelector(".ot-list-count");
      if (count) count.textContent = String(cards.querySelectorAll(".ot-card").length);
    });
  },
};

module.exports = { cardDragMethods };
