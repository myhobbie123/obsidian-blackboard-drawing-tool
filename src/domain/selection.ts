import type { Stroke } from './entities';
import { strokeBox } from './stroke-cache';
import type { TextItem, TextItemBox } from './text-item';
import { estimateTextItemBox } from './text-item';

/**
 * Marquee selection: drag a rectangle over the board and act on everything inside it. This is
 * the DRAWING-SPACE geometry only — no DOM, no gesture state — so the one rule that decides
 * what a marquee catches is directly testable.
 *
 * HIT DETERMINATION: an item is selected when it is FULLY CONTAINED by the marquee (its
 * axis-aligned bounding box lies inside the rectangle, edges inclusive), not when it merely
 * intersects it. Two reasons:
 *
 *  - Predictability. The eraser is intersection-based because it is a physical disc the user
 *    sweeps over what they want gone; a marquee is a statement about a region, and on a dense
 *    sketch an intersection rule grabs half the drawing the moment the rectangle clips a long
 *    stroke. "Everything I drew a box around" is what people mean, and it matches what every
 *    other drawing tool in Obsidian's orbit does.
 *  - Exactness for free. For CONTAINMENT the cached AABB test is not merely a broad phase, it
 *    is the whole answer: every point of a stroke lies inside its own box, so a contained box
 *    means contained points and a non-contained box means at least one point outside. There is
 *    no narrow phase to get wrong, and the cached `strokeBox` (invalidated by `moveStroke`) is
 *    the only geometry read per stroke.
 */
export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A drag's two corners as a normalised rectangle (either drag direction works). */
export function marqueeRect(x0: number, y0: number, x1: number, y1: number): SelectionRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** Whether a box lies inside the rectangle. Edges count as inside. */
export function rectContainsBox(
  rect: SelectionRect,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  return minX >= rect.x && maxX <= rect.x + rect.width &&
    minY >= rect.y && maxY <= rect.y + rect.height;
}

export function rectContainsPoint(rect: SelectionRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * Whether a stroke is caught by the marquee. A stroke with no points is never selected: its
 * cached box is the inverted/empty box, which no rectangle can contain.
 */
export function strokeInMarquee(stroke: Stroke, rect: SelectionRect): boolean {
  if (stroke.points.length === 0) return false;
  const box = strokeBox(stroke);
  return rectContainsBox(rect, box.minX, box.minY, box.maxX, box.maxY);
}

export function selectStrokesIn(strokes: readonly Stroke[], rect: SelectionRect): string[] {
  const ids: string[] = [];
  for (const stroke of strokes) {
    if (strokeInMarquee(stroke, rect)) ids.push(stroke.id);
  }
  return ids;
}

/**
 * Whether a label is caught by the marquee. Its box is measured by the caller where a DOM
 * measurement exists, and estimated from the font size otherwise — the same two-tier rule the
 * eraser and the label hit-test already use.
 */
export function textItemInMarquee(
  item: TextItem,
  rect: SelectionRect,
  box?: TextItemBox,
): boolean {
  const b = box ?? estimateTextItemBox(item);
  return rectContainsBox(rect, item.x, item.y, item.x + b.width, item.y + b.height);
}

export function selectTextItemsIn(
  items: readonly TextItem[],
  rect: SelectionRect,
  boxFor?: (item: TextItem) => TextItemBox | undefined,
): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (textItemInMarquee(item, rect, boxFor?.(item))) ids.push(item.id);
  }
  return ids;
}

/**
 * The bounding box of a selection, in drawing units, or null when it is empty. Used to draw
 * the selection chrome and to decide whether a press lands "on" the selection (which starts a
 * group move rather than a new marquee).
 */
export function selectionBounds(
  strokes: readonly Stroke[],
  strokeIds: ReadonlySet<string>,
  items: readonly TextItem[] = [],
  textIds: ReadonlySet<string> = new Set(),
  boxFor?: (item: TextItem) => TextItemBox | undefined,
): SelectionRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;

  for (const stroke of strokes) {
    if (!strokeIds.has(stroke.id) || stroke.points.length === 0) continue;
    const box = strokeBox(stroke);
    found = true;
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
  }
  for (const item of items) {
    if (!textIds.has(item.id)) continue;
    const b = boxFor?.(item) ?? estimateTextItemBox(item);
    found = true;
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.x + b.width > maxX) maxX = item.x + b.width;
    if (item.y + b.height > maxY) maxY = item.y + b.height;
  }
  if (!found) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Slack (drawing units) added around the selection box when deciding whether a press grabs the
 * selection to move it. Without it a thin selection is nearly impossible to grab on a stylus.
 */
export const SELECTION_GRAB_TOLERANCE = 6;

/** Whether a press at (x, y) should start a group move of the current selection. */
export function hitsSelection(
  bounds: SelectionRect | null,
  x: number,
  y: number,
  tolerance = SELECTION_GRAB_TOLERANCE,
): boolean {
  if (!bounds) return false;
  return rectContainsPoint(
    {
      x: bounds.x - tolerance,
      y: bounds.y - tolerance,
      width: bounds.width + tolerance * 2,
      height: bounds.height + tolerance * 2,
    },
    x,
    y,
  );
}

/**
 * Below this drag distance (screen px) a select-tool gesture is a CLICK, not a marquee: it
 * clears the selection instead of selecting the zero-area rectangle under the cursor.
 */
export const MARQUEE_MIN_DRAG_PX = 3;

export function isMarqueeDrag(dx: number, dy: number, threshold = MARQUEE_MIN_DRAG_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}
