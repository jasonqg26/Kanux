const { Notice } = require("obsidian");
const {
  DEFAULT_MEMBER_COLOR,
  cleanMemberId,
  createElement,
  initials,
  memberKey,
  pickMemberColor,
  renderIcon,
} = require("../helpers");

let activeMemberPopover = null;

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

/**
 * Builds the circular avatar chip for a member, resolving vault or Sync Deck
 * pictures live and falling back to deterministic colored initials.
 */
function buildMemberAvatarElement(plugin, member) {
  const resolved = plugin && typeof plugin.resolveMember === "function"
    ? (plugin.resolveMember(member) || member || {})
    : (member || {});
  const displayName = resolved.name || resolved.email || "";
  const avatar = createElement("span", "ot-card-avatar");
  avatar.style.setProperty("--ot-avatar-color", resolved.color || DEFAULT_MEMBER_COLOR);
  avatar.title = displayName;

  const picture = plugin && typeof plugin.getMemberPicture === "function"
    ? plugin.getMemberPicture(resolved)
    : "";
  if (picture) {
    const img = createElement("img", "");
    img.src = picture;
    img.alt = "";
    avatar.append(img);
  } else {
    avatar.textContent = initials(displayName);
    avatar.classList.add("is-initials");
  }
  return avatar;
}

function openKanuxMembersSettings(app, plugin) {
  const setting = app && app.setting;
  const pluginId = (plugin && plugin.manifest && plugin.manifest.id) || "kanux";
  if (setting && typeof setting.open === "function") {
    setting.open();
    if (typeof setting.openTabById === "function") setting.openTabById(pluginId);
    return;
  }
  new Notice("Open Settings > Kanux > Members to manage vault members.");
}

function closeMemberPickerPopover() {
  if (!activeMemberPopover) return;
  if (typeof activeMemberPopover._cleanup === "function") activeMemberPopover._cleanup();
  if (typeof activeMemberPopover.remove === "function") activeMemberPopover.remove();
  if (activeMemberPopover._anchor && typeof activeMemberPopover._anchor.setAttribute === "function") {
    activeMemberPopover._anchor.setAttribute("aria-expanded", "false");
  }
  activeMemberPopover = null;
}

function positionPopover(pop, anchor) {
  if (!anchor || typeof anchor.getBoundingClientRect !== "function") return;
  const rect = anchor.getBoundingClientRect();
  const minWidth = Math.max(240, Math.round(rect.width || 0));
  pop.style.top = `${Math.round((rect.bottom || 0) + 4)}px`;
  pop.style.left = `${Math.round(rect.left || 0)}px`;
  pop.style.minWidth = `${minWidth}px`;

  if (typeof pop.getBoundingClientRect !== "function") return;
  const popRect = pop.getBoundingClientRect();
  const vw = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 768;
  const maxLeft = Math.max(8, vw - (popRect.width || minWidth) - 8);
  pop.style.left = `${Math.min(Math.max(8, Math.round(rect.left || 0)), maxLeft)}px`;
  if ((popRect.bottom || 0) > vh - 8) {
    const maxTop = Math.max(8, vh - (popRect.height || 0) - 8);
    pop.style.top = `${Math.max(8, Math.min(Math.round((rect.top || 0) - (popRect.height || 0) - 4), maxTop))}px`;
  }
}

function buildMemberRow({ plugin, member, isSelected, onActivate }) {
  const row = createElement("button", "ot-popover-row ot-member-picker-row");
  row.type = "button";
  const avatar = buildMemberAvatarElement(plugin, member);
  const textWrap = createElement("span", "ot-member-picker-text");
  textWrap.append(createElement("span", "ot-popover-label", member.name || member.email));
  if (member.email && memberKey(member.email) !== memberKey(member.name)) {
    textWrap.append(createElement("span", "ot-member-picker-sub", member.email));
  }
  row.append(avatar, textWrap);

  if (isSelected) {
    const check = createElement("span", "ot-popover-check");
    renderIcon(check, "check");
    row.append(check);
  }
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    onActivate();
  });
  return row;
}

function buildUnassignedRow({ isSelected, onActivate }) {
  const row = createElement("button", "ot-popover-row ot-member-picker-row");
  row.type = "button";
  const glyph = createElement("span", "ot-member-picker-unassign-icon");
  renderIcon(glyph, "user-x");
  row.append(glyph, createElement("span", "ot-popover-label", "Unassigned"));
  if (isSelected) {
    const check = createElement("span", "ot-popover-check");
    renderIcon(check, "check");
    row.append(check);
  }
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    onActivate();
  });
  return row;
}

function buildCreateMemberRow(name, onActivate) {
  const row = createElement("button", "ot-popover-row ot-member-picker-create");
  row.type = "button";
  const preview = createElement("span", "ot-card-avatar is-initials");
  preview.style.setProperty("--ot-avatar-color", pickMemberColor(name));
  preview.textContent = initials(name);
  const label = createElement("span", "ot-popover-label", `Add "${name}"`);
  const plus = createElement("span", "ot-member-picker-create-icon");
  renderIcon(plus, "plus");
  row.append(preview, label, plus);
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    onActivate();
  });
  return row;
}

function hasExactMemberMatch(members, query) {
  const target = memberKey(query);
  if (!target) return false;
  return members.some((member) => memberKey(member) === target || memberKey(member.name) === target);
}

/**
 * Shared anchored popover for assigning existing members or creating local
 * members inline across cards, checklists, templates, and the table view.
 */
function openMemberPickerPopover({
  anchor,
  plugin,
  selected = [],
  getSelected = null,
  multiSelect = true,
  allowUnassign = false,
  onToggle,
  onCreateMember,
  onManageMembers = null,
}) {
  closeMemberPickerPopover();

  const pop = createElement("div", "ot-popover ot-member-picker-popover");
  const header = createElement("div", "ot-member-picker-header");
  const search = createElement("input", "ot-member-picker-search");
  search.type = "search";
  search.placeholder = "Search or add member...";
  search.setAttribute("aria-label", "Search or add member");
  header.append(search);

  const optionsEl = createElement("div", "ot-member-picker-options");
  pop.append(header, optionsEl);

  if (typeof onManageMembers === "function") {
    const footer = createElement("div", "ot-member-picker-footer");
    const manageBtn = createElement("button", "ot-member-picker-manage");
    manageBtn.type = "button";
    const iconEl = createElement("span", "ot-member-picker-manage-icon");
    renderIcon(iconEl, "users");
    manageBtn.append(iconEl, createElement("span", "", "Manage members"));
    manageBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      closeMemberPickerPopover();
      onManageMembers();
    });
    footer.append(manageBtn);
    pop.append(footer);
  }

  let activeIndex = -1;
  let interactiveRows = [];
  let creating = false;

  const currentSelectedKeys = () => {
    const list = typeof getSelected === "function" ? getSelected() : selected;
    return new Set((Array.isArray(list) ? list : []).map((item) => memberKey(item)).filter(Boolean));
  };

  const setActiveIndex = (nextIndex) => {
    if (!interactiveRows.length) {
      activeIndex = -1;
      return;
    }
    const clamped = ((nextIndex % interactiveRows.length) + interactiveRows.length) % interactiveRows.length;
    activeIndex = clamped;
    interactiveRows.forEach((row, index) => row.classList.toggle("is-active", index === activeIndex));
  };

  const handleCreate = async (rawName) => {
    const cleanName = cleanMemberId(rawName);
    if (!cleanName || creating || typeof onCreateMember !== "function") return;
    creating = true;
    try {
      await onCreateMember(cleanName);
      search.value = "";
      if (!multiSelect) {
        closeMemberPickerPopover();
      } else {
        renderOptions();
        search.focus();
      }
    } finally {
      creating = false;
    }
  };

  const handleToggle = async (memberOrNull) => {
    if (typeof onToggle !== "function") return;
    await onToggle(memberOrNull);
    if (!multiSelect) {
      closeMemberPickerPopover();
    } else {
      renderOptions();
    }
  };

  const renderOptions = () => {
    optionsEl.replaceChildren();
    interactiveRows = [];
    activeIndex = -1;

    const allMembers = plugin && typeof plugin.getVaultMembers === "function"
      ? plugin.getVaultMembers()
      : [];
    const selectedKeys = currentSelectedKeys();
    const rawQuery = cleanMemberId(search.value);
    const query = normalizeSearchText(rawQuery);
    const matches = allMembers.filter((member) => {
      if (!query) return true;
      const haystack = normalizeSearchText(`${member.name || ""} ${member.email || ""}`);
      return haystack.includes(query);
    });

    if (!multiSelect && allowUnassign && !query) {
      const unassignRow = buildUnassignedRow({
        isSelected: selectedKeys.size === 0,
        onActivate: () => handleToggle(null),
      });
      optionsEl.append(unassignRow);
      interactiveRows.push(unassignRow);
    }

    matches.forEach((member) => {
      const row = buildMemberRow({
        plugin,
        member,
        isSelected: selectedKeys.has(memberKey(member)),
        onActivate: () => handleToggle(member),
      });
      optionsEl.append(row);
      interactiveRows.push(row);
    });

    if (rawQuery && typeof onCreateMember === "function" && !hasExactMemberMatch(allMembers, rawQuery)) {
      const createRow = buildCreateMemberRow(rawQuery, () => handleCreate(rawQuery));
      optionsEl.append(createRow);
      interactiveRows.push(createRow);
    }

    if (!interactiveRows.length) {
      optionsEl.append(createElement("div", "ot-popover-empty", "Type a name above to add a member."));
    }
    positionPopover(pop, anchor);
  };

  search.addEventListener("input", renderOptions);
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(activeIndex < 0 ? interactiveRows.length - 1 : activeIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && interactiveRows[activeIndex]) {
        interactiveRows[activeIndex].click();
      } else if (interactiveRows.length === 1) {
        interactiveRows[0].click();
      } else if (cleanMemberId(search.value) && typeof onCreateMember === "function") {
        handleCreate(search.value);
      }
    }
  });

  if (document.body) document.body.append(pop);
  if (anchor && typeof anchor.setAttribute === "function") anchor.setAttribute("aria-expanded", "true");
  pop._anchor = anchor;

  const onDown = (event) => {
    if (typeof pop.contains === "function" && pop.contains(event.target)) return;
    if (anchor && typeof anchor.contains === "function" && anchor.contains(event.target)) return;
    closeMemberPickerPopover();
  };
  const onKey = (event) => {
    if (event.key === "Escape") closeMemberPickerPopover();
  };
  if (typeof document.addEventListener === "function") {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  }
  pop._cleanup = () => {
    if (typeof document.removeEventListener === "function") {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    }
  };

  activeMemberPopover = pop;
  renderOptions();
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    window.setTimeout(() => {
      if (typeof search.focus === "function") search.focus();
    }, 0);
  }
  return pop;
}

module.exports = {
  buildMemberAvatarElement,
  closeMemberPickerPopover,
  openKanuxMembersSettings,
  openMemberPickerPopover,
};
