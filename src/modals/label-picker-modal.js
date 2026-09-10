const { Modal, Notice } = require("obsidian");
const {
  DEFAULT_LABEL_COLOR,
  LABEL_COLORS,
  addButtonIcon,
  clone,
  createElement,
  iconButton,
  labelKey,
  textButton,
  textLine,
} = require("../helpers");
const { colorSwatchGrid } = require("./modal-ui");

// Label selection and editing for a card.
class LabelPickerModal extends Modal {
  constructor(app, labels, selectedLabels, onChange, onDelete = null) {
    super(app);
    this.labels = clone(labels || []);
    this.selectedLabels = clone(selectedLabels || []);
    this.onChange = onChange;
    this.onDelete = onDelete;
    this.resetCreateForm();
  }

  onOpen() {
    this.render();
  }

  resetCreateForm() {
    this.creating = false;
    this.editingKey = null;
    this.query = "";
    this.createName = "";
    this.createColor = DEFAULT_LABEL_COLOR;
  }

  isSelected(label) {
    const key = labelKey(label);
    return this.selectedLabels.some((item) => labelKey(item) === key);
  }

  emitChange(options = {}) {
    this.onChange(clone(this.labels), clone(this.selectedLabels), options);
  }

  dedupeLabels(labels) {
    const seen = new Set();
    return (labels || []).filter((label) => {
      const key = labelKey(label);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  toggleLabel(label) {
    if (this.isSelected(label)) {
      this.selectedLabels = this.selectedLabels.filter((item) => labelKey(item) !== labelKey(label));
    } else {
      this.selectedLabels.push(clone(label));
    }
    this.emitChange();
    this.render();
  }

  /**
   * Creates or updates a global label and keeps selected labels in sync.
   */
  createLabel(name, color) {
    const cleanName = textLine(name);
    if (!cleanName) return;

    const label = { name: cleanName, color: color || DEFAULT_LABEL_COLOR };
    if (this.editingKey) {
      const oldKey = this.editingKey;
      const update = (item) => (labelKey(item) === oldKey ? clone(label) : item);
      this.labels = this.dedupeLabels(this.labels.map(update));
      this.selectedLabels = this.dedupeLabels(this.selectedLabels.map(update));
    } else {
      const existing = this.labels.find((item) => labelKey(item) === labelKey(cleanName));
      const nextLabel = existing || label;
      if (!existing) this.labels.push(nextLabel);
      if (!this.isSelected(nextLabel)) this.selectedLabels.push(clone(nextLabel));
    }

    this.resetCreateForm();
    this.emitChange();
    this.render();
  }

  editLabel(label) {
    this.creating = true;
    this.editingKey = labelKey(label);
    this.createName = label.name;
    this.createColor = label.color || DEFAULT_LABEL_COLOR;
    this.render();
  }

  async deleteLabel(label) {
    if (!label || !this.onDelete) return false;
    const deleted = await this.onDelete(clone(label));
    if (!deleted) return false;
    const key = labelKey(label);
    this.labels = this.labels.filter((item) => labelKey(item) !== key);
    this.selectedLabels = this.selectedLabels.filter((item) => labelKey(item) !== key);
    this.resetCreateForm();
    this.emitChange({ persist: false });
    this.render();
    return true;
  }

  render() {
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-label-modal-shell");
    this.contentEl.addClass("ot-label-modal");

    if (this.creating) {
      this.renderCreateScreen();
      return;
    }

    const header = createElement("div", "ot-label-modal-header");
    header.append(createElement("h2", "", "Labels"));

    const search = createElement("input", "ot-label-search");
    search.type = "text";
    search.placeholder = "Search labels";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      renderList();
    });

    const labelTitle = createElement("h3", "ot-label-modal-subtitle", "Labels");
    const list = createElement("div", "ot-label-picker-list");
    const createArea = createElement("div", "ot-label-create-area");

    const renderList = () => {
      const query = this.query.trim().toLowerCase();
      list.replaceChildren();

      this.labels
        .filter((label) => !query || label.name.toLowerCase().includes(query))
        .forEach((label) => {
          const row = createElement("div", "ot-label-option-row");
          const checkbox = createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = this.isSelected(label);

          const labelButton = createElement("button", "ot-label-option", label.name);
          labelButton.type = "button";
          labelButton.style.backgroundColor = label.color || DEFAULT_LABEL_COLOR;

          const edit = iconButton("pencil", "Edit label", (event) => {
            event.stopPropagation();
            this.editLabel(label);
          });

          checkbox.addEventListener("change", () => this.toggleLabel(label));
          labelButton.addEventListener("click", () => this.toggleLabel(label));
          row.append(checkbox, labelButton, edit);
          list.append(row);
        });
    };

    const renderCreateArea = () => {
      createArea.replaceChildren();

      const create = createElement("button", "ot-label-create-button", "Create new label");
      addButtonIcon(create, "plus");
      create.type = "button";
      create.addEventListener("click", () => {
        this.creating = true;
        this.editingKey = null;
        this.createName = this.query;
        this.createColor = DEFAULT_LABEL_COLOR;
        this.render();
      });
      createArea.append(create);
    };

    this.contentEl.append(header, search, labelTitle, list, createArea);
    renderList();
    renderCreateArea();
    requestAnimationFrame(() => search.focus());
  }

  renderCreateScreen() {
    const header = createElement("div", "ot-label-modal-header");
    const back = iconButton("arrow-left", "Back", () => {
      this.creating = false;
      this.editingKey = null;
      this.render();
    });
    back.classList.add("ot-label-back");
    header.append(back, createElement("h2", "", this.editingKey ? "Edit label" : "Create label"));

    const previewBand = createElement("div", "ot-label-create-preview-band");
    const preview = createElement("div", "ot-label-preview-pill", this.createName || "Label preview");
    preview.style.backgroundColor = this.createColor;
    previewBand.append(preview);

    const form = createElement("form", "ot-label-create-screen");
    const titleField = createElement("label", "ot-field");
    titleField.append(createElement("span", "", "Title"));
    const title = createElement("input", "ot-label-create-title");
    title.type = "text";
    title.value = this.createName;
    title.placeholder = "Label name";
    titleField.append(title);

    const colorField = createElement("div", "ot-field");
    colorField.append(createElement("span", "", "Choose color"));
    colorField.append(colorSwatchGrid(LABEL_COLORS, this.createColor, (color) => {
      this.createColor = color;
      this.render();
    }));

    const removeColor = textButton("x", "Remove color", () => {
      this.createColor = "#6f737a";
      this.render();
    });
    removeColor.classList.add("ot-remove-color-button");

    const footer = createElement("div", "ot-label-create-footer");
    const create = createElement("button", this.editingKey ? "mod-cta ot-save-button" : "mod-cta", this.editingKey ? "Save" : "Create");
    addButtonIcon(create, this.editingKey ? "check" : "plus");
    create.type = "submit";
    if (this.editingKey && this.onDelete) {
      const original = this.labels.find((label) => labelKey(label) === this.editingKey);
      const remove = createElement("button", "mod-warning", "Delete label");
      remove.type = "button";
      addButtonIcon(remove, "trash");
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          const deleted = await this.deleteLabel(original);
          if (!deleted) remove.disabled = false;
        } catch (error) {
          console.error(error);
          new Notice("Could not delete the label.");
          remove.disabled = false;
        }
      });
      footer.append(remove);
    }
    footer.append(create);

    title.addEventListener("input", () => {
      this.createName = title.value;
      preview.textContent = this.createName || "Label preview";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.createLabel(title.value, this.createColor);
    });

    form.append(titleField, colorField, removeColor, footer);
    this.contentEl.append(header, previewBand, form);
    requestAnimationFrame(() => title.focus());
  }
}

module.exports = {
  LabelPickerModal,
};
