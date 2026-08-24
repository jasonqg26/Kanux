# Kanux

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-f1c40f.svg)](LICENSE)

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

- **Board and table views** for the same set of Markdown-backed tasks.
- **Drag-and-drop workflow** for cards and list ordering.
- **Fast editing** with inline card creation, renaming, quick status changes, and undo while the Task Deck view is active.
- **Rich cards** with colored labels, start and due dates, Markdown descriptions, images, and multiple named, colored checklists with independent progress bars. Checklist items can open their own linked Markdown notes.
- **Multiple boards** with independent folders, lists, colors, and cards.
- **Normal Obsidian notes** that remain searchable, linkable, visible in graph view, and editable from the file explorer.
- **Automatic note discovery** for compatible Markdown cards created or edited outside Task Deck.
- **Optional collaboration** through Sync Deck, including shared boards, member assignment, and live presence.

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

[MIT](LICENSE)
