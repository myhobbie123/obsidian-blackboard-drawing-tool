/**
 * A text label placed on a drawing. Positions are in DRAWING space (the same coordinate
 * system as stroke points), so a label follows the drawing through pan, zoom and re-fit.
 *
 * Text lives INSIDE the `.blackboard` document (the file's `text` field), so it travels with
 * the drawing when it is copied, exported, synced or duplicated, and rides the one
 * commit/save/undo pipeline the strokes already use. Drawings written before wave 2 kept
 * their labels in a `<drawing>.blackboard-text.json` sidecar; those are imported once (see
 * `application/text-migration`) and the sidecar is retired.
 */
export interface TextItem {
  id: string;
  x: number;
  y: number;
  text: string;
  /** Font size in drawing units (scaled by the view transform when rendered). */
  fontSize: number;
  color: string;
}

export const DEFAULT_TEXT_FONT_SIZE = 20;
export const DEFAULT_TEXT_COLOR = '#ffffff';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** The minimum an entry must have to be a usable label; `fontSize`/`color` are repairable. */
export function isValidTextItem(raw: unknown): boolean {
  return isRecord(raw) &&
    typeof raw.id === 'string' &&
    typeof raw.x === 'number' && Number.isFinite(raw.x) &&
    typeof raw.y === 'number' && Number.isFinite(raw.y) &&
    typeof raw.text === 'string';
}

/** Fill in the optional fields of an already-valid entry. */
export function normalizeTextItem(raw: unknown): TextItem {
  const r = raw as Record<string, unknown>;
  return {
    id: r.id as string,
    x: r.x as number,
    y: r.y as number,
    text: r.text as string,
    fontSize: typeof r.fontSize === 'number' && Number.isFinite(r.fontSize) && r.fontSize > 0
      ? r.fontSize
      : DEFAULT_TEXT_FONT_SIZE,
    color: typeof r.color === 'string' && r.color !== '' ? r.color : DEFAULT_TEXT_COLOR,
  };
}

/**
 * A label's box in DRAWING units. Labels are DOM, so their real size comes from the layer
 * (`offsetWidth`/`offsetHeight` divided by the view scale). Where no measurement exists yet
 * — a label that has never been laid out, or a headless caller — `estimateTextItemBox`
 * approximates it from the font size, which is enough for hit-testing.
 */
export interface TextItemBox {
  width: number;
  height: number;
}

/** Ratio of glyph advance to font size used by the estimate. Deliberately generous. */
const AVERAGE_GLYPH_RATIO = 0.55;
/** Matches the .blackboard-text-item line-height in styles.css. */
export const TEXT_LINE_HEIGHT = 1.25;
/**
 * Baseline position inside one line box, as a fraction of the font size. A label is
 * positioned by its TOP-LEFT everywhere else in the plugin, but SVG `<text>` is positioned by
 * its BASELINE, so the exporter needs this to put a label where the screen shows it: half the
 * leading ((1.25 - 1) / 2) plus a typical ascent (0.8em).
 */
export const TEXT_BASELINE_RATIO = (TEXT_LINE_HEIGHT - 1) / 2 + 0.8;

/** Baseline offset (drawing units) of line `line` of a label from the label's top edge. */
export function textBaselineOffset(fontSize: number, line: number): number {
  return (TEXT_BASELINE_RATIO + line * TEXT_LINE_HEIGHT) * fontSize;
}

export function estimateTextItemBox(item: TextItem): TextItemBox {
  const lines = item.text.split('\n');
  const longest = lines.reduce((n, line) => Math.max(n, line.length), 0);
  return {
    width: Math.max(item.fontSize * 0.4, longest * item.fontSize * AVERAGE_GLYPH_RATIO),
    height: Math.max(1, lines.length) * item.fontSize * TEXT_LINE_HEIGHT,
  };
}

/**
 * Whether a drawing-space point lands on a label. The label's anchor (`x`,`y`) is its
 * TOP-LEFT — the same corner the layer positions it by — so the box extends right and down.
 * `tolerance` (drawing units) widens the box so a label is not pixel-precise to grab.
 */
export function hitTestTextItem(
  item: TextItem,
  x: number,
  y: number,
  box?: TextItemBox,
  tolerance = 0,
): boolean {
  const b = box ?? estimateTextItemBox(item);
  return x >= item.x - tolerance &&
    x <= item.x + b.width + tolerance &&
    y >= item.y - tolerance &&
    y <= item.y + b.height + tolerance;
}

/**
 * The topmost label under a point. Later items are painted over earlier ones, so the search
 * runs backwards — clicking overlapping labels grabs the one you can actually see.
 */
export function textItemAt(
  items: TextItem[],
  x: number,
  y: number,
  boxFor?: (item: TextItem) => TextItemBox | undefined,
  tolerance = 0,
): TextItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (hitTestTextItem(items[i], x, y, boxFor?.(items[i]), tolerance)) return items[i];
  }
  return null;
}

/**
 * Parse the `items` of a stored text layer (a sidecar, or the `.blackboard` file's own `text`
 * field). Tolerant by construction: anything that is not an array yields no labels, and
 * individual malformed entries are dropped rather than failing the whole drawing — refusing
 * to open a drawing over one bad label would be strictly worse than showing the rest.
 */
export function parseTextItems(raw: unknown): TextItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidTextItem).map(normalizeTextItem);
}

/** Whether any entry of `raw` had to be dropped by `parseTextItems` (i.e. data we cannot read). */
export function hasUnreadableTextItems(raw: unknown): boolean {
  if (!Array.isArray(raw)) return true;
  return raw.some((entry) => !isValidTextItem(entry));
}

/**
 * Circle-vs-box overlap, in drawing units and without allocating: the eraser is a disc swept
 * along a pointer path, and this runs once per label per pointermove sample. Takes the box as
 * loose numbers precisely so the caller can keep its measurements in flat arrays and never
 * build an object inside the hot loop.
 */
export function textBoxHitByCircle(
  x: number,
  y: number,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  const nx = cx < x ? x : cx > x + width ? x + width : cx;
  const ny = cy < y ? y : cy > y + height ? y + height : cy;
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= radius * radius;
}
