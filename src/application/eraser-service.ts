import type { Stroke } from '../domain/entities';
import { distToSegmentSq } from '../domain/geometry';
import { strokeBox } from '../domain/stroke-cache';
import { StrokeManager } from '../domain/stroke-manager';

/**
 * Every stroke on the board is tested against every eraser sample, so this is the hottest
 * loop in the plugin. Two things keep it cheap without changing which strokes are reported:
 *
 * 1. A per-stroke AABB pre-test (cached, invalidated via `stroke-cache`) rejects strokes
 *    whose bounding box, inflated by the eraser radius, cannot contain the probe. A stroke
 *    can only be hit if some point of it is within `eraserSize` of the probe, and every such
 *    point lies inside the inflated box, so the pre-test is exact — never a false negative.
 * 2. Distances are compared squared, so no `Math.sqrt` runs per point or segment.
 */
export function findStrokesAtPoint(
  strokes: Stroke[],
  worldX: number,
  worldY: number,
  eraserSize: number,
): string[] {
  const toDelete: string[] = [];
  const radiusSq = eraserSize * eraserSize;
  for (const stroke of strokes) {
    const points = stroke.points;
    if (points.length === 0) continue;

    const box = strokeBox(stroke);
    if (
      worldX < box.minX - eraserSize || worldX > box.maxX + eraserSize ||
      worldY < box.minY - eraserSize || worldY > box.maxY + eraserSize
    ) {
      continue;
    }

    let hit = false;
    for (let pi = 0; pi < points.length; pi++) {
      const sp = points[pi];
      const dx = sp[0] - worldX;
      const dy = sp[1] - worldY;
      if (dx * dx + dy * dy < radiusSq) { hit = true; break; }
      if (pi > 0) {
        const prev = points[pi - 1];
        if (distToSegmentSq(worldX, worldY, prev[0], prev[1], sp[0], sp[1]) < radiusSq) { hit = true; break; }
      }
    }
    if (hit) toDelete.push(stroke.id);
  }
  return toDelete;
}

/**
 * The radius the eraser actually sweeps. A small nib is unusable on a touch screen, so the
 * size is floored; exported so everything the eraser deletes — strokes and labels alike —
 * agrees on one disc.
 */
export function effectiveEraserSize(eraserSize: number): number {
  return Math.max(eraserSize, 15);
}

export function eraseAtPoint(
  strokeManager: StrokeManager,
  worldX: number,
  worldY: number,
  eraserSize: number,
): boolean {
  const effectiveSize = effectiveEraserSize(eraserSize);
  const toDelete = findStrokesAtPoint(strokeManager.strokes, worldX, worldY, effectiveSize);
  for (const id of toDelete) strokeManager.deleteStroke(id);
  return toDelete.length > 0;
}
