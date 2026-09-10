const { Notice, arrayBufferToBase64 } = require("obsidian");
const {
  DEFAULT_LABEL_COLOR,
  LIST_COLORS,
  checklistStats,
  cleanColor,
  dateRangeLabel,
  imageSizeFromMarkup,
} = require("../helpers");
const { escapeDetailsHtml, detailsMdToHtml, splitDetailSegments } = require("./details-markdown");

// Renders the card into a hidden window and prints it as a vault-safe PDF.
// Export this card as a clean, print-styled PDF (title, board/list, labels,
// members, dates, description with embedded images, checklist). Desktop only:
// renders self-contained HTML in a hidden BrowserWindow, then saves the PDF
// through Obsidian's vault API without direct filesystem access.
async function exportCardToPdf(modal) {
  let remote = null;
  try { remote = window.require && window.require("@electron/remote"); } catch (error) { remote = null; }
  if (!remote) {
    try { remote = window.require && window.require("electron").remote; } catch (error) { remote = null; }
  }
  if (!remote || !remote.BrowserWindow) {
    new Notice("PDF export needs the Obsidian desktop app.");
    return;
  }
  try {
    if (!modal.readOnly) await modal.saveNow();
    const card = modal.card;
    const board = modal.plugin.findBoardForCard(card);
    const list = board && board.lists.find((item) => item.id === card.listId);
    const esc = escapeDetailsHtml;

    // Description: markdown via the shared converter; images inlined as data
    // URLs so the hidden window needs no access to the vault's app:// protocol.
    // Consecutive images form a RUN (whitespace between embeds doesn't break
    // it) and print as a flex row with PERCENTAGE widths derived from the
    // stored px sizes (relative to the ~800px modal they were sized in). Raw
    // px would overflow the narrower A4 content box and wrap the grid into a
    // single column — percentages keep 2-across as 2-across on any page.
    const descriptionParts = [];
    let imageRun = [];
    const flushImageRun = () => {
      if (!imageRun.length) return;
      if (imageRun.length === 1) {
        const only = imageRun[0];
        const sizing = only.width ? ` style="width:${Math.min(only.width, 660)}px"` : "";
        descriptionParts.push(`<img src="${only.src}"${sizing}>`);
      } else {
        const cells = imageRun.map((item) => {
          const percent = Math.min(100, Math.max(12, Math.round(((item.width || 380) / 8) * 10) / 10));
          return `<img src="${item.src}" style="width: calc(${percent}% - 8px)">`;
        }).join("");
        descriptionParts.push(`<div class="imgrow">${cells}</div>`);
      }
      imageRun = [];
    };
    for (const seg of splitDetailSegments(modal.currentDetailsText())) {
      if (seg.type === "img") {
        const resolved = modal.plugin.resolveCardImage(card, seg.target);
        if (resolved && resolved.file) {
          try {
            const bin = await modal.app.vault.readBinary(resolved.file);
            const ext = (resolved.file.extension || "png").toLowerCase();
            const mime = ext === "svg" ? "image/svg+xml" : (ext === "jpg" ? "image/jpeg" : `image/${ext}`);
            imageRun.push({
              src: `data:${mime};base64,${arrayBufferToBase64(bin)}`,
              width: imageSizeFromMarkup(seg.markup),
            });
          } catch (error) {
            // unreadable image — skip it rather than fail the export
          }
        }
        continue;
      }
      if (!seg.text.trim()) continue; // whitespace gap — keep the image run going
      flushImageRun();
      descriptionParts.push(detailsMdToHtml(seg.text));
    }
    flushImageRun();

    const labelsHtml = (modal.localLabels || [])
      .map((label) => `<span class="pill" style="background:${esc(label.color || DEFAULT_LABEL_COLOR)}">${esc(label.name)}</span>`)
      .join("");
    const collaborationEnabled = modal.plugin.isSyncDeckEnabled();
    const membersText = collaborationEnabled
      ? (modal.localAssignees || []).map((a) => a.name || a.email).filter(Boolean).join(", ")
      : "";
    const datesText = dateRangeLabel(card.startDate, card.dueDate) || "";
    const checklistHtml = (modal.localChecklists || [])
      .map((group) => {
        const stats = checklistStats(group.items);
        const items = (group.items || [])
          .map((item) => `<div class="chk"><span class="box">${item.done ? "☑" : "☐"}</span><span class="${item.done ? "done" : ""}">${esc(item.text || "")}</span>${collaborationEnabled && item.assignee && (item.assignee.name || item.assignee.email) ? `<span class="who"> — ${esc(item.assignee.name || item.assignee.email)}</span>` : ""}</div>`)
          .join("");
        const color = cleanColor(group.color) || LIST_COLORS[1];
        const description = String(group.description || "").trim();
        const descriptionHtml = description
          ? `<div class="checklist-desc">${esc(description).replace(/\n/g, "<br>")}</div>`
          : "";
        return `<div class="checklist-group" style="border-left:3px solid ${esc(color)};padding-left:10px"><h3 style="color:${esc(color)}">${esc(group.title || "Checklist")}</h3>${descriptionHtml}<div class="checklist-progress">${stats.percent}% · ${stats.done}/${stats.total}</div>${items}</div>`;
      })
      .join("");
    const metaBits = [
      board ? esc(board.name) : "",
      list ? esc(list.title) : "",
      card.completed ? "Completed" : "",
      datesText ? esc(datesText) : "",
    ].filter(Boolean).join(" • ");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(modal.localTitle || "Card")}</title><style>
      body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328; margin: 42px; line-height: 1.5; }
      h1 { font-size: 24px; margin: 0 0 6px; }
      .meta { color: #667085; font-size: 13px; margin-bottom: 12px; }
      .pill { display: inline-block; color: #fff; border-radius: 4px; padding: 2px 10px; font-size: 12px; font-weight: 700; margin: 0 6px 6px 0; }
      .section { margin-top: 22px; }
      .section h2 { font-size: 15px; margin: 0 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
      .checklist-group + .checklist-group { margin-top: 18px; }
      .checklist-group h3 { font-size: 14px; margin: 0 0 2px; }
      .checklist-desc { color: #475467; font-size: 12px; margin: 0 0 4px; }
      .checklist-progress { color: #667085; font-size: 11px; margin-bottom: 6px; }
      img { max-width: 100%; border-radius: 8px; margin: 10px 0; }
      .imgrow { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; margin: 10px 0; }
      .imgrow img { margin: 0; }
      .chk { margin: 4px 0; }
      .box { margin-right: 7px; }
      .done { text-decoration: line-through; color: #98a2b3; }
      .who { color: #667085; font-size: 12px; }
      blockquote { border-left: 3px solid #e5e7eb; margin: 8px 0; padding: 2px 12px; color: #667085; }
      code { background: #f2f4f7; padding: 1px 5px; border-radius: 4px; }
      ul, ol { padding-left: 22px; }
      p { margin: 0 0 0.6em; }
    </style></head><body>
      <h1>${esc(modal.localTitle || "Card")}</h1>
      ${metaBits ? `<div class="meta">${metaBits}</div>` : ""}
      ${labelsHtml ? `<div>${labelsHtml}</div>` : ""}
      ${membersText ? `<div class="meta" style="margin-top:8px">Members: ${esc(membersText)}</div>` : ""}
      ${descriptionParts.length ? `<div class="section"><h2>Description</h2>${descriptionParts.join("")}</div>` : ""}
      ${checklistHtml ? `<div class="section"><h2>Checklist</h2>${checklistHtml}</div>` : ""}
    </body></html>`;

    const baseName = String(modal.localTitle || "card").replace(/[\\/:*?"<>|]/g, "-").trim() || "card";
    let pdfPath = `${baseName}.pdf`;
    let suffix = 2;
    while (modal.app.vault.getAbstractFileByPath(pdfPath)) {
      pdfPath = `${baseName} ${suffix}.pdf`;
      suffix += 1;
    }

    const win = new remote.BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      const htmlBytes = new TextEncoder().encode(html);
      await win.loadURL(`data:text/html;charset=utf-8;base64,${arrayBufferToBase64(htmlBytes.buffer)}`);
      // Give layout a beat to settle (data-URI images decode synchronously,
      // but pagination measures after first paint).
      await new Promise((resolve) => setTimeout(resolve, 150));
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
      const bytes = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
      await modal.app.vault.createBinary(pdfPath, bytes);
      new Notice(`PDF saved to ${pdfPath}.`);
    } finally {
      win.destroy();
    }
  } catch (error) {
    console.error(error);
    new Notice("Could not export the PDF.");
  }
}

module.exports = {
  exportCardToPdf,
};
