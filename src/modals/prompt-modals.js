const { Modal, Notice } = require("obsidian");
const { addButtonIcon, createElement, textLine } = require("../helpers");

// Reusable text prompt and confirmation dialogs.
class TextPromptModal extends Modal {
  constructor(app, title, placeholder, initialValue, onSubmit) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.initialValue = initialValue || "";
    this.onSubmit = onSubmit;
    this.submitting = false;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-prompt-modal");

    this.contentEl.append(createElement("h2", "", this.title));

    const input = createElement("input", "ot-input");
    input.type = "text";
    input.placeholder = this.placeholder;
    input.value = this.initialValue;
    this.contentEl.append(input);

    const actions = createElement("div", "ot-modal-actions");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta ot-save-button", "Save");
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");
    cancel.type = "button";
    save.type = "button";

    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", () => this.submit(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit(input.value);
      }
    });

    actions.append(cancel, save);
    this.contentEl.append(actions);

    requestAnimationFrame(() => input.focus());
  }

  submit(value) {
    if (this.submitting) return;
    const cleanValue = textLine(value);
    if (!cleanValue) {
      new Notice("Name cannot be empty.");
      return;
    }

    this.submitting = true;
    this.close();
    Promise.resolve(this.onSubmit(cleanValue)).catch((error) => {
      console.error(error);
      new Notice("Could not save.");
    });
  }
}

class ConfirmModal extends Modal {
  /**
   * The defaults describe the destructive confirmation this dialog started as.
   * A caller gating a reversible action (a dependency warning, for example)
   * overrides the confirm button and drops the irreversibility warning.
   */
  constructor(app, title, message, resolve, options = {}) {
    super(app);
    this.title = title;
    this.message = message;
    this.resolve = resolve;
    this.settled = false;
    this.confirmText = textLine(options.confirmText) || "Delete";
    this.confirmIcon = textLine(options.confirmIcon) || "trash-2";
    this.confirmClass = options.danger === false ? "mod-cta" : "mod-warning";
    this.warning = options.warning === undefined ? "This action cannot be undone." : textLine(options.warning);
    // A dialog with nothing to decide (see alertAction) drops the Cancel button.
    this.hideCancel = !!options.hideCancel;
    // Whatever the message introduces, listed one per line: a run-on sentence
    // of quoted names is unreadable past the second one.
    this.details = (Array.isArray(options.details) ? options.details : []).map(textLine).filter(Boolean);
  }

  onOpen() {
    this.modalEl.addClass("ot-confirm-modal-shell");
    this.contentEl.addClass("ot-confirm-modal");
    const heading = createElement("div", "ot-confirm-heading");
    heading.append(createElement("h2", "", this.title));

    const message = createElement("p", "ot-confirm-message", this.message);
    const actions = createElement("div", "ot-confirm-actions");
    const confirm = createElement("button", this.confirmClass, this.confirmText);
    confirm.type = "button";
    addButtonIcon(confirm, this.confirmIcon);
    confirm.addEventListener("click", () => this.finish(true));

    let initialFocus = confirm;
    if (!this.hideCancel) {
      const cancel = createElement("button", "", "Cancel");
      cancel.type = "button";
      addButtonIcon(cancel, "x");
      cancel.addEventListener("click", () => this.finish(false));
      actions.append(cancel);
      initialFocus = cancel;
    }
    actions.append(confirm);

    const warning = this.warning ? createElement("p", "ot-confirm-warning", this.warning) : null;
    this.contentEl.replaceChildren(...[heading, message, this.renderDetails(), warning, actions].filter(Boolean));
    requestAnimationFrame(() => initialFocus.focus());
  }

  renderDetails() {
    if (!this.details.length) return null;
    const list = createElement("ul", "ot-confirm-list");
    this.details.forEach((detail) => list.append(createElement("li", "", detail)));
    return list;
  }

  finish(confirmed) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }

  onClose() {
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
  }
}

function confirmAction(app, title, message, options) {
  if (!app || !app.workspace) return Promise.resolve(true);
  return new Promise((resolve) => new ConfirmModal(app, title, message, resolve, options).open());
}

/**
 * A one-button dialog for something the user has to read rather than decide:
 * the action was already refused, so there is nothing left to confirm.
 */
function alertAction(app, title, message, details) {
  if (!app || !app.workspace) return Promise.resolve();
  return new Promise((resolve) => new ConfirmModal(app, title, message, () => resolve(), {
    details,
    confirmText: "Understood",
    confirmIcon: "check",
    danger: false,
    warning: "",
    hideCancel: true,
  }).open());
}

module.exports = {
  TextPromptModal,
  ConfirmModal,
  alertAction,
  confirmAction,
};
