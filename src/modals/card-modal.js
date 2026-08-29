const { Menu, Modal, Notice } = require("obsidian");
const {
  LIST_COLORS,
  addButtonIcon,
  checklistItemNoteWithBody,
  cleanColor,
  cleanLabelName,
  clone,
  createElement,
  iconButton,
  labelKey,
  normalizeChecklists,
  normalizeDependencies,
  textLine,
  initials,
  uid,
} = require("../helpers");
const { splitDetailSegments } = require("./details-markdown");
const { SAVE_DEBOUNCE_MS, LOCK_HEARTBEAT_MS, setIconSafe } = require("./modal-ui");
const { confirmAction } = require("./prompt-modals");
const { LabelPickerModal } = require("./label-picker-modal");
const { buildDependenciesField } = require("./card-dependencies-field");
const { buildDetailsField } = require("./card-details-field");
const { exportCardToPdf } = require("./card-pdf-export");
const { buildChecklistsField } = require("./card-checklist-field");

// Controls that only reveal content, so a read-only viewer keeps them: they
// expand a panel or open a preview without ever writing to the card.
const VIEW_ONLY_CONTROL_CLASSES = ["ot-image-tile", "ot-checklist-note-action"];

// The card editor modal: state, locking, saving, and field wiring.
class CardModal extends Modal {
  constructor(app, plugin, cardId, options = {}) {
    super(app);
    this.plugin = plugin;
    this.cardId = cardId;
    // notesOnly: show just the title + Description + Checklist (used by the table
    // view, where labels / members / dates / status are edited inline in the cells).
    this.notesOnly = !!options.notesOnly;
    this.localTitle = "";
    this.localLabels = [];
    this.localGlobalLabels = [];
    this.localDetails = "";
    this.detailsDraft = "";
    this.editingDetails = false;
    this.detailsEditDismissed = false;
    this.pendingDetailAttachments = new Set();
    this.localChecklists = [];
    this.localDependencies = [];
    this.expandedChecklistNotes = new Set();
    this.checklistNoteDrafts = new Map();
    this.editingChecklistNotes = new Set();
    this.detailsTextarea = null;
    this.addingChecklistId = null;
    this.saveTimer = null;
    this.savePromise = Promise.resolve();
    this.readOnly = false;
    this.lockHolder = null;
    this.lockAcquired = false;
    this.lockBoardId = null;
    this.lockHeartbeat = null;
    // Where each sheet-capable editor landed this session ("sheet" | "inline"),
    // keyed by its sheet owner key. Pinned so a modal re-render can't migrate
    // an inline editor into the side sheet mid-edit.
    this.sheetPlacements = new Map();
  }

  onOpen() {
    this.contentEl.replaceChildren(createElement("div", "ot-loading", "Opening card..."));
    this.load().catch((error) => {
      console.error(error);
      new Notice("Could not open card.");
      this.close();
    });
  }

  /**
   * Pulls the latest Markdown note content before rendering the editor.
   */
  async load() {
    const card = this.plugin.data.cards[this.cardId];
    if (!card) {
      new Notice("Card not found.");
      this.close();
      return;
    }

    await this.plugin.hydrateCardFromFile(card);
    this.card = card;
    this.localTitle = card.title || "";
    this.localLabels = clone(card.labels || []);
    this.localGlobalLabels = clone(this.plugin.data.labels || []);
    this.localLabels.forEach((label) => this.ensureLocalGlobalLabel(label));
    this.localDetails = card.details || "";
    this.detailsDraft = "";
    this.editingDetails = false;
    this.detailsEditDismissed = false;
    this.localChecklists = normalizeChecklists(clone(card.checklists || []), []);
    this.localDependencies = normalizeDependencies(card.dependencies);
    // Group ids whose description field stays visible while still empty, so
    // the opt-in "Add description" flow survives re-renders until first save.
    this.openChecklistDescriptions = new Set();
    this.focusChecklistDescriptionId = null;
    this.localAssignees = clone(card.assignees || []);
    await this.setupCardLock();
    this.render();
  }

  /**
   * Decide whether this card can be edited. If someone else already holds the
   * lock we open read-only; otherwise we take the lock and keep it warm with a
   * heartbeat until the modal closes. Offline / no-SyncDeck falls open (editable).
   */
  async setupCardLock() {
    const board = this.plugin.getBoard();
    this.lockBoardId = board && board.id;

    const holder = this.plugin.getCardLockHolder && this.plugin.getCardLockHolder(this.cardId);
    if (holder) {
      this.readOnly = true;
      this.lockHolder = holder;
      return;
    }
    if (!this.lockBoardId || !this.plugin.acquireCardLock) return;

    const result = await this.plugin.acquireCardLock(this.lockBoardId, this.cardId);
    if (result && result.ok === false) {
      this.readOnly = true;
      this.lockHolder = result.lock || null;
      return;
    }
    this.lockAcquired = !!(result && result.ok && !result.offline);
    this.plugin.editingCardId = this.cardId;
    this.startLockHeartbeat();
  }

  startLockHeartbeat() {
    this.stopLockHeartbeat();
    // If the server now reports someone else holds the lock (we opened while
    // offline, or another editor took over), drop this modal to read-only.
    this.lockHeartbeat = window.setInterval(async () => {
      if (!this.lockBoardId || this.readOnly) return;
      const result = await this.plugin.acquireCardLock(this.lockBoardId, this.cardId).catch(() => null);
      if (result && result.ok === false) this.enterReadOnly(result.lock);
    }, LOCK_HEARTBEAT_MS);
  }

  // Convert an open editable modal into a read-only view after losing the lock.
  // Unsaved edits are dropped rather than saved, so we never persist a write that
  // would conflict with the real editor's changes.
  enterReadOnly(holder) {
    if (this.readOnly) return;
    this.readOnly = true;
    this.lockHolder = holder || this.lockHolder;
    this.lockAcquired = false;
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.stopLockHeartbeat();
    this.discardPendingDetailAttachments().catch(console.error);
    if (this.plugin.editingCardId === this.cardId) this.plugin.editingCardId = null;
    if (this.plugin.viewRefreshPending) this.plugin.refreshViews();
    new Notice(`🔒 ${(holder && holder.name) || "Someone"} is editing this card`);
    this.render();
  }

  stopLockHeartbeat() {
    if (this.lockHeartbeat) {
      window.clearInterval(this.lockHeartbeat);
      this.lockHeartbeat = null;
    }
  }

  /**
   * Ensures labels found on a card are available in the modal's label picker.
   */
  ensureLocalGlobalLabel(label) {
    const name = cleanLabelName(label);
    if (!name) return null;

    const key = labelKey(name);
    const existing = this.localGlobalLabels.find((item) => labelKey(item) === key);
    if (existing) return existing;

    const globalLabel = { name, color: label.color || "#d43c35" };
    this.localGlobalLabels.push(globalLabel);
    return globalLabel;
  }

  isSelectedLabel(label) {
    const key = labelKey(label);
    return this.localLabels.some((item) => labelKey(item) === key);
  }

  // Avatar chip for a member: profile picture when available, else initials.
  memberAvatar(member) {
    const avatar = createElement("span", "ot-card-avatar");
    avatar.style.setProperty("--ot-avatar-color", member.color || "#8b5cf6");
    const picture = this.plugin.getMemberPicture(member.email);
    if (picture) {
      const img = createElement("img", "");
      img.src = picture;
      img.alt = "";
      avatar.append(img);
    } else {
      avatar.textContent = initials(member.name || member.email);
      avatar.classList.add("is-initials");
    }
    return avatar;
  }

  renderAssigneesField() {
    const field = createElement("div", "ot-field ot-assignee-editor");
    field.append(createElement("span", "", "Members"));
    const row = createElement("div", "ot-assignee-row");

    const rebuild = () => {
      row.replaceChildren();
      (this.localAssignees || []).forEach((assignee) => {
        const chip = createElement("span", "ot-assignee-chip");
        const avatar = this.memberAvatar(assignee);
        const remove = iconButton("x", "Remove member", () => {
          this.localAssignees = (this.localAssignees || []).filter((a) => a.email !== assignee.email);
          rebuild();
          this.queueSave();
        });
        remove.classList.add("ot-assignee-remove");
        chip.append(avatar, createElement("span", "ot-assignee-name", assignee.name || assignee.email), remove);
        row.append(chip);
      });
      const addButton = iconButton("plus", "Assign a member", (event) => this.showMemberMenu(event, rebuild));
      addButton.classList.add("ot-assignee-add");
      row.append(addButton);
    };

    rebuild();
    field.append(row);
    return field;
  }

  showMemberMenu(event, rebuild) {
    const members = this.plugin.getVaultMembers();
    const menu = new Menu();
    if (!members.length) {
      menu.addItem((item) => item.setTitle("No members — sign in to Sync Deck").setDisabled(true));
    } else {
      members.forEach((member) => {
        const assigned = (this.localAssignees || []).some((a) => a.email === member.email);
        menu.addItem((item) => {
          item.setTitle(member.name || member.email).setChecked(assigned).onClick(() => {
            if (assigned) {
              this.localAssignees = (this.localAssignees || []).filter((a) => a.email !== member.email);
            } else {
              this.localAssignees = [...(this.localAssignees || []), { email: member.email, name: member.name, color: member.color }];
            }
            rebuild();
            this.queueSave();
          });
        });
      });
    }
    menu.showAtMouseEvent(event);
  }

  // Single-member picker for one checklist item (leftmost circle).
  showChecklistMemberMenu(event, item, rerender) {
    const members = this.plugin.getVaultMembers();
    const menu = new Menu();
    menu.addItem((mi) => mi
      .setTitle("Unassigned")
      .setChecked(!(item.assignee && item.assignee.email))
      .onClick(() => {
        item.assignee = null;
        rerender();
        this.saveNow().catch(console.error);
      }));
    if (!members.length) {
      menu.addItem((mi) => mi.setTitle("No members — sign in to Sync Deck").setDisabled(true));
    } else {
      members.forEach((member) => {
        const current = !!(item.assignee && item.assignee.email === member.email);
        menu.addItem((mi) => mi
          .setTitle(member.name || member.email)
          .setChecked(current)
          .onClick(() => {
            item.assignee = { email: member.email, name: member.name, color: member.color };
            rerender();
            this.saveNow().catch(console.error);
          }));
      });
    }
    menu.showAtMouseEvent(event);
  }

  render() {
    const card = this.card;
    const previousBody = this.contentEl.querySelector(".ot-card-modal-body");
    const bodyScrollTop = previousBody ? previousBody.scrollTop : 0;
    this.destroyEmbeddedEditors();
    // Fields reclaim the side sheet while rendering (openDetailsSideSheet
    // reuses it in place); it only closes below if no field claimed it.
    this.sideSheetClaimed = false;
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-card-modal-shell");
    this.contentEl.addClass("ot-card-modal");
    const collaborationEnabled = this.plugin.isSyncDeckEnabled();
    this.contentEl.classList.toggle("is-sync-disabled", !collaborationEnabled);

    const title = createElement("input", "ot-title-input");
    title.type = "text";
    title.value = this.localTitle;
    title.placeholder = "Card title";
    title.addEventListener("input", () => {
      this.localTitle = title.value;
      this.queueSave();
    });

    const board = this.plugin.findBoardForCard(card);
    const list = board && board.lists.find((item) => item.id === card.listId);
    // Centered document-style header: title, then where the card lives.
    const header = createElement("header", "ot-card-modal-header");
    const location = createElement("div", "ot-card-modal-location");
    if (list) location.append(createElement("span", "ot-card-modal-location-pill", list.title));
    if (list && board) location.append(createElement("span", "ot-card-modal-location-sep", "·"));
    if (board) location.append(createElement("span", "", board.name));
    if (!list && !board) location.append(createElement("span", "", "Kanux card"));
    header.append(title, location);

    const labelsField = this.notesOnly ? null : this.renderLabelsField();
    const assigneesField = this.notesOnly || !collaborationEnabled ? null : this.renderAssigneesField();
    const dependenciesField = this.renderDependenciesField();
    const detailsField = this.renderDetailsField();
    // Read BEFORE building the checklist field: rendering it consumes this id
    // when it queues focus for a just-opened checklist description.
    const checklistDescriptionFocusPending = !!this.focusChecklistDescriptionId;
    const checklistField = this.renderChecklistField();
    if (!this.sideSheetClaimed) this.closeSideSheet();

    const actions = createElement("div", "ot-modal-actions");
    const deleteButton = createElement("button", "mod-warning", "Delete");
    const openNote = createElement("button", "", "Open note");
    const exportPdf = createElement("button", "", "PDF");
    const close = createElement("button", "mod-cta", "Close");
    addButtonIcon(deleteButton, "trash");
    addButtonIcon(openNote, "file-text");
    addButtonIcon(exportPdf, "download");
    addButtonIcon(close, "x");

    [deleteButton, openNote, exportPdf, close].forEach((button) => {
      button.type = "button";
    });

    deleteButton.addEventListener("click", async () => {
      const confirmed = await confirmAction(this.app, "Delete card", "Delete this card and its linked Markdown note?");
      if (!confirmed) return;
      await this.plugin.deleteCard(card.id);
      this.close();
    });

    openNote.addEventListener("click", async () => {
      await this.saveNow();
      await this.plugin.openCardFile(card.id);
      this.close();
    });

    // Works in read-only too — exporting doesn't modify the card.
    exportPdf.addEventListener("click", () => this.exportCardPdf().catch(console.error));

    close.addEventListener("click", async () => {
      await this.saveNow();
      this.close();
    });

    actions.append(deleteButton, openNote, exportPdf, close);

    const sidebarFields = [labelsField, assigneesField, dependenciesField].filter(Boolean);
    const editableFields = [...sidebarFields, detailsField, checklistField];
    const mainColumn = createElement("main", "ot-card-modal-main");
    mainColumn.append(detailsField, checklistField);
    const body = createElement("div", "ot-card-modal-body");
    body.append(mainColumn);
    // Labels, members and dependencies live in captioned sidebar cards, so each
    // has an unmistakable home; with nothing to show, content takes the full width.
    if (sidebarFields.length) {
      const sidebar = createElement("aside", "ot-card-modal-sidebar");
      sidebar.append(...sidebarFields);
      body.append(sidebar);
    } else {
      body.classList.add("is-notes-only");
    }
    const children = [header, body, actions];
    if (this.readOnly) {
      this.contentEl.addClass("ot-card-readonly");
      const holderName = (this.lockHolder && this.lockHolder.name) || "Someone";
      children.unshift(createElement("div", "ot-card-lock-banner", `🔒 ${holderName} is editing this card — read only`));
    }
    this.contentEl.append(...children);
    if (bodyScrollTop) requestAnimationFrame(() => { body.scrollTop = bodyScrollTop; });

    if (this.readOnly) {
      title.disabled = true;
      deleteButton.disabled = true;
      this.disableEditing(editableFields);
    } else if (!this.editingDetails && !checklistDescriptionFocusPending) {
      // Refocusing the title here would blur the just-opened (still empty)
      // checklist description, whose blur handler collapses it immediately.
      requestAnimationFrame(() => title.focus());
    }
  }

  // Freeze every editable control inside the given fields so a read-only viewer
  // can look but not change anything (Open note / Close stay usable).
  disableEditing(fields) {
    fields.forEach((field) => {
      field.querySelectorAll("input, textarea, button, [contenteditable]").forEach((el) => {
        if (VIEW_ONLY_CONTROL_CLASSES.some((className) => el.classList.contains(className))) return;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON") {
          el.disabled = true;
        } else {
          el.setAttribute("contenteditable", "false");
        }
        el.classList.add("is-disabled");
      });
    });
  }

  onClose() {
    this.stopLockHeartbeat();
    this.destroyEmbeddedEditors();
    this.closeSideSheet();
    this.discardPendingDetailAttachments().catch(console.error);
    if (!this.readOnly && this.lockBoardId && this.plugin.releaseCardLock) {
      this.plugin.releaseCardLock(this.lockBoardId, this.cardId).catch(() => {});
    }
    if (this.plugin.editingCardId === this.cardId) this.plugin.editingCardId = null;
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveNow().catch(console.error);
    }
    // Board views stayed frozen while this modal was editing; catch them up.
    if (this.plugin.viewRefreshPending) this.plugin.refreshViews();
    this.contentEl.replaceChildren();
  }

  renderLabelsField() {
    const field = createElement("div", "ot-field ot-label-editor");
    field.append(createElement("span", "", "Labels"));
    const labelsWrap = createElement("div", "ot-selected-labels");
    const addButton = iconButton("plus", "Choose labels", () => {
      new LabelPickerModal(this.app, this.localGlobalLabels, this.localLabels, (labels, selectedLabels, options = {}) => {
        this.localGlobalLabels = labels;
        this.localLabels = selectedLabels;
        renderLabels();
        if (options.persist !== false) this.saveNow().catch(console.error);
      }, (label) => this.plugin.deleteLabel(label)).open();
    });
    addButton.classList.add("ot-label-add-button");

    const renderLabels = () => {
      labelsWrap.replaceChildren();

      this.localLabels.forEach((label, index) => {
        const pill = createElement("button", "ot-large-label-pill");
        pill.type = "button";
        pill.textContent = label.name;
        pill.style.backgroundColor = label.color;
        pill.title = "Remove label";
        pill.addEventListener("click", () => {
          this.localLabels.splice(index, 1);
          renderLabels();
          this.saveNow().catch(console.error);
        });
        labelsWrap.append(pill);
      });

      labelsWrap.append(addButton);
    };
    renderLabels();
    field.append(labelsWrap);
    return field;
  }

  // The embedded Obsidian editors hold keymap scopes and a patched workspace
  // method, so instances discarded by a re-render must be destroyed, not just
  // dropped with their DOM.
  trackEmbeddedEditor(editorInstance) {
    if (!this.embeddedEditors) this.embeddedEditors = [];
    this.embeddedEditors = this.embeddedEditors.filter((tracked) => {
      if (tracked.containerEl && tracked.containerEl.isConnected) return true;
      try { tracked.destroy(); } catch (error) { console.error(error); }
      return false;
    });
    this.embeddedEditors.push(editorInstance);
  }

  destroyEmbeddedEditors() {
    (this.embeddedEditors || []).forEach((tracked) => {
      try { tracked.destroy(); } catch (error) { console.error(error); }
    });
    this.embeddedEditors = [];
  }

  // ---- Side editing sheet ----
  // Editing the description slides the modal left and opens a page-like panel
  // beside it, so the card (labels, checklist, dates) stays visible while
  // writing. Only used when the viewport has room for both.
  openDetailsSideSheet(titleText, ownerKey) {
    if (!this.modalEl) return null;
    // One sheet at a time: whoever claimed it keeps it; a second editor
    // (e.g. a checklist note while the description is open) edits inline.
    if (this.sideSheet && this.sideSheet.isConnected && this.sideSheetOwner !== ownerKey) return null;
    // Same owner re-rendering (another field triggered modal.render): reuse
    // the open sheet in place so the panel doesn't animate out and back in.
    if (this.sideSheet && this.sideSheet.isConnected && this.sideSheetOwner === ownerKey) {
      const content = this.sideSheet.querySelector(".ot-side-sheet-content");
      if (content) {
        content.replaceChildren();
        this.sideSheetClaimed = true;
        return content;
      }
    }
    this.closeSideSheet();
    const SHEET_WIDTH = 440;
    const SHEET_GAP = 18;
    const modalWidth = this.modalEl.getBoundingClientRect().width;
    if (!modalWidth || window.innerWidth < modalWidth + SHEET_WIDTH + SHEET_GAP + 32) return null;
    this.sideSheetOwner = ownerKey;
    const sheet = createElement("aside", "ot-side-sheet");
    const header = createElement("div", "ot-side-sheet-header");
    const icon = createElement("span", "ot-details-heading-icon");
    setIconSafe(icon, "align-left");
    header.append(icon, createElement("span", "", titleText));
    const content = createElement("div", "ot-side-sheet-content");
    sheet.append(header, content);
    this.modalEl.append(sheet);
    this.modalEl.classList.add("ot-side-editing");
    this.sideSheet = sheet;
    this.sideSheetClaimed = true;
    return content;
  }

  closeSideSheet(ownerKey) {
    if (ownerKey && this.sideSheetOwner && this.sideSheetOwner !== ownerKey) return;
    // An owner-key close marks the end of that editing session (save/cancel),
    // so its pinned sheet-vs-inline placement resets for the next session.
    if (ownerKey && this.sheetPlacements) this.sheetPlacements.delete(ownerKey);
    const sheet = this.sideSheet;
    this.sideSheet = null;
    this.sideSheetOwner = null;
    if (this.modalEl) this.modalEl.classList.remove("ot-side-editing");
    if (!sheet) return;
    // Let the sheet tuck back behind the modal before leaving the DOM; the
    // timeout covers environments where animation events never fire.
    sheet.classList.add("is-closing");
    const removeSheet = () => sheet.remove();
    sheet.addEventListener("animationend", removeSheet, { once: true });
    window.setTimeout(removeSheet, 400);
  }

  currentDetailsText() {
    return this.editingDetails ? this.detailsDraft : this.localDetails;
  }

  shouldEditDetails() {
    const emptyDescription = !String(this.localDetails || "").trim();
    return !this.readOnly && (this.editingDetails || (emptyDescription && !this.detailsEditDismissed));
  }

  /**
   * Writes the description mid-edit, leaving the editing session running so
   * autosave never moves the caret or closes the side sheet. Attachments the
   * draft still references are released here; the ones it dropped are trashed,
   * exactly as an explicit save would.
   */
  async autoSaveDetails(markdown) {
    const previousDetails = this.localDetails;
    this.localDetails = String(markdown || "").trim();
    try {
      await this.saveNow({ propagateError: true });
    } catch (error) {
      this.localDetails = previousDetails;
      throw error;
    }
    await this.finalizePendingDetailAttachments(this.localDetails);
  }

  /** The same write, plus closing the editing session it belonged to. */
  async persistDetailsDraft(markdown) {
    await this.autoSaveDetails(markdown);
    this.detailsDraft = "";
    this.editingDetails = false;
    this.detailsEditDismissed = !this.localDetails;
  }

  async discardPendingDetailAttachment(path) {
    if (!this.pendingDetailAttachments || !this.pendingDetailAttachments.has(path)) return;
    const attachment = this.app.vault.getAbstractFileByPath(path);
    this.pendingDetailAttachments.delete(path);
    try {
      if (attachment) await this.app.vault.trash(attachment, false);
    } catch (error) {
      this.pendingDetailAttachments.add(path);
      throw error;
    }
  }

  async discardPendingDetailAttachments() {
    if (!this.pendingDetailAttachments) return;
    for (const path of [...this.pendingDetailAttachments]) {
      await this.discardPendingDetailAttachment(path);
    }
  }

  async finalizePendingDetailAttachments(markdown) {
    if (!this.pendingDetailAttachments || !this.pendingDetailAttachments.size) return;
    const referencedPaths = new Set(
      splitDetailSegments(markdown)
        .filter((segment) => segment.type === "img")
        .map((segment) => segment.target)
    );

    for (const path of [...this.pendingDetailAttachments]) {
      if (referencedPaths.has(path)) {
        this.pendingDetailAttachments.delete(path);
        continue;
      }
      try {
        await this.discardPendingDetailAttachment(path);
      } catch (error) {
        console.error(`Could not remove unused attachment: ${path}`, error);
      }
    }
  }

  async persistChecklistNote(filePath, body) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || file.extension !== "md") throw new Error("Checklist item note not found");
    const current = await this.app.vault.read(file);
    const updated = checklistItemNoteWithBody(current, body);
    if (updated !== current) await this.app.vault.modify(file, updated);
  }

  beginChecklistNoteEdit(filePath, body) {
    this.editingChecklistNotes.add(filePath);
    if (!this.checklistNoteDrafts.has(filePath)) this.checklistNoteDrafts.set(filePath, String(body || ""));
  }

  updateChecklistNoteDraft(filePath, draft) {
    this.checklistNoteDrafts.set(filePath, String(draft || ""));
  }

  finishChecklistNoteEdit(filePath) {
    this.checklistNoteDrafts.delete(filePath);
    this.editingChecklistNotes.delete(filePath);
  }

  /**
   * The heavy field builders and the PDF exporter live in their own modules;
   * these delegates keep the modal's public surface unchanged.
   */
  renderDetailsField(options = {}) {
    return buildDetailsField(this, options);
  }

  renderDependenciesField() {
    return buildDependenciesField(this, this.localDependencies);
  }

  async exportCardPdf() {
    return exportCardToPdf(this);
  }

  renderChecklistField() {
    return buildChecklistsField(this);
  }

  /**
   * Sanitizes modal state and writes it through the plugin's card updater.
   */
  cardPatch() {
    return {
      title: textLine(this.localTitle) || this.card.title,
      labels: clone(this.localLabels),
      assignees: clone(this.localAssignees || []),
      dependencies: normalizeDependencies(this.localDependencies),
      details: this.localDetails.trim(),
      checklists: this.localChecklists.map((group, index) => ({
        id: group.id || uid("checklist"),
        title: textLine(group.title) || `Checklist ${index + 1}`,
        color: cleanColor(group.color) || LIST_COLORS[1],
        description: String(group.description || ""),
        dependencies: normalizeDependencies(group.dependencies),
        items: (group.items || [])
          .map((item) => ({
            id: item.id || uid("item"),
            done: !!item.done,
            text: textLine(item.text),
            filePath: textLine(item.filePath),
            assignee: item.assignee && item.assignee.email
              ? { email: item.assignee.email, name: item.assignee.name || "", color: item.assignee.color || "" }
              : null,
          }))
          .filter((item) => item.text),
      })),
    };
  }

  queueSave() {
    if (this.readOnly) return;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveNow().catch(console.error);
    }, SAVE_DEBOUNCE_MS);
  }

  async saveNow(options = {}) {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.readOnly) return;

    const card = this.card;
    if (!card) return;

    const patch = this.cardPatch();
    const globalLabels = clone(this.localGlobalLabels);
    const saveOperation = this.savePromise.then(() => this.plugin.updateCard(card.id, patch, globalLabels));
    this.savePromise = saveOperation.catch((error) => {
        console.error(error);
        new Notice("Could not save card.");
      });

    if (options.propagateError) return saveOperation;
    await this.savePromise;
  }
}

module.exports = {
  CardModal,
};
