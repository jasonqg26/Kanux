const { Notice, Plugin, addIcon } = require("obsidian");

// Plugin entry point: Obsidian lifecycle, commands, the undo stack, and view
// refresh. Everything else lives in the src/core/ modules mixed into the
// prototype below (see docs/ARCHITECTURE.md).
const { KANUX_ICON, KANUX_ICON_SVG, VIEW_TYPE } = require("./helpers");
const { BoardView } = require("./board-view");
const { KanuxSettingTab } = require("./settings/settings-tab");
const { appearanceMethods } = require("./core/appearance");
const { boardIndexMethods } = require("./core/board-index");
const { boardOpsMethods } = require("./core/board-ops");
const { cardDependencyMethods } = require("./core/card-dependencies");
const { cardFileMethods } = require("./core/card-files");
const { cardOpsMethods } = require("./core/card-ops");
const { pluginDataMethods } = require("./core/plugin-data");
const { syncDeckMethods } = require("./core/sync-deck");
const { vaultDecorationMethods } = require("./core/vault-decorations");
const { vaultSyncMethods } = require("./core/vault-sync");

/**
 * Main plugin controller.
 *
 * The board state is saved with Obsidian's plugin data API, while every card is
 * mirrored as a Markdown note. UI code calls this class for all mutations so
 * the JSON data and the Markdown files stay in sync.
 */
class KanuxPlugin extends Plugin {
  async onload() {
    // In-memory load only (reads data.json + normalizes) so this.data exists for
    // the board view. Heavy vault I/O is deferred to onLayoutReady below.
    await this.loadPluginData();

    // Live "someone else is editing this card" locks, keyed by card id. Filled
    // from the SyncDeck presence roster; read by the board and the card modal.
    this.cardLocks = new Map();
    this.editingCardId = null;

    // The exact Markdown we last read from (or wrote to) each card file, keyed by
    // card id. writeCardFile compares against it so a note another device just
    // delivered is never clobbered by our (possibly stale) in-memory card.
    this.diskSignatures = new Map();
    // Same optimistic-concurrency guard for each board's generated index file, so
    // a stale startup rewrite never reverts an index Sync Deck just pulled in
    // (boardId -> the exact index Markdown we last read from / wrote to disk).
    this.indexSignatures = new Map();
    this.pendingResync = false;
    this.resyncTimer = null;

    // Undo stack for board/table edits (Cmd/Ctrl+Z). Each user mutation records an
    // async inverse; undoLast() pops and runs it. applyingUndo suppresses
    // re-recording while an inverse runs (so it never loops).
    this.undoStack = [];
    this.applyingUndo = false;

    addIcon(KANUX_ICON, KANUX_ICON_SVG);
    this.registerView(VIEW_TYPE, (leaf) => new BoardView(leaf, this));
    this.addSettingTab(new KanuxSettingTab(this.app, this));
    ["create", "modify", "rename", "delete"].forEach((eventName) => {
      this.registerEvent(this.app.vault.on(eventName, (file) => this.queueCardFolderSync(file, eventName)));
    });

    // Reconcile card notes AFTER the workspace + metadata cache are ready, and
    // never let it reject onload(): a startup file error used to crash onload and
    // leave the plugin disabled until manually toggled off/on on every restart.
    this.app.workspace.onLayoutReady(() => {
      this.reconcileVaultFiles().catch((error) => {
        console.error("Kanux: startup vault reconcile failed", error);
        new Notice("Kanux loaded, but reconciling notes hit an error. Your boards are intact.");
      });
    });

    // Boards sync themselves: vault events reconcile on change, and this periodic
    // safety net re-imports every ~30s so remote edits (pulled by Sync Deck) show
    // up even if an event is missed. Skipped while reconciling or editing a card,
    // so it never disrupts the user. The manual "Sync" button still works too.
    this.registerInterval(window.setInterval(() => {
      if (this.reconciling || this.editingCardId) return;
      const before = JSON.stringify(this.data.boards);
      Promise.resolve(this.syncCardsFromFolder())
        .then(() => { if (JSON.stringify(this.data.boards) !== before) this.refreshViews(); })
        .catch(() => {});
    }, 30000));

    this.addRibbonIcon(KANUX_ICON, "Open Kanux", () => this.activateView());
    this.addCommand({
      id: "open-board",
      name: "Open board",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "add-card-to-first-list",
      name: "Add card to first list",
      callback: async () => {
        const board = this.getBoard();
        const firstList = board && board.lists[0];
        if (firstList) {
          await this.addCard(firstList.id);
        } else if (!board) {
          new Notice("Create a board first.");
        } else {
          new Notice("Add a list first.");
        }
      },
    });
    this.addCommand({
      id: "undo-last-change",
      name: "Undo last change",
      callback: () => this.undoLast(),
    });
    // Cmd/Ctrl+Z undoes the last board/table edit — but only while a Kanux
    // board is the active view and the focus isn't in a text field (so it never
    // steals undo from note editing or an input).
    this.registerDomEvent(document, "keydown", (event) => {
      if ((event.key !== "z" && event.key !== "Z") || event.shiftKey || event.altKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!this.app.workspace.getActiveViewOfType(BoardView)) return;
      if (!this.undoStack.length) return;
      event.preventDefault();
      this.undoLast();
    });
  }

  async onunload() {
    if (this.explorerColorStyleEl) this.explorerColorStyleEl.remove();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  recordUndo(inverse) {
    if (this.applyingUndo) return;
    this.undoStack.push(inverse);
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  async undoLast() {
    if (this.applyingUndo) return; // ignore a second Cmd+Z while one undo is in flight
    const inverse = this.undoStack.pop();
    if (!inverse) { new Notice("Nothing to undo"); return; }
    this.applyingUndo = true;
    try {
      await inverse();
      new Notice("Undone");
    } catch (error) {
      console.error("Kanux undo failed", error);
      new Notice("Couldn't undo that change.");
    } finally {
      this.applyingUndo = false;
    }
  }

  async savePluginData() {
    await this.writeBoardIndexFiles();
    await this.syncGraphColorGroups();
    await this.saveData(this.data);
  }

  refreshViews() {
    this.updateExplorerColors();
    // While a card modal is editing, each debounced save would repaint the
    // board views behind it — a visible background flash on every typing
    // pause. Freeze them and flush one refresh when the modal closes.
    if (this.editingCardId) {
      this.viewRefreshPending = true;
      return;
    }
    this.viewRefreshPending = false;
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (!leaf.view || !leaf.view.render) return;
      if (leaf.view.shouldDeferRefresh && leaf.view.shouldDeferRefresh()) return;
      leaf.view.render();
    });
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = leaves[0] || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}

Object.assign(
  KanuxPlugin.prototype,
  appearanceMethods,
  boardIndexMethods,
  boardOpsMethods,
  cardDependencyMethods,
  cardFileMethods,
  cardOpsMethods,
  pluginDataMethods,
  syncDeckMethods,
  vaultDecorationMethods,
  vaultSyncMethods
);

module.exports = KanuxPlugin;
