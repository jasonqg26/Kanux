
// ---- Markdown <-> HTML for the WYSIWYG description blocks ----
// A deliberately SMALL, symmetric subset (paragraphs, line breaks, #-headings,
// -/1. lists, > quotes, ---, **bold**, *italic*, ~~strike~~, `code`, [link](url)) so that
// md -> html -> md round-trips bytes for everything these converters produce.
// Unrecognized markdown stays literal text and survives untouched.
function escapeDetailsHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMdToHtml(text) {
  let out = escapeDetailsHtml(text);
  out = out.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (match, target, alias) => {
    const hasAlias = alias != null;
    const label = hasAlias ? alias : target.split("/").pop();
    return `<a class="internal-link" data-wikilink="true" data-has-alias="${hasAlias ? "true" : "false"}" data-href="${target}" href="${target}">${label}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function detailsMdToHtml(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let para = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(inlineMdToHtml).join("<br>")}</p>`);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flushPara(); i += 1; continue; }
    if (/^-{3,}\s*$/.test(line)) { flushPara(); html.push("<hr>"); i += 1; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${inlineMdToHtml(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^\d+[.)]\s+/, ""))}</li>`);
        i += 1;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(inlineMdToHtml(lines[i].replace(/^>\s?/, "")));
        i += 1;
      }
      // One <p> per quoted line (empty lines keep a <br> so they hold a caret):
      // per-line wrappers are what lets the editor's Enter-on-empty-line escape
      // detect the current line inside the quote.
      html.push(`<blockquote>${quoted.map((q) => `<p>${q || "<br>"}</p>`).join("")}</blockquote>`);
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return html.join("");
}

// Serialize a contenteditable's DOM back to the same markdown subset. Unknown
// wrappers (span/font/...) are flattened to their text, so pasted styling can't
// leak HTML into the note.
function detailsHtmlToMd(root) {
  const BLOCK_TAGS = /^(P|DIV|UL|OL|BLOCKQUOTE|HR|H[1-6])$/;
  const inline = (node) => {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { out += child.textContent; return; }
      if (child.nodeType !== 1) return;
      // Live-preview markers (the "#" shown while the caret is on a heading
      // line) are visual only — the heading tag already encodes them.
      if (child.classList && child.classList.contains("ot-md-token")) return;
      const tag = child.tagName;
      if (tag === "BR") { out += "\n"; return; }
      const inner = inline(child);
      if (tag === "B" || tag === "STRONG") out += inner.trim() ? `**${inner}**` : inner;
      else if (tag === "I" || tag === "EM") out += inner.trim() ? `*${inner}*` : inner;
      else if (tag === "S" || tag === "DEL" || tag === "STRIKE") out += inner.trim() ? `~~${inner}~~` : inner;
      else if (tag === "CODE") out += inner.trim() ? `\`${inner}\`` : inner;
      else if (tag === "A" && child.dataset.wikilink === "true") {
        const target = child.dataset.href || child.getAttribute("href") || "";
        out += child.dataset.hasAlias === "true" ? `[[${target}|${inner || target}]]` : `[[${target}]]`;
      }
      else if (tag === "A") out += `[${inner || child.getAttribute("href") || "link"}](${child.getAttribute("href") || ""})`;
      else out += inner;
    });
    return out;
  };
  // Chromium freely nests blocks (a <ul> inside the caret's <p>, a quote inside
  // a <div>...), so serialization must RECURSE into containers — flattening a
  // wrapped list through inline() used to glue every item into one word.
  const serializeChildren = (node, parts) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        if (child.textContent.trim()) parts.push(child.textContent);
        return;
      }
      if (child.nodeType !== 1) return;
      if (BLOCK_TAGS.test(child.tagName)) serializeBlock(child, parts);
      else {
        const text = inline({ childNodes: [child] });
        if (text.trim()) parts.push(text);
      }
    });
  };
  const serializeBlock = (el, parts) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      parts.push(`${"#".repeat(Number(tag[1]))} ${inline(el)}`);
      return;
    }
    if (tag === "UL" || tag === "OL") {
      const lines = [];
      let n = 1;
      el.querySelectorAll(":scope > li").forEach((li) => {
        const nestedBlocks = Array.from(li.children).filter((c) => BLOCK_TAGS.test(c.tagName));
        const inlineOnly = { childNodes: Array.from(li.childNodes).filter((c) => !(c.nodeType === 1 && BLOCK_TAGS.test(c.tagName))) };
        lines.push(tag === "UL" ? `- ${inline(inlineOnly)}` : `${n++}. ${inline(inlineOnly)}`);
        // Nested lists/blocks inside an item flatten to sibling lines.
        nestedBlocks.forEach((nested) => {
          const sub = [];
          serializeBlock(nested, sub);
          sub.forEach((line) => lines.push(line));
        });
      });
      parts.push(lines.join("\n"));
      return;
    }
    if (tag === "BLOCKQUOTE") {
      const sub = [];
      serializeChildren(el, sub);
      const flat = sub.length ? sub.join("\n") : inline(el);
      parts.push(flat.split("\n").map((l) => `> ${l}`).join("\n"));
      return;
    }
    if (tag === "HR") { parts.push("---"); return; }
    // P/DIV: a real paragraph when it only holds inline content; a transparent
    // container when Chromium nested block elements inside it.
    const hasBlockChild = Array.from(el.children || []).some((c) => BLOCK_TAGS.test(c.tagName));
    if (hasBlockChild) { serializeChildren(el, parts); return; }
    const text = inline(el);
    if (text.trim()) parts.push(text);
  };
  const parts = [];
  serializeChildren(root, parts);
  return parts.join("\n\n").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Notion-style autoformat triggers for the description editor: typing one of
// these at the start of a line and pressing Space converts the line into the
// matching block instead of leaving raw markdown markers in the text.
const DETAILS_AUTOFORMAT_COMMANDS = {
  "-": { command: "insertUnorderedList" },
  "*": { command: "insertUnorderedList" },
  "1.": { command: "insertOrderedList" },
  "1)": { command: "insertOrderedList" },
  ">": { command: "formatBlock", value: "blockquote" },
  "#": { command: "formatBlock", value: "h1" },
  "##": { command: "formatBlock", value: "h2" },
  "###": { command: "formatBlock", value: "h3" },
};

function autoformatCommandForPrefix(prefix) {
  return DETAILS_AUTOFORMAT_COMMANDS[prefix] || null;
}

// Inline live-preview triggers: finishing "**bold**", "*italic*", "~~strike~~"
// or "`code`" right before the caret formats the run in place, Obsidian-style.
const INLINE_AUTOFORMAT_RULES = [
  { pattern: /\*\*([^*\n]+)\*\*$/, tag: "strong" },
  { pattern: /~~([^~\n]+)~~$/, tag: "s" },
  { pattern: /`([^`\n]+)`$/, tag: "code" },
  { pattern: /(?<!\*)\*([^*\n]+)\*$/, tag: "em" },
];

function inlineAutoformatMatch(textBeforeCaret) {
  for (const rule of INLINE_AUTOFORMAT_RULES) {
    const match = String(textBeforeCaret || "").match(rule.pattern);
    if (!match || !match[1].trim()) continue;
    return { tag: rule.tag, span: match[0], content: match[1] };
  }
  return null;
}

/**
 * Splits details Markdown into ordered segments so text and images render
 * inline, in the order they appear: [{type:'md',text} | {type:'img',target}].
 */
function splitDetailSegments(markdown) {
  const text = String(markdown || "");
  const re = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(\?|#|$)/i;
  const segments = [];
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    const isWiki = match[1] !== undefined;
    let target = (isWiki ? match[1] : match[2]) || "";
    target = target.split("|")[0].split("#")[0].trim();
    if (!isWiki) target = target.split(/\s+/)[0]; // md link: drop optional "title"
    if (!IMG_EXT.test(target)) continue; // not an image link — leave it in the text
    if (match.index > last) segments.push({ type: "md", text: text.slice(last, match.index) });
    // Keep the exact original markup so an editor rebuilding the markdown from
    // segments round-trips wiki AND ![](url) embeds byte-identically. start/end
    // let callers splice a resized embed back into the source string safely.
    segments.push({ type: "img", target, markup: match[0], start: match.index, end: match.index + match[0].length });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: "md", text: text.slice(last) });
  if (!segments.length) segments.push({ type: "md", text });
  return segments;
}

module.exports = {
  escapeDetailsHtml,
  detailsMdToHtml,
  detailsHtmlToMd,
  autoformatCommandForPrefix,
  inlineAutoformatMatch,
  splitDetailSegments,
};
