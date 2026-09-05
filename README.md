# Kanux

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-663399.svg)](LICENSE)

Kanux is a focused kanban and table view for Obsidian. Every card stays a real Markdown note in your vault, so your tasks remain searchable, linkable, portable, and editable outside the board.

Use it locally with as many boards as you need, or pair it with **Sync Deck** for cross-device sync, shared vaults, member assignment, and live presence.

![Kanux running in a full Obsidian workspace](<docs/images/Full window.png>)

## Screenshots

### Board and Table views

Organize Markdown-backed cards visually on the Board, then switch to Table for searching, filtering, sorting, and editing the same data in a structured overview.

![Kanux Board view with colored lists and cards](<docs/images/Kanux Board.png>)

![Kanux Table view with filters, lists, dates, and labels](<docs/images/Kanux Table.png>)

### Cards and Markdown workflow

Open a card to manage its labels, dates, Markdown description, checklists, and progress without losing access to the underlying notes.

![Complete Kanux card editor](<docs/images/View of the card.png>)

<details>
<summary>More card details</summary>

#### Dates

![Start and due dates displayed on a card](<docs/images/View of the date on a card.png>)

#### Labels

![Colored labels displayed on cards](<docs/images/View of the tags on the cards.png>)

#### Markdown linked to a checklist task

![Expanded Markdown document linked to a checklist task](<docs/images/View of the document linked to a check-list-item.png>)

</details>

### Filters and multiple boards

Use searchable label filters on large boards and move between independent boards directly from the Kanux interface.

![Filtering cards by labels](<docs/images/Filters by tags.png>)

<details>
<summary>Board navigation</summary>

![Overview containing multiple Kanux boards](<docs/images/View of multiple boards.png>)

![Quick access to other Kanux boards](<docs/images/Easy access to your other boards.png>)

</details>

### Per-board customization

Customize each board independently without changing the active Obsidian theme. Backgrounds support solid colors, gradients, and local images with adjustable fitting and darkening.

![Kanux per-board customization window](<docs/images/Customization window.png>)

![Customized Kanux appearance without modifying the Obsidian theme](<docs/images/Customization without touching the theme.png>)

<details>
<summary>Background customization examples</summary>

![Kanux background customization controls](<docs/images/Full customization of the Kanux background.png>)

![Kanux board with a customized image background](<docs/images/Customized background with an image.png>)

![Alternative Kanux board with a customized image background](<docs/images/Customized background with an image 2.png>)

</details>

### Team collaboration with Sync Deck

Sync Deck adds shared vaults, member assignment, card locks, and live presence while keeping local-only Kanux usage independent.

![Kanux card with Sync Deck collaboration enabled](<docs/images/View of a card with the sync functionality enabled.png>)

<details>
<summary>Member assignment and live collaboration</summary>

![Assigning specific checklist tasks to team members](<docs/images/Assign specific tasks to members of your team.png>)

![Card displaying an assigned member](<docs/images/View with a member assigned to a card.png>)

![Multiple people collaborating through Sync Deck](<docs/images/Ability to work with multiple people tacks to Sync Deck.png>)

</details>

<sub>Screenshots were captured from a clean demo vault.</sub>

## Features

- **Flexible boards and lists:** Create multiple independent boards, organize colored lists, and reorder cards or complete lists with drag and drop.
- **Board and Table views:** Manage the same cards visually or through a searchable, sortable, and configurable table.
- **Complete card management:** Create, edit, complete, move, export, or delete cards with titles, dates, labels, members, descriptions, images, and progress information.
- **Labels and dates:** Use reusable colored labels, flexible display modes, start dates, due dates, ranges, and overdue indicators.
- **Rich Markdown descriptions:** Write and render formatted descriptions with links, lists, quotes, code, Obsidian note references, and collapsible long content. Typing is saved as you go, so a closed modal never costs you a paragraph.
- **Images and attachments:** Add, paste, resize, arrange, reorder, copy, and manage images while keeping attachments organized inside the vault.
- **Checklists and tasks:** Build multiple colored checklists, reorder tasks, track independent progress, assign members, and associate individual tasks with their own Markdown notes.
- **Card templates:** Save any card as a template — title, labels, members, description and colored checklists — and start new cards from it in one click, with the caret waiting in the first blank. Give a template a running code (BUG-014) and every card it makes carries its own identifier, kept through renames and searchable. Review, edit and delete them from one place.
- **Dependencies and blocking:** Make a card — or a single checklist — depend on other cards, and pick per dependency whether an unfinished one blocks nothing, asks for confirmation, or blocks the action completely.
- **Per-board appearance:** Customize backgrounds, colors, spacing, typography, density, borders, shadows, animations, labels, and image fitting; save presets or copy an appearance from another board.
- **Native Obsidian storage:** Keep cards as normal Markdown notes with frontmatter, graph connections, automatic file discovery, external-change synchronization, and migration support.
- **Productivity and accessibility:** Use commands, undo supported changes, keyboard navigation, responsive layouts, visible focus states, and reduced-motion support.
- **Offline-first operation:** Use local boards without an account, permanent connection, or dependency on Sync Deck.
- **Optional Sync Deck collaboration:** Synchronize encrypted board content across devices, share vaults, assign members, display live presence, and prevent conflicting edits with card locks.

## Quick start

1. Open **Kanux** from the ribbon or run `Kanux: Open board` from the command palette.
2. Create a board. New boards start with **To do**, **Doing**, and **Done** lists.
3. Add cards inline, then drag them between lists as work moves forward.
4. Open a card to add labels, dates, a Markdown description, images, and named checklists.
5. Switch to **Table** when you want a compact overview across every list.

Use **Open note** in the card editor whenever you want to work directly in the underlying Markdown file.

## Markdown storage

Each board lives in its own readable folder:

```text
Product Launch/
├── Product Launch.md          board index: list order and graph links
├── cards/
│   ├── Prepare onboarding checklist.md
│   └── Write launch announcement.md
├── templates/                 card templates, ignored by the board
│   └── Bug report.md
├── checklist-items/           notes opened from a checklist task
│   └── Draft the welcome email.md
└── attachments/               images pasted into a description
```

The board index keeps list order and graph links connected. Card metadata lives in frontmatter, while the description and checklist remain ordinary Markdown. The plugin folder stores the local UI state; your task content stays in the vault.

### What a card note carries

| Key | Holds |
| --- | --- |
| `kanban-card-id`, `kanban-board-id`, `kanban-list-id` | Identity and placement, so a card survives a rename or a move on another device |
| `kanux-card-code` | The running code a template gave it (`BUG-014`), shown as a chip in front of the name |
| `position` | Order inside its list — the only place card order is persisted to a synced file |
| `tags` | The `kanux/board/list` hierarchy, for Obsidian search and the graph |
| `kanux-board`, `kanux-list`, `kanux-list-color` | Readable names and the list color, so the note makes sense on its own |
| `labels`, `assignees` | Colored labels and assigned members |
| `depends-on` | Dependencies as `card-id\|none\|warn\|block` |
| `completed`, `start`, `due` | Progress and dates |

A checklist keeps its own metadata in hidden comments on its heading (`kanux-checklist-id`, `kanux-checklist-color`, `kanux-checklist-depends`) and one per item (`kanux-item-id`), so groups, colors and dependencies all survive a sync to another device.

### The other two note types

Two more kinds of note live in a board folder, and both are marked so the board's sync never mistakes them for cards:

- **Templates** carry `kanux-template: true` and no card id. A template that numbers its cards also keeps `kanux-id-prefix`, `kanux-id-next` and `kanux-id-pad`.
- **Checklist-item notes** carry `kanux-checklist-item: true` and `kanux-card-id` pointing back at their card, plus a `Card:` wikilink so the graph connects both ways. One is created the first time you open a checklist task as a note.

## Card templates

The **Add card** menu ends with **New template**, which opens an editor for the shape a repeated kind of card starts from: its title, labels, destination list, members, a Markdown description and named checklists with their own colors. A card you already built can become one too, with **Save as template** from its menu.

Either way the template is written to `<board>/templates/` as an ordinary Markdown note, with nothing ticked and nothing linked to a particular card.

A list's menu offers **New card from template**, with the same two actions at the bottom. The card is created in the list you opened the menu from, and if the template's description has fill-in blanks — `As a [ ] I want [ ] so that [ ]` — the editor opens with the caret already in the first one.

### Incremental codes

Turn on **Number each card** and the template stamps a running code on every card it makes — `BUG-001`, then `BUG-002`, and so on. Set the prefix, the next number and how many digits it pads to; the editor shows the code the next card will get.

The code is stored on the card as `kanux-card-code` and shown as a chip in front of its name — on the board, in the table and in the card itself. It is not part of the title, so **renaming a card keeps its code**, and the table's search box finds a card by typing its code.

The counter lives in the template note as `kanux-id-next`, so it survives a reload and travels with the vault. **Manage templates** shows each template's next code and restarts the counter from there — the confirmation tells you how many cards already carry codes from that point on, because a restart is what hands the same number out twice.

Two devices creating cards from one template while offline can both take the same number: the counter is a note, and notes merge after the fact.

### Managing templates

**Manage templates**, in the same two menus, lists what the board has. Click a template to open its note and edit it by hand; the trash icon deletes it, and cards already made from it are untouched.

Templates are plain notes, so you can also rename or delete one straight from the file explorer. They live inside the board folder and never appear on the board itself.

## Dependencies and blocking

A dependency points at another card and is met once that card is completed:

- A **card** dependency guards moving the card to a different list. Reordering inside the same list is never blocked.
- A **checklist** dependency guards ticking the items of that checklist. Unticking an item is always allowed.

Each dependency chooses its own blocking level: **no blocking** (the default, informational only), **warn before continuing** (a dialog names the unfinished cards and asks whether to go on), or **block completely** (a dialog explains that the action cannot be performed and which cards block it). Change a level from the dependency's own menu or by dragging it onto another level. When several dependencies apply, the strongest unmet level wins. A dependency whose card was deleted is shown as missing and never blocks.

A checklist keeps its dependencies behind a link button in its header, collapsed every time the card is opened. The button counts what is behind it and takes the colour of the strongest unmet level, so a gated checklist is recognisable without opening the panel.

## Sync across devices and teams

Kanux works fully offline and does not require an account. To sync boards, install **Sync Deck**, sign in, and open or create a synced vault.

Sync Deck carries the board index, cards, and attachments across your devices. New and upgraded Sync Deck vaults end-to-end encrypt those files, their paths, and the board/card identifiers used for presence and locks; account and activity metadata still remain visible to the service. In shared vaults it also provides member assignment and live presence, so teammates can see who is viewing or editing a card. Local-only Kanux usage remains unlimited.

### Network, accounts, and payment

- Kanux's local board features work offline, require no account, and contain no client-side telemetry or dynamically loaded advertising. Its interface includes a link to the optional Sync Deck companion.
- Network access occurs only through the optional Sync Deck integration when Sync Deck is installed, enabled, and signed in. It is used for file synchronization, member assignment, live presence, and edit locks.
- A Sync Deck account is required for those optional online features. Its free plan may limit the number of synchronized boards; its paid plan removes that limit. Disabling cloud synchronization leaves local Kanux boards unlimited.

### Local data access

- Kanux enumerates vault file paths to discover its board and card notes and to populate note and image pickers. It reads or changes file contents only when required by a board operation or an explicit user action.
- Clipboard access occurs only when the user pastes content into a card or explicitly copies an image from a card.
- PDF exports are created through Obsidian's vault API and saved inside the vault. Kanux does not use Node.js filesystem APIs to write outside the vault.

## Custom CSS

**Customize** covers backgrounds, colors, spacing and typography per board, and everything it controls is written as a CSS variable on the board root. Those are Kanux's own to set — overriding them by hand fights the picker.

Six variables are never set by Kanux, only read. They exist for a CSS snippet to override, and they are the supported way to recolor the parts the appearance panel does not reach:

| Variable | Controls | Falls back to |
| --- | --- | --- |
| `--ot-save-color` | Save buttons and confirmed-state accents | `--color-green`, else `#22c55e` |
| `--ot-done-color` | Completed cards and finished checklists | `--color-green`, else `#8cc63f` |
| `--ot-warn-color` | Warning-level dependencies | `#c2620f` |
| `--ot-danger-color` | Delete buttons, blocking dependencies, overdue dates | `--color-red`, else `#c9372c` |
| `--ot-board-background` | The board surface behind the lists | `--background-primary` |
| `--ot-list-shadow` | The shadow under a list column | `0 2px 8px rgb(0 0 0 / 14%)` |

Put a snippet in `.obsidian/snippets/` and scope it to `.ot-board-root` so it cannot reach the rest of Obsidian:

```css
.ot-board-root {
  --ot-danger-color: #b4232a;
  --ot-warn-color: #9a5b00;
}
```

## Install

Until Kanux is available in the Obsidian community plugin directory:

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release of this repository.
2. Put the files in:

```text
Your Vault/.obsidian/plugins/kanux/
```

3. Enable **Kanux** in Obsidian under **Settings → Community plugins**.

## Development

Source files live in `src/`; `main.js` is generated and must never be edited by hand. After changing anything under `src/`, run:

```bash
node build.js
```

Obsidian loads the generated `main.js`. Then run the four test suites — `helpers` covers the pure utilities, `modals` the card field lifecycles, `plugin` the data operations, and `board-view` the drag-and-drop geometry:

```bash
node tests/helpers.test.js && node tests/modals.test.js && node tests/plugin.test.js && node tests/board-view.test.js
```

`AGENTS.md` has the full checklist, including the syntax pass over every file in `src/` and the CSS rules the project does not allow. `docs/ARCHITECTURE.md` maps the modules, and `docs/HELPERS-CATALOG.md` lists the shared utilities — check it before writing a new helper.

To try a build in a real vault, copy `main.js` and `styles.css` into `Your Vault/.obsidian/plugins/kanux/` and reload Obsidian.

## Credits

This project originally used [ismailivanov/task-deck](https://github.com/ismailivanov/task-deck) as its base. It has since evolved into a substantially expanded implementation with a broader product direction, independent customization, and new workflows beyond the original plugin.

Credit and thanks to Ismail Ivanov for releasing the original project under the MIT License. You can support his work through [Buy Me a Coffee](https://buymeacoffee.com/carbon06).

## License

Kanux is distributed under the [GNU Affero General Public License version 3](LICENSE), with an [additional linking exception for Obsidian and the Obsidian Plugin API](OBSIDIAN-LINKING-EXCEPTION.md).

Portions derived from the original `ismailivanov/task-deck` project retain their original MIT copyright and permission notice in [LICENSES/MIT-upstream.txt](LICENSES/MIT-upstream.txt). See [NOTICE](NOTICE) for attribution details.
