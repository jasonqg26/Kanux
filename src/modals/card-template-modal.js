const { Menu, Modal, Notice } = require("obsidian");

// The card template editor: the shape a repeated kind of card starts from.
// It wears the card modal's own chrome — document header, main column beside a
// sidebar, sticky actions — because what you are filling in *is* a card, and
// two layouts for the same content would only make you learn it twice.
const {
  LIST_COLORS,
  addButtonIcon,
  cleanColor,
  clone,
  createElement,
  formatCardCode,
  iconButton,
  initials,
  textButton,
  textLine,
} = require("../helpers");
const { LabelPickerModal } = require("./label-picker-modal");
const { ListColorModal } = require("./list-color-modal");
const { confirmAction } = require("./prompt-modals");

const BLANK_HINT = "Write [ ] wherever the card should be filled in — “As a [ ] I want [ ] so that [ ]”. The editor opens on the first one.";
const NUMBER_HINT = "Every card made from this template takes the next code and the counter moves on. The code is stored on the card, so renaming it keeps the code. Restart the counter any time from Manage templates.";
const DEFAULT_PAD = 3;

class CardTemplateModal extends Modal {
  constructor(app, plugin, board, onSaved = null) {
    super(app);
    this.plugin = plugin;
    this.board = board;
    this.onSaved = onSaved;
    this.saving = false;
    this.template = {
      title: "",
      listId: (board.lists[0] && board.lists[0].id) || "",
      labels: [],
      assignees: [],
      details: "",
      checklists: [],
      numbering: null,
    };
    // Kept aside from the template so switching numbering off and back on does
    // not throw away the prefix that was already typed.
    this.numberingDraft = { prefix: "", next: 1, pad: DEFAULT_PAD };
    this.globalLabels = clone(plugin.data.labels || []);
  }

  onOpen() {
    this.modalEl.addClass("ot-card-modal-shell");
    this.contentEl.addClass("ot-card-modal");
    this.contentEl.addClass("ot-template-modal");

    const main = createElement("main", "ot-card-modal-main");
    main.append(this.buildDetailsField(), this.buildChecklistsField());

    const sidebar = createElement("aside", "ot-card-modal-sidebar");
    sidebar.append(this.buildLabelsField());
    if (this.plugin.isSyncDeckEnabled()) sidebar.append(this.buildMembersField());
    sidebar.append(this.buildNumberingField());

    const body = createElement("div", "ot-card-modal-body");
    body.append(main, sidebar);

    this.contentEl.replaceChildren(this.buildHeader(), body, this.buildActions());

    // Escape takes the same path as Cancel: a form with typing in it should not
    // vanish on a stray keypress. Guarded because the modal still has to build
    // where `scope` is absent (the test harness stubs Modal out).
    if (this.scope) {
      this.scope.register([], "Escape", () => {
        this.requestClose();
        return false;
      });
    }

    requestAnimationFrame(() => this.titleInput.focus());
  }

  onClose() {
    this.contentEl.replaceChildren();
  }

  /** Title, then where its cards land — the card modal's own header, editable. */
  buildHeader() {
    const header = createElement("header", "ot-card-modal-header");

    this.titleInput = createElement("input", "ot-title-input");
    this.titleInput.type = "text";
    this.titleInput.placeholder = "Bug report";
    this.titleInput.value = this.template.title;
    this.titleInput.setAttribute("aria-label", "Card title");
    this.titleInput.addEventListener("input", () => {
      this.template.title = this.titleInput.value;
      this.clearError();
      this.paintNumberPreview();
    });

    this.errorEl = createElement("p", "ot-template-error");
    this.errorEl.setAttribute("aria-live", "polite");
    this.errorEl.hidden = true;

    header.append(this.titleInput, this.errorEl, this.buildLocation());
    return header;
  }

  /**
   * The destination list sits where the card modal prints the card's own
   * location, so the header answers the same question in both: where is this.
   */
  buildLocation() {
    const location = createElement("div", "ot-card-modal-location");
    const pill = createElement("button", "ot-card-modal-location-pill ot-template-list");
    pill.type = "button";
    pill.setAttribute("aria-haspopup", "true");

    const paint = () => {
      const list = this.plugin.findList(this.template.listId, this.board);
      const dot = createElement("span", "ot-mini-card-dot");
      if (list && list.color) dot.style.setProperty("--ot-mini-card-color", list.color);
      const name = (list && list.title) || "Choose a list";
      pill.replaceChildren(dot, createElement("span", "", name));
      pill.setAttribute("aria-label", `Destination list: ${name}`);
    };

    pill.addEventListener("click", (event) => {
      const menu = new Menu();
      this.board.lists.forEach((list) => {
        menu.addItem((item) => item
          .setTitle(list.title)
          .setChecked(list.id === this.template.listId)
          .onClick(() => {
            this.template.listId = list.id;
            paint();
          }));
      });
      const rect = event.currentTarget.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    });

    paint();
    location.append(pill, createElement("span", "ot-card-modal-location-sep", "·"), createElement("span", "", this.board.name));
    return location;
  }

  buildLabelsField() {
    const field = createElement("div", "ot-field ot-label-editor");
    field.append(createElement("span", "", "Labels"));
    const pills = createElement("div", "ot-selected-labels");

    const paint = () => {
      pills.replaceChildren();
      this.template.labels.forEach((label, index) => {
        const pill = createElement("button", "ot-large-label-pill", label.name);
        pill.type = "button";
        pill.style.backgroundColor = label.color;
        pill.title = "Remove label";
        pill.setAttribute("aria-label", `Remove label ${label.name}`);
        pill.addEventListener("click", () => {
          this.template.labels.splice(index, 1);
          paint();
        });
        pills.append(pill);
      });
      const add = iconButton("plus", "Choose labels", () => {
        new LabelPickerModal(this.app, this.globalLabels, this.template.labels, (labels, selected) => {
          this.globalLabels = labels;
          this.template.labels = selected;
          paint();
        }).open();
      });
      add.classList.add("ot-label-add-button");
      pills.append(add);
    };

    paint();
    field.append(pills);
    return field;
  }

  buildMembersField() {
    const field = createElement("div", "ot-field");
    field.append(createElement("span", "", "Members"));
    const row = createElement("div", "ot-assignee-row");

    const paint = () => {
      row.replaceChildren();
      this.template.assignees.forEach((member, index) => {
        const chip = createElement("span", "ot-assignee-chip");
        const remove = iconButton("x", `Remove ${member.name || member.email}`, () => {
          this.template.assignees.splice(index, 1);
          paint();
        });
        remove.classList.add("ot-assignee-remove");
        chip.append(this.memberAvatar(member), createElement("span", "ot-assignee-name", member.name || member.email), remove);
        row.append(chip);
      });
      const add = iconButton("plus", "Assign a member", (event) => this.showMemberMenu(event, paint));
      add.classList.add("ot-assignee-add");
      row.append(add);
    };

    paint();
    field.append(row);
    return field;
  }

  /**
   * A running code — BUG-014 — stamped on the front of every card this template
   * makes, so a card can be named out loud.
   */
  buildNumberingField() {
    const field = createElement("div", "ot-field ot-template-numbering");
    field.append(createElement("span", "", "Numbering"));

    const toggleRow = createElement("label", "ot-template-toggle");
    const toggle = createElement("input", "");
    toggle.type = "checkbox";
    toggle.checked = !!this.template.numbering;
    toggleRow.append(toggle, createElement("span", "", "Number each card"));

    const boxes = createElement("div", "ot-template-number-boxes");
    boxes.append(
      this.buildNumberBox("Prefix", "prefix"),
      this.buildNumberBox("Next", "next"),
      this.buildNumberBox("Digits", "pad"),
    );

    this.previewEl = createElement("p", "ot-template-number-preview");
    this.previewEl.setAttribute("aria-live", "polite");
    const hint = createElement("span", "ot-template-hint", NUMBER_HINT);

    const paint = () => {
      const on = toggle.checked;
      this.template.numbering = on ? { ...this.numberingDraft } : null;
      boxes.hidden = !on;
      this.previewEl.hidden = !on;
      hint.hidden = !on;
      this.paintNumberPreview();
    };

    toggle.addEventListener("change", paint);
    paint();

    field.append(toggleRow, boxes, this.previewEl, hint);
    return field;
  }

  buildNumberBox(label, key) {
    const wrap = createElement("label", "ot-template-number-box");
    const input = createElement("input", "ot-input");
    if (key === "prefix") {
      input.type = "text";
      input.placeholder = "BUG";
      input.spellcheck = false;
      input.autocapitalize = "characters";
    } else {
      input.type = "number";
      input.inputMode = "numeric";
      input.min = key === "pad" ? "1" : "0";
      if (key === "pad") input.max = "8";
    }
    input.value = String(this.numberingDraft[key]);
    input.addEventListener("input", () => {
      this.numberingDraft[key] = key === "prefix" ? input.value : Number(input.value);
      if (this.template.numbering) this.template.numbering = { ...this.numberingDraft };
      this.paintNumberPreview();
    });

    wrap.append(createElement("span", "", label), input);
    return wrap;
  }

  paintNumberPreview() {
    if (!this.previewEl) return;
    const code = formatCardCode(this.template.numbering);
    if (!code) {
      this.previewEl.replaceChildren();
      return;
    }
    // Shown the way the card will wear it: the code beside the name, in the same
    // chip the board uses — never inside the title, which a rename would take.
    const name = createElement("span", "ot-template-number-name");
    name.append(
      createElement("span", "ot-card-code", code),
      createElement("span", "", this.template.title || "Untitled card"),
    );
    this.previewEl.replaceChildren(createElement("span", "ot-template-number-caption", "Next card"), name);
  }

  memberAvatar(member) {
    const avatar = createElement("span", "ot-card-avatar");
    avatar.style.setProperty("--ot-avatar-color", member.color || "#8b5cf6");
    const picture = this.plugin.getMemberPicture(member.email);
    if (picture) {
      const image = createElement("img", "");
      image.src = picture;
      image.alt = "";
      avatar.append(image);
      return avatar;
    }
    avatar.textContent = initials(member.name || member.email);
    avatar.classList.add("is-initials");
    return avatar;
  }

  showMemberMenu(event, paint) {
    const members = this.plugin.getVaultMembers();
    const menu = new Menu();
    if (!members.length) {
      menu.addItem((item) => item.setTitle("No members — sign in to Sync Deck").setDisabled(true));
    }
    members.forEach((member) => {
      const chosen = this.template.assignees.some((assignee) => assignee.email === member.email);
      menu.addItem((item) => item
        .setTitle(member.name || member.email)
        .setChecked(chosen)
        .onClick(() => {
          this.template.assignees = chosen
            ? this.template.assignees.filter((assignee) => assignee.email !== member.email)
            : [...this.template.assignees, { email: member.email, name: member.name, color: member.color }];
          paint();
        }));
    });
    menu.showAtMouseEvent(event);
  }

  buildDetailsField() {
    const field = createElement("div", "ot-field");
    field.append(createElement("span", "", "Description"));
    const input = createElement("textarea", "ot-textarea ot-template-details");
    input.rows = 6;
    input.placeholder = "As a [ ] I want [ ] so that [ ]";
    input.value = this.template.details;
    input.setAttribute("aria-label", "Description");
    input.addEventListener("input", () => { this.template.details = input.value; });
    field.append(input, createElement("span", "ot-template-hint", BLANK_HINT));
    return field;
  }

  buildChecklistsField() {
    const field = createElement("div", "ot-field");
    const header = createElement("div", "ot-field-row");
    const groups = createElement("div", "ot-template-checklists");

    const paint = () => {
      groups.replaceChildren();
      if (!this.template.checklists.length) groups.append(createElement("span", "ot-empty-text", "No checklists yet"));
      this.template.checklists.forEach((group, index) => groups.append(this.buildChecklistGroup(group, index, paint)));
    };

    const add = iconButton("plus", "Add checklist", () => {
      this.template.checklists.push({
        title: `Checklist ${this.template.checklists.length + 1}`,
        color: LIST_COLORS[this.template.checklists.length % LIST_COLORS.length],
        description: "",
        dependencies: [],
        items: [],
      });
      paint();
    });
    add.classList.add("ot-dependency-add");
    header.append(createElement("span", "", "Checklists"), add);

    paint();
    field.append(header, groups);
    return field;
  }

  // Groups keep the order they were added in; that order is what the created
  // card gets, so moving one is done by removing and adding it again.
  buildChecklistGroup(group, index, repaintGroups) {
    const section = createElement("div", "ot-template-checklist");
    section.style.setProperty("--ot-checklist-color", group.color);

    const header = createElement("div", "ot-checklist-header");
    const name = createElement("input", "ot-checklist-name");
    name.type = "text";
    name.value = group.title;
    name.setAttribute("aria-label", "Checklist name");
    name.addEventListener("input", () => { group.title = name.value; });

    const color = createElement("button", "ot-checklist-color");
    color.type = "button";
    color.title = "Choose checklist color";
    color.setAttribute("aria-label", "Choose checklist color");
    color.style.backgroundColor = group.color;
    color.addEventListener("click", () => {
      new ListColorModal(this.app, group.title || "Checklist", group.color, (picked) => {
        group.color = cleanColor(picked) || group.color;
        repaintGroups();
      }, "Checklist").open();
    });

    const remove = iconButton("trash", "Remove checklist", () => {
      this.template.checklists.splice(index, 1);
      repaintGroups();
    });
    remove.classList.add("ot-checklist-delete");

    header.append(name, color, remove);
    section.append(header, this.buildChecklistItems(group));
    return section;
  }

  buildChecklistItems(group) {
    const wrap = createElement("div", "ot-template-items");

    const paint = () => {
      wrap.replaceChildren();
      group.items.forEach((item, index) => {
        const row = createElement("div", "ot-template-item");
        const input = createElement("input", "ot-input");
        input.type = "text";
        input.placeholder = "Checklist item";
        input.value = item.text;
        input.setAttribute("aria-label", "Checklist item");
        input.addEventListener("input", () => { item.text = input.value; });
        const remove = iconButton("x", "Remove item", () => {
          group.items.splice(index, 1);
          paint();
        });
        row.append(input, remove);
        wrap.append(row);
      });
      wrap.append(textButton("plus", "Add item", () => {
        group.items.push({ text: "", done: false, filePath: "", assignee: null });
        paint();
        const inputs = wrap.querySelectorAll("input");
        if (inputs.length) inputs[inputs.length - 1].focus();
      }));
    };

    paint();
    return wrap;
  }

  buildActions() {
    const actions = createElement("div", "ot-modal-actions");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta ot-save-button", "Create template");
    cancel.type = "button";
    save.type = "button";
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");
    cancel.addEventListener("click", () => this.requestClose());
    save.addEventListener("click", () => this.submit(save).catch(console.error));
    actions.append(cancel, save);
    return actions;
  }

  /** Anything filled in is worth a question before it is dropped. */
  isDirty() {
    const template = this.template;
    return !!(textLine(template.title)
      || template.labels.length
      || template.assignees.length
      || String(template.details).trim()
      || template.checklists.length
      || template.numbering);
  }

  requestClose() {
    if (!this.isDirty()) {
      this.close();
      return;
    }
    confirmAction(this.app, "Discard template", "Discard this template? Nothing you filled in is saved yet.", {
      confirmText: "Discard",
      confirmIcon: "trash-2",
      warning: "",
    }).then((discard) => {
      if (discard) this.close();
    }).catch(console.error);
  }

  showError(message) {
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
    this.titleInput.setAttribute("aria-invalid", "true");
    this.titleInput.classList.add("is-invalid");
    this.titleInput.focus();
  }

  clearError() {
    if (this.errorEl.hidden) return;
    this.errorEl.hidden = true;
    this.titleInput.removeAttribute("aria-invalid");
    this.titleInput.classList.remove("is-invalid");
  }

  async submit(button) {
    if (this.saving) return;
    const title = textLine(this.template.title);
    if (!title) {
      this.showError("Give the template a card title.");
      return;
    }

    this.saving = true;
    button.disabled = true;
    try {
      // Empty groups and empty items are dropped on the way out, so a checklist
      // started and abandoned does not reach every card made from this.
      await this.plugin.saveCardTemplate(this.board, {
        ...this.template,
        title,
        checklists: this.template.checklists.filter((group) => textLine(group.title) || group.items.length),
      });
      new Notice(`Template “${title}” created.`);
      this.close();
      if (this.onSaved) this.onSaved();
    } catch (error) {
      console.error(error);
      new Notice("Could not create the template. The board folder may be read-only.");
      this.saving = false;
      button.disabled = false;
    }
  }
}

module.exports = { CardTemplateModal };
