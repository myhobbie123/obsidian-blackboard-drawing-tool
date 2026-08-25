/**
 * Drag geometry for text labels, kept free of the DOM so the one rule that decides between
 * "the user clicked this label" and "the user is moving this label" is directly testable.
 */

export interface DragPoint {
  x: number;
  y: number;
}

/**
 * How far (in screen px) a pointer must travel before a press on a label becomes a move.
 * Below it the gesture is a click and opens the editor. Sized for a stylus on iPad: small
 * enough that a deliberate drag registers at once, large enough that a tap — which always
 * wobbles a pixel or two — still opens the editor rather than nudging the label.
 */
export const TEXT_DRAG_THRESHOLD_PX = 4;

/** Straight difference between two points, in whatever space they were measured. */
export function dragDelta(from: DragPoint, to: DragPoint): { dx: number; dy: number } {
  return { dx: to.x - from.x, dy: to.y - from.y };
}

export function exceedsDragThreshold(dx: number, dy: number, threshold = TEXT_DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}
