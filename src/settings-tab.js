const { FuzzySuggestModal, Notice, PluginSettingTab, Setting } = require("obsidian");

// Settings tab for board access, sync, preferences, and version info.
const { isImagePath } = require("./helpers");

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
 * Obsidian settings tab for Task Deck.
 */
class TaskDeckSettingTab extends PluginSettingTab {
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
        new Notice("Background image imported into Task Deck's private data folder.");
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

    containerEl.createEl("h2", { text: "Task Deck" });
    containerEl.createEl("p", {
      text: this.plugin.isSyncDeckEnabled()
        ? "Trello-style boards backed by Markdown card notes — with a table view, labels, dates, checklists, and optional collaboration."
        : "Trello-style boards backed by Markdown card notes — with a table view, labels, dates, and checklists.",
    });

    // ---- Board ----
    new Setting(containerEl).setName("Board").setHeading();

    new Setting(containerEl)
      .setName("Open Task Deck")
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

    new Setting(containerEl)
      .setName("Cloud sync and collaboration")
      .setDesc("Show optional cloud sync, presence, edit locks, and member assignment features.")
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
          ? `${appearance.background.imageSource === "plugin" ? "Task Deck data" : "Vault"}: ${appearance.background.imagePath.split("/").pop()}`
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
        .setDesc("Fit shows the complete image without stretching or cropping it.")
        .addDropdown((dropdown) => dropdown
          .addOption("contain", "Fit — no cropping")
          .addOption("cover", "Fill — crop edges")
          .addOption("repeat", "Repeat")
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
      .setDesc("Restore Task Deck's Obsidian-theme appearance defaults.")
      .addButton((button) => button.setButtonText("Reset").setWarning().onClick(async () => {
        await this.plugin.applyAppearancePreset("obsidian");
        this.redisplayPreservingScroll();
      }));
  }

  renderAbout(containerEl) {
    // ---- About ----
    new Setting(containerEl).setName("About").setHeading();

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.manifest.version || "");
  }
}

module.exports = { TaskDeckSettingTab };
