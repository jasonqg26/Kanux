const { Modal } = require("obsidian");

// The board's card templates, listed so they can be read, edited and removed.
// Making a card from a template belongs to the board (the Add card menu, the
// list menus); what has no home there is managing the templates themselves.
const { addButtonIcon, cardCodeChip, createElement, formatCardCode, iconButton } = require("../helpers");
const { CardTemplateModal } = require("./card-template-modal");
const { fillMiniCard } = require("./modal-ui");

const EMPTY_HINT = "No templates yet. A template holds the title, labels, description and checklists that a repeated kind of card starts from.";

class CardTemplateLibraryModal extends Modal {
  constructor(app, plugin, board) {
    super(app);
    this.plugin = plugin;
    this.board = board;
    this.templates = [];
    this.loaded = false;
  }

  onOpen() {
    this.modalEl.addClass("ot-template-library-shell");
    this.contentEl.addClass("ot-template-library");
    // The frame goes up before the folder read comes back: rendering the empty
    // state first would claim there are no templates for as long as it takes.
    this.render();
    this.refresh().catch(console.error);
  }

  onClose() {
    this.contentEl.replaceChildren();
  }

  /** Re-read the folder: the notes are the record, not anything held here. */
  async refresh() {
    this.templates = await this.plugin.listCardTemplates(this.board);
    this.loaded = true;
    if (this.contentEl.isConnected) this.render();
  }

  render() {
    const header = createElement("div", "ot-template-library-header");
    header.append(createElement("h2", "", "Card templates"));

    const body = createElement("div", "ot-template-library-body");
    if (this.templates.length) this.templates.forEach((template) => body.append(this.buildRow(template)));
    else if (this.loaded) body.append(createElement("p", "ot-template-library-empty", EMPTY_HINT));

    this.contentEl.replaceChildren(header, body, this.buildActions());
  }

  /**
   * A template is a note, so editing one is opening it. Handing that off keeps
   * the file the only place a template is written.
   */
  buildRow(template) {
    const row = createElement("div", "ot-template-row");

    const list = this.plugin.findList(template.listId, this.board);
    const open = createElement("button", "");
    open.type = "button";
    open.title = "Open the template note";
    // The same surface a card wears elsewhere: a template is read as the card
    // it will become, destination list and next code included — that code is
    // the number the next card actually gets, so it is worth seeing here.
    const code = formatCardCode(template.numbering);
    fillMiniCard(open, {
      title: template.title,
      listTitle: (list && list.title) || "",
      listColor: (list && list.color) || "",
    }, code ? cardCodeChip(code, this.plugin.getBoardAppearance(this.board.id).codes) : null);
    open.addEventListener("click", () => {
      this.close();
      this.plugin.openCardTemplate(template).catch(console.error);
    });

    const remove = iconButton("trash-2", "Delete template", () => this.remove(template).catch(console.error));
    remove.classList.add("ot-template-delete");

    // The counter is the one thing about a template you change without editing
    // it, so it gets an action of its own rather than a trip through the note.
    if (code) {
      const restart = iconButton("rotate-ccw", `Restart numbering — next is ${code}`, () => this.restart(template).catch(console.error));
      row.append(open, restart, remove);
    } else {
      row.append(open, remove);
    }
    return row;
  }

  async remove(template) {
    if (await this.plugin.deleteCardTemplate(template)) await this.refresh();
  }

  async restart(template) {
    if (await this.plugin.resetTemplateNumbering(template)) await this.refresh();
  }

  buildActions() {
    const actions = createElement("div", "ot-modal-actions");
    const close = createElement("button", "", "Close");
    const create = createElement("button", "mod-cta", "New template");
    close.type = "button";
    create.type = "button";
    addButtonIcon(close, "x");
    addButtonIcon(create, "copy-plus");
    close.addEventListener("click", () => this.close());
    create.addEventListener("click", () => {
      new CardTemplateModal(this.app, this.plugin, this.board, () => this.refresh().catch(console.error)).open();
    });
    actions.append(close, create);
    return actions;
  }
}

module.exports = { CardTemplateLibraryModal };
