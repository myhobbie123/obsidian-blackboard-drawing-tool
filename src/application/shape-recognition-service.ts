import type { Stroke } from '../domain/entities';
import type { StrokeManager } from '../domain/stroke-manager';
import type { RecognitionOptions } from '../domain/shape-recognition';
import { recognizeShape } from '../domain/shape-recognition';
import { createShapeStroke } from '../domain/shapes';

/**
 * Offer the stroke that just committed to the shape recogniser and, if it is confident,
 * REPLACE it with the clean shape.
 *
 * The replacement is its own undo step on top of the stroke's own, which is what makes
 * recognition safe to leave on: one Ctrl+Z restores the exact freehand stroke the user drew
 * (same id, same points, same everything), a second removes it. The shape inherits the
 * stroke's colour, width, opacity and tool, so a recognised circle is indistinguishable from
 * one drawn with the ellipse tool.
 *
 * Returns the shape stroke, or null when nothing was recognised.
 */
export function applyShapeRecognition(
  manager: StrokeManager,
  stroke: Stroke,
  options?: RecognitionOptions,
): Stroke | null {
  const result = recognizeShape(stroke.points, options);
  if (!result) return null;
  const shape = createShapeStroke(
    result.spec,
    { color: stroke.color, size: stroke.size, opacity: stroke.opacity, tool: stroke.tool },
    crypto.randomUUID(),
    stroke.timestamp,
  );
  manager.replaceStroke(stroke.id, shape);
  return shape;
}

/** Whether a tool's strokes are offered to the recogniser at all. */
export function isRecognizableTool(tool: string): boolean {
  return tool === 'pen' || tool === 'highlighter';
}
