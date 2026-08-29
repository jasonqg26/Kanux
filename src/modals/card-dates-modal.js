const { Modal } = require("obsidian");
const {
  addMonths,
  addButtonIcon,
  cleanDate,
  createElement,
  dateFromISO,
  fieldDateLabel,
  iconButton,
  isoFromDate,
} = require("../helpers");

// Start/due date picker for a card.
class CardDatesModal extends Modal {
  constructor(app, plugin, cardId) {
    super(app);
    this.plugin = plugin;
    this.cardId = cardId;
    this.activeField = "due";
    this.startDate = "";
    this.dueDate = "";
    this.visibleMonth = new Date();
  }

  onOpen() {
    const card = this.plugin.data.cards[this.cardId];
    if (!card) {
      this.close();
      return;
    }

    this.card = card;
    this.startDate = cleanDate(card.startDate);
    this.dueDate = cleanDate(card.dueDate);
    this.activeField = this.startDate && !this.dueDate ? "start" : "due";
    const seed = dateFromISO(this.dueDate || this.startDate) || new Date();
    this.visibleMonth = new Date(seed.getFullYear(), seed.getMonth(), 1);
    this.render();
  }

  render() {
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-date-modal-shell");
    this.contentEl.addClass("ot-date-modal");
    this.contentEl.append(createElement("h2", "", "Dates"));

    this.contentEl.append(this.renderCalendar(), this.renderDateFields(), this.renderActions());
  }

  renderCalendar() {
    const calendar = createElement("div", "ot-date-calendar");
    const nav = createElement("div", "ot-date-calendar-nav");
    const title = createElement("div", "ot-date-month-title");
    title.textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(this.visibleMonth);

    nav.append(
      iconButton("chevrons-left", "Previous year", () => {
        this.visibleMonth = addMonths(this.visibleMonth, -12);
        this.render();
      }),
      iconButton("chevron-left", "Previous month", () => {
        this.visibleMonth = addMonths(this.visibleMonth, -1);
        this.render();
      }),
      title,
      iconButton("chevron-right", "Next month", () => {
        this.visibleMonth = addMonths(this.visibleMonth, 1);
        this.render();
      }),
      iconButton("chevrons-right", "Next year", () => {
        this.visibleMonth = addMonths(this.visibleMonth, 12);
        this.render();
      })
    );

    const weekdays = createElement("div", "ot-date-weekdays");
    const monday = new Date(2024, 0, 1);
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
      weekdays.append(createElement("span", "", new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date).replace(/\.$/, "")));
    }

    const grid = createElement("div", "ot-date-grid");
    const firstDay = new Date(this.visibleMonth.getFullYear(), this.visibleMonth.getMonth(), 1);
    const mondayOffset = (firstDay.getDay() + 6) % 7;
    const firstCell = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() - mondayOffset);

    for (let index = 0; index < 42; index += 1) {
      const date = new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index);
      const iso = isoFromDate(date);
      const button = createElement("button", "ot-date-day", String(date.getDate()));
      button.type = "button";
      if (date.getMonth() !== this.visibleMonth.getMonth()) button.classList.add("is-outside");
      if (iso === this.startDate || iso === this.dueDate) button.classList.add("is-selected");
      if (this.startDate && this.dueDate && iso > this.startDate && iso < this.dueDate) button.classList.add("is-range");
      button.addEventListener("click", () => this.selectDate(iso));
      grid.append(button);
    }

    calendar.append(nav, weekdays, grid);
    return calendar;
  }

  renderDateFields() {
    const fields = createElement("div", "ot-date-fields");
    fields.append(
      this.renderDateField("start", "Start date", this.startDate),
      this.renderDateField("due", "Due date", this.dueDate)
    );
    return fields;
  }

  renderDateField(field, label, value) {
    const wrap = createElement("div", "ot-date-field");
    wrap.append(createElement("span", "ot-date-field-label", label));

    const row = createElement("div", "ot-date-field-row");
    const checkbox = createElement("input", "ot-date-checkbox");
    checkbox.type = "checkbox";
    checkbox.checked = !!value;
    checkbox.addEventListener("change", () => {
      this.activeField = field;
      if (!checkbox.checked) this[field === "start" ? "startDate" : "dueDate"] = "";
      this.render();
    });

    const dateButton = createElement("button", `ot-date-field-button${value ? "" : " is-empty"}`, fieldDateLabel(value));
    dateButton.type = "button";
    if (this.activeField === field) dateButton.classList.add("is-active");
    dateButton.addEventListener("click", () => {
      this.activeField = field;
      this.render();
    });

    row.append(checkbox, dateButton);
    wrap.append(row);
    return wrap;
  }

  renderActions() {
    const actions = createElement("div", "ot-modal-actions");
    const clear = createElement("button", "", "Clear dates");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta ot-save-button", "Save");
    addButtonIcon(clear, "x");
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");

    [clear, cancel, save].forEach((button) => {
      button.type = "button";
    });

    clear.addEventListener("click", async () => {
      await this.plugin.updateCard(this.card.id, { startDate: "", dueDate: "" });
      this.close();
    });
    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", async () => {
      await this.plugin.updateCard(this.card.id, {
        startDate: this.startDate,
        dueDate: this.dueDate,
      });
      this.close();
    });

    actions.append(clear, cancel, save);
    return actions;
  }

  /**
   * Applies the clicked calendar day to whichever date field is active.
   */
  selectDate(date) {
    if (this.activeField === "start") {
      this.startDate = date;
      if (this.dueDate && this.dueDate < date) this.dueDate = "";
    } else {
      this.dueDate = date;
      if (this.startDate && this.startDate > date) this.startDate = "";
    }
    this.render();
  }
}

module.exports = {
  CardDatesModal,
};
