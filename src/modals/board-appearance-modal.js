const { Modal, Notice, Setting } = require("obsidian");
const { createElement } = require("../helpers");
const { TextPromptModal, confirmAction } = require("./prompt-modals");
const { VaultBackgroundSuggestModal } = require("./vault-suggest-modals");

// Board appearance (colors, background, density) settings dialog.
class BoardAppearanceModal extends Modal {
  constructor(app, plugin, boardId) {
    super(app);
    this.plugin = plugin;
    this.boardId = boardId;
  }

  onOpen() {
    this.render(false);
  }

  async update(patch, rerender = false) {
    await this.plugin.updateBoardAppearance(this.boardId, patch);
    if (rerender) this.render();
  }

  chooseComputerImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp,image/avif,image/x-icon";
    input.style.display = "none";
    document.body.append(input);
    const cleanup = () => input.remove();
    input.addEventListener("cancel", cleanup, { once: true });
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      try {
        if (!file) return;
        const imagePath = await this.plugin.importAppearanceBackground(file);
        await this.update({
          background: { type: "image", imageSource: "plugin", imagePath, imageFit: "original" },
        }, true);
        new Notice("Background image imported into Kanux's private data folder.");
      } catch (error) {
        new Notice(error && error.message ? error.message : "The background image could not be imported.");
      } finally {
        cleanup();
      }
    }, { once: true });
    try {
      if (typeof input.showPicker === "function") input.showPicker();
      else input.click();
    } catch (error) {
      input.click();
    }
  }

  render(preserveScroll = true) {
    const board = this.plugin.findBoard(this.boardId);
    if (!board) { this.close(); return; }
    const appearance = this.plugin.getBoardAppearance(this.boardId);
    const scrollTop = preserveScroll ? this.contentEl.scrollTop : 0;
    this.contentEl.replaceChildren();
    this.modalEl.addClass("ot-appearance-modal-shell");
    this.contentEl.addClass("ot-appearance-modal");
    this.contentEl.append(createElement("h2", "", `${board.name} appearance`));
    this.contentEl.append(createElement("p", "ot-appearance-modal-intro", "These settings apply only to this board."));

    new Setting(this.contentEl)
      .setName("Visual preset")
      .addDropdown((dropdown) => dropdown
        .addOption("obsidian", "Obsidian theme")
        .addOption("trello-dark", "Trello dark")
        .addOption("trello-light", "Trello light")
        .addOption("transparent", "Transparent")
        .addOption("high-contrast", "High contrast")
        .addOption("custom", "Custom")
        .setValue(appearance.preset)
        .onChange(async (value) => {
          if (value === "custom") await this.update({ preset: "custom" });
          else {
            await this.plugin.applyBoardAppearancePreset(this.boardId, value);
            this.render();
          }
        }));

    new Setting(this.contentEl).setName("Saved appearances").setHeading();
    const presets = this.plugin.getAppearancePresets();
    let selectedPresetId = presets[0] ? presets[0].id : "";
    const presetSetting = new Setting(this.contentEl)
      .setName("Custom preset")
      .setDesc(presets.length ? "Apply or delete a saved appearance." : "No custom appearances saved yet.")
      .addDropdown((dropdown) => {
        if (!presets.length) dropdown.addOption("", "No saved presets");
        presets.forEach((preset) => dropdown.addOption(preset.id, preset.name));
        dropdown.setValue(selectedPresetId).onChange((value) => { selectedPresetId = value; });
      })
      .addButton((button) => button.setButtonText("Apply").setDisabled(!presets.length).onClick(async () => {
        if (!selectedPresetId) return;
        await this.plugin.applyCustomAppearancePreset(this.boardId, selectedPresetId);
        this.render();
      }))
      .addButton((button) => button.setButtonText("Delete").setWarning().setDisabled(!presets.length).onClick(async () => {
        if (!selectedPresetId) return;
        const selected = presets.find((preset) => preset.id === selectedPresetId);
        if (!selected) return;
        const confirmed = await confirmAction(this.app, "Delete appearance preset", `Delete appearance preset "${selected.name}"?`);
        if (!confirmed) return;
        await this.plugin.deleteAppearancePreset(selectedPresetId);
        this.render();
      }));
    presetSetting.addButton((button) => {
      button.setButtonText("Save current").setCta();
      button.buttonEl.addClass("ot-save-button");
      button.onClick(() => {
        new TextPromptModal(this.app, "Save appearance", "Preset name", "", async (name) => {
          const saved = await this.plugin.saveAppearancePreset(name, this.plugin.getBoardAppearance(this.boardId));
          if (saved) {
            new Notice(`Appearance preset "${saved.name}" saved.`);
            this.render();
          }
        }).open();
      });
    });

    const sourceBoards = this.plugin.data.boards.filter((item) => item.id !== this.boardId);
    let sourceBoardId = sourceBoards[0] ? sourceBoards[0].id : "";
    new Setting(this.contentEl)
      .setName("Copy from another board")
      .setDesc(sourceBoards.length ? "Replace this board's appearance with another board's settings." : "Create another board to use this option.")
      .addDropdown((dropdown) => {
        if (!sourceBoards.length) dropdown.addOption("", "No other boards");
        sourceBoards.forEach((item) => dropdown.addOption(item.id, item.name));
        dropdown.setValue(sourceBoardId).onChange((value) => { sourceBoardId = value; });
      })
      .addButton((button) => button.setButtonText("Copy appearance").setDisabled(!sourceBoards.length).onClick(async () => {
        if (!sourceBoardId) return;
        await this.plugin.copyBoardAppearance(this.boardId, sourceBoardId);
        this.render();
      }));

    new Setting(this.contentEl).setName("Background").setHeading();
    new Setting(this.contentEl)
      .setName("Background type")
      .addDropdown((dropdown) => dropdown
        .addOption("theme", "Obsidian theme")
        .addOption("solid", "Solid color")
        .addOption("gradient", "Gradient")
        .addOption("image", "Image")
        .setValue(appearance.background.type)
        .onChange((value) => this.update({ background: { type: value } }, true)));

    if (appearance.background.type === "solid") {
      new Setting(this.contentEl).setName("Background color").addColorPicker((picker) => picker
        .setValue(appearance.background.color)
        .onChange((value) => this.update({ background: { color: value } })));
    }
    if (appearance.background.type === "gradient") {
      new Setting(this.contentEl).setName("Gradient start").addColorPicker((picker) => picker
        .setValue(appearance.background.gradientStart)
        .onChange((value) => this.update({ background: { gradientStart: value } })));
      new Setting(this.contentEl).setName("Gradient end").addColorPicker((picker) => picker
        .setValue(appearance.background.gradientEnd)
        .onChange((value) => this.update({ background: { gradientEnd: value } })));
    }
    if (appearance.background.type === "image") {
      const imageSetting = new Setting(this.contentEl)
        .setName("Background image")
        .setDesc(appearance.background.imagePath ? appearance.background.imagePath.split("/").pop() : "No image selected")
        .addButton((button) => button.setButtonText("From vault").onClick(() => {
          new VaultBackgroundSuggestModal(this.app, async (file) => {
            await this.update({ background: { imageSource: "vault", imagePath: file.path, imageFit: "original" } }, true);
          }).open();
        }))
        .addButton((button) => button.setButtonText("From computer").setCta().onClick(() => this.chooseComputerImage()));
      if (appearance.background.imagePath) {
        imageSetting.addButton((button) => button.setButtonText("Clear").onClick(() => this.update({ background: { imagePath: "" } }, true)));
      }
      new Setting(this.contentEl)
        .setName("Image fit")
        .setDesc("Cover fills the board without stretching the image; edges may be cropped.")
        .addDropdown((dropdown) => dropdown
          .addOption("original", "Original size — no enlargement")
          .addOption("cover", "Cover — fill board and crop edges")
          .addOption("contain", "Contain — show complete image")
          .addOption("repeat", "Repeat at original size")
          .setValue(appearance.background.imageFit)
          .onChange((value) => this.update({ background: { imageFit: value } })));
      new Setting(this.contentEl)
        .setName("Image darkening")
        .addSlider((slider) => slider.setLimits(0, 0.85, 0.05)
          .setValue(appearance.background.overlayOpacity).setDynamicTooltip()
          .onChange((value) => this.update({ background: { overlayOpacity: value } })));
    }

    new Setting(this.contentEl).setName("Cards").setHeading();
    let cardColor = null;
    new Setting(this.contentEl).setName("Use theme card color").addToggle((toggle) => toggle
      .setValue(appearance.cards.useTheme).onChange(async (value) => {
        await this.update({ cards: { useTheme: value } });
        if (cardColor) cardColor.setDisabled(value);
      }));
    new Setting(this.contentEl).setName("Card color").addColorPicker((picker) => {
      cardColor = picker;
      picker.setValue(appearance.cards.background).setDisabled(appearance.cards.useTheme)
        .onChange((value) => this.update({ cards: { background: value } }));
    });
    new Setting(this.contentEl).setName("Hover color").setDesc("Card color while the pointer is over it.")
      .addColorPicker((picker) => picker.setValue(appearance.cards.hoverBackground)
        .onChange((value) => this.update({ cards: { hoverBackground: value } })));
    new Setting(this.contentEl).setName("Vertical spacing").setDesc("Space between cards inside each list.")
      .addSlider((slider) => slider.setLimits(0, 28, 1).setValue(appearance.cards.verticalGap).setDynamicTooltip()
        .onChange((value) => this.update({ cards: { verticalGap: value } })));
    new Setting(this.contentEl).setName("Title size").addSlider((slider) => slider
      .setLimits(12, 30, 1).setValue(appearance.cards.titleSize).setDynamicTooltip()
      .onChange((value) => this.update({ cards: { titleSize: value } })));

    new Setting(this.contentEl).setName("Labels").setHeading();
    new Setting(this.contentEl)
      .setName("Label display")
      .setDesc("Choose when card labels reveal their names.")
      .addDropdown((dropdown) => dropdown
        .addOption("compact", "Always compact")
        .addOption("expanded", "Always expanded")
        .addOption("hover", "Expand hovered label")
        .addOption("card-hover", "Expand when card is hovered")
        .setValue(appearance.labels.displayMode)
        .onChange((value) => this.update({ labels: { displayMode: value } })));

    new Setting(this.contentEl).setName("Columns").setHeading();
    let columnColor = null;
    new Setting(this.contentEl).setName("Use theme list color").addToggle((toggle) => toggle
      .setValue(appearance.lists.useTheme).onChange(async (value) => {
        await this.update({ lists: { useTheme: value } });
        if (columnColor) columnColor.setDisabled(value);
      }));
    new Setting(this.contentEl).setName("Column color").addColorPicker((picker) => {
      columnColor = picker;
      picker.setValue(appearance.lists.background).setDisabled(appearance.lists.useTheme)
        .onChange((value) => this.update({ lists: { background: value } }));
    });
    new Setting(this.contentEl).setName("Column spacing").addSlider((slider) => slider
      .setLimits(0, 40, 1).setValue(appearance.lists.columnGap).setDynamicTooltip()
      .onChange((value) => this.update({ lists: { columnGap: value } })));
    new Setting(this.contentEl).setName("Top border thickness").addSlider((slider) => slider
      .setLimits(0, 12, 1).setValue(appearance.lists.topBorderWidth).setDynamicTooltip()
      .onChange((value) => this.update({ lists: { topBorderWidth: value } })));
    new Setting(this.contentEl).setName("Show color dot").addToggle((toggle) => toggle
      .setValue(appearance.lists.showColorDot)
      .onChange((value) => this.update({ lists: { showColorDot: value } })));

    new Setting(this.contentEl).setName("Layout and typography").setHeading();
    new Setting(this.contentEl).setName("Content contrast").addDropdown((dropdown) => dropdown
      .addOption("theme", "Follow Obsidian theme").addOption("dark", "Light text").addOption("light", "Neutral dark text")
      .setValue(appearance.colorScheme).onChange((value) => this.update({ colorScheme: value })));
    new Setting(this.contentEl).setName("Density").addDropdown((dropdown) => dropdown
      .addOption("compact", "Compact").addOption("normal", "Normal").addOption("comfortable", "Comfortable")
      .setValue(appearance.density).onChange((value) => this.update({ density: value })));
    new Setting(this.contentEl).setName("Text scale").addSlider((slider) => slider
      .setLimits(0.85, 1.4, 0.05).setValue(appearance.fontScale).setDynamicTooltip()
      .onChange((value) => this.update({ fontScale: value })));
    new Setting(this.contentEl).setName("Card corners").addSlider((slider) => slider
      .setLimits(0, 24, 1).setValue(appearance.cards.borderRadius).setDynamicTooltip()
      .onChange((value) => this.update({ cards: { borderRadius: value } })));
    new Setting(this.contentEl).setName("Column corners").addSlider((slider) => slider
      .setLimits(0, 24, 1).setValue(appearance.lists.borderRadius).setDynamicTooltip()
      .onChange((value) => this.update({ lists: { borderRadius: value } })));
    new Setting(this.contentEl).setName("Card shadow").addDropdown((dropdown) => dropdown
      .addOption("none", "None").addOption("small", "Small").addOption("medium", "Medium").addOption("large", "Large")
      .setValue(appearance.cards.shadow).onChange((value) => this.update({ cards: { shadow: value } })));
    new Setting(this.contentEl).setName("Animations").addToggle((toggle) => toggle
      .setValue(appearance.motion.enabled).onChange((value) => this.update({ motion: { enabled: value } })));

    const actions = createElement("div", "ot-modal-actions");
    const reset = createElement("button", "mod-warning", "Reset this board");
    const close = createElement("button", "mod-cta", "Done");
    reset.type = "button";
    close.type = "button";
    reset.addEventListener("click", async () => {
      await this.plugin.applyBoardAppearancePreset(this.boardId, "obsidian");
      this.render();
    });
    close.addEventListener("click", () => this.close());
    actions.append(reset, close);
    this.contentEl.append(actions);
    if (preserveScroll) requestAnimationFrame(() => { this.contentEl.scrollTop = scrollTop; });
  }
}

module.exports = {
  BoardAppearanceModal,
};
