# Blackboard Drawing Tool

Draw by hand right inside your Obsidian notes. A board lives in the note like a picture, but you can keep drawing on it, move it anywhere in the text, and let the text wrap around it.

🇷🇺 [Русская версия](README.ru.md)

## Features

- **Draw inside a note** with a mouse, pen tablet or stylus. No separate app, no switching windows.
- **Tools:** pen, highlighter, eraser, text labels, shapes (line, arrow, rectangle, ellipse) and selection.
- **Colors and sizes** for every tool, plus undo/redo.
- **Quick keys:** **Q** pen, **E** eraser, **T** text. They work on any keyboard layout.
- **Resize** a board by dragging its edges.
- **Move a board anywhere in the note:** grab the ⠿ handle (or hold **Alt** and drag the board) and drop it between any lines, even between list items.
- **Text wrap like in Word:** put the board on the left or right and the text flows beside it (in Reading view; experimental while editing).
- **Works in Canvas** cards and as a standalone drawing file.
- **Optional SVG export** of every drawing.
- **Private:** no internet access, no tracking. Everything stays in your vault.

## Installation

### With BRAT (recommended, updates automatically)

1. In Obsidian open **Settings → Community plugins**. If you see *Restricted mode*, turn it off.
2. Click **Browse**, search for **BRAT**, click **Install**, then **Enable**.
3. Press **Ctrl+P** (Cmd+P on Mac), type **BRAT** and choose **Add a beta plugin for testing**.
4. Paste `myhobbie123/obsidian-blackboard-drawing-tool` and click **Add plugin**.
5. Back in **Settings → Community plugins**, turn on **Blackboard Drawing Tool**.

### Manually

1. Open the [latest release](https://github.com/myhobbie123/obsidian-blackboard-drawing-tool/releases/latest) and download `main.js`, `manifest.json` and `styles.css`.
2. In your vault, create the folder `.obsidian/plugins/blackboard-text/` (the `.obsidian` folder is hidden — turn on hidden files in your file manager).
3. Put the three files there, restart Obsidian and turn on **Blackboard Drawing Tool** in **Settings → Community plugins**.

Don't enable this plugin together with the original Blackboard in the same vault — they conflict.

## Quick start

1. Open a note, press **Ctrl+P** and run **Blackboard Drawing Tool: Insert drawing**. A board appears in the note.
2. Draw. Switch tools on the toolbar or with **Q / E / T**.
3. To move the board, hover it, grab the **⠿** handle and drop it where you want. **Ctrl+Z** undoes the move.
4. To wrap text around it, click **◧** (board left) or **◨** (board right). **↔** puts it back in the center.

## Fork notice

This is a fork of [Blackboard](https://github.com/jameswolensky/obsidian-blackboard) by James Wolensky (MIT). It is substantially modified and not affiliated with or endorsed by the original author.

## What's different from upstream

- A text tool with editable, movable labels stored inside the drawing and included in SVG exports. Older text sidecars are imported on first open.
- Physical-key shortcuts: **Q** for pen, **E** for eraser, and **T** for text, including on non-Latin keyboard layouts. Custom command bindings take precedence.
- Line, arrow, rectangle, and ellipse tools, plus marquee selection to move, recolor, or delete strokes and labels together.
- A **Draw drawing area** command: drag a rectangle in the source editor to insert a drawing of that size.
- Guards against an untouched empty view overwriting an existing board, and against teardown clearing saved content.
- A canvas rendering fix for invisible committed strokes caused by desynchronized canvas compositing.

## Usage details

Create a board with **Blackboard Drawing Tool: New drawing** in the command palette. Use **Insert drawing** or **Insert existing drawing** in a note or Canvas. Drawing files use the `.blackboard` extension and can also be opened directly.

Embed a board in Markdown with `![[Drawing.blackboard]]`. Set an explicit embed size with `![[Drawing.blackboard|600x400]]` or `![[Drawing.blackboard|80%]]`.

The floating toolbar offers pen, highlighter, eraser, text, selection, and shape tools, with color and size controls and undo/redo. In text mode, click the board to add a label. Select the selection tool and drag a rectangle around strokes or labels to work with them as a group. Q/E/T switch tools while working on a drawing and do not intercept typing. Tool commands can also be bound in **Settings -> Hotkeys**.

Settings include the drawing folder, board background, toolbar palette, optional shape recognition, and automatic SVG export. Text is stored in the `.blackboard` file; plugin preferences are stored separately in the plugin's `data.json`.

Screenshots are from the original Blackboard; the fork's UI differs slightly.

![Drawing in a Canvas card](assets/canvas.png)
![Drawing embedded in a note](assets/embed.png)
![Drawing tools demonstration](assets/demo.gif)
![Color controls](assets/color.png)
![Plugin settings](assets/settings.png)

## Moving and wrapping boards

Hover or focus a board to reveal four frame controls: **grip**, **Center**, **Left**, and **Right**. In **Live Preview**, hold the 32px grip and move at least **4px**, or **Alt+press anywhere on the board** to grab without drawing. A semi-transparent outline follows the mouse at the original grab offset. The insertion caret shows the exact line boundary: the upper half of the visual text line selects before that Markdown line; the lower half selects after it. Release to place the board. The pane auto-scrolls near its edges; **Escape** cancels.

Drop slots include the top of the note after properties, the end, every list item (including nested and numbered items), and every paragraph line. In a list, the board becomes a continuation of the previous item, using that item's content indentation. No extra marker or blank line is inserted, so numbering continues:

```md
- First item
  ![[Drawing.blackboard|right|300]]
- Next item
```

Elsewhere, the embed occupies its own line. Each adjacent nonempty block gets exactly one blank separator if a blank line is not already present. Dropping between paragraph lines adds a blank line on each side of the board; the paragraph becomes two paragraphs around it. Existing blank gaps count as separation. The note's LF/CRLF format and final-newline policy are retained.

Only the selected embed token is extracted, including from prose, list items, quotes and glued pairs such as `Text.![[A.blackboard]]![[B.blackboard]]`. Extraction removes one adjacent ASCII space (preferring the preceding space), preserves punctuation and other tokens, trims trailing source-line whitespace, removes a vacated board line or empty list item, and collapses its adjacent blank lines to at most one. An empty parent list item with children is refused rather than orphaning its children. Dropping a board already on its own line into its current gap writes nothing. Every successful move is one isolated editor transaction and one undo.

Pointer targets inside frontmatter, fenced/indented code, tables and math blocks are refused with a Notice. Source code (including backticks), enclosing links, mixed line endings, unresolved identical occurrences and unsupported opaque syntax also refuse without a write. Whole protected blocks can be crossed. Canvas boards have no note placement controls. Reading view does not move boards; use Live Preview. Reading-view wrap controls stay clickable and explain how to switch to editing.

**Move board up/down** commands remain available without default hotkeys; these retain their previous top-level block semantics. In Source mode put the cursor inside the selected embed token. **Put on its own line** is available only by right-clicking the grip, and retains extraction after the containing block. Selecting left/right on an inline board still extracts before the containing block and writes the layout in the same transaction; Center changes the alias in place.

For diagnostics only, set `"debugDrag": true` in the plugin's settings JSON. It defaults off and has no settings UI. The console records `[bb-drag]` acceptance/refusal, pointer capture, first movement, slot line numbers and drop results. Turn it off after diagnosis.

Use **Center**, **Board left, text on the right**, or **Board right, text on the left** in the frame. Layout and size are separate pipe-delimited alias tokens:

```md
![[Drawing.blackboard]]
![[Drawing.blackboard|left|400x300]]
![[Drawing.blackboard|right|100%x400]]
```

Token order is flexible on read; edits write layout before size. Center is the default and is omitted on write. Unknown tokens survive rewrites; conflicting layout or size tokens are refused. Resizing preserves layout. All existing size aliases (`640x480`, `300`, `100%`, `100%x400`) remain supported.

**Reading view and PDF export** float left/right boards, capped at 60% of the note width, with headings clearing the wrap and floats contained within the note. Following lists get a formatting context to keep their markers beside the board. Panes narrower than 500px center boards automatically without changing their aliases. By default, **Live Preview** centers the board and displays a clickable `wrap: right — shown in Reading view` badge (or left). Click it to open the plugin settings.

**Wrap text around boards while editing (experimental)** is off by default. Turning it on applies real floats in Live Preview and requests CM6 remeasurement after layout changes and board/pane resize. This opt-in can affect caret mapping, selection and scrolling: turn it off if those become unstable. Offline fixtures verify CSS and browser geometry; Obsidian runtime editing and PDF checks still need owner verification. To rerun the installed-Chrome offline fixture, use `node scripts/check-wrap-fixture.mjs` (no downloads; output in ignored `release/wrap-fixture/`).

### Conflict with the original Blackboard

The plugin IDs differ, but both plugins register the `blackboard-view` view type and the `.blackboard` file extension, so only one of them can be enabled in a vault.

## Data & privacy

The production plugin makes no network requests and includes no telemetry. Drawings, labels, settings, and SVG exports stay in your vault; any syncing is managed by your own vault setup. File deletion initiated by the plugin uses Obsidian's trash handling and follows your trash settings. Erasing strokes or labels edits the drawing and can be undone with the drawing's undo controls.

## Building from source

Use **Node.js 24**, as specified in `.nvmrc`.

```sh
npm ci
npm run build
npm run check
```

`npm run check` runs typechecking, lint, unit tests and a production build (this is what CI runs). `npm run check:local` additionally runs the real CodeMirror drag harness in an installed Chromium; it needs full git history and writes evidence to ignored `release/drag-fixture/`. Run the harness alone with `npm run test:drag`. Set `CHROME_PATH` if Chromium is installed outside the standard Chrome location. No browser download or local HTTP server is used. The build writes the ignored root `main.js` with the license and third-party notices retained; `manifest.json` and `styles.css` are shipped directly from the repository. Development builds include a local reload bridge; production builds exclude it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development.

## Releasing

Bump the version in `package.json`, the two root version fields in `package-lock.json`, and `manifest.json`, and add its minimum app version to `versions.json`. Alternatively, `npm version <version> --no-git-tag-version` updates these through the version hook. Run `npm run check`, commit the changes, then create a tag equal to the manifest version with **no `v` prefix** and push that tag. The release workflow validates the version, builds and attests the assets, and attaches `main.js`, `manifest.json`, and `styles.css` to the GitHub Release.

Distribution is through GitHub Releases and BRAT; this fork is not submitted to the community plugin catalog.

## License & credits

[MIT](LICENSE). Original work &copy; 2026 James Wolensky; fork changes &copy; 2026 Tatyana. Bundled third-party packages and their licenses are listed in [NOTICE](NOTICE).
