import type { Stroke } from './entities';

/** Axis-aligned bounding box of a stroke's raw points (no brush-width padding). */
export interface StrokeBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface CachedBox extends StrokeBox {
  /** The exact points array the box was computed from (identity check). */
  points: Stroke['points'];
  length: number;
  epoch: number;
}

/**
 * Per-stroke derived-data caches (the bounding box here, the renderer's Path2D elsewhere) are
 * keyed on `points` identity + length, which catches every way a stroke normally changes:
 * strokes are replaced wholesale on load, and points are only ever appended while drawing.
 *
 * `StrokeManager.moveStroke` (and its undo/redo commands) is the ONE place that mutates point
 * coordinates in place, leaving identity and length untouched. It calls `invalidateStroke`,
 * which bumps a monotonic epoch; every cache mixes that epoch into its validity check, so a
 * single invalidation point serves all of them without the caches knowing about each other.
 *
 * WeakMaps (not properties on the stroke) keep the cached data out of `structuredClone`,
 * `JSON.stringify` and the on-disk file format entirely.
 */
const epochs = new WeakMap<Stroke, number>();
const boxes = new WeakMap<Stroke, CachedBox>();

/** Current geometry epoch of a stroke; bumped by `invalidateStroke`. */
export function strokeEpoch(stroke: Stroke): number {
  return epochs.get(stroke) ?? 0;
}

/** Mark a stroke's point coordinates as changed in place, invalidating every derived cache. */
export function invalidateStroke(stroke: Stroke): void {
  epochs.set(stroke, strokeEpoch(stroke) + 1);
  boxes.delete(stroke);
}

/**
 * Cached AABB of a stroke's points. An empty stroke yields an inverted (empty) box, which
 * every containment test rejects.
 */
export function strokeBox(stroke: Stroke): StrokeBox {
  const epoch = strokeEpoch(stroke);
  const cached = boxes.get(stroke);
  if (
    cached &&
    cached.points === stroke.points &&
    cached.length === stroke.points.length &&
    cached.epoch === epoch
  ) {
    return cached;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const points = stroke.points;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }

  const box: CachedBox = { points, length: points.length, epoch, minX, minY, maxX, maxY };
  boxes.set(stroke, box);
  return box;
}
