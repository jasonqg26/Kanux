const { FuzzySuggestModal } = require("obsidian");
const { isImagePath } = require("../helpers");

// Fuzzy pickers over vault files.
class VaultNoteSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Search Markdown notes in this vault...");
  }

  getItems() {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file) {
    return file.path.replace(/\.md$/i, "");
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

class VaultBackgroundSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Choose an image from the vault");
  }

  getItems() {
    return this.app.vault.getFiles().filter((file) => isImagePath(file.path));
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

module.exports = {
  VaultNoteSuggestModal,
  VaultBackgroundSuggestModal,
};
