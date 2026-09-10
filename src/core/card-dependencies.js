// Card and checklist dependencies: resolving how far an unmet dependency gates
// a user action, and the dialog shown before that action goes through.
const {
  DEPENDENCY_BLOCK_NONE,
  DEPENDENCY_BLOCK_TOTAL,
  cleanColor,
  dependencyGate,
  textLine,
} = require("../helpers");
const { alertAction, confirmAction } = require("../modals");

const UNTITLED_CARD = "Untitled card";

const cardDependencyMethods = {
  dependencyGateFor(dependencies) {
    return dependencyGate(dependencies, (cardId) => this.data.cards[cardId]);
  },

  cardDependencyGate(card) {
    return this.dependencyGateFor(card && card.dependencies);
  },

  checklistDependencyGate(group) {
    return this.dependencyGateFor(group && group.dependencies);
  },

  /**
   * What a compact stand-in for a referenced card has to show. The board name
   * comes back empty while the card lives on `contextBoardId`, so a sidebar
   * full of same-board dependencies does not repeat it on every one.
   */
  dependencyCardSummary(card, contextBoardId) {
    const board = this.findBoard(card && card.boardId);
    const list = this.findList(card && card.listId, board);
    return {
      title: textLine(card && card.title) || UNTITLED_CARD,
      boardName: board && board.id !== contextBoardId ? board.name : "",
      listTitle: (list && list.title) || "",
      listColor: cleanColor(list && list.color),
      completed: !!(card && card.completed),
    };
  },

  /** "Board · List": where a referenced card currently sits. */
  dependencyCardLocation(card) {
    const summary = this.dependencyCardSummary(card);
    return [summary.boardName, summary.listTitle].filter(Boolean).join(" · ");
  },

  /**
   * The cards a new dependency may point at: every card except the one asking
   * and the ones it already depends on.
   */
  dependencyCandidates(excludeCardId, chosenCardIds = []) {
    const chosen = new Set(chosenCardIds);
    return Object.values(this.data.cards)
      .filter((card) => card.id !== excludeCardId && !chosen.has(card.id))
      .sort((first, second) => textLine(first.title).localeCompare(textLine(second.title)));
  },

  /**
   * Applies a gate to the action the caller is about to run. A total block
   * refuses it and says why, a warning asks the user first, and anything else
   * lets it through. Both dialogs open with the reason and then list the cards
   * that are still holding the action back, one per line.
   */
  async confirmDependencyGate(gate) {
    if (!gate || gate.mode === DEPENDENCY_BLOCK_NONE) return true;

    const names = gate.pending.map((entry) => entry.title || UNTITLED_CARD);
    const single = names.length === 1;
    const subject = single ? "this card is" : "these cards are";
    if (gate.mode === DEPENDENCY_BLOCK_TOTAL) {
      const reason = `This action can’t be performed until ${subject} completed:`;
      await alertAction(this.app, "Action blocked", reason, names);
      return false;
    }

    // The Cancel / Continue pair is the question, so the message only has to
    // say what is unfinished.
    const title = single ? "Dependency not met" : "Dependencies not met";
    return confirmAction(this.app, title, `${single ? "This card is" : "These cards are"} not completed yet:`, {
      details: names,
      confirmText: "Continue",
      confirmIcon: "arrow-right",
      danger: false,
      warning: "",
    });
  },
};

module.exports = { cardDependencyMethods };
