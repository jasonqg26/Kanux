# Kanux

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-663399.svg)](LICENSE)

Task Deck is a focused kanban and table view for Obsidian. Every card stays a real Markdown note in your vault, so your tasks remain searchable, linkable, portable, and editable outside the board.

Use it locally with as many boards as you need, or pair it with **Sync Deck** for cross-device sync, shared vaults, member assignment, and live presence.

![Task Deck running in a full Obsidian workspace](<docs/images/Full window.png>)

## Screenshots

### Board and Table views

Organize Markdown-backed cards visually on the Board, then switch to Table for searching, filtering, sorting, and editing the same data in a structured overview.

![Task Deck Board view with colored lists and cards](<docs/images/Task Desk Board.png>)

![Task Deck Table view with filters, lists, dates, and labels](<docs/images/Task Desk Table.png>)

### Cards and Markdown workflow

Open a card to manage its labels, dates, Markdown description, checklists, and progress without losing access to the underlying notes.

![Complete Task Deck card editor](<docs/images/View of the card.png>)

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

Use searchable label filters on large boards and move between independent boards directly from the Task Deck interface.

![Filtering cards by labels](<docs/images/Filters by tags.png>)

<details>
<summary>Board navigation</summary>

![Overview containing multiple Task Deck boards](<docs/images/View of multiple boards.png>)

![Quick access to other Task Deck boards](<docs/images/Easy access to your other boards.png>)

</details>

### Per-board customization

Customize each board independently without changing the active Obsidian theme. Backgrounds support solid colors, gradients, and local images with adjustable fitting and darkening.

![Task Deck per-board customization window](<docs/images/Customization window.png>)

![Customized Task Deck appearance without modifying the Obsidian theme](<docs/images/Customization without touching the theme.png>)

<details>
<summary>Background customization examples</summary>

![Task Deck background customization controls](<docs/images/Full customization of the task deck background.png>)

![Task Deck board with a customized image background](<docs/images/Customized background with an image.png>)

![Alternative Task Deck board with a customized image background](<docs/images/Customized background with an image 2.png>)

</details>

### Team collaboration with Sync Deck

Sync Deck adds shared vaults, member assignment, card locks, and live presence while keeping local-only Task Deck usage independent.

![Task Deck card with Sync Deck collaboration enabled](<docs/images/View of a card with the sync functionality enabled.png>)

<details>
<summary>Member assignment and live collaboration</summary>

![Assigning specific checklist tasks to team members](<docs/images/Assign specific tasks to members of your team.png>)

![Card displaying an assigned member](<docs/images/View with a member assigned to a card.png>)

![Multiple people collaborating through Sync Deck](<docs/images/Ability to work with multiple people tacks to Sync Deck.png>)

</details>

<sub>Screenshots were captured from a clean demo vault using Task Deck 0.3.8.</sub>

## Features

### Boards and lists

- Create and manage multiple independent boards from a dedicated board home.
- Switch boards without leaving the Task Deck view.
- Start new boards empty or with ready-made **To do**, **Doing**, and **Done** lists.
- Add, rename, recolor, reorder, and delete lists.
- See each list's card count and identifying color directly in its header.
- Drag lists horizontally and place them before or after another list.
- Give every board its own folder, cards, attachments, lists, colors, and appearance.

### Board view

- Trello-style cards with wrapped titles, colored labels, dates, checklist progress, description indicators, member avatars, and completion state.
- Create cards inline inside any list.
- Rename cards directly from the Board.
- Drag cards within a list or between lists with exact insertion placement.
- Mark cards complete or incomplete from the closed card.
- Optional completion sound and animated completion feedback.
- Quick access to dates, deletion, and the complete card editor.
- Undo recent Board and Table changes with the command palette or `Ctrl/Cmd + Z` while Task Deck is active.

### Table view

- View every card from every list as a structured, card-styled table row.
- Open the same complete card editor used by the Board view.
- Create a card directly in a selected list from the centered Table composer.
- Mark cards complete or incomplete without leaving the table.
- Edit a card's list, members, dates, and labels directly from its row.
- Search across card titles, descriptions, list names, labels, assigned members, and checklist tasks.
- Accent-insensitive, multi-term search: every entered term can match a different part of the card.
- Filter by list and by open or completed state.
- Searchable multi-label filtering that only indexes labels used by the current board and limits rendered results for large label collections.
- Sort by Board order, title, nearest due date, or most recently updated.
- Display filtered and total card counts and clear all active filters in one action.
- Show, hide, resize, and reorder the optional **List**, **Assignee**, **Dates**, and **Labels** fields.
- Preserve each board's Table field order and widths as local interface preferences.

### Complete card editor

- Edit the card title with automatic saving.
- See the card's current board and list in the modal header.
- Open the underlying Markdown note at any time.
- Export a complete card to a print-styled A4 PDF on Obsidian Desktop, including metadata, labels, dates, members, description, images, and checklists.
- Delete a card together with its linked Markdown note after confirmation.
- Respect collaborative edit locks by opening cards read-only when another member is editing them.

### Labels

- Create reusable global labels with a large color palette.
- Search, select, edit, and delete labels from the label manager.
- Assign multiple labels to each card.
- Remove labels directly from the card editor.
- Choose how labels appear on each board: always compact, always expanded, expand only the hovered label, or expand all labels when the card is hovered.
- Smooth label expansion animations with reduced-motion support.

### Dates

- Set independent start and due dates from a visual calendar.
- Display single dates or date ranges on closed cards and in Table.
- Highlight overdue dates in Table.
- Clear or update dates without editing the Markdown file manually.

### Markdown descriptions

- Render card descriptions as normal Obsidian Markdown.
- Edit descriptions through a visual block editor instead of working directly with raw Markdown markers.
- Format headings, bold text, italics, quotes, bulleted lists, inline code, links, dividers, and links to other vault notes.
- Preserve paragraphs and list continuation while typing.
- Keep pasted text free from foreign HTML styling.
- Collapse long descriptions behind **Show more / Show less** controls.
- Fall back to readable source text if Markdown rendering fails.

### Images and attachments

- Add multiple images from the file picker, clipboard paste, or drag and drop.
- Save card media inside the board's organized `attachments/` folder.
- Insert images at the current description position and keep them inline with surrounding Markdown.
- Preview real images while editing instead of raw embed syntax.
- Resize images by dragging and persist their width in Obsidian-compatible embed markup.
- Arrange consecutive images at full width or in two-, three-, and four-column layouts.
- Reorder images by drag and drop.
- Copy a rendered image directly to the system clipboard.
- Remove images from the description while preserving the surrounding text structure.
- Resolve vault image embeds and migrate older loose board media into the organized attachments folder.

### Checklists and tasks

- Add multiple named checklists to a card.
- Give every checklist its own color and independent progress bar.
- Rename or delete entire checklists.
- Add, edit, complete, and remove checklist tasks.
- Wrap long task titles across multiple lines.
- Reorder tasks within a checklist or drag them between different checklists.
- Create a dedicated Markdown note for any checklist task.
- Expand and render a task's linked Markdown description directly inside the card.
- Open the linked task note in Obsidian for full editing.
- Move linked task notes to the vault trash when their task or checklist is deleted.
- Assign an individual Sync Deck member to a checklist task when collaboration is enabled.

### Per-board customization

- Define global appearance defaults in plugin settings, then override them independently for each board.
- Customize each board independently without modifying the active Obsidian theme.
- Start from **Obsidian theme**, **Trello dark**, **Trello light**, **Transparent**, or **High contrast** visual presets.
- Save the current appearance as a reusable custom preset.
- Apply or delete saved presets and copy the complete appearance from another board.
- Reset one board to the Obsidian-theme defaults.
- Use the Obsidian theme, a solid color, a two-color gradient, or an image as the board background.
- Select background images from the vault or import them from the computer into Task Deck's private plugin data folder.
- Fit images with **Original**, **Cover**, **Contain**, or **Repeat** behavior.
- Adjust image darkening to keep cards and controls readable.
- Use theme-derived or custom card and list surface colors.
- Customize card hover color, vertical card spacing, card title size, list spacing, top-border thickness, and list color-dot visibility.
- Control text contrast independently from surface colors.
- Choose compact, normal, or comfortable layout density.
- Adjust global text scale, card corners, list corners, card shadow strength, and interface animations.
- Share the same appearance variables across Board and Table views for visual consistency.

### Markdown-native Obsidian integration

- Keep every card as a normal Markdown note that remains searchable, linkable, portable, and editable outside Task Deck.
- Store card metadata in frontmatter while descriptions and checklists remain readable Markdown.
- Maintain a readable generated board index containing list order and links to every card.
- Keep cards connected in Obsidian Graph view.
- Add board/list tags and matching Graph color groups automatically.
- Mark each card note in Obsidian's File Explorer with a left border matching its current list color.
- Rename card files when card titles change while preserving unique paths.
- Detect compatible Markdown cards created, modified, renamed, or deleted outside Task Deck.
- Re-import external changes automatically through vault events and a periodic reconciliation pass, with a manual re-import action available from settings and the board home.
- Repair duplicate card files and migrate legacy board layouts and media without discarding the current board data.
- Keep plugin interface state separate from the Markdown content stored in the vault.

### Commands and accessibility

- Open Task Deck from the ribbon, settings, or command palette.
- Add a card to the first list from the command palette.
- Undo the latest supported Board or Table change from the command palette.
- Use keyboard-focused flows such as Enter to open Table cards and Escape to cancel inline creation or editing.
- Preserve visible focus states, semantic labels, responsive layouts, and reduced-motion behavior.
- Run local boards without an account or network connection.

### Optional Sync Deck collaboration

- Enable or disable cloud collaboration features independently from local Task Deck usage.
- Sync board indexes, Markdown cards, and attachments across devices.
- Work in shared vaults with multiple members.
- Assign multiple members to a card and display their avatars on Board and Table views.
- Assign one member to an individual checklist task.
- See live member presence and smooth collaborative cursors on the board.
- Use card-level edit locks, heartbeats, and read-only fallback to prevent simultaneous edits from overwriting each other.
- Protect new and upgraded Sync Deck vault content with end-to-end encryption for files, paths, and the board/card identifiers used by presence and locks.

## Quick start

1. Open **Task Deck** from the ribbon or run `Task Deck: Open board` from the command palette.
2. Create a board. New boards start with **To do**, **Doing**, and **Done** lists.
3. Add cards inline, then drag them between lists as work moves forward.
4. Open a card to add labels, dates, a Markdown description, images, and named checklists.
5. Switch to **Table** when you want a compact overview across every list.

Use **Open note** in the card editor whenever you want to work directly in the underlying Markdown file.

## Markdown storage

Each board lives in its own readable folder:

```text
Product Launch/
├── Product Launch.md
├── cards/
│   ├── Prepare onboarding checklist.md
│   └── Write launch announcement.md
└── attachments/
```

The board index keeps list order and graph links connected. Card metadata lives in frontmatter, while the description and checklist remain ordinary Markdown. The plugin folder stores the local UI state; your task content stays in the vault.

## Sync across devices and teams

Task Deck works fully offline and does not require an account. To sync boards, install **Sync Deck**, sign in, and open or create a synced vault.

Sync Deck carries the board index, cards, and attachments across your devices. New and upgraded Sync Deck vaults end-to-end encrypt those files, their paths, and the board/card identifiers used for presence and locks; account and activity metadata still remain visible to the service. In shared vaults it also provides member assignment and live presence, so teammates can see who is viewing or editing a card. Local-only Task Deck usage remains unlimited.

## Install

Until Task Deck is available in the Obsidian community plugin directory:

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release of this repository.
2. Put the files in:

```text
Your Vault/.obsidian/plugins/task-deck/
```

3. Enable **Task Deck** in Obsidian under **Settings → Community plugins**.

## Development

Source files live in `src/`. After changing them, run:

```bash
node build.js
```

Obsidian loads the generated `main.js` file.

## Credits

This project originally used [ismailivanov/task-deck](https://github.com/ismailivanov/task-deck) as its base. It has since evolved into a substantially expanded implementation with a broader product direction, independent customization, and new workflows beyond the original plugin.

Credit and thanks to Ismail Ivanov for releasing the original project under the MIT License. You can support his work through [Buy Me a Coffee](https://buymeacoffee.com/carbon06).

## License

Kanux is distributed under the [GNU Affero General Public License version 3](LICENSE), with an [additional linking exception for Obsidian and the Obsidian Plugin API](OBSIDIAN-LINKING-EXCEPTION.md).

Portions derived from the original `ismailivanov/task-deck` project retain their original MIT copyright and permission notice in [LICENSES/MIT-upstream.txt](LICENSES/MIT-upstream.txt). See [NOTICE](NOTICE) for attribution details.
