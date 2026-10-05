# Blackboard Text

Blackboard Text adds handwriting and drawing boards to your notes, Markdown embeds, and Canvas cards. Use a mouse or stylus to draw, add text labels and shapes, and select content on a shared drawing surface.

## Fork notice

This is a fork of [Blackboard](https://github.com/jameswolensky/obsidian-blackboard) by James Wolensky (MIT). It is substantially modified and not affiliated with or endorsed by the original author.

## What's different from upstream

- A text tool with editable, movable labels stored inside the drawing and included in SVG exports. Older text sidecars are imported on first open.
- Physical-key shortcuts: **Q** for pen, **E** for eraser, and **T** for text, including on non-Latin keyboard layouts. Custom command bindings take precedence.
- Line, arrow, rectangle, and ellipse tools, plus marquee selection to move, recolor, or delete strokes and labels together.
- A **Draw drawing area** command: drag a rectangle in the source editor to insert a drawing of that size.
- Guards against an untouched empty view overwriting an existing board, and against teardown clearing saved content.
- A canvas rendering fix for invisible committed strokes caused by desynchronized canvas compositing.

## Features / usage

Create a board with **Blackboard Text: New drawing** in the command palette. Use **Insert drawing** or **Insert existing drawing** in a note or Canvas. Drawing files use the `.blackboard` extension and can also be opened directly.

Embed a board in Markdown with `![[Drawing.blackboard]]`. Set an explicit embed size with `![[Drawing.blackboard|600x400]]` or `![[Drawing.blackboard|80%]]`.

The floating toolbar offers pen, highlighter, eraser, text, selection, and shape tools, with color and size controls and undo/redo. In text mode, click the board to add a label. Select the selection tool and drag a rectangle around strokes or labels to work with them as a group. Q/E/T switch tools while working on a drawing and do not intercept typing. Tool commands can also be bound in **Settings -> Hotkeys**.

Settings include the drawing folder, board background, toolbar palette, optional shape recognition, and automatic SVG export. Text is stored in the `.blackboard` file; plugin preferences are stored separately in the plugin's `data.json`.

Screenshots are from the original Blackboard; the fork's UI differs slightly.

![Drawing in a Canvas card](assets/canvas.png)
![Drawing embedded in a note](assets/embed.png)
![Drawing tools demonstration](assets/demo.gif)
![Color controls](assets/color.png)
![Plugin settings](assets/settings.png)

## Installation

### BRAT (recommended)

1. Install and enable **BRAT** from Obsidian's community plugins.
2. In BRAT, choose **Add Beta plugin** and enter `myhobbie123/obsidian-blackboard-text`.
3. Enable **Blackboard Text** in your installed plugins.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest GitHub Release](https://github.com/myhobbie123/obsidian-blackboard-text/releases/latest). Put all three files in `<vault>/.obsidian/plugins/blackboard-text/`, reload Obsidian, and enable **Blackboard Text**.

Do not enable this fork and the original Blackboard together in the same vault. Their plugin IDs differ, but both register the `blackboard-view` view type and `.blackboard` file extension, so they conflict.

## Data & privacy

The production plugin makes no network requests and includes no telemetry. Drawings, labels, settings, and SVG exports stay in your vault; any syncing is managed by your own vault setup. File deletion initiated by the plugin uses Obsidian's trash handling and follows your trash settings. Erasing strokes or labels edits the drawing and can be undone with the drawing's undo controls.

## Building from source

Use **Node.js 24**, as specified in `.nvmrc`.

```sh
npm ci
npm run build
npm run check
```

`npm run check` runs typechecking, lint, unit tests, and a production build. The build writes the ignored root `main.js` with the license and third-party notices retained; `manifest.json` and `styles.css` are shipped directly from the repository. Development builds include a local reload bridge; production builds exclude it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development.

## Releasing

Bump the version in `package.json`, the two root version fields in `package-lock.json`, and `manifest.json`, and add its minimum app version to `versions.json`. Alternatively, `npm version <version> --no-git-tag-version` updates these through the version hook. Run `npm run check`, commit the changes, then create a tag equal to the manifest version with **no `v` prefix** and push that tag. The release workflow validates the version, builds and attests the assets, and attaches `main.js`, `manifest.json`, and `styles.css` to the GitHub Release.

Distribution is through GitHub Releases and BRAT; this fork is not submitted to the community plugin catalog.

## License & credits

[MIT](LICENSE). Original work &copy; 2026 James Wolensky; fork changes &copy; 2026 Tatyana. Bundled third-party packages and their licenses are listed in [NOTICE](NOTICE).
