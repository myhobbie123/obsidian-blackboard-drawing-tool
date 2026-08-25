/**
 * Pure geometry for the Markdown-embed resize handles (see `attachResizeHandles` in
 * `embed.ts`). Deliberately DOM-free so the edge/corner rules and the minimum-size
 * clamp are unit-testable without a layout engine.
 */

/** The eight handle positions, in the order they are appended to the embed. */
export const RESIZE_DIRECTIONS = [
  'top', 'bottom', 'left', 'right',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
] as const;

export type ResizeDirection = (typeof RESIZE_DIRECTIONS)[number];

/** Smallest box a drag may produce. Mirrors `.blackboard-embed`'s min-width/min-height. */
export const MIN_EMBED_WIDTH = 150;
export const MIN_EMBED_HEIGHT = 100;

export interface ResizeStart {
  /** Box size when the drag began, in layout px. */
  width: number;
  height: number;
  /** Computed margins when the drag began, in px (used to anchor the opposite edge). */
  marginLeft: number;
  marginTop: number;
}

export interface ResizeGeometry {
  width: number;
  height: number;
  marginLeft: number;
  marginTop: number;
}

/**
 * Apply a pointer delta to the box captured at drag start.
 *
 * A handle only moves the edges its name mentions: `left`/`right` change the width,
 * `top`/`bottom` the height, corners both. Dragging a left or top edge grows the box
 * towards the pointer, so the *opposite* edge must stay put — done by shifting the
 * margin by exactly the size change (the element's left/top edge is otherwise pinned by
 * the surrounding text flow). Both axes are clamped to the minimum box; past the
 * minimum further dragging is inert, and dragging back out resumes immediately because
 * everything is derived from the drag-start box rather than accumulated per move.
 */
export function resizeFromDrag(
  direction: ResizeDirection,
  start: ResizeStart,
  dx: number,
  dy: number,
): ResizeGeometry {
  const fromLeft = direction.includes('left');
  const fromRight = direction.includes('right');
  const fromTop = direction.includes('top');
  const fromBottom = direction.includes('bottom');

  const rawWidth = fromLeft ? start.width - dx : fromRight ? start.width + dx : start.width;
  const rawHeight = fromTop ? start.height - dy : fromBottom ? start.height + dy : start.height;

  const width = Math.max(MIN_EMBED_WIDTH, Math.round(rawWidth));
  const height = Math.max(MIN_EMBED_HEIGHT, Math.round(rawHeight));

  return {
    width,
    height,
    marginLeft: fromLeft ? start.marginLeft + (start.width - width) : start.marginLeft,
    marginTop: fromTop ? start.marginTop + (start.height - height) : start.marginTop,
  };
}
