const { Modal } = require("obsidian");
const { createElement, textLine } = require("../helpers");
const { fillMiniCard } = require("./modal-ui");

// Picks one card out of every card in the vault, used wherever a card has to
// reference another card. Options are drawn as the cards themselves, shrunk,
// and searching matches the title as well as where the card lives — so
// "backlog" finds everything still sitting in that list.
class CardPickerModal extends Modal {
  constructor(app, cards, summarizeCard, onChoose) {
    super(app);
    this.cards = cards;
    this.summarizeCard = summarizeCard;
    this.onChoose = onChoose;
    this.query = "";
  }

  onOpen() {
    this.modalEl.addClass("ot-card-picker-shell");
    this.contentEl.addClass("ot-card-picker");

    const header = createElement("div", "ot-card-picker-header");
    header.append(createElement("h2", "", "Add dependency"));

    const search = createElement("input", "ot-card-picker-search");
    search.type = "search";
    search.placeholder = "Search cards…";
    search.spellcheck = false;
    search.setAttribute("aria-label", "Search cards");
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderOptions();
    });

    this.subtitle = createElement("h3", "ot-card-picker-subtitle", "Cards");
    this.list = createElement("div", "ot-card-picker-list");
    this.contentEl.replaceChildren(header, search, this.subtitle, this.list);
    this.renderOptions();
    requestAnimationFrame(() => search.focus());
  }

  matchingCards() {
    const query = textLine(this.query).toLowerCase();
    if (!query) return this.cards;
    return this.cards.filter((card) => this.searchText(card).includes(query));
  }

  searchText(card) {
    const summary = this.summarizeCard(card);
    return `${summary.title} ${summary.boardName} ${summary.listTitle}`.toLowerCase();
  }

  renderOptions() {
    const cards = this.matchingCards();
    this.subtitle.textContent = cards.length ? `Cards · ${cards.length}` : "Cards";
    this.list.replaceChildren();
    if (!cards.length) {
      const message = this.cards.length ? "No cards match this search" : "No other cards to depend on";
      this.list.append(createElement("span", "ot-empty-text", message));
      return;
    }
    cards.forEach((card) => this.list.append(this.buildOption(card)));
  }

  buildOption(card) {
    const summary = this.summarizeCard(card);
    const option = createElement("button", "ot-card-picker-option");
    option.type = "button";
    fillMiniCard(option, summary);
    option.addEventListener("click", () => {
      this.close();
      this.onChoose(card);
    });
    return option;
  }

  onClose() {
    this.contentEl.replaceChildren();
  }
}

module.exports = { CardPickerModal };
