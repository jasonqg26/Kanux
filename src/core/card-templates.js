const { Notice } = require("obsidian");

// Card templates: the saved starting point for a repeated kind of card. They
// are card notes that never joined a board, kept in the board's templates
// folder, so they sync, read and edit like everything else in the vault.
const {
  assigneesToFrontmatter,
  blankChecklists,
  cardCodeNumber,
  cardFileBaseName,
  checklistsToMarkdown,
  clone,
  formatCardCode,
  labelsToFrontmatter,
  normalizeNumbering,
  parseCardMarkdown,
  parseTemplateNumbering,
  textLine,
  withNumbering,
} = require("../helpers");
const { confirmAction } = require("../modals");

const TEMPLATE_FLAG = /(?:^|\r?\n)[ \t]*kanux-template[ \t]*:[ \t]*true[ \t]*(?:\r?\n|$)/i;
const UNTITLED_TEMPLATE = "Untitled template";

const cardTemplateMethods = {
  templatesFolder(board) {
    return board && board.folderPath ? `${board.folderPath}/templates` : "";
  },

  isTemplatePath(path, board) {
    const folder = this.templatesFolder(board);
    return !!(folder && path && String(path).startsWith(`${folder}/`));
  },

  /** Every template a board has, in the order they read on screen. */
  async listCardTemplates(board) {
    const folder = this.templatesFolder(board);
    if (!folder) return [];

    const templates = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${folder}/`)) continue;
      const template = await this.readCardTemplate(file);
      if (template) templates.push(template);
    }
    return templates.sort((first, second) => first.title.localeCompare(second.title));
  },

  async readCardTemplate(file) {
    let markdown = "";
    try {
      markdown = await this.app.vault.read(file);
    } catch (error) {
      return null;
    }
    if (!TEMPLATE_FLAG.test(markdown)) return null;

    const parsed = parseCardMarkdown(markdown);
    return {
      filePath: file.path,
      title: parsed.title || file.basename || UNTITLED_TEMPLATE,
      listId: parsed.listId,
      labels: parsed.labels,
      assignees: parsed.assignees || [],
      details: parsed.details,
      checklists: parsed.checklists,
      numbering: parseTemplateNumbering(markdown),
    };
  },

  /**
   * The template a card would make: its shape, with everything that belongs to
   * that one card in particular left behind.
   */
  cardAsTemplate(card, title) {
    return {
      title: textLine(title) || textLine(card.title) || UNTITLED_TEMPLATE,
      listId: card.listId,
      labels: clone(card.labels || []),
      assignees: clone(card.assignees || []),
      details: String(card.details || ""),
      checklists: blankChecklists(card.checklists),
      numbering: null,
    };
  },

  /**
   * Writes a template note. No `tags` and no card id: a template must not show
   * up under the board's tag hierarchy or be mistaken for a card by the sync.
   */
  async saveCardTemplate(board, template) {
    const folder = this.templatesFolder(board);
    if (!folder) throw new Error("no board folder for the template");
    await this.ensureBoardFolder(board);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder).catch(() => {});
    }

    const list = this.findList(template.listId, board);
    const markdown = [
      "---",
      "kanux-template: true",
      `kanban-board-id: ${board.id}`,
      `kanban-list-id: ${template.listId || ""}`,
      `kanux-board: ${this.frontmatterText(board.name)}`,
      `kanux-list: ${this.frontmatterText(list && list.title)}`,
      `labels: ${labelsToFrontmatter(template.labels)}`,
      `assignees: ${assigneesToFrontmatter(template.assignees)}`,
      "---",
      "",
      `# ${textLine(template.title)}`,
      "",
      "## Details",
      template.details || "",
      "",
      "## Checklist",
      checklistsToMarkdown(template.checklists),
      "",
    ].join("\n");

    const path = await this.nextTemplatePath(folder, template.title);
    await this.app.vault.create(path, withNumbering(markdown, template.numbering));
    return path;
  },

  async nextTemplatePath(folder, title) {
    const base = cardFileBaseName(title || UNTITLED_TEMPLATE);
    let path = `${folder}/${base}.md`;
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = `${folder}/${base} ${index}.md`;
      index += 1;
    }
    return path;
  },

  /**
   * Creates a card from a template. `listId` wins over the template's own
   * destination: asking for a card in a list is more specific than a default
   * chosen when the template was saved.
   */
  async createCardFromTemplate(template, listId) {
    const targetListId = listId || template.listId;
    const board = this.data.boards.find((item) => item.lists.some((list) => list.id === targetListId));
    if (!board) {
      new Notice("That template's list no longer exists. Open a list menu to choose where the card goes.");
      return "";
    }

    // The code goes in the card's own field, not its name: a rename must not
    // cost the card its identifier.
    const cardId = await this.createCard(targetListId, template.title || UNTITLED_TEMPLATE, {
      code: formatCardCode(template.numbering),
      labels: template.labels,
      assignees: template.assignees,
      details: template.details,
      checklists: blankChecklists(template.checklists),
    });

    // Only once the card exists: a creation that failed must not burn a number.
    // And a counter that cannot be written is worth saying out loud rather than
    // throwing — the card is already on the board, so losing the caller here
    // would cost the user their editor and tell them nothing.
    if (cardId) {
      try {
        await this.bumpTemplateNumbering(template);
      } catch (error) {
        console.error(error);
        new Notice(`The card was created, but "${template.title}" could not advance its counter, so the next card would repeat ${formatCardCode(template.numbering)}.`);
      }
    }
    return cardId;
  },

  /** Hands the next code out and advances the counter by one. */
  async bumpTemplateNumbering(template) {
    const numbering = normalizeNumbering(template.numbering);
    if (!numbering) return;

    const next = { ...numbering, next: numbering.next + 1 };
    if (await this.writeTemplateNumbering(template, next)) template.numbering = next;
  },

  /**
   * Writes the counter back to the template note. `process` rather than the
   * `modify` used elsewhere: it reads and writes under one lock, so two cards
   * created back to back cannot both take the same number.
   */
  async writeTemplateNumbering(template, numbering) {
    const file = this.app.vault.getAbstractFileByPath(template.filePath);
    if (!file) return false;

    let written = false;
    await this.app.vault.process(file, (markdown) => {
      const updated = withNumbering(markdown, numbering);
      written = updated !== markdown;
      return updated;
    });
    return written;
  },

  /**
   * Restarts the counter. Numbers already handed out are in card titles, not
   * here, so the confirmation says how many are about to be issued twice —
   * a restart is what breaks the uniqueness, and the choice belongs to you.
   */
  async resetTemplateNumbering(template, start = 1) {
    const numbering = normalizeNumbering(template.numbering);
    if (!numbering) return false;

    const next = { ...numbering, next: Math.max(0, Math.floor(start)) };
    const reused = this.cardsCarryingCode(template).filter((card) => cardCodeNumber(card.code, next) >= next.next);
    const message = reused.length
      ? `Restart numbering at ${formatCardCode(next)}? ${reused.length} ${reused.length === 1 ? "card already carries a code" : "cards already carry codes"} from here on, so those numbers would be issued twice.`
      : `Restart numbering at ${formatCardCode(next)}?`;

    const confirmed = await confirmAction(this.app, "Restart numbering", message, {
      confirmText: "Restart",
      confirmIcon: "rotate-ccw",
      danger: reused.length > 0,
      warning: "",
    });
    if (!confirmed) return false;

    if (!await this.writeTemplateNumbering(template, next)) return false;
    template.numbering = next;
    new Notice(`Next card from "${template.title}" will be ${formatCardCode(next)}.`);
    return true;
  },

  cardsCarryingCode(template) {
    const numbering = normalizeNumbering(template.numbering);
    if (!numbering) return [];
    return Object.values(this.data.cards).filter((card) => cardCodeNumber(card.code, numbering) >= 0);
  },


  /**
   * Editing a template is opening its note: the file is the template, so a
   * second editor here could only disagree with it.
   */
  async openCardTemplate(template) {
    const file = this.app.vault.getAbstractFileByPath(template.filePath);
    if (!file) {
      new Notice("That template note is no longer in the vault.");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  },

  /**
   * Deleting a template touches nothing but its own note: a card made from one
   * keeps no link back, so nothing has to be unpicked first.
   */
  async deleteCardTemplate(template) {
    const title = template.title || UNTITLED_TEMPLATE;
    const message = `Delete the template "${title}"? Cards already made from it are not affected.`;
    if (!await confirmAction(this.app, "Delete template", message)) return false;

    const file = this.app.vault.getAbstractFileByPath(template.filePath);
    if (file) await this.app.vault.trash(file, true);
    new Notice(`Template "${title}" deleted.`);
    return true;
  },
};

module.exports = { cardTemplateMethods };
