const { MarkdownRenderer, Notice, setIcon } = require("obsidian");
const {
  LIST_COLORS,
  addButtonIcon,
  checklistItemNoteBody,
  checklistStats,
  cleanColor,
  createElement,
  iconButton,
  textButton,
  textLine,
  uid,
} = require("../helpers");
const { setIconSafe } = require("./modal-ui");
const { TextPromptModal, confirmAction } = require("./prompt-modals");
const { ListColorModal } = require("./list-color-modal");
const { buildDependenciesField } = require("./card-dependencies-field");

// Builds the card checklists field: groups with description, drag & drop,
// per-item notes and member assignment.
/**
 * Renders every named checklist as an independent progress bar.
 */
function buildChecklistsField(modal) {
  const field = createElement("div", "ot-checklists-field");
  const checklistRenderers = new Map();
  let draggedChecklistItem = null;

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
    const sourceIndex = sourceGroup.items.indexOf(draggedChecklistItem.item);
    if (sourceIndex < 0) return;

    let nextIndex = insertionIndex;
    sourceGroup.items.splice(sourceIndex, 1);
    if (sourceGroup === targetGroup && sourceIndex < nextIndex) nextIndex -= 1;
    nextIndex = Math.max(0, Math.min(nextIndex, targetGroup.items.length));
    targetGroup.items.splice(nextIndex, 0, draggedChecklistItem.item);

    const sourceRenderer = checklistRenderers.get(sourceGroup.id);
    const targetRenderer = checklistRenderers.get(targetGroup.id);
    if (sourceRenderer) sourceRenderer();
    if (targetRenderer && targetRenderer !== sourceRenderer) targetRenderer();
    await modal.saveNow();
  };

  const renderGroup = (group) => {
    if (!Array.isArray(group.dependencies)) group.dependencies = [];
    const section = createElement("div", "ot-field ot-checklist-group");
    const groupColor = cleanColor(group.color) || LIST_COLORS[1];
    section.style.setProperty("--ot-checklist-color", groupColor);
    section.style.setProperty("border", `1px solid ${groupColor}`, "important");
    const header = createElement("div", "ot-checklist-header");
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
    header.append(heading);

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
    const dependenciesField = buildDependenciesField(modal, group.dependencies);

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
    list.addEventListener("drop", async (event) => {
      if (!draggedChecklistItem || modal.readOnly) return;
      event.preventDefault();
      list.classList.remove("is-checklist-drop-end");
      await moveChecklistItem(group, group.items.length);
      draggedChecklistItem = null;
      clearChecklistDropState();
    });
    const updateProgress = () => {
      const stats = checklistStats(group.items);
      progressText.textContent = `${stats.percent}%`;
      progressFill.style.width = `${stats.percent}%`;
    };

    const renderItems = () => {
      list.replaceChildren();
      if (!group.items.length) list.append(createElement("span", "ot-empty-text", "No checklist items"));

      group.items.forEach((item, index) => {
        const itemWrap = createElement("div", "ot-checklist-item");
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
        itemWrap.addEventListener("drop", async (event) => {
          if (!draggedChecklistItem || modal.readOnly) return;
          event.preventDefault();
          event.stopPropagation();
          if (draggedChecklistItem.item === item) {
            clearChecklistDropState();
            return;
          }
          const targetIndex = group.items.indexOf(item);
          const after = itemWrap.classList.contains("is-checklist-drop-after");
          itemWrap.classList.remove("is-checklist-drop-before", "is-checklist-drop-after");
          await moveChecklistItem(group, targetIndex + (after ? 1 : 0));
          draggedChecklistItem = null;
          clearChecklistDropState();
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
              onCancel: () => {
                modal.finishChecklistNoteEdit(file.path);
                showNoteBody().catch(console.error);
              },
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
            group.items.splice(index, 1);
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
          updateProgress();
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
        list.append(itemWrap);
      });
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

  modal.localChecklists.forEach((group) => field.append(renderGroup(group)));
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

module.exports = {
  buildChecklistsField,
};
