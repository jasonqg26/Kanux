const { Modal, Notice } = require("obsidian");
const { addButtonIcon, createElement } = require("../helpers");

// Short about/credits panel.
class AboutModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-about-modal-shell");
    this.contentEl.addClass("ot-about-modal");
    this.contentEl.append(
      createElement("h2", "", "Kanux"),
      createElement("p", "", "A Trello-style board for Obsidian with Markdown-backed cards, labels, dates, and checklist tasks.")
    );

    const actions = createElement("div", "ot-modal-actions");
    const openSettings = createElement("button", "", "Open settings");
    const sync = createElement("button", "", "Re-import notes");
    const close = createElement("button", "mod-cta", "Close");
    addButtonIcon(openSettings, "settings");
    addButtonIcon(sync, "refresh-cw");
    addButtonIcon(close, "x");
    [openSettings, sync, close].forEach((button) => {
      button.type = "button";
    });
    openSettings.addEventListener("click", () => {
      this.app.setting.open();
      this.app.setting.openTabById(this.plugin.manifest.id);
      this.close();
    });
    sync.addEventListener("click", async () => {
      await this.plugin.syncCardsFromFolder();
      this.plugin.refreshViews();
      new Notice("Kanux notes re-imported.");
    });
    close.addEventListener("click", () => this.close());
    actions.append(openSettings, sync, close);
    this.contentEl.append(actions);
  }
}

module.exports = {
  AboutModal,
};
