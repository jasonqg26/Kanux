const { MarkdownRenderer, Notice, setIcon } = require("obsidian");
const {
  DEPENDENCY_BLOCK_TOTAL,
  DEPENDENCY_BLOCK_WARN,
  LIST_COLORS,
  addButtonIcon,
  checklistItemNoteBody,
  checklistStats,
  cleanColor,
  createElement,
  iconButton,
  moveArrayEntry,
  renderIcon,
  textButton,
  textLine,
  uid,
} = require("../helpers");
const { setIconSafe } = require("./modal-ui");
const { TextPromptModal, confirmAction } = require("./prompt-modals");
const { ListColorModal } = require("./list-color-modal");
const { buildDependenciesField } = require("./card-dependencies-field");

// Builds the card checklists field: groups with description, collapsed
// dependencies, drag & drop of items and whole checklists, per-item notes
// and member assignment.
/**
 * Renders every named checklist as an independent progress bar.
 */
function buildChecklistsField(modal) {
  const field = createElement("div", "ot-checklists-field");
  const groupsArea = createElement("div", "ot-checklist-groups");
  const checklistRenderers = new Map();
  const groupSections = new Map();
  let draggedChecklistItem = null;
  let draggedChecklistGroup = null;

  const clearChecklistDropState = () => {
    field.querySelectorAll(".is-checklist-drop-before, .is-checklist-drop-after, .is-checklist-drop-end, .is-checklist-dragging")
      .forEach((element) => element.classList.remove(
        "is-checklist-drop-before",
        "is-checklist-drop-after",
        "is-checklist-drop-end",
        "is-checklist-dragging",
      ));
  };

  const moveChecklistItem = async (targetGroup, insertionIndex) => {
    if (!draggedChecklistItem || !targetGroup) return;
    const sourceGroup = modal.localChecklists.find((candidate) => candidate.id === draggedChecklistItem.groupId);
    if (!sourceGroup) return;
    if (!moveArrayEntry(sourceGroup.items, targetGroup.items, draggedChecklistItem.item, insertionIndex)) return;

    const sourceRenderer = checklistRenderers.get(sourceGroup.id);
    const targetRenderer = checklistRenderers.get(targetGroup.id);
    if (sourceRenderer) sourceRenderer();
    if (targetRenderer && targetRenderer !== sourceRenderer) targetRenderer();
    await modal.saveNow();
  };

  // "End of the list" is the end of the dragged item's own partition: pending
  // rows render before the completed section, so a pending item dropped on the
  // list background must not land between completed entries in the array.
  const endInsertionIndex = (targetGroup, draggedItem) => {
    if (draggedItem.done) return targetGroup.items.length;
    let insertionIndex = 0;
    targetGroup.items.forEach((entry, position) => {
      if (!entry.done) insertionIndex = position + 1;
    });
    return insertionIndex;
  };

  const clearGroupDropState = () => {
    groupsArea.classList.remove("is-checklist-drag-compact");
    groupsArea.querySelectorAll(".is-checklist-group-drop-before, .is-checklist-group-drop-after, .is-checklist-group-dragging")
      .forEach((element) => element.classList.remove(
        "is-checklist-group-drop-before",
        "is-checklist-group-drop-after",
        "is-checklist-group-dragging",
      ));
  };

  // Which checklist the pointer would drop the dragged one next to: the first
  // group whose upper half the pointer is above, otherwise after the last one.
  const groupDropTarget = (clientY) => {
    const candidates = modal.localChecklists
      .filter((group) => group !== draggedChecklistGroup)
      .map((group) => ({ group, section: groupSections.get(group.id) }))
      .filter((candidate) => candidate.section && candidate.section.isConnected);
    const hit = candidates.find(({ section }) => {
      const rect = section.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    if (hit) return { ...hit, after: false };
    const last = candidates[candidates.length - 1];
    return last ? { ...last, after: true } : null;
  };

  const paintGroupDropTarget = (target) => {
    groupsArea.querySelectorAll(".is-checklist-group-drop-before, .is-checklist-group-drop-after").forEach((element) => {
      if (!target || element !== target.section) {
        element.classList.remove("is-checklist-group-drop-before", "is-checklist-group-drop-after");
      }
    });
    if (!target) return;
    target.section.classList.toggle("is-checklist-group-drop-before", !target.after);
    target.section.classList.toggle("is-checklist-group-drop-after", target.after);
  };

  // Reorders the checklists and moves the already-rendered sections in place,
  // so open notes, editors and focus survive the drop without a re-render.
  const moveChecklistGroup = async (target) => {
    if (!draggedChecklistGroup || !target || target.group === draggedChecklistGroup) return;
    const insertionIndex = modal.localChecklists.indexOf(target.group) + (target.after ? 1 : 0);
    if (!moveArrayEntry(modal.localChecklists, modal.localChecklists, draggedChecklistGroup, insertionIndex)) return;
    modal.localChecklists.forEach((group) => {
      const section = groupSections.get(group.id);
      if (section) groupsArea.append(section);
    });
    await modal.saveNow();
  };

  groupsArea.addEventListener("dragover", (event) => {
    if (!draggedChecklistGroup || modal.readOnly) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    paintGroupDropTarget(groupDropTarget(event.clientY));
  });
  groupsArea.addEventListener("dragleave", (event) => {
    if (!draggedChecklistGroup) return;
    if (!groupsArea.contains(event.relatedTarget)) paintGroupDropTarget(null);
  });
  groupsArea.addEventListener("drop", (event) => {
    if (!draggedChecklistGroup || modal.readOnly) return;
    event.preventDefault();
    // The reorder itself is synchronous; only the save inside is awaited.
    // Cleaning up before that await resolves keeps this handler's tail from
    // clobbering a new drag the user starts while the drop is still saving.
    const commit = moveChecklistGroup(groupDropTarget(event.clientY));
    draggedChecklistGroup = null;
    clearGroupDropState();
    commit.catch(console.error);
  });

  // A drag ghost the size of the collapsed header: dragging a checklist with
  // dozens of items must not tow a screenful of rows under the pointer.
  const appendGroupDragPreview = (group) => {
    if (!document.body) return null;
    const preview = createElement("div", "ot-checklist-drag-preview");
    preview.style.setProperty("--ot-checklist-color", cleanColor(group.color) || LIST_COLORS[1]);
    const icon = createElement("span", "ot-checklist-heading-icon");
    setIconSafe(icon, "check-square", "");
    const stats = checklistStats(group.items);
    preview.append(
      icon,
      createElement("span", "ot-checklist-drag-preview-title", group.title || "Checklist"),
      createElement("span", "ot-checklist-drag-preview-count", `${stats.done}/${stats.total}`),
    );
    preview.setAttribute("aria-hidden", "true");
    document.body.append(preview);
    return preview;
  };

  const groupDragHandle = (group, section) => {
    const handle = createElement("span", "ot-checklist-drag-handle ot-checklist-group-handle");
    handle.draggable = !modal.readOnly;
    handle.title = "Drag to reorder checklist";
    handle.setAttribute("aria-label", "Drag to reorder checklist");
    setIconSafe(handle, "grip-vertical", "⋮⋮");
    let dragPreview = null;
    handle.addEventListener("dragstart", (event) => {
      if (modal.readOnly) {
        event.preventDefault();
        return;
      }
      draggedChecklistGroup = group;
      dragPreview = appendGroupDragPreview(group);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", group.title || "Checklist");
        if (event.dataTransfer.setDragImage && dragPreview) event.dataTransfer.setDragImage(dragPreview, 18, 18);
      }
      // Collapse and dim only after the browser has begun the drag, so the
      // source keeps its geometry while the drag image is taken.
      requestAnimationFrame(() => {
        if (draggedChecklistGroup !== group) return;
        section.classList.add("is-checklist-group-dragging");
        groupsArea.classList.add("is-checklist-drag-compact");
      });
    });
    handle.addEventListener("dragend", () => {
      draggedChecklistGroup = null;
      if (dragPreview) {
        dragPreview.remove();
        dragPreview = null;
      }
      clearGroupDropState();
    });
    return handle;
  };

  const renderGroup = (group) => {
    if (!Array.isArray(group.dependencies)) group.dependencies = [];
    const section = createElement("div", "ot-field ot-checklist-group");
    groupSections.set(group.id, section);
    const groupColor = cleanColor(group.color) || LIST_COLORS[1];
    section.style.setProperty("--ot-checklist-color", groupColor);
    section.style.setProperty("border", `1px solid ${groupColor}`, "important");
    const header = createElement("div", "ot-checklist-header");

    // Folded is card data (it round-trips through the note's heading comment),
    // so a checklist stays folded across reopens and syncs, not just renders.
    const collapseToggle = createElement("button", "ot-icon-button ot-checklist-collapse");
    collapseToggle.type = "button";
    const paintCollapseToggle = () => {
      const collapsed = !!group.collapsed;
      section.classList.toggle("is-checklist-collapsed", collapsed);
      renderIcon(collapseToggle, collapsed ? "chevron-right" : "chevron-down");
      collapseToggle.title = collapsed ? "Expand checklist" : "Collapse checklist";
      collapseToggle.setAttribute("aria-label", collapseToggle.title);
      collapseToggle.setAttribute("aria-expanded", String(!collapsed));
    };
    paintCollapseToggle();
    collapseToggle.addEventListener("click", () => {
      group.collapsed = !group.collapsed;
      paintCollapseToggle();
      modal.saveNow().catch(console.error);
    });
    const expandCollapsedGroup = () => {
      if (!group.collapsed) return;
      group.collapsed = false;
      paintCollapseToggle();
      modal.saveNow().catch(console.error);
    };

    const heading = createElement("div", "ot-checklist-heading");
    const headingIcon = createElement("span", "ot-checklist-heading-icon");
    headingIcon.style.setProperty("color", groupColor, "important");
    setIconSafe(headingIcon, "check-square", "☑");
    const name = createElement("input", "ot-checklist-name");
    name.type = "text";
    name.value = group.title || "Checklist";
    name.placeholder = "Checklist name";
    name.setAttribute("aria-label", "Checklist name");
    name.addEventListener("input", () => {
      group.title = name.value;
      modal.queueSave();
    });
    name.addEventListener("blur", () => {
      group.title = textLine(name.value) || "Checklist";
      name.value = group.title;
      modal.saveNow().catch(console.error);
    });
    heading.append(headingIcon, name);
    if (modal.localChecklists.length > 1) header.append(groupDragHandle(group, section));
    header.append(collapseToggle, heading);

    const hasDescription = !!textLine(group.description || "");
    const descriptionOpen = () => hasDescription || modal.openChecklistDescriptions.has(group.id);
    if (!modal.readOnly && !descriptionOpen()) {
      const addDescription = iconButton("align-left", "Add description", () => {
        modal.openChecklistDescriptions.add(group.id);
        modal.focusChecklistDescriptionId = group.id;
        modal.render();
      });
      addDescription.classList.add("ot-checklist-desc-button");
      header.append(addDescription);
    }

    // The very same editor the card uses, so a dependency is added and read the
    // same way whether it gates the card or one of its checklists.
    //
    // Most checklists depend on nothing, so the panel starts collapsed and the
    // header button carries the count: hidden is quiet, never silent, and a
    // gate that warns or blocks colours the count to say so from the header.
    const dependenciesOpen = () => modal.openChecklistDependencies.has(group.id);
    const dependenciesToggle = iconButton("link", "Show dependencies", () => {
      // On a folded checklist the panel has nowhere to show: unfold first and
      // make sure the click opens the panel instead of toggling it shut.
      const wasCollapsed = !!group.collapsed;
      expandCollapsedGroup();
      if (!wasCollapsed && dependenciesOpen()) modal.openChecklistDependencies.delete(group.id);
      else modal.openChecklistDependencies.add(group.id);
      paintDependenciesToggle();
    });
    dependenciesToggle.classList.add("ot-checklist-deps-button");
    const dependenciesCount = createElement("span", "ot-checklist-deps-count");
    dependenciesToggle.append(dependenciesCount);
    header.append(dependenciesToggle);

    // Called back rather than read once: adding or removing a dependency while
    // the panel is open has to move the count the header is showing.
    const dependenciesField = buildDependenciesField(modal, group.dependencies, () => paintDependenciesToggle());

    const paintDependenciesToggle = () => {
      const open = dependenciesOpen();
      const gate = modal.plugin.dependencyGateFor(group.dependencies);
      dependenciesField.hidden = !open;
      dependenciesToggle.classList.toggle("is-expanded", open);
      dependenciesToggle.classList.toggle("is-warning", gate.mode === DEPENDENCY_BLOCK_WARN);
      dependenciesToggle.classList.toggle("is-blocked", gate.mode === DEPENDENCY_BLOCK_TOTAL);
      dependenciesToggle.setAttribute("aria-expanded", String(open));
      dependenciesToggle.title = dependenciesToggleLabel(open, gate.total);
      dependenciesToggle.setAttribute("aria-label", dependenciesToggle.title);
      dependenciesCount.textContent = gate.total ? String(gate.total) : "";
      dependenciesCount.hidden = !gate.total;
    };
    paintDependenciesToggle();

    const colorButton = createElement("button", "ot-checklist-color");
    colorButton.type = "button";
    colorButton.title = "Choose checklist color";
    colorButton.setAttribute("aria-label", "Choose checklist color");
    colorButton.style.backgroundColor = groupColor;
    colorButton.addEventListener("click", () => {
      new ListColorModal(modal.app, group.title || "Checklist", groupColor, async (color) => {
        group.color = cleanColor(color) || LIST_COLORS[1];
        modal.render();
        await modal.saveNow();
      }, "Checklist").open();
    });
    header.append(colorButton);

    if (modal.localChecklists.length > 1) {
      const removeGroup = iconButton("trash", "Delete checklist", async () => {
        const items = group.items || [];
        const linkedNotes = items.filter((item) => item && item.filePath).length;
        const warning = linkedNotes
          ? `Delete "${group.title || "Checklist"}" and its items? This will also move ${linkedNotes} linked Markdown ${linkedNotes === 1 ? "note" : "notes"} to the trash.`
          : `Delete "${group.title || "Checklist"}" and its items?`;
        if (items.length) {
          const confirmed = await confirmAction(modal.app, "Delete checklist", warning);
          if (!confirmed) return;
        }
        try {
          await modal.plugin.deleteChecklistItemFiles(modal.card, items);
          items.forEach((item) => {
            if (!item || !item.filePath) return;
            modal.finishChecklistNoteEdit(item.filePath);
            modal.expandedChecklistNotes.delete(item.filePath);
          });
          modal.localChecklists = modal.localChecklists.filter((item) => item.id !== group.id);
          if (modal.addingChecklistId === group.id) modal.addingChecklistId = null;
          modal.render();
          await modal.saveNow();
        } catch (error) {
          console.error(error);
          new Notice("Could not delete the linked checklist notes.");
        }
      });
      removeGroup.classList.add("ot-checklist-delete");
      header.append(removeGroup);
    }

    const descriptionArea = createElement("div", "ot-checklist-description");
    const renderDescription = () => {
      descriptionArea.replaceChildren();
      if (!descriptionOpen()) return;

      const input = createElement("textarea", "ot-checklist-description-input");
      input.rows = 2;
      input.value = group.description || "";
      input.placeholder = "Add a more detailed description…";
      input.setAttribute("aria-label", "Checklist description");
      input.disabled = modal.readOnly;
      const resize = () => {
        input.style.height = "auto";
        input.style.height = `${input.scrollHeight}px`;
      };
      requestAnimationFrame(resize);
      input.addEventListener("input", () => {
        group.description = input.value;
        resize();
        modal.queueSave();
      });
      input.addEventListener("blur", () => {
        group.description = input.value.trim();
        // An abandoned empty field collapses back to the opt-in button.
        if (!group.description) {
          modal.openChecklistDescriptions.delete(group.id);
          modal.render();
        }
        modal.saveNow().catch(console.error);
      });
      if (modal.focusChecklistDescriptionId === group.id) {
        modal.focusChecklistDescriptionId = null;
        requestAnimationFrame(() => input.focus());
      }
      descriptionArea.append(input);
    };
    renderDescription();

    const progress = createElement("div", "ot-checklist-progress");
    const progressText = createElement("span", "ot-checklist-percent", "0%");
    const progressTrack = createElement("div", "ot-progress-track");
    const progressFill = createElement("div", "ot-progress-fill");
    progressFill.style.setProperty("background", groupColor, "important");
    progressTrack.append(progressFill);
    progress.append(progressText, progressTrack);

    const list = createElement("div", "ot-checklist");
    list.addEventListener("dragover", (event) => {
      if (!draggedChecklistItem || modal.readOnly) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      list.classList.add("is-checklist-drop-end");
    });
    list.addEventListener("dragleave", (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove("is-checklist-drop-end");
    });
    list.addEventListener("drop", (event) => {
      if (!draggedChecklistItem || modal.readOnly) return;
      event.preventDefault();
      list.classList.remove("is-checklist-drop-end");
      const commit = moveChecklistItem(group, endInsertionIndex(group, draggedChecklistItem.item));
      draggedChecklistItem = null;
      clearChecklistDropState();
      commit.catch(console.error);
    });
    const updateProgress = () => {
      const stats = checklistStats(group.items);
      progressText.textContent = `${stats.percent}%`;
      progressFill.style.width = `${stats.percent}%`;
    };

    const completedOpen = () => modal.openChecklistCompleted.has(group.id);

    // Completed rows sit behind their own toggle so a long checklist reads as
    // what is still pending; the count keeps the hidden rows accounted for.
    const buildCompletedSection = (doneCount, completedItemsArea) => {
      const wrap = createElement("div", "ot-checklist-completed");
      const open = completedOpen();
      const toggle = textButton(open ? "chevron-down" : "chevron-right", `Completed (${doneCount})`, () => {
        if (completedOpen()) modal.openChecklistCompleted.delete(group.id);
        else modal.openChecklistCompleted.add(group.id);
        renderItems();
        // The rebuild replaced the button under the keyboard user's focus.
        const nextToggle = list.querySelector(".ot-checklist-completed-toggle");
        if (nextToggle) nextToggle.focus();
      }, "ot-checklist-completed-toggle");
      toggle.title = open ? "Hide completed items" : "Show completed items";
      toggle.setAttribute("aria-expanded", String(open));
      wrap.append(toggle);
      if (completedItemsArea) wrap.append(completedItemsArea);
      return wrap;
    };

    // Re-rendering replaces the node that held keyboard focus; put it back on
    // the same item's checkbox, or on the Completed toggle it moved behind.
    const restoreItemFocus = (item) => {
      const checkbox = item.id ? list.querySelector(`[data-item-id="${item.id}"] input[type="checkbox"]`) : null;
      const target = checkbox || list.querySelector(".ot-checklist-completed-toggle");
      if (target && !target.disabled) target.focus();
    };

    const renderItems = () => {
      list.replaceChildren();
      if (!group.items.length) list.append(createElement("span", "ot-empty-text", "No checklist items"));

      // Collapsed completed rows are not even built: a checklist with dozens
      // of ticked items should not pay their Markdown wiring to stay hidden.
      const doneCount = group.items.filter((item) => item.done).length;
      const completedItemsArea = completedOpen() ? createElement("div", "ot-checklist-completed-items") : null;

      group.items.forEach((item) => {
        if (item.done && !completedItemsArea) return;
        const itemWrap = createElement("div", "ot-checklist-item");
        itemWrap.dataset.itemId = item.id || "";
        const row = createElement("div", "ot-checklist-row");
        const dragHandle = createElement("span", "ot-checklist-drag-handle");
        dragHandle.draggable = !modal.readOnly;
        dragHandle.title = "Drag to reorder checklist item";
        dragHandle.setAttribute("aria-label", "Drag to reorder checklist item");
        setIconSafe(dragHandle, "grip-vertical", "⋮⋮");
        dragHandle.addEventListener("dragstart", (event) => {
          if (modal.readOnly) {
            event.preventDefault();
            return;
          }
          draggedChecklistItem = { groupId: group.id, item };
          itemWrap.classList.add("is-checklist-dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.text || "Checklist item");
          }
        });
        dragHandle.addEventListener("dragend", () => {
          draggedChecklistItem = null;
          clearChecklistDropState();
        });
        itemWrap.addEventListener("dragover", (event) => {
          if (!draggedChecklistItem || modal.readOnly) return;
          // Rows only host neighbours from their own partition: a pending item
          // can never visually sit between completed rows, so accepting the
          // drop would paint a seam the re-render then contradicts.
          if (!!draggedChecklistItem.item.done !== !!item.done) {
            event.stopPropagation();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (draggedChecklistItem.item === item) return;
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          const after = event.clientY >= itemWrap.getBoundingClientRect().top + (itemWrap.offsetHeight / 2);
          itemWrap.classList.toggle("is-checklist-drop-before", !after);
          itemWrap.classList.toggle("is-checklist-drop-after", after);
        });
        itemWrap.addEventListener("dragleave", () => {
          itemWrap.classList.remove("is-checklist-drop-before", "is-checklist-drop-after");
        });
        itemWrap.addEventListener("drop", (event) => {
          if (!draggedChecklistItem || modal.readOnly) return;
          event.preventDefault();
          event.stopPropagation();
          if (draggedChecklistItem.item === item || !!draggedChecklistItem.item.done !== !!item.done) {
            clearChecklistDropState();
            return;
          }
          const targetIndex = group.items.indexOf(item);
          const after = itemWrap.classList.contains("is-checklist-drop-after");
          itemWrap.classList.remove("is-checklist-drop-before", "is-checklist-drop-after");
          const commit = moveChecklistItem(group, targetIndex + (after ? 1 : 0));
          draggedChecklistItem = null;
          clearChecklistDropState();
          commit.catch(console.error);
        });
        const checkbox = createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !!item.done;
        const input = createElement("textarea", "ot-checklist-title");
        input.rows = 1;
        input.value = item.text || "";
        input.setAttribute("aria-label", "Checklist item");
        const resizeTitle = () => {
          input.style.height = "auto";
          input.style.height = `${input.scrollHeight}px`;
        };
        requestAnimationFrame(resizeTitle);
        const actions = createElement("div", "ot-checklist-item-actions");
        const createNoteButton = !item.filePath ? iconButton("file-plus", "Create Markdown note", async () => {
          createNoteButton.disabled = true;
          try {
            const file = await modal.plugin.ensureChecklistItemFile(modal.card, item);
            item.filePath = file.path;
            await modal.saveNow();
            modal.expandedChecklistNotes.add(file.path);
            modal.render();
          } catch (error) {
            console.error(error);
            new Notice("Could not create the checklist item note.");
            createNoteButton.disabled = false;
          }
        }) : null;

        if (createNoteButton) createNoteButton.classList.add("ot-checklist-note");

        const noteKey = item.filePath || "";
        let notePanel = null;
        let noteToggle = null;
        let noteContent = null;
        let noteRenderVersion = 0;

        const showNoteBody = async () => {
          const renderVersion = ++noteRenderVersion;
          noteContent.replaceChildren(createElement("span", "ot-checklist-note-status", "Loading Markdown description..."));
          try {
            const file = modal.plugin.resolveChecklistItemFile(modal.card, item);
            if (!file) throw new Error("Checklist item note not found");
            const markdown = await modal.app.vault.read(file);
            if (renderVersion !== noteRenderVersion || !modal.expandedChecklistNotes.has(noteKey) || !noteContent.isConnected) return;
            const body = checklistItemNoteBody(markdown);
            const draft = modal.checklistNoteDrafts.get(file.path);
            const editing = modal.editingChecklistNotes.has(file.path);
            const noteActions = createElement("div", "ot-checklist-note-actions");
            const editButton = createElement("button", "", "Edit");
            editButton.type = "button";
            editButton.disabled = modal.readOnly;
            addButtonIcon(editButton, "pencil");
            const beginEditing = () => {
              if (modal.readOnly) return;
              modal.beginChecklistNoteEdit(file.path, body);
              showNoteBody().catch(console.error);
            };
            editButton.addEventListener("click", beginEditing);
            noteContent.replaceChildren();
            if (!editing) {
              const preview = createElement("div", "ot-markdown-preview ot-checklist-note-preview markdown-rendered");
              if (!body) preview.append(createElement("span", "ot-checklist-note-status", "This note has no description."));
              else {
                await MarkdownRenderer.render(modal.app, body, preview, file.path, this);
                if (renderVersion !== noteRenderVersion || !noteContent.isConnected) return;
              }
              preview.addEventListener("click", (event) => {
                if (event.target.closest("a, button, img")) return;
                const selection = window.getSelection();
                if (selection && selection.toString()) return;
                beginEditing();
              });
              noteActions.append(editButton);
              noteContent.append(preview, noteActions);
              return;
            }

            const noteEditor = modal.renderDetailsField({
              noteMode: true,
              sheetKey: file.path,
              title: "Checklist item note",
              placeholder: "Write details for this checklist item...",
              markdown: draft !== undefined ? draft : body,
              savedMarkdown: body,
              onDraftChange: (nextDraft) => modal.updateChecklistNoteDraft(file.path, nextDraft),
              onSave: async (markdown) => {
                try {
                  await modal.persistChecklistNote(file.path, markdown);
                } catch (error) {
                  new Notice("Could not save the Markdown description.");
                  throw error;
                }
                modal.finishChecklistNoteEdit(file.path);
                await showNoteBody();
              },
              onAutoSave: (markdown) => modal.persistChecklistNote(file.path, markdown),
            });
            noteContent.replaceChildren(noteEditor);
          } catch (error) {
            console.error(error);
            if (renderVersion !== noteRenderVersion || !modal.expandedChecklistNotes.has(noteKey) || !noteContent.isConnected) return;
            noteContent.replaceChildren(createElement("span", "ot-checklist-note-status is-error", "Could not read the Markdown description."));
          }
        };

        if (item.filePath) {
          noteToggle = textButton("file-text", "Markdown", () => {
            const expanded = !modal.expandedChecklistNotes.has(noteKey);
            if (expanded) modal.expandedChecklistNotes.add(noteKey);
            else modal.expandedChecklistNotes.delete(noteKey);
            notePanel.hidden = !expanded;
            noteToggle.classList.toggle("is-expanded", expanded);
            noteToggle.setAttribute("aria-expanded", String(expanded));
            noteToggle.title = expanded ? "Hide Markdown description" : "Show Markdown description";
            setIcon(noteToggle.querySelector(".ot-checklist-note-chevron"), expanded ? "chevron-up" : "chevron-down");
            if (expanded) showNoteBody();
          }, "ot-checklist-note-toggle ot-checklist-note-action");
          noteToggle.title = "Show Markdown description";
          noteToggle.setAttribute("aria-expanded", "false");
          const chevron = createElement("span", "ot-checklist-note-chevron");
          setIcon(chevron, "chevron-down");
          noteToggle.append(chevron);

          const openNoteButton = iconButton("file-text", "Open Markdown note", async () => {
            openNoteButton.disabled = true;
            try {
              const file = modal.plugin.resolveChecklistItemFile(modal.card, item);
              if (!file) throw new Error("Checklist item note not found");
              await modal.plugin.openChecklistItemFile(file.path);
              modal.close();
            } catch (error) {
              console.error(error);
              new Notice("Could not open the checklist item note.");
              openNoteButton.disabled = false;
            }
          });
          openNoteButton.classList.add("ot-checklist-note-open", "ot-checklist-note-action");
          actions.append(noteToggle, openNoteButton);

          notePanel = createElement("div", "ot-checklist-note-panel");
          notePanel.hidden = true;
          noteContent = createElement("div", "ot-checklist-note-content");
          notePanel.append(noteContent);
        }
        const remove = iconButton("x", "Remove item", async () => {
          if (item.filePath) {
            const confirmed = await confirmAction(
              modal.app,
              "Remove checklist item",
              `Remove "${item.text || "Checklist item"}"? Its linked Markdown note will also be moved to the trash.`,
            );
            if (!confirmed) return;
          }
          try {
            await modal.plugin.deleteChecklistItemFile(modal.card, item);
            if (item.filePath) {
              modal.finishChecklistNoteEdit(item.filePath);
              modal.expandedChecklistNotes.delete(item.filePath);
            }
            const itemIndex = group.items.indexOf(item);
            if (itemIndex >= 0) group.items.splice(itemIndex, 1);
            renderItems();
            await modal.saveNow();
          } catch (error) {
            console.error(error);
            new Notice("Could not delete the linked checklist note.");
          }
        });
        remove.addEventListener("click", (event) => event.stopPropagation());

        checkbox.addEventListener("change", async () => {
          // Only completing an item is gated: undoing progress is always allowed.
          if (checkbox.checked) {
            const allowed = await modal.plugin.confirmDependencyGate(modal.plugin.checklistDependencyGate(group));
            if (!allowed) {
              checkbox.checked = false;
              return;
            }
          }
          item.done = checkbox.checked;
          // A ticked item whose note is open on screen would otherwise vanish
          // into the collapsed completed section mid-edit; reveal the section
          // so the row (and the editor it hosts) stays visible.
          if (item.done && item.filePath && !completedOpen()
            && (modal.expandedChecklistNotes.has(item.filePath) || modal.editingChecklistNotes.has(item.filePath))) {
            modal.openChecklistCompleted.add(group.id);
          }
          // Re-render so the row crosses between the pending list and the
          // completed section instead of only repainting the progress bar.
          renderItems();
          restoreItemFocus(item);
          modal.saveNow().catch(console.error);
        });
        input.addEventListener("input", () => {
          item.text = input.value;
          resizeTitle();
          modal.queueSave();
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") event.preventDefault();
        });
        input.addEventListener("blur", () => {
          item.text = textLine(input.value);
          input.value = item.text;
          resizeTitle();
          modal.saveNow().catch(console.error);
        });

        let assigneeBtn = null;
        if (modal.plugin.isSyncDeckEnabled()) {
          assigneeBtn = createElement("button", "ot-checklist-assignee");
          assigneeBtn.type = "button";
          const paintAssignee = () => {
            assigneeBtn.replaceChildren();
            const a = item.assignee;
            if (a && a.email) {
              assigneeBtn.classList.add("is-assigned");
              assigneeBtn.title = a.name || a.email;
              assigneeBtn.append(modal.memberAvatar(a));
            } else {
              assigneeBtn.classList.remove("is-assigned");
              assigneeBtn.title = "Assign member";
              assigneeBtn.append(createElement("span", "ot-checklist-assignee-empty"));
            }
          };
          paintAssignee();
          assigneeBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            modal.showChecklistMemberMenu(event, item, paintAssignee);
          });
        }

        if (createNoteButton) actions.append(createNoteButton);
        actions.append(remove);
        if (assigneeBtn) {
          row.append(dragHandle, assigneeBtn, checkbox, input, actions);
        } else {
          row.style.setProperty("grid-template-columns", "18px 20px minmax(0, 1fr) auto", "important");
          row.append(dragHandle, checkbox, input, actions);
        }
        itemWrap.append(row);
        if (notePanel) {
          itemWrap.append(notePanel);
          if (modal.expandedChecklistNotes.has(noteKey)) {
            notePanel.hidden = false;
            noteToggle.classList.add("is-expanded");
            noteToggle.setAttribute("aria-expanded", "true");
            noteToggle.title = "Hide Markdown description";
            setIcon(noteToggle.querySelector(".ot-checklist-note-chevron"), "chevron-up");
            showNoteBody();
          }
        }
        (item.done ? completedItemsArea : list).append(itemWrap);
      });

      if (doneCount) list.append(buildCompletedSection(doneCount, completedItemsArea));
      // A re-render rebuilds rows after the modal's one-time read-only sweep,
      // so the fresh controls must be frozen again (the Completed toggle stays
      // usable: it only reveals content).
      if (modal.readOnly) modal.disableEditing([list]);
      updateProgress();
    };
    checklistRenderers.set(group.id, renderItems);

    const addArea = createElement("div", "ot-checklist-add");
    const renderAddArea = () => {
      addArea.replaceChildren();
      if (modal.addingChecklistId !== group.id) {
        addArea.append(textButton("plus", "Add item", () => {
          modal.addingChecklistId = group.id;
          renderAddArea();
        }));
        return;
      }

      const addForm = createElement("form", "ot-checklist-add-form");
      const addInput = createElement("input", "ot-input");
      addInput.type = "text";
      addInput.placeholder = "Checklist item";
      const addButton = createElement("button", "mod-cta", "Add");
      addButtonIcon(addButton, "plus");
      const cancel = iconButton("x", "Cancel", () => {
        modal.addingChecklistId = null;
        renderAddArea();
      });
      addButton.type = "submit";
      addForm.append(addInput, addButton, cancel);
      addForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = textLine(addInput.value);
        if (!text) {
          addInput.focus();
          return;
        }
        group.items.push({ id: uid("item"), done: false, text, filePath: "", assignee: null });
        modal.addingChecklistId = null;
        renderItems();
        renderAddArea();
        modal.saveNow().catch(console.error);
      });
      addInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          modal.addingChecklistId = null;
          renderAddArea();
        }
      });
      addArea.append(addForm);
      requestAnimationFrame(() => addInput.focus());
    };

    renderItems();
    renderAddArea();
    section.append(header, descriptionArea, dependenciesField, progress, list, addArea);
    return section;
  };

  modal.localChecklists.forEach((group) => groupsArea.append(renderGroup(group)));
  field.append(groupsArea);
  const addChecklist = textButton("plus", "Add checklist", () => {
    new TextPromptModal(modal.app, "Add checklist", "Checklist name", "", (title) => {
      const color = LIST_COLORS[modal.localChecklists.length % LIST_COLORS.length] || LIST_COLORS[1];
      modal.localChecklists.push({ id: uid("checklist"), title, color, dependencies: [], items: [] });
      modal.render();
      return modal.saveNow();
    }).open();
  }, "ot-add-checklist");
  field.append(addChecklist);
  return field;
}

// What the header button offers, so a collapsed panel still says how much is
// behind it instead of only that something might be.
function dependenciesToggleLabel(open, total) {
  if (open) return "Hide dependencies";
  if (!total) return "Show dependencies";
  return `Show ${total} ${total === 1 ? "dependency" : "dependencies"}`;
}

module.exports = {
  buildChecklistsField,
};
