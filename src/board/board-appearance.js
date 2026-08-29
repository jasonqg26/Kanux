// Applies the active appearance (density, colors, background, motion) to the
// board root element as CSS variables, classes, and background properties.

const BOARD_DENSITY = {
  compact: { listWidth: 258, listMinWidth: 244, cardPadding: "7px 8px" },
  normal: { listWidth: 292, listMinWidth: 272, cardPadding: "9px 10px" },
  comfortable: { listWidth: 326, listMinWidth: 300, cardPadding: "12px" },
};
const CARD_SHADOWS = {
  none: "none",
  small: "0 1px 2px rgb(0 0 0 / 16%)",
  medium: "0 2px 4px rgb(0 0 0 / 24%), 0 1px 1px rgb(0 0 0 / 16%)",
  large: "0 6px 16px rgb(0 0 0 / 32%), 0 2px 4px rgb(0 0 0 / 22%)",
};
const BOARD_BACKGROUND_PROPERTIES = [
  "background-image",
  "background-color",
  "background-size",
  "background-position",
  "background-repeat",
  "background-attachment",
];

const boardAppearanceMethods = {
  applyAppearance() {
    const root = this.contentEl;
    const appearance = this.plugin.getAppearance();
    this.applyAppearanceVariables(root, appearance);
    this.applyAppearanceClasses(root, appearance);
    this.applyBoardBackground(root, appearance.background);
  },

  applyAppearanceVariables(root, appearance) {
    const density = BOARD_DENSITY[appearance.density] || BOARD_DENSITY.normal;
    root.style.setProperty("--ot-font-scale", String(appearance.fontScale));
    root.style.setProperty("--ot-list-width", `${density.listWidth}px`);
    root.style.setProperty("--ot-list-min-width", `${density.listMinWidth}px`);
    root.style.setProperty("--ot-card-padding", density.cardPadding);
    root.style.setProperty("--ot-card-gap", `${appearance.cards.verticalGap}px`);
    root.style.setProperty("--ot-card-radius", `${appearance.cards.borderRadius}px`);
    root.style.setProperty("--ot-card-hover-background", appearance.cards.hoverBackground);
    root.style.setProperty("--ot-card-title-size", `${appearance.cards.titleSize}px`);
    root.style.setProperty("--ot-column-gap", `${appearance.lists.columnGap}px`);
    root.style.setProperty("--ot-list-top-border-width", `${appearance.lists.topBorderWidth}px`);
    root.style.setProperty("--ot-list-radius", `${appearance.lists.borderRadius}px`);
    root.style.setProperty("--ot-card-shadow", CARD_SHADOWS[appearance.cards.shadow] || CARD_SHADOWS.medium);
    root.style.setProperty("--ot-card-background", appearance.cards.useTheme
      ? "color-mix(in srgb, var(--background-primary-alt, var(--background-primary)) 88%, var(--background-modifier-hover) 12%)"
      : appearance.cards.background);
    root.style.setProperty("--ot-list-background", appearance.lists.useTheme
      ? "color-mix(in srgb, var(--background-secondary) 96%, var(--background-primary) 4%)"
      : appearance.lists.background);
  },

  applyAppearanceClasses(root, appearance) {
    root.classList.toggle("is-motion-disabled", !appearance.motion.enabled);
    root.classList.toggle("is-appearance-dark", appearance.colorScheme === "dark");
    root.classList.toggle("is-appearance-light", appearance.colorScheme === "light");
    root.classList.toggle("is-surfaces-dark", appearance.surfaceScheme === "dark");
    root.classList.toggle("is-surfaces-light", appearance.surfaceScheme === "light");
    root.classList.toggle("is-list-color-dot-hidden", !appearance.lists.showColorDot);
  },

  applyBoardBackground(root, background) {
    BOARD_BACKGROUND_PROPERTIES.forEach((property) => root.style.removeProperty(property));
    if (background.type === "solid") {
      root.style.setProperty("background-color", background.color, "important");
      return;
    }
    if (background.type === "gradient") {
      root.style.setProperty("background-color", background.gradientEnd, "important");
      root.style.setProperty("background-image", `linear-gradient(135deg, ${background.gradientStart}, ${background.gradientEnd})`);
      return;
    }
    if (background.type === "image" && background.imagePath) {
      this.applyImageBoardBackground(root, background);
      return;
    }
    root.style.setProperty("background-color", "var(--background-primary)", "important");
  },

  applyImageBoardBackground(root, background) {
    const resourcePath = this.plugin.getAppearanceBackgroundResource(background);
    root.style.setProperty("background-color", "var(--background-primary)", "important");
    if (!resourcePath) return;
    const resource = resourcePath.replace(/"/g, "\\\"");
    const imageSize = ["repeat", "original"].includes(background.imageFit) ? "auto" : background.imageFit;
    const overlay = `linear-gradient(rgb(0 0 0 / ${background.overlayOpacity}), rgb(0 0 0 / ${background.overlayOpacity}))`;
    root.style.setProperty("background-image", `${overlay}, url("${resource}")`);
    root.style.setProperty("background-position", "center, center");
    root.style.setProperty("background-size", `auto, ${imageSize}`);
    root.style.setProperty("background-repeat", background.imageFit === "repeat" ? "no-repeat, repeat" : "no-repeat, no-repeat");
    root.style.setProperty("background-attachment", "local");
  },
};

module.exports = { boardAppearanceMethods };
