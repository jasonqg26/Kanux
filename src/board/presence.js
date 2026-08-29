// Live board presence (SyncDeck cursors) and the card-lock badge overlay.
// The transport stays plain HTTP polling; smoothness comes from client-side
// interpolation rather than a faster/heavier network loop.
const { createElement } = require("../helpers");

const PRESENCE_SEND_INTERVAL_MS = 110; // min gap between outbound position posts while moving
const PRESENCE_POLL_ACTIVE_MS = 260; // GET poll while other cursors are on the board
const PRESENCE_POLL_IDLE_MS = 1100; // GET poll when nobody else is present
const PRESENCE_HEARTBEAT_MS = 3000; // resend our own point so the server TTL never expires us
const PRESENCE_SMOOTHING_TAU_MS = 70; // interpolation time constant; lower = snappier, higher = smoother
const PRESENCE_SNAP_DISTANCE = 0.0006; // normalized distance under which we snap instead of easing

const presenceMethods = {
  startPresence(board) {
    if (!this.plugin.getSyncDeckBridge()) return;

    this.presenceBoard = board;
    this.presencePoint = { x: 0.5, y: 0.08 };
    this.presenceUsers = new Map();
    this.presenceSendInFlight = false;
    this.presenceDirty = false;
    this.lastPresenceSendAt = 0;
    this.presenceRafId = null;
    this.presenceLastFrame = null;
    this.presenceTrailTimer = null;
    // Monotonic session id. render() calls stopPresence()+startPresence() on every
    // board re-render, so responses from an in-flight request can land after a new
    // session started. Every async callback carries the gen it was issued under and
    // no-ops if it no longer matches, so a stale response can never touch live state.
    this.presenceGen = (this.presenceGen || 0) + 1;
    const gen = this.presenceGen;
    // Board-owned copy of the lock roster used purely as the badge-diff baseline.
    // It must NOT be plugin.cardLocks, which an open card modal rewrites out of
    // band (acquire/release/heartbeat) and would desync the diff into ghost badges.
    this.lockUiState = new Map(this.plugin.cardLocks || []);
    if (!this.presenceTickBound) this.presenceTickBound = (now) => this.presenceTick(now);

    this.presenceLayer = createElement("div", "ot-presence-layer");
    this.contentEl.append(this.presenceLayer);

    this.presenceMouseHandler = (event) => {
      const rect = this.presenceLayer.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      this.presencePoint = { x, y };
      this.sendPresence();
    };
    this.contentEl.addEventListener("pointermove", this.presenceMouseHandler);

    this.presenceHeartbeatTimer = window.setInterval(() => this.sendPresence(true), PRESENCE_HEARTBEAT_MS);
    this.sendPresence(true);
    this.pollPresence(gen);
  },

  stopPresence() {
    // Invalidate the current session so any request still in flight becomes a no-op
    // when it resolves, even if no new session starts afterwards (e.g. onClose).
    this.presenceGen = (this.presenceGen || 0) + 1;
    if (this.presenceMouseHandler && this.contentEl) {
      this.contentEl.removeEventListener("pointermove", this.presenceMouseHandler);
    }
    if (this.presencePollTimer) window.clearTimeout(this.presencePollTimer);
    if (this.presenceHeartbeatTimer) window.clearInterval(this.presenceHeartbeatTimer);
    if (this.presenceTrailTimer) window.clearTimeout(this.presenceTrailTimer);
    if (this.presenceRafId != null) cancelAnimationFrame(this.presenceRafId);
    if (this.presenceLayer && this.presenceLayer.parentElement) this.presenceLayer.remove();
    this.presenceMouseHandler = null;
    this.presencePollTimer = null;
    this.presenceHeartbeatTimer = null;
    this.presenceTrailTimer = null;
    this.presenceRafId = null;
    this.presenceLayer = null;
    this.presenceBoard = null;
    this.presencePoint = null;
    this.presenceUsers = null;
    this.lockUiState = null;
    this.presenceSendInFlight = false;
    this.presenceDirty = false;
  },

  // Post our own cursor position. Sends are coalesced: while a request is in
  // flight or we are inside the throttle window, we only mark the state dirty
  // and flush the latest point afterwards so the resting position always lands.
  sendPresence(force = false) {
    if (!this.presenceBoard || !this.presencePoint) return;
    this.presenceDirty = true;
    this.flushPresence(force);
  },

  flushPresence(force = false) {
    if (!this.presenceBoard || !this.presenceDirty || this.presenceSendInFlight) return;

    const now = Date.now();
    const sinceLast = now - (this.lastPresenceSendAt || 0);
    if (!force && sinceLast < PRESENCE_SEND_INTERVAL_MS) {
      if (!this.presenceTrailTimer) {
        this.presenceTrailTimer = window.setTimeout(() => {
          this.presenceTrailTimer = null;
          this.flushPresence();
        }, PRESENCE_SEND_INTERVAL_MS - sinceLast);
      }
      return;
    }

    if (this.presenceTrailTimer) {
      window.clearTimeout(this.presenceTrailTimer);
      this.presenceTrailTimer = null;
    }
    const gen = this.presenceGen;
    this.lastPresenceSendAt = now;
    this.presenceDirty = false;
    this.presenceSendInFlight = true;
    this.plugin.sendBoardPresence(this.presenceBoard, this.presencePoint)
      .then((result) => this.applyPresenceResult(result, gen))
      .catch(() => {})
      .finally(() => {
        if (gen !== this.presenceGen) return; // superseded session: leave the new one untouched
        this.presenceSendInFlight = false;
        if (this.presenceDirty) this.flushPresence();
      });
  },

  // Self-scheduling receive loop. It polls fast while other cursors are present
  // and backs off when alone. GETs are skipped while our own POSTs are already
  // refreshing the roster, to avoid doubling the request rate while moving.
  schedulePresencePoll(gen) {
    if (gen !== this.presenceGen || !this.presenceBoard) return;
    const hasOthers = this.presenceUsers && this.presenceUsers.size > 0;
    const delay = hasOthers ? PRESENCE_POLL_ACTIVE_MS : PRESENCE_POLL_IDLE_MS;
    this.presencePollTimer = window.setTimeout(() => this.pollPresence(gen), delay);
  },

  pollPresence(gen) {
    if (gen !== this.presenceGen || !this.presenceBoard) return;
    const now = Date.now();
    if (now - (this.lastPresenceSendAt || 0) < PRESENCE_POLL_ACTIVE_MS) {
      this.schedulePresencePoll(gen);
      return;
    }
    this.plugin.fetchBoardPresence(this.presenceBoard.id)
      .then((result) => this.applyPresenceResult(result, gen))
      .catch(() => {})
      .finally(() => this.schedulePresencePoll(gen));
  },

  // Split a presence response into its cursor roster and card-lock roster. A
  // null result means a transient error: keep both rosters as-is (no flicker).
  applyPresenceResult(result, gen) {
    if (gen !== this.presenceGen) return;
    if (!result || !Array.isArray(result.users)) return;
    this.applyPresenceSnapshot(result.users, gen);
    this.applyLockSnapshot(Array.isArray(result.locks) ? result.locks : [], gen);
  },

  // Reconcile the card-lock roster into the plugin's lock map, then patch only
  // the cards whose lock state changed so the board is not fully re-rendered.
  applyLockSnapshot(locks, gen) {
    if (gen !== this.presenceGen) return;
    // Keep the plugin's map fresh for the card modal, but diff against our own
    // board-owned baseline so out-of-band modal writes cannot create ghost badges.
    this.plugin.setCardLocks(locks);
    const before = this.lockUiState || new Map();
    const after = new Map();
    (locks || []).forEach((lock) => {
      if (lock && lock.cardId) after.set(lock.cardId, lock);
    });

    const touched = new Set(before.keys());
    after.forEach((_value, cardId) => touched.add(cardId));
    touched.forEach((cardId) => {
      const beforeHolder = before.get(cardId) || null;
      const afterHolder = after.get(cardId) || null;
      const beforeEmail = beforeHolder && beforeHolder.email;
      const afterEmail = afterHolder && afterHolder.email;
      if (beforeEmail !== afterEmail || (beforeHolder && beforeHolder.name) !== (afterHolder && afterHolder.name)) {
        this.applyCardLockUi(cardId, afterHolder);
      }
    });
    this.lockUiState = after;
  },

  // Add/update/remove the lock overlay on a single card element in place.
  applyCardLockUi(cardId, holder) {
    if (!this.contentEl) return;
    const card = this.contentEl.querySelector(`.ot-card[data-card-id="${CSS.escape(cardId)}"]`);
    if (!card) return;
    card.classList.toggle("is-locked", !!holder);
    card.draggable = !holder && this.editingCardId !== cardId;
    const badge = card.querySelector(".ot-card-lock");
    if (badge) badge.remove();
    if (holder) card.append(this.buildLockBadge(holder));
  },

  // Reconcile the incoming roster against the live cursor elements: update
  // targets on existing cursors, create ones that just joined, remove ones that
  // left. Elements are never rebuilt wholesale, so the interpolation survives.
  applyPresenceSnapshot(users, gen) {
    if (gen !== this.presenceGen) return; // response from a superseded session
    if (!this.presenceLayer || !this.presenceUsers) return;
    // A failed request yields null (see plugin.sendBoardPresence/fetchBoardPresence).
    // Only an actual array is an authoritative roster; null means "keep what we have"
    // so a transient network error does not flicker every cursor off and back on.
    if (!Array.isArray(users)) return;
    const list = users;
    const seen = new Set();

    list.forEach((user) => {
      if (!user || !Number.isFinite(user.x) || !Number.isFinite(user.y)) return;
      const key = user.email || user.name;
      if (!key) return;
      seen.add(key);
      const x = Math.max(0, Math.min(1, user.x));
      const y = Math.max(0, Math.min(1, user.y));

      let entry = this.presenceUsers.get(key);
      if (!entry) {
        entry = this.createPresenceCursor();
        entry.cur.x = x;
        entry.cur.y = y;
        this.presenceLayer.append(entry.el);
        this.presenceUsers.set(key, entry);
      }
      entry.target.x = x;
      entry.target.y = y;
      this.updatePresenceCursorMeta(entry, user);
    });

    this.presenceUsers.forEach((entry, key) => {
      if (seen.has(key)) return;
      if (entry.el.parentElement) entry.el.remove();
      this.presenceUsers.delete(key);
    });

    this.ensurePresenceLoop();
  },

  createPresenceCursor() {
    const el = createElement("div", "ot-presence-cursor");
    const arrow = createElement("span", "ot-presence-arrow");
    const label = createElement("span", "ot-presence-name");
    const avatar = createElement("img", "ot-presence-avatar");
    avatar.alt = "";
    avatar.style.display = "none";
    const nameText = createElement("span", "", "");
    label.append(avatar, nameText);
    el.append(arrow, label);
    return {
      el,
      avatarEl: avatar,
      nameTextEl: nameText,
      color: null,
      name: null,
      picture: null,
      cur: { x: 0.5, y: 0.5 },
      target: { x: 0.5, y: 0.5 },
    };
  },

  updatePresenceCursorMeta(entry, user) {
    const color = user.color || "#8b5cf6";
    if (color !== entry.color) {
      entry.color = color;
      entry.el.style.setProperty("--ot-presence-color", color);
    }
    const name = user.name || user.email || "User";
    if (name !== entry.name) {
      entry.name = name;
      entry.nameTextEl.textContent = name;
    }
    const picture = user.picture || "";
    if (picture !== entry.picture) {
      entry.picture = picture;
      if (picture) {
        entry.avatarEl.src = picture;
        entry.avatarEl.style.display = "";
      } else {
        entry.avatarEl.removeAttribute("src");
        entry.avatarEl.style.display = "none";
      }
    }
  },

  ensurePresenceLoop() {
    if (this.presenceRafId != null) return;
    if (!this.presenceUsers || this.presenceUsers.size === 0) return;
    this.presenceLastFrame = null;
    this.presenceRafId = requestAnimationFrame(this.presenceTickBound);
  },

  // Ease every cursor toward its latest network target. Frame-rate independent
  // exponential smoothing keeps motion identical at 60/120Hz; the dt clamp stops
  // a big jump after the tab was backgrounded.
  presenceTick(now) {
    this.presenceRafId = null;
    if (!this.presenceLayer || !this.presenceUsers || this.presenceUsers.size === 0) return;

    let dt = now - (this.presenceLastFrame || now);
    this.presenceLastFrame = now;
    if (!(dt > 0)) dt = 16;
    if (dt > 100) dt = 100;
    const alpha = 1 - Math.exp(-dt / PRESENCE_SMOOTHING_TAU_MS);

    const rect = this.presenceLayer.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const drawable = w > 0 && h > 0;
    let anyMoving = false;

    this.presenceUsers.forEach((entry) => {
      const dx = entry.target.x - entry.cur.x;
      const dy = entry.target.y - entry.cur.y;
      if (Math.abs(dx) < PRESENCE_SNAP_DISTANCE && Math.abs(dy) < PRESENCE_SNAP_DISTANCE) {
        entry.cur.x = entry.target.x;
        entry.cur.y = entry.target.y;
      } else {
        entry.cur.x += dx * alpha;
        entry.cur.y += dy * alpha;
        anyMoving = true;
      }
      if (drawable) {
        entry.el.style.transform = `translate(${(entry.cur.x * w).toFixed(1)}px, ${(entry.cur.y * h).toFixed(1)}px)`;
      }
    });

    // Idle when everything has settled. A new target restarts the loop via
    // ensurePresenceLoop(); until then a motionless board costs zero rAF work.
    // Keep spinning while not yet drawable so cursors still get placed once the
    // view has a size.
    if (anyMoving || !drawable) {
      this.presenceRafId = requestAnimationFrame(this.presenceTickBound);
    }
  },
};

module.exports = { presenceMethods };
