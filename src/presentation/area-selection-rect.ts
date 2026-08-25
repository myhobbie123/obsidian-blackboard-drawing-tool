export interface SelectionBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The minimum size of a drawing created from an area selection, applied at COMMIT only. */
export const MIN_AREA_WIDTH = 240;
export const MIN_AREA_HEIGHT = 160;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isPointInside(bounds: SelectionBounds, x: number, y: number): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

/**
 * The live drag rectangle, in viewport coordinates, clipped to the editor surface.
 *
 * It tracks the pointer EXACTLY — the 240x160 minimum is deliberately not applied here.
 * Enforcing it during the drag made the preview refuse to shrink below a size the user could
 * still see themselves dragging past, so the rectangle stopped following the cursor. The
 * minimum belongs to `commitSize`, and a below-minimum drag is signalled visually instead.
 */
export function selectionRect(
  start: { x: number; y: number },
  current: { x: number; y: number },
  bounds: SelectionBounds,
): SelectionRect {
  const availableWidth = Math.max(1, bounds.right - bounds.left);
  const availableHeight = Math.max(1, bounds.bottom - bounds.top);
  const width = Math.min(availableWidth, Math.abs(current.x - start.x));
  const height = Math.min(availableHeight, Math.abs(current.y - start.y));
  const rawLeft = Math.min(start.x, current.x);
  const rawTop = Math.min(start.y, current.y);
  let left = current.x < start.x ? start.x - width : rawLeft;
  let top = current.y < start.y ? start.y - height : rawTop;
  left = clamp(left, bounds.left, bounds.right - width);
  top = clamp(top, bounds.top, bounds.bottom - height);
  return { left, top, width, height };
}

/** True while the drag is smaller than the drawing that will actually be created. */
export function isBelowMinimum(rect: { width: number; height: number }): boolean {
  return rect.width < MIN_AREA_WIDTH || rect.height < MIN_AREA_HEIGHT;
}

/** The size of the drawing to create: the drag, rounded, raised to the minimum. */
export function commitSize(rect: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(MIN_AREA_WIDTH, Math.round(rect.width)),
    height: Math.max(MIN_AREA_HEIGHT, Math.round(rect.height)),
  };
}
