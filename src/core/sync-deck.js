const { Notice } = require("obsidian");

// Sync Deck integration: plugin bridge, board presence, card edit locks,
// vault members, and the free-plan board gate.

// Sync Deck's public bridge namespace is stable and independent from this plugin's display name.
const SYNC_DECK_BOARD_NAMESPACE = ["task", "deck"].join("");

const syncDeckMethods = {
  isSyncDeckEnabled() {
    return this.data.syncDeckEnabled !== false;
  },

  async setSyncDeckEnabled(enabled) {
    this.data.syncDeckEnabled = !!enabled;
    if (!enabled) {
      this.cardLocks = new Map();
      this.editingCardId = null;
    }
    await this.saveData(this.data);
    this.refreshViews();
  },

  getSyncDeckPlugin() {
    if (!this.isSyncDeckEnabled()) return null;
    const plugins = this.app.plugins && this.app.plugins.plugins;
    return (plugins && plugins["sync-deck"]) || null;
  },

  // Open the Sync Deck panel (cloud sync for boards + vaults). If Sync Deck isn't
  // installed, point the user at it.
  async openSyncDeck() {
    const syncDeck = this.getSyncDeckPlugin();
    if (!syncDeck || typeof syncDeck.activateView !== "function") {
      new Notice("Install the Sync Deck plugin to sync your boards and vaults across devices.");
      return;
    }
    try {
      await syncDeck.activateView();
    } catch (error) {
      new Notice("Could not open Sync Deck.");
    }
  },

  isNewerVersion(candidate, current) {
    const parts = (value) => String(value || "0").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    const a = parts(candidate);
    const b = parts(current);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  },

  // Free Sync Deck accounts can only sync a limited number of boards. The gate
  // applies ONLY when Sync Deck is installed AND signed in AND on the free plan,
  // so a standalone Kanux (no cloud account) stays unlimited. Pro or an
  // unset/null limit => unlimited. Existing boards are never removed; only NEW
  // board creation past the limit is blocked.
  boardGate() {
    const syncDeck = this.getSyncDeckPlugin();
    const sd = syncDeck && syncDeck.data;
    // The board limit only applies to SYNCED boards: it bites only when the user
    // is signed in AND actively syncing on the free plan. Not syncing (sync off
    // or no Sync Deck account) => unlimited local boards.
    if (!sd || !sd.signedIn || !sd.syncEnabled) return { limited: false, limit: null };
    const limit = sd.boardLimit;
    if (sd.plan === "pro" || limit === null || limit === undefined || !Number.isFinite(Number(limit))) {
      return { limited: false, limit: null };
    }
    return { limited: true, limit: Number(limit) };
  },

  // True (and warns) when the free board limit is already reached.
  boardLimitReached(notify) {
    const gate = this.boardGate();
    if (!gate.limited || this.data.boards.length < gate.limit) return false;
    if (notify) {
      new Notice(`While syncing, the free plan covers ${gate.limit} board${gate.limit === 1 ? "" : "s"}. Upgrade Sync Deck to Pro to sync more.`);
    }
    return true;
  },

  getSyncDeckBridge() {
    const syncDeck = this.getSyncDeckPlugin();
    const data = syncDeck && syncDeck.data;
    if (!syncDeck || typeof syncDeck.api !== "function") return null;
    if (!data || !data.signedIn || !data.authToken || !data.vaultId) return null;
    return syncDeck;
  },

  // Assignable users = the SyncDeck vault members. Empty when SyncDeck is not
  // installed/signed in (the assignee UI then just shows nothing to assign).
  getVaultMembers() {
    const syncDeck = this.getSyncDeckPlugin();
    const members = syncDeck && syncDeck.data && syncDeck.data.members;
    if (!Array.isArray(members)) return [];
    return members
      .filter((m) => m && m.email)
      .map((m) => ({ email: m.email, name: m.name || m.email, color: m.color || "#8b5cf6", picture: m.picture || "" }));
  },

  // The avatar picture for an assignee, resolved live from SyncDeck (not stored
  // in the card frontmatter, since the URL can change/expire).
  getMemberPicture(email) {
    const member = this.getVaultMembers().find((m) => m.email === email);
    return (member && member.picture) || "";
  },

  // Presence responses carry both the cursor roster (users) and the card-lock
  // roster (locks). Both helpers return { users, locks } on success, an empty
  // object-shaped roster when the bridge is unavailable (a real "nobody here"),
  // or null on a transient error so callers keep their last known state.
  async sendBoardPresence(board, point) {
    const syncDeck = this.getSyncDeckBridge();
    if (!syncDeck || !board || !point) return { users: [], locks: [] };

    try {
      const encrypted = syncDeck.activeEncryptionVersion && syncDeck.activeEncryptionVersion() === 1;
      const boardToken = encrypted ? await syncDeck.blindPresenceId(`${SYNC_DECK_BOARD_NAMESPACE}-board`, board.id) : board.id;
      const result = await syncDeck.api(`/vaults/${encodeURIComponent(syncDeck.data.vaultId)}/${SYNC_DECK_BOARD_NAMESPACE}/presence`, {
        method: "POST",
        body: {
          boardId: boardToken,
          ...(!encrypted ? { boardName: board.name } : {}),
          x: point.x,
          y: point.y,
          color: syncDeck.data.user.color || "#8b5cf6",
        },
      });
      return { users: result.users || [], locks: await this.decodeSyncDeckLocks(syncDeck, result.locks, board.id) };
    } catch (error) {
      return null;
    }
  },

  async fetchBoardPresence(boardId) {
    const syncDeck = this.getSyncDeckBridge();
    if (!syncDeck || !boardId) return { users: [], locks: [] };

    try {
      const encrypted = syncDeck.activeEncryptionVersion && syncDeck.activeEncryptionVersion() === 1;
      const boardToken = encrypted ? await syncDeck.blindPresenceId(`${SYNC_DECK_BOARD_NAMESPACE}-board`, boardId) : boardId;
      const result = await syncDeck.api(`/vaults/${encodeURIComponent(syncDeck.data.vaultId)}/${SYNC_DECK_BOARD_NAMESPACE}/presence?boardId=${encodeURIComponent(boardToken)}`);
      return { users: result.users || [], locks: await this.decodeSyncDeckLocks(syncDeck, result.locks, boardId) };
    } catch (error) {
      return null;
    }
  },

  // Card edit locks ---------------------------------------------------------

  async postCardLock(boardId, cardId, action) {
    const syncDeck = this.getSyncDeckBridge();
    if (!syncDeck || !boardId || !cardId) return null;
    try {
      const encrypted = syncDeck.activeEncryptionVersion && syncDeck.activeEncryptionVersion() === 1;
      const boardToken = encrypted ? await syncDeck.blindPresenceId(`${SYNC_DECK_BOARD_NAMESPACE}-board`, boardId) : boardId;
      const cardToken = encrypted ? await syncDeck.blindPresenceId(`${SYNC_DECK_BOARD_NAMESPACE}-card`, cardId) : cardId;
      const result = await syncDeck.api(`/vaults/${encodeURIComponent(syncDeck.data.vaultId)}/${SYNC_DECK_BOARD_NAMESPACE}/lock`, {
        method: "POST",
        body: {
          boardId: boardToken,
          cardId: cardToken,
          action,
          color: syncDeck.data.user.color || "#8b5cf6",
        },
      });
      const locks = await this.decodeSyncDeckLocks(syncDeck, result.locks, boardId);
      let lock = result.lock || null;
      if (lock && encrypted) lock = Object.assign({}, lock, { cardId });
      return Object.assign({}, result, { locks, ...(lock ? { lock } : {}) });
    } catch (error) {
      return null;
    }
  },

  async decodeSyncDeckLocks(syncDeck, locks, boardId) {
    if (!Array.isArray(locks)) return [];
    const encrypted = syncDeck.activeEncryptionVersion && syncDeck.activeEncryptionVersion() === 1;
    if (!encrypted) return locks;
    const board = boardId ? this.findBoard(boardId) : null;
    const boardCardIds = new Set(
      board ? board.lists.flatMap((list) => Array.isArray(list.cardIds) ? list.cardIds : []) : []
    );
    const cards = Object.values(this.data.cards || {}).filter(
      (card) => !boardId || card.boardId === boardId || boardCardIds.has(card.id)
    );
    const pairs = await Promise.all(cards.map(async (card) => [
      await syncDeck.blindPresenceId(`${SYNC_DECK_BOARD_NAMESPACE}-card`, card.id),
      card.id,
    ]));
    const ids = new Map(pairs);
    return locks
      .map((lock) => lock && ids.has(lock.cardId)
        ? Object.assign({}, lock, { cardId: ids.get(lock.cardId) })
        : null)
      .filter(Boolean);
  },

  // Try to take the lock for a card. Returns { ok, lock } — ok:false means
  // someone else holds it (lock describes the holder). null means offline: we
  // fail open so a server hiccup never blocks local editing.
  async acquireCardLock(boardId, cardId) {
    const result = await this.postCardLock(boardId, cardId, "acquire");
    if (!result) return { ok: true, offline: true };
    if (Array.isArray(result.locks)) this.setCardLocks(result.locks);
    return result;
  },

  async releaseCardLock(boardId, cardId) {
    const result = await this.postCardLock(boardId, cardId, "release");
    if (result && Array.isArray(result.locks)) this.setCardLocks(result.locks);
    return result;
  },

  setCardLocks(locks) {
    const next = new Map();
    (locks || []).forEach((lock) => {
      if (lock && lock.cardId) next.set(lock.cardId, lock);
    });
    this.cardLocks = next;
  },

  // The holder if this card is being edited by someone else, otherwise null.
  getCardLockHolder(cardId) {
    if (!this.isSyncDeckEnabled()) return null;
    return (this.cardLocks && this.cardLocks.get(cardId)) || null;
  },
};

module.exports = { syncDeckMethods };
