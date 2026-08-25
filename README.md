# Blackboard (Text fork)

Native stylus and Apple Pencil drawing for Obsidian.

> **This is a fork.** It tracks [jameswolensky/obsidian-blackboard](https://github.com/jameswolensky/obsidian-blackboard)
> **1.2.1** and adds a text tool (labels stored inside the `.blackboard` file), text in
> SVG export, an eraser that also erases labels, tool-selection commands with
> layout-independent Q/E/T keys, drag-a-rectangle drawing-area insertion, and a set of
> rendering/input performance fixes. Upstream is MIT-licensed by James Wolensky; see
> [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The plugin id is `blackboard-text` so it
> installs alongside upstream Blackboard. A drawing with **no** labels is written in the
> unchanged upstream format (version 3) and opens in upstream Blackboard as before; only a
> drawing that actually has labels is written at version 4.

Blackboard adds a `.blackboard` file type with pressure-sensitive freehand drawing and palm rejection, and lets you draw **directly** inside Obsidian Canvas nodes and Markdown embeds — no separate editor to open first. It is built for iPad with Apple Pencil, and works on desktop with a mouse.

<p align="center">
  <img src="assets/demo.gif" alt="Handwriting on Blackboard drawings inside an Obsidian Canvas on iPad" width="420">
</p>

## Features

- **Pressure-sensitive drawing** — Apple Pencil and stylus support with variable-width strokes via [perfect-freehand](https://github.com/steveruizok/perfect-freehand).
- **Draw in place** — Pen-down draws immediately on a Canvas node or a Markdown embed; there is no click-to-open step.
- **Palm rejection** — A stylus always draws; a resting palm or finger never does. Touch is reserved for navigation (see below), so your hand can rest on the screen while you write.
- **Touch navigation** — In a standalone `.blackboard` view, one finger pans and two fingers pinch-zoom the infinite canvas; on desktop, hold **Space** and drag to pan. The stylus keeps drawing throughout.
- **Pen, highlighter, eraser, text** — Solid pen strokes, semi-transparent highlighter, an eraser that removes strokes *and* labels, and crisp DOM text labels. Each tool keeps its own colour and size; for the text tool "size" is its font size.
- **Shapes** — Line, arrow, rectangle and ellipse tools. Drag to draw; hold **Shift** to constrain (15° angles, a square, a circle). A shape takes the pen's current colour and width and is stored as an ordinary stroke, so it erases, moves, exports and undoes exactly like something you drew by hand.
- **Selection** — Drag a marquee with the select tool to catch the strokes and labels **fully inside** it, then move, delete, or recolour them as a group. Each group operation is a single undo step.
- **Shape recognition (optional, off by default)** — Draw a rough circle, rectangle, triangle, line or arrow and have it snap to a clean one. It fires only when it is confident, never while you are handwriting, and one undo brings your original stroke straight back.
- **Blackboard or whiteboard** — The board background is a single setting; keep it black or set it white (or any color) for a whiteboard.
- **Shared floating toolbar** — One toolbar follows the active drawing. Tool, color, and brush size are global across every drawing on the page; it collapses to a corner pill.
- **Per-embed sizing** — Each embed's display size is controlled by its host (the Canvas node's geometry, or the `|WxH` size on a Markdown embed), never baked into the file. Resizing scales the drawing without distortion; strokes are clipped to the node and never resize it.
- **Automatic SVG export (optional)** — Export a vector `.svg` alongside each drawing on save.
- **Plain-JSON files** — `.blackboard` files are human-readable JSON that diffs cleanly in Git.

## How it compares

Blackboard focuses on fast, native pen drawing that lives inside your notes and canvases. [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) is a full diagramming tool; [Ink](https://github.com/daledesilva/obsidian_ink) is another handwriting plugin. They're built for different things.

| | Blackboard | Excalidraw | Ink |
|---|:--:|:--:|:--:|
| Draw directly on a Canvas node (no open-to-edit step) | ✓ | ✗ | ✗¹ |
| Live drawing in a Markdown embed | ✓ | ✗ | ✓² |
| Strokes reliably persist on reload | ✓ | ✓ | ⚠️³ |
| Plain-text, git-diffable files | ✓ | ✗⁴ | ✗⁴ |
| Diagramming: shapes, arrows, text | ✓⁵ | ✓ | ✗ |
| Primary focus | pen drawing | diagramming | handwriting |

<sub>
¹ Ink has no Canvas-node drawing — <a href="https://github.com/daledesilva/obsidian_ink/issues/89">obsidian_ink#89</a> (open as of 0.3.4).<br>
² Ink renders editable drawings in Markdown embeds today.<br>
³ Ink drawings can disappear on reload — <a href="https://github.com/daledesilva/obsidian_ink/issues/125">obsidian_ink#125</a> (open as of 0.3.4).<br>
⁴ Excalidraw stores drawing data compressed by default; Ink stores the tldraw document model; Blackboard files are plain, human-readable JSON.<br>
⁵ This fork adds line/arrow/rectangle/ellipse tools, text labels and marquee selection. It is still not a diagramming app — there are no connectors, no layers and no shape libraries — but simple diagrams no longer need a different plugin.
</sub>

Need rich diagramming? Use [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) — it's excellent at it.

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/jameswolensky/obsidian-blackboard/releases).
2. Create the folder `<vault>/.obsidian/plugins/blackboard/`.
3. Copy the three files into it.
4. Enable **Blackboard** in **Settings → Community plugins**.

### BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. **Add Beta Plugin** → `jameswolensky/obsidian-blackboard`.
3. Enable **Blackboard** in **Settings → Community plugins**.

## Usage

### Create a drawing

Run **Blackboard: New drawing** from the command palette. This creates a `.blackboard` file and opens it.

### The toolbar

A single floating toolbar follows whichever drawing is active. It holds the pen, highlighter, eraser, select, line, arrow, rectangle, ellipse and text tools; a color control (preset swatches plus a color wheel); a size control; undo/redo; and a button to collapse it to a small pill. Exactly one tool is active at a time, and the color and size controls always act on that tool's own values — the text tool has its own colour and font size, and its own font-size scale in the size popover. Tool, color, and size apply to **every** drawing on the page.

![The color control: preset swatches, a color wheel, and a brightness slider](assets/color.png)

### Shapes

Pick the line, arrow, rectangle or ellipse tool and drag on the drawing. Hold **Shift** while
dragging to constrain the shape: a line or arrow snaps to 15° increments, a rectangle becomes a
square, an ellipse becomes a circle. Shapes use the pen's current colour and width.

A shape is stored as an ordinary stroke — a tessellated point list, not a separate object — so
the eraser, the marquee, undo/redo, SVG export and the file format treat it exactly like a
freehand stroke, and a drawing full of shapes still opens in upstream Blackboard 1.2.1. The
trade-off is deliberate: a committed shape cannot be re-edited as a parametric rectangle later.

### Selecting and moving things

Pick the select tool and drag a rectangle over the board. Everything **completely inside** it —
strokes and labels alike — is selected; a stroke that merely crosses the rectangle is not (the
eraser is the tool for "whatever I sweep over"). Then:

- **drag** anywhere inside the selection to move it,
- press **Delete** or **Backspace** to remove it,
- pick a **colour** from the toolbar to recolour it.

Each of those is one undo step. The selection clears when you press **Escape**, click empty
space, switch tools, or switch drawings. (Delete/Backspace are bound in the standalone
`.blackboard` view only — inside a Canvas node or a Markdown embed those keys belong to the
host.)

### Shape recognition

Turn on **Recognize shapes** in settings, and a freehand stroke that is clearly a circle,
rectangle, triangle, line or arrow is replaced by a clean shape when you lift the pen. The
recogniser is deliberately shy: it measures the stroke's closure, the area ratios of its convex
hull, its corners and its straightness, and stays silent unless the result is unambiguous, so
handwriting, scribbles and open curves are left exactly as drawn. The replacement is its own
undo step — one **Ctrl+Z** restores your original stroke, a second removes it.

### Embed in a Canvas

1. Open an Obsidian Canvas.
2. Use the Canvas card menu's drawing button, or **Blackboard: Insert drawing**, to add a drawing node.
3. Draw on it directly with a stylus. Resize the Canvas node to scale the drawing.

![A Blackboard drawing living in an Obsidian Canvas node, next to a text card](assets/canvas.png)

### Embed in a Markdown note

Embed a drawing like any file: `![[My Drawing.blackboard]]`. Set a size with the standard Obsidian syntax, e.g. `![[My Drawing.blackboard|640x480]]` or `![[My Drawing.blackboard|100%]]`. You can draw on the embed directly.

![A Blackboard drawing embedded inline in a Markdown note, between paragraphs of text](assets/embed.png)

### Text labels

Pick the **T** tool and tap the drawing to place a label; type and click away to commit it. Labels live **inside** the `.blackboard` file, so they travel with the drawing when it is copied, duplicated, synced or exported.

With the text tool active a label can be:

- **edited** — click it (or double-click it at any time);
- **moved** — drag it; the whole drag is one undo step;
- **deleted** — click to select it (it gets a dashed outline), then press **Delete** or **Backspace**. **Escape** clears the selection, and again leaves the text tool.

With the **eraser** active, dragging over a label removes it, exactly like a stroke. The whole erase gesture is one undo step.

Creating, editing, moving, deleting and erasing labels all go on the same undo stack — and through the same save — as your strokes, so **Ctrl/Cmd+Z** walks back through drawing and text in the order you did them.

**Migrating from the old sidecar.** Earlier versions of this fork kept labels in a
`<drawing>.blackboard-text.json` file next to the drawing. The first time such a drawing is
opened, its labels are imported into the `.blackboard` file and the sidecar is renamed to
`…json.migrated` rather than deleted — nothing is thrown away, and you can remove the
`.migrated` files yourself once you are happy. A sidecar the plugin cannot fully parse is
left exactly as it is (and the problem is logged to the developer console) rather than
destroyed.

### Export

Enable **Auto-export SVG** in settings to write a `.svg` next to each drawing whenever it is saved (renames and deletes are kept in sync). Set **SVG export path** to collect exports in one folder. Text labels are exported as real SVG `<text>` elements, on top of the strokes, and the exported viewBox is sized to include them.

## Commands

| Command | Description |
|---|---|
| New drawing | Create a new `.blackboard` file and open it |
| Insert drawing | Create a drawing and embed it at the cursor in a note, or as a node in the active Canvas |
| Insert existing drawing | Pick an existing `.blackboard` file and embed it at the cursor / in the active Canvas |
| Draw drawing area | Drag a rectangle in the editor to create a drawing of that size |
| Select pen / highlighter / eraser / text tool | Select that tool on the active drawing (inert when no drawing is live) |
| Select selection / line / arrow / rectangle / ellipse tool | Select that tool on the active drawing (inert when no drawing is live) |

The tool commands ship with **no default hotkeys** — bind whatever you like in
**Settings → Hotkeys**. Independently of that, the fork's original **Q** (pen), **E**
(eraser) and **T** (text) keys keep working while you are working on a drawing: they match
the *physical* key, so they stay under the same fingers on a Cyrillic (or any other)
layout, where Obsidian's own hotkeys — which match the produced character — would not.
Give one of those commands a hotkey of your own and its physical-key shortcut steps aside,
leaving Obsidian in charge of that key. The shortcuts never fire while you are typing, with
a modifier held, or on key repeat. The selection and shape tools get commands but no
physical-key shortcut at all — claiming five more keys on every layout for shortcuts nobody
has been pressing is exactly what that rule exists to prevent.

## Settings

![The Blackboard settings tab: file storage, drawing defaults, and input options](assets/settings.png)

| Setting | Default | Description |
|---|---|---|
| Drawing folder | `Blackboard` | Folder for new drawing files |
| New file location | Fixed folder | Create new drawings in the fixed folder, or alongside the active file |
| Auto-export SVG | Off | Write an `.svg` alongside each drawing on save |
| SVG export path | (same folder) | Folder for exported SVGs (shown when Auto-export SVG is on) |
| Board background | `#000000` | Color painted behind every drawing — set white for a whiteboard |
| Recognize shapes | Off | Snap an obvious freehand circle/rectangle/triangle/line/arrow to a clean shape on release (one undo restores the original) |
| Toolbar palette (Color 1–8) | see below | The eight swatches in the toolbar color popover |
| Show toolbar pill | On | Show the collapsed pen-icon pill on Canvas with no active drawing |

The default toolbar palette is `#000000`, `#ffffff`, `#ff0000`, `#0000ff`, `#00ff00`, `#ffff00`, `#ffa500`, `#800080`. Pen, highlighter, and eraser sizes and colors are chosen live from the floating toolbar; they are not separate settings. The text tool's colour and font size are also chosen from the toolbar, but they persist between sessions (`textColor` / `textFontSize` in the plugin's data file; existing files without them fall back to white at 20).

## Compatibility

| Platform | Input | Notes |
|---|---|---|
| iPad + Apple Pencil | Full pressure | Primary target |
| iPad (touch) | Navigation only | One finger pans, two-finger pinch zooms; the stylus draws |
| Android tablet + stylus | Pressure varies by device | Supported |
| Desktop (mouse) | Uniform width (no pressure) | Supported |

## File format

`.blackboard` files are JSON:

```json
{
  "version": 4,
  "width": 320,
  "height": 240,
  "strokes": [
    {
      "id": "abc123",
      "tool": "pen",
      "color": "#ffffff",
      "size": 2,
      "opacity": 1,
      "points": [[100, 200, 0.5], [101, 201, 0.6]],
      "hasPressure": true,
      "timestamp": 1711281600000
    }
  ],
  "background": { "color": "transparent" },
  "contentBounds": { "x": 80, "y": 180, "width": 60, "height": 50 },
  "text": {
    "version": 1,
    "items": [
      { "id": "def456", "x": 120, "y": 210, "text": "label", "fontSize": 20, "color": "#ffffff" }
    ]
  }
}
```

Each stroke is an array of `[x, y, pressure]` points in drawing-space. **Shapes are strokes**:
a rectangle or ellipse is stored as its tessellated point list with `"hasPressure": true` and a
constant pressure (which is what gives it an even width), so nothing in the format — and
nothing in any older reader — has to know that shape tools exist. `width`/`height` and `contentBounds` cache the strokes' bounding box for previews and are recomputed from the strokes; display size is decided by each embed, not the file. Files from earlier versions are read without loss.

`text` holds the labels, in the same drawing-space coordinates as the strokes, and is
**omitted entirely** from a drawing that has none — such a file stays at `"version": 3` and is
byte-identical to what upstream Blackboard writes. A drawing that does carry labels is written
at `"version": 4`; older readers will treat it as read-only rather than silently dropping the
text. A `text` block this build cannot parse costs the drawing its labels, never the drawing.

## Development

Requires **Node.js 24** and npm.

```bash
npm install
npm run dev      # watch build
npm run build    # production build
npm test         # unit tests (Vitest)
npm run check    # typecheck + tests + build
```

iPad-specific rendering (Apple WebKit) can't be reproduced by the desktop/Electron test runner; verify anything iPad-specific manually in the iOS Simulator (requires Xcode). The static harnesses in `test/webkit/` render the toolbar and engine in real WebKit for that.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and conventions.

## Built with

- [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT) — pressure-sensitive stroke geometry
- [iro.js](https://github.com/jaames/iro.js) (MPL-2.0) — the color wheel

## License

[MIT](LICENSE) © James Wolensky
