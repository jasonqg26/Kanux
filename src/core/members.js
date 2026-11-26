// Vault members: combines Sync Deck members, vault/settings members stored in
// a syncable Markdown note, and members auto-discovered from cards/checklists.
const {
  DEFAULT_MEMBERS_FILE_PATH,
  MEMBERS_NOTE_MARKER,
  cleanColor,
  imageTarget,
  memberKey,
  normalizeMember,
  parseMembersNote,
  serializeMembersNote,
  textLine,
} = require("../helpers");

function normalizeMembersFilePath(value) {
  const raw = textLine(value).replace(/^\/+|\/+$/g, "");
  if (!raw) return DEFAULT_MEMBERS_FILE_PATH;
  return /\.md$/i.test(raw) ? raw : `${raw}.md`;
}

function normalizeStoredMembers(members) {
  const seen = new Set();
  const result = [];
  (Array.isArray(members) ? members : []).forEach((item) => {
    const member = normalizeMember(item);
    if (!member) return;
    const key = memberKey(member);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(member);
  });
  return result;
}

const memberMethods = {
  getMembersFilePath() {
    return normalizeMembersFilePath(this.data && this.data.membersFilePath);
  },

  isMembersFile(file) {
    return !!(file && file.extension === "md" && file.path === this.getMembersFilePath());
  },

  hasMembersNoteFrontmatter(file) {
    const cache = this.app && this.app.metadataCache && typeof this.app.metadataCache.getFileCache === "function"
      ? this.app.metadataCache.getFileCache(file)
      : null;
    return !!(cache && cache.frontmatter && cache.frontmatter["kanux-members"] === true);
  },

  async findMembersFile() {
    const vault = this.app && this.app.vault;
    if (!vault) return null;
    const preferred = typeof vault.getAbstractFileByPath === "function"
      ? vault.getAbstractFileByPath(this.getMembersFilePath())
      : null;
    if (preferred && preferred.extension === "md") return preferred;
    if (typeof vault.getMarkdownFiles !== "function") return null;

    const markdownFiles = vault.getMarkdownFiles();
    const cachedMatch = markdownFiles.find((file) => this.hasMembersNoteFrontmatter(file));
    if (cachedMatch) return cachedMatch;

    if (typeof vault.read !== "function") return null;
    for (const file of markdownFiles) {
      if (this.boardForFile && this.boardForFile(file)) continue;
      if (file.stat && file.stat.size > 65536) continue;
      try {
        const text = await vault.read(file);
        if (String(text || "").includes(MEMBERS_NOTE_MARKER)) return file;
      } catch (error) {
        // Skip unreadable files while scanning for an adopted members note.
      }
    }
    return null;
  },

  collectCardMembers() {
    const seen = new Set();
    const collected = [];
    const push = (raw) => {
      const member = normalizeMember(raw);
      if (!member) return;
      const key = memberKey(member);
      if (seen.has(key)) return;
      seen.add(key);
      collected.push({ ...member, source: "card" });
    };

    Object.values((this.data && this.data.cards) || {}).forEach((card) => {
      if (!card) return;
      (card.assignees || []).forEach(push);
      (card.checklists || []).forEach((group) => {
        (group && group.items ? group.items : []).forEach((item) => {
          if (item && item.assignee) push(item.assignee);
        });
      });
    });
    return collected;
  },

  getVaultMembers() {
    const merged = new Map();

    this.collectCardMembers().forEach((member) => {
      merged.set(memberKey(member), member);
    });

    normalizeStoredMembers(this.data && this.data.members).forEach((member) => {
      merged.set(memberKey(member), { ...member, source: "vault" });
    });

    const syncDeckMembers = typeof this.getSyncDeckMembers === "function"
      ? this.getSyncDeckMembers()
      : [];
    syncDeckMembers.forEach((raw) => {
      const member = normalizeMember(raw);
      if (!member) return;
      const key = memberKey(member);
      const existing = merged.get(key);
      if (existing && existing.source === "vault") {
        merged.set(key, {
          ...existing,
          picture: existing.picture || member.picture,
          syncDeck: true,
        });
        return;
      }
      merged.set(key, { ...member, source: "sync-deck", syncDeck: true });
    });

    return Array.from(merged.values()).sort((a, b) =>
      String(a.name || a.email).localeCompare(String(b.name || b.email), undefined, { sensitivity: "base" })
    );
  },

  resolveMember(memberOrId) {
    const key = memberKey(memberOrId);
    if (!key) return null;
    const known = this.getVaultMembers().find((member) => memberKey(member) === key);
    if (known) return known;
    return typeof memberOrId === "object"
      ? normalizeMember(memberOrId)
      : normalizeMember({ email: memberOrId, name: memberOrId });
  },

  resolveVaultImageUrl(rawPath) {
    const raw = textLine(rawPath);
    if (!raw) return "";
    if (/^(https?:|data:)/i.test(raw)) return raw;

    const vault = this.app && this.app.vault;
    if (!vault || typeof vault.getResourcePath !== "function") return "";
    const target = imageTarget(raw);
    if (!target) return "";

    let file = typeof vault.getAbstractFileByPath === "function"
      ? vault.getAbstractFileByPath(target)
      : null;
    if (!file && this.app.metadataCache && typeof this.app.metadataCache.getFirstLinkpathDest === "function") {
      try {
        file = this.app.metadataCache.getFirstLinkpathDest(target, "");
      } catch (error) {
        file = null;
      }
    }
    return file && file.path ? vault.getResourcePath(file) : "";
  },

  getMemberPicture(memberOrId) {
    const resolved = this.resolveMember(memberOrId);
    if (!resolved || !resolved.picture) return "";
    return this.resolveVaultImageUrl(resolved.picture);
  },

  async ensureLocalMember(input) {
    const candidate = normalizeMember(typeof input === "string" ? { name: input } : input);
    if (!candidate) return null;

    this.data.members = normalizeStoredMembers(this.data.members);
    const key = memberKey(candidate);
    const existing = this.data.members.find((member) => memberKey(member) === key);
    if (existing) return existing;

    this.data.members.push(candidate);
    await this.writeMembersFile();
    await this.saveData(this.data);
    this.refreshViews();
    return candidate;
  },

  async upsertVaultMember(input, previousKey = "") {
    const candidate = normalizeMember(input);
    if (!candidate) return null;

    this.data.members = normalizeStoredMembers(this.data.members);
    const targetKey = memberKey(previousKey) || memberKey(candidate);
    const nextKey = memberKey(candidate);
    const filtered = this.data.members.filter((member) => {
      const key = memberKey(member);
      return key !== targetKey && key !== nextKey;
    });
    filtered.push(candidate);
    this.data.members = normalizeStoredMembers(filtered);

    const deletedKeys = targetKey && targetKey !== nextKey ? [targetKey] : [];
    await this.writeMembersFile({ force: true, deletedKeys });
    await this.saveData(this.data);
    this.refreshViews();
    return candidate;
  },

  async removeVaultMember(keyOrMember) {
    const targetKey = memberKey(keyOrMember);
    if (!targetKey) return false;

    this.data.members = normalizeStoredMembers(this.data.members);
    const before = this.data.members.length;
    this.data.members = this.data.members.filter((member) => memberKey(member) !== targetKey);
    if (this.data.members.length === before) return false;

    await this.writeMembersFile({ force: true, deletedKeys: [targetKey] });
    await this.saveData(this.data);
    this.refreshViews();
    return true;
  },

  async setMembersFilePath(nextPath) {
    const normalized = normalizeMembersFilePath(nextPath);
    if (normalized === this.getMembersFilePath()) return false;

    this.data.membersFilePath = normalized;
    this.membersFileSignature = null;
    const synced = await this.syncMembersFromVault();
    if (!synced && this.data.members && this.data.members.length) {
      await this.writeMembersFile({ force: true });
    }
    await this.saveData(this.data);
    this.refreshViews();
    return true;
  },

  async syncMembersFromVault() {
    const file = await this.findMembersFile();
    if (!file) return false;

    let changed = false;
    if (file.path !== this.getMembersFilePath()) {
      this.data.membersFilePath = file.path;
      changed = true;
    }

    let markdown = "";
    try {
      markdown = await this.app.vault.read(file);
    } catch (error) {
      return changed;
    }

    this.membersFileSignature = markdown;
    const parsed = parseMembersNote(markdown);
    const current = normalizeStoredMembers(this.data.members);
    if (serializeMembersNote(parsed) !== serializeMembersNote(current)) {
      this.data.members = parsed;
      changed = true;
    }
    return changed;
  },

  async ensureMembersFolder(filePath) {
    const parts = String(filePath || "").split("/").slice(0, -1);
    if (!parts.length || !this.app || !this.app.vault) return;

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current).catch(() => {});
      }
    }
  },

  mergeDiskMembers(diskMembers, deletedKeys = []) {
    const deleted = new Set(deletedKeys.map((key) => memberKey(key)).filter(Boolean));
    const merged = new Map();
    diskMembers.forEach((member) => {
      const key = memberKey(member);
      if (!deleted.has(key)) merged.set(key, member);
    });
    normalizeStoredMembers(this.data.members).forEach((member) => {
      merged.set(memberKey(member), member);
    });
    return Array.from(merged.values());
  },

  async writeMembersFile(options = {}) {
    const vault = this.app && this.app.vault;
    if (!vault) return false;

    const filePath = this.getMembersFilePath();
    const existingFile = typeof vault.getAbstractFileByPath === "function"
      ? vault.getAbstractFileByPath(filePath)
      : null;
    const members = normalizeStoredMembers(this.data && this.data.members);

    if (!options.force && !members.length && !existingFile) return false;

    let nextMembers = members;
    let markdown = serializeMembersNote(nextMembers);

    if (!existingFile) {
      await this.ensureMembersFolder(filePath);
      await vault.create(filePath, markdown);
      this.membersFileSignature = markdown;
      return true;
    }

    let current = null;
    try {
      current = await vault.read(existingFile);
    } catch (error) {
      current = null;
    }
    if (current === markdown) {
      this.membersFileSignature = markdown;
      return false;
    }

    // Preserve external edits delivered by Git/LiveSync when the note changed on disk.
    const changedUnderUs = current !== null
      && this.membersFileSignature !== null
      && current !== this.membersFileSignature;
    if (changedUnderUs) {
      nextMembers = this.mergeDiskMembers(parseMembersNote(current), options.deletedKeys || []);
      this.data.members = normalizeStoredMembers(nextMembers);
      markdown = serializeMembersNote(this.data.members);
      if (current === markdown) {
        this.membersFileSignature = markdown;
        return false;
      }
    }

    await vault.modify(existingFile, markdown);
    this.membersFileSignature = markdown;
    return true;
  },

  normalizeMemberColor(value, seed) {
    return cleanColor(value) || normalizeMember({ email: seed, name: seed }).color;
  },
};

module.exports = { memberMethods, normalizeMembersFilePath, normalizeStoredMembers };
