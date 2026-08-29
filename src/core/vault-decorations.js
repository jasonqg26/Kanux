// Vault-wide visual touches derived from board state: list-colored file
// explorer entries and graph color groups per Kanux list tag.
const { cleanColor } = require("../helpers");

const vaultDecorationMethods = {
  updateExplorerColors() {
    if (!this.explorerColorStyleEl) {
      this.explorerColorStyleEl = document.createElement("style");
      this.explorerColorStyleEl.id = "kanux-explorer-colors";
      document.head.append(this.explorerColorStyleEl);
    }

    const escape = (value) => {
      if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
      return String(value).replace(/["\\]/g, "\\$&");
    };
    const rules = Object.values(this.data.cards || {})
      .map((card) => {
        const board = this.findBoard(card.boardId);
        const list = this.findList(card.listId, board);
        const color = cleanColor(list && list.color);
        if (!card.filePath || !color) return "";
        const path = escape(card.filePath);
        return `.nav-file-title[data-path="${path}"]{border-left:3px solid ${color};padding-left:calc(var(--nav-item-padding-left) - 3px);}`;
      })
      .filter(Boolean);

    this.explorerColorStyleEl.textContent = rules.join("\n");
  },

  graphColorGroup(board, list) {
    const tag = this.kanuxTag(board, list);
    const color = cleanColor(list && list.color);
    if (!tag || !color) return null;

    return {
      query: `tag:#${tag}`,
      color: {
        a: 1,
        rgb: parseInt(color.slice(1), 16),
      },
    };
  },

  async syncGraphColorGroups() {
    const adapter = this.app.vault.adapter;
    if (!adapter || !adapter.exists || !adapter.read || !adapter.write) return;

    const graphPath = `${this.app.vault.configDir || ".obsidian"}/graph.json`;
    const exists = await adapter.exists(graphPath);
    const graph = exists ? JSON.parse(await adapter.read(graphPath)) : {};
    const existing = Array.isArray(graph.colorGroups) ? graph.colorGroups : [];
    const keep = existing.filter((group) => !(group && String(group.query || "").startsWith("tag:#kanux/")));
    const kanuxGroups = [];

    this.data.boards.forEach((board) => {
      board.lists.forEach((list) => {
        if (!list.cardIds.length) return;
        const group = this.graphColorGroup(board, list);
        if (group) kanuxGroups.push(group);
      });
    });

    graph["collapse-color-groups"] = false;
    graph.colorGroups = keep.concat(kanuxGroups);
    await adapter.write(graphPath, JSON.stringify(graph, null, 2));
  },
};

module.exports = { vaultDecorationMethods };
