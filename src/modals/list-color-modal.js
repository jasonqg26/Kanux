const { Modal } = require("obsidian");
const { LIST_COLORS, addButtonIcon, cleanColor, createElement } = require("../helpers");
const { colorSwatchGrid } = require("./modal-ui");

// Color picker shared by lists and checklists.
class ListColorModal extends Modal {
  constructor(app, title, currentColor, onSelect, kind = "List") {
    super(app);
    this.title = title;
    this.currentColor = cleanColor(currentColor) || LIST_COLORS[0];
    this.onSelect = onSelect;
    this.kind = kind;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-label-modal-shell");
    this.contentEl.addClass("ot-label-modal", "ot-list-color-modal");

    const header = createElement("div", "ot-label-modal-header");
    header.append(createElement("h2", "", `${this.kind} color`));

    const previewBand = createElement("div", "ot-label-create-preview-band");
    const preview = createElement("div", "ot-label-preview-pill", this.title || this.kind);
    preview.style.backgroundColor = this.currentColor;
    previewBand.append(preview);

    const field = createElement("div", "ot-field");
    field.append(createElement("span", "", "Choose color"));
    field.append(colorSwatchGrid(LIST_COLORS, this.currentColor, async (color) => {
      await this.onSelect(color);
      this.close();
    }));

    const customField = createElement("label", "ot-field");
    customField.append(createElement("span", "", "Custom color"));
    const custom = createElement("input", "ot-color-input");
    custom.type = "color";
    custom.value = this.currentColor;
    custom.addEventListener("input", () => {
      this.currentColor = custom.value;
      preview.style.backgroundColor = this.currentColor;
    });
    customField.append(custom);

    const actions = createElement("div", "ot-modal-actions");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta ot-save-button", "Save");
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");
    cancel.type = "button";
    save.type = "button";
    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", async () => {
      await this.onSelect(custom.value);
      this.close();
    });
    actions.append(cancel, save);

    this.contentEl.append(header, previewBand, field, customField, actions);
  }
}

module.exports = {
  ListColorModal,
};
