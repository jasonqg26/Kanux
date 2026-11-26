const { FuzzySuggestModal, Notice, PluginSettingTab, Setting } = require("obsidian");

// Settings tab for board access, members, sync, preferences, and version info.
const {
  cleanColor,
  createElement,
  isImagePath,
  memberKey,
  pickMemberColor,
  textLine,
} = require("../helpers");
const { buildMemberAvatarElement } = require("../modals");

class VaultImageSuggestModal extends FuzzySuggestModal {
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

/**
 * Obsidian settings tab for Kanux.
 */
class KanuxSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  redisplayPreservingScroll() {
    const scroller = this.containerEl.closest(".vertical-tab-content-container") || this.containerEl.parentElement || this.containerEl;
    const top = scroller.scrollTop;
    const left = scroller.scrollLeft;
    this.display();
    requestAnimationFrame(() => {
      scroller.scrollTop = top;
      scroller.scrollLeft = left;
    });
  }

  chooseComputerBackground() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp,image/avif,image/x-icon";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const imagePath = await this.plugin.importAppearanceBackground(file);
        await this.plugin.updateAppearance({
          background: { type: "image", imageSource: "plugin", imagePath, imageFit: "contain" },
        });
        this.redisplayPreservingScroll();
        new Notice("Background image imported into Kanux's private data folder.");
      } catch (error) {
        new Notice(error && error.message ? error.message : "The background image could not be imported.");
      }
    }, { once: true });
    input.click();
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ot-settings");

    new Setting(containerEl).setName("Kanux").setHeading();
    containerEl.createEl("p", {
      text: this.plugin.isSyncDeckEnabled()
        ? "Trello-style boards backed by Markdown card notes — with a table view, labels, dates, checklists, members, and optional cloud collaboration."
        : "Trello-style boards backed by Markdown card notes — with a table view, labels, dates, checklists, and vault members.",
    });

    // ---- Board ----
    new Setting(containerEl).setName("Board").setHeading();

    new Setting(containerEl)
      .setName("Open Kanux")
      .setDesc("Open the board / table view.")
      .addButton((button) => button.setButtonText("Open").setCta().onClick(() => this.plugin.activateView()));

    new Setting(containerEl)
      .setName("Start new boards with To do / Doing / Done")
      .setDesc("New boards come with three ready-made lists (grey, blue, green). Turn off to start empty.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.seedDefaultLists !== false)
        .onChange(async (value) => {
          this.plugin.data.seedDefaultLists = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Completion sound")
      .setDesc("Play a short sound when a card is marked complete.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.completionSound !== false)
        .onChange(async (value) => {
          this.plugin.data.completionSound = value;
          await this.plugin.savePluginData();
        }));

    // Local note discovery is independent from the optional cloud integration.
    new Setting(containerEl)
      .setName("Re-import card notes")
      .setDesc("Pull in Markdown cards added or edited outside the board.")
      .addButton((button) => button
        .setButtonText("Re-import")
        .onClick(async () => {
          await this.plugin.syncCardsFromFolder();
          this.plugin.refreshViews();
          new Notice("Card notes re-imported.");
        }));

    this.renderMembers(containerEl);

    new Setting(containerEl)
      .setName("Cloud sync and collaboration")
      .setDesc("Show optional Sync Deck cloud sync, live presence, and card edit locks.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.isSyncDeckEnabled())
        .onChange(async (value) => {
          await this.plugin.setSyncDeckEnabled(value);
          this.redisplayPreservingScroll();
        }));

    if (!this.plugin.isSyncDeckEnabled()) {
      this.renderAbout(containerEl);
      return;
    }

    // ---- Sync & collaboration ----
    new Setting(containerEl).setName("Sync & collaboration").setHeading();

    const hasSyncDeck = !!this.plugin.getSyncDeckPlugin();
    new Setting(containerEl)
      .setName("Sync Deck")
      .setDesc(hasSyncDeck
        ? "Installed. Your boards sync across devices and teammates in real time, with live presence and per-card members."
        : "Install Sync Deck to sync boards across your devices, collaborate live with presence, and assign members to cards.")
      .addButton((button) => button
        .setButtonText(hasSyncDeck ? "Open Sync Deck" : "Get Sync Deck")
        .setCta()
        .onClick(() => this.plugin.openSyncDeck()));

    this.renderAbout(containerEl);
  }

  renderAppearance(containerEl) {
    const appearance = this.plugin.getAppearance();
    const update = (patch, rerender = false) => this.plugin.updateAppearance(patch).then(() => {
      if (rerender) this.redisplayPreservingScroll();
    });

    new Setting(containerEl).setName("Appearance").setHeading();

    new Setting(containerEl)
      .setName("Visual preset")
      .setDesc("Start from a complete visual style, then customize individual values.")
      .addDropdown((dropdown) => dropdown
        .addOption("obsidian", "Obsidian theme")
        .addOption("trello-dark", "Trello dark")
        .addOption("trello-light", "Trello light")
        .addOption("transparent", "Transparent")
        .addOption("high-contrast", "High contrast")
        .addOption("custom", "Custom")
        .setValue(appearance.preset)
        .onChange(async (value) => {
          if (value === "custom") {
            await this.plugin.updateAppearance({ preset: "custom" }, { keepPreset: true });
            return;
          }
          await this.plugin.applyAppearancePreset(value);
          this.redisplayPreservingScroll();
        }));

    new Setting(containerEl)
      .setName("Content contrast")
      .setDesc("Changes text color only. Background and surface colors remain unchanged.")
      .addDropdown((dropdown) => dropdown
        .addOption("theme", "Follow Obsidian theme")
        .addOption("dark", "Light text on dark surfaces")
        .addOption("light", "Dark text on light surfaces")
        .setValue(appearance.colorScheme)
        .onChange((value) => update({ colorScheme: value })));

    new Setting(containerEl).setName("Background").setHeading();

    new Setting(containerEl)
      .setName("Board background")
      .setDesc("Use the Obsidian theme, a solid color, a gradient, or an image.")
      .addDropdown((dropdown) => dropdown
        .addOption("theme", "Obsidian theme")
        .addOption("solid", "Solid color")
        .addOption("gradient", "Gradient")
        .addOption("image", "Image")
        .setValue(appearance.background.type)
        .onChange((value) => update({ background: { type: value } }, true)));

    if (appearance.background.type === "solid") {
      new Setting(containerEl)
        .setName("Background color")
        .addColorPicker((picker) => picker
          .setValue(appearance.background.color)
          .onChange((value) => update({ background: { color: value } })));
    }

    if (appearance.background.type === "gradient") {
      new Setting(containerEl)
        .setName("Gradient start")
        .addColorPicker((picker) => picker
          .setValue(appearance.background.gradientStart)
          .onChange((value) => update({ background: { gradientStart: value } })));
      new Setting(containerEl)
        .setName("Gradient end")
        .addColorPicker((picker) => picker
          .setValue(appearance.background.gradientEnd)
          .onChange((value) => update({ background: { gradientEnd: value } })));
    }

    if (appearance.background.type === "image") {
      const imageSetting = new Setting(containerEl)
        .setName("Background image")
        .setDesc(appearance.background.imagePath
          ? `${appearance.background.imageSource === "plugin" ? "Kanux data" : "Vault"}: ${appearance.background.imagePath.split("/").pop()}`
          : "No image selected.")
        .addButton((button) => button.setButtonText("From vault").onClick(() => {
          new VaultImageSuggestModal(this.app, async (file) => {
            await update({ background: { imageSource: "vault", imagePath: file.path, imageFit: "contain" } });
            this.redisplayPreservingScroll();
          }).open();
        }))
        .addButton((button) => button.setButtonText("From computer").setCta().onClick(() => this.chooseComputerBackground()));
      if (appearance.background.imagePath) {
        imageSetting.addButton((button) => button.setButtonText("Clear").onClick(() => update({ background: { imagePath: "" } }, true)));
      }

      new Setting(containerEl)
        .setName("Image fit")
        .setDesc("Cover fills the board without stretching the image; edges may be cropped.")
        .addDropdown((dropdown) => dropdown
          .addOption("original", "Original size — no enlargement")
          .addOption("cover", "Cover — fill board and crop edges")
          .addOption("contain", "Contain — show complete image")
          .addOption("repeat", "Repeat at original size")
          .setValue(appearance.background.imageFit)
          .onChange((value) => update({ background: { imageFit: value } })));

      new Setting(containerEl)
        .setName("Image darkening")
        .setDesc("Adds a dark overlay so cards and controls remain readable.")
        .addSlider((slider) => slider
          .setLimits(0, 0.85, 0.05)
          .setValue(appearance.background.overlayOpacity)
          .setDynamicTooltip()
          .onChange((value) => update({ background: { overlayOpacity: value } })));
    }

    new Setting(containerEl).setName("Cards and lists").setHeading();

    let cardColorPicker = null;
    new Setting(containerEl)
      .setName("Use theme card color")
      .setDesc("Derive card surfaces from the active Obsidian theme.")
      .addToggle((toggle) => toggle
        .setValue(appearance.cards.useTheme)
        .onChange(async (value) => {
          await update({ cards: { useTheme: value } });
          if (cardColorPicker) cardColorPicker.setDisabled(value);
        }));
    new Setting(containerEl)
      .setName("Card color")
      .setDesc(appearance.cards.useTheme ? "Disable theme card color to customize this value." : "Global card surface color.")
      .addColorPicker((picker) => {
        cardColorPicker = picker;
        picker
          .setValue(appearance.cards.background)
          .setDisabled(appearance.cards.useTheme)
          .onChange((value) => update({ cards: { background: value } }));
      });

    let columnColorPicker = null;
    new Setting(containerEl)
      .setName("Use theme list color")
      .setDesc("Derive list surfaces from the active Obsidian theme.")
      .addToggle((toggle) => toggle
        .setValue(appearance.lists.useTheme)
        .onChange(async (value) => {
          await update({ lists: { useTheme: value } });
          if (columnColorPicker) columnColorPicker.setDisabled(value);
        }));
    new Setting(containerEl)
      .setName("Column color")
      .setDesc(appearance.lists.useTheme ? "Disable theme list color to customize this value." : "Global list surface color.")
      .addColorPicker((picker) => {
        columnColorPicker = picker;
        picker
          .setValue(appearance.lists.background)
          .setDisabled(appearance.lists.useTheme)
          .onChange((value) => update({ lists: { background: value } }));
      });

    new Setting(containerEl).setName("Layout and typography").setHeading();

    new Setting(containerEl)
      .setName("Density")
      .setDesc("Controls list width, card padding, and spacing between cards.")
      .addDropdown((dropdown) => dropdown
        .addOption("compact", "Compact")
        .addOption("normal", "Normal")
        .addOption("comfortable", "Comfortable")
        .setValue(appearance.density)
        .onChange((value) => update({ density: value })));

    new Setting(containerEl)
      .setName("Text scale")
      .setDesc("Scale text throughout the board.")
      .addSlider((slider) => slider
        .setLimits(0.85, 1.4, 0.05)
        .setValue(appearance.fontScale)
        .setDynamicTooltip()
        .onChange((value) => update({ fontScale: value })));

    new Setting(containerEl)
      .setName("Card corners")
      .addSlider((slider) => slider
        .setLimits(0, 24, 1)
        .setValue(appearance.cards.borderRadius)
        .setDynamicTooltip()
        .onChange((value) => update({ cards: { borderRadius: value } })));

    new Setting(containerEl)
      .setName("Column corners")
      .addSlider((slider) => slider
        .setLimits(0, 24, 1)
        .setValue(appearance.lists.borderRadius)
        .setDynamicTooltip()
        .onChange((value) => update({ lists: { borderRadius: value } })));

    new Setting(containerEl)
      .setName("Card shadow")
      .addDropdown((dropdown) => dropdown
        .addOption("none", "None")
        .addOption("small", "Small")
        .addOption("medium", "Medium")
        .addOption("large", "Large")
        .setValue(appearance.cards.shadow)
        .onChange((value) => update({ cards: { shadow: value } })));

    new Setting(containerEl).setName("Motion").setHeading();

    new Setting(containerEl)
      .setName("Animations")
      .setDesc("Enable hover, completion, drag, and label transitions.")
      .addToggle((toggle) => toggle
        .setValue(appearance.motion.enabled)
        .onChange((value) => update({ motion: { enabled: value } })));

    new Setting(containerEl)
      .setName("Reset appearance")
      .setDesc("Restore Kanux's Obsidian-theme appearance defaults.")
      .addButton((button) => button.setButtonText("Reset").setWarning().onClick(async () => {
        await this.plugin.applyAppearancePreset("obsidian");
        this.redisplayPreservingScroll();
      }));
  }

  renderMembers(containerEl) {
    new Setting(containerEl).setName("Members").setHeading();
    this.renderMembersNoteSetting(containerEl);
    this.renderAddMemberForm(containerEl);

    const savedMembers = Array.isArray(this.plugin.data.members) ? this.plugin.data.members : [];
    const savedKeys = new Set(savedMembers.map((member) => memberKey(member)));
    const listEl = createElement("div", "ot-settings-members-list");
    if (savedMembers.length) {
      savedMembers.forEach((member) => listEl.append(this.buildSavedMemberRow(member)));
    } else {
      listEl.append(createElement("p", "ot-settings-members-empty", "No saved vault members yet. Add one above or inline from any card or table cell."));
    }
    containerEl.append(listEl);

    this.renderDiscoveredMembers(containerEl, savedKeys);
    this.renderSyncDeckMembers(containerEl);
  }

  renderMembersNoteSetting(containerEl) {
    const filePath = this.plugin.getMembersFilePath();
    let draftPath = filePath;
    const noteSetting = new Setting(containerEl)
      .setName("Members note")
      .setDesc("Markdown note in your vault that keeps team members, colors, and avatars synced across devices.")
      .addText((text) => text
        .setPlaceholder("Kanux Members.md")
        .setValue(filePath)
        .onChange((value) => { draftPath = value; }))
      .addButton((button) => button
        .setButtonText("Save path")
        .onClick(async () => {
          const changed = await this.plugin.setMembersFilePath(draftPath);
          if (changed) {
            this.redisplayPreservingScroll();
            new Notice(`Members note path set to ${this.plugin.getMembersFilePath()}.`);
          }
        }))
      .addButton((button) => button
        .setButtonText("Sync now")
        .onClick(async () => {
          const changed = await this.plugin.syncMembersFromVault();
          if (changed) await this.plugin.saveData(this.plugin.data);
          this.plugin.refreshViews();
          this.redisplayPreservingScroll();
          new Notice(changed ? "Members synced from vault note." : "Members note is up to date.");
        }));

    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (existingFile) {
      noteSetting.addButton((button) => button
        .setButtonText("Open note")
        .onClick(() => {
          if (this.app.workspace && typeof this.app.workspace.openLinkText === "function") {
            this.app.workspace.openLinkText(existingFile.path, "");
          }
        }));
    }
  }

  renderAddMemberForm(containerEl) {
    const form = createElement("div", "ot-settings-member-form");
    const nameInput = createElement("input", "ot-settings-member-input");
    nameInput.type = "text";
    nameInput.placeholder = "Name (e.g. Alice)";
    nameInput.setAttribute("aria-label", "Member name");

    const idInput = createElement("input", "ot-settings-member-input");
    idInput.type = "text";
    idInput.placeholder = "ID or email (optional)";
    idInput.setAttribute("aria-label", "Member ID or email");

    const colorInput = createElement("input", "ot-settings-member-color");
    colorInput.type = "color";
    colorInput.value = pickMemberColor("member");
    colorInput.setAttribute("aria-label", "Member color");
    let colorEdited = false;
    colorInput.addEventListener("input", () => { colorEdited = true; });
    nameInput.addEventListener("input", () => {
      if (!colorEdited) colorInput.value = pickMemberColor(idInput.value || nameInput.value || "member");
    });

    let avatarPath = "";
    const avatarBtn = createElement("button", "ot-settings-member-avatar-btn", "Avatar");
    avatarBtn.type = "button";
    avatarBtn.addEventListener("click", () => {
      new VaultImageSuggestModal(this.app, (file) => {
        avatarPath = file.path;
        avatarBtn.textContent = file.name;
        avatarBtn.title = file.path;
      }).open();
    });

    const addBtn = createElement("button", "mod-cta", "Add member");
    addBtn.type = "button";
    const submit = async () => {
      const name = textLine(nameInput.value);
      const email = textLine(idInput.value) || name;
      if (!name) {
        new Notice("Enter a member name first.");
        nameInput.focus();
        return;
      }
      await this.plugin.upsertVaultMember({
        name,
        email,
        color: cleanColor(colorInput.value) || pickMemberColor(email),
        picture: avatarPath,
      });
      this.redisplayPreservingScroll();
    };
    addBtn.addEventListener("click", submit);
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); submit(); }
    });

    form.append(nameInput, idInput, colorInput, avatarBtn, addBtn);
    containerEl.append(form);
  }

  buildSavedMemberRow(member) {
    const row = createElement("div", "ot-settings-member-row");
    const preview = buildMemberAvatarElement(this.plugin, member);

    const nameInput = createElement("input", "ot-settings-member-input");
    nameInput.type = "text";
    nameInput.value = member.name || member.email;
    nameInput.setAttribute("aria-label", `Name for ${member.name || member.email}`);

    const idInput = createElement("input", "ot-settings-member-input");
    idInput.type = "text";
    idInput.value = member.email || "";
    idInput.placeholder = "ID or email";
    idInput.setAttribute("aria-label", `ID for ${member.name || member.email}`);

    const colorInput = createElement("input", "ot-settings-member-color");
    colorInput.type = "color";
    colorInput.value = cleanColor(member.color) || pickMemberColor(member.email);
    colorInput.setAttribute("aria-label", `Color for ${member.name || member.email}`);

    const previousKey = memberKey(member);
    const saveChanges = async (nextPicture = member.picture || "") => {
      const nextName = textLine(nameInput.value) || member.name || member.email;
      const nextEmail = textLine(idInput.value) || nextName;
      await this.plugin.upsertVaultMember({
        name: nextName,
        email: nextEmail,
        color: cleanColor(colorInput.value) || pickMemberColor(nextEmail),
        picture: nextPicture,
      }, previousKey);
      this.redisplayPreservingScroll();
    };

    nameInput.addEventListener("change", () => saveChanges());
    idInput.addEventListener("change", () => saveChanges());
    colorInput.addEventListener("change", () => saveChanges());

    const avatarBtn = createElement("button", "ot-settings-member-avatar-btn", member.picture ? "Change avatar" : "Avatar");
    avatarBtn.type = "button";
    if (member.picture) avatarBtn.title = member.picture;
    avatarBtn.addEventListener("click", () => {
      new VaultImageSuggestModal(this.app, (file) => saveChanges(file.path)).open();
    });

    const actions = createElement("div", "ot-settings-member-actions");
    actions.append(colorInput, avatarBtn);

    if (member.picture) {
      const clearBtn = createElement("button", "ot-settings-member-clear-btn", "Clear");
      clearBtn.type = "button";
      clearBtn.addEventListener("click", () => saveChanges(""));
      actions.append(clearBtn);
    }

    const removeBtn = createElement("button", "mod-warning", "Remove");
    removeBtn.type = "button";
    removeBtn.addEventListener("click", async () => {
      await this.plugin.removeVaultMember(previousKey);
      this.redisplayPreservingScroll();
    });
    actions.append(removeBtn);

    row.append(preview, nameInput, idInput, actions);
    return row;
  }

  renderDiscoveredMembers(containerEl, savedKeys) {
    const discovered = this.plugin.collectCardMembers()
      .filter((member) => !savedKeys.has(memberKey(member)));
    if (!discovered.length) return;

    const section = createElement("div", "ot-settings-members-discovered");
    section.append(createElement("p", "ot-settings-members-hint", "Found in existing cards and checklists (save to customize color or avatar):"));
    discovered.forEach((member) => {
      const row = createElement("div", "ot-settings-member-row is-discovered");
      const info = createElement("span", "ot-settings-member-discovered-name", member.name || member.email);
      const saveBtn = createElement("button", "", "Save to list");
      saveBtn.type = "button";
      saveBtn.addEventListener("click", async () => {
        await this.plugin.upsertVaultMember(member);
        this.redisplayPreservingScroll();
      });
      row.append(buildMemberAvatarElement(this.plugin, member), info, saveBtn);
      section.append(row);
    });
    containerEl.append(section);
  }

  renderSyncDeckMembers(containerEl) {
    const syncDeckMembers = typeof this.plugin.getSyncDeckMembers === "function"
      ? this.plugin.getSyncDeckMembers()
      : [];
    if (!syncDeckMembers.length) return;

    const section = createElement("div", "ot-settings-members-syncdeck");
    section.append(createElement("p", "ot-settings-members-hint", "From Sync Deck:"));
    syncDeckMembers.forEach((member) => {
      const row = createElement("div", "ot-settings-member-row is-syncdeck");
      const name = createElement("span", "ot-settings-member-discovered-name", `${member.name || member.email} (${member.email})`);
      const badge = createElement("span", "ot-settings-member-badge", "Sync Deck");
      row.append(buildMemberAvatarElement(this.plugin, member), name, badge);
      section.append(row);
    });
    containerEl.append(section);
  }

  renderAbout(containerEl) {
    // ---- About ----
    new Setting(containerEl).setName("About").setHeading();

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.manifest.version || "");
  }
}

module.exports = { KanuxSettingTab };
