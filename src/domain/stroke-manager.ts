import type { Stroke } from './entities';
import { invalidateStroke } from './stroke-cache';

export interface Command {
  execute(): void;
  undo(): void;
}

/**
 * Translate a set of strokes in place, invalidating every derived cache. THE one place point
 * coordinates are mutated (`moveStroke`, the group move of a marquee selection, and both of
 * their undo/redo directions all go through here), so the bounds/Path2D invalidation contract
 * described in `stroke-cache` has exactly one implementation.
 */
export function translateStrokes(
  strokes: readonly Stroke[],
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
): void {
  if (dx === 0 && dy === 0) return;
  for (const stroke of strokes) {
    if (!ids.has(stroke.id)) continue;
    for (const point of stroke.points) {
      point[0] += dx;
      point[1] += dy;
    }
    invalidateStroke(stroke);
  }
}

export class StrokeManager {
  strokes: Stroke[] = [];
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  addStroke(stroke: Stroke): void {
    this.strokes.push(stroke);
    this.undoStack.push({
      execute: () => { this.strokes.push(stroke); },
      undo: () => { const i = this.strokes.findIndex(s => s.id === stroke.id); if (i !== -1) this.strokes.splice(i, 1); },
    });
    this.redoStack.length = 0;
  }

  deleteStroke(id: string): void {
    const index = this.strokes.findIndex(s => s.id === id);
    if (index === -1) return;
    const deleted = this.strokes.splice(index, 1)[0];
    this.undoStack.push({
      execute: () => { const i = this.strokes.findIndex(s => s.id === deleted.id); if (i !== -1) this.strokes.splice(i, 1); },
      undo: () => { this.strokes.splice(index, 0, deleted); },
    });
    this.redoStack.length = 0;
  }

  /**
   * Move one stroke, in place, through `translateStrokes` — points keep their array identity
   * and length, so every derived cache (stroke AABB, renderer Path2D) is told explicitly here
   * and on both undo/redo paths.
   */
  moveStroke(id: string, dx: number, dy: number): void {
    const stroke = this.strokes.find(s => s.id === id);
    if (!stroke) return;
    const ids = new Set([id]);
    translateStrokes(this.strokes, ids, dx, dy);
    this.undoStack.push({
      execute: () => { translateStrokes(this.strokes, ids, dx, dy); },
      undo: () => { translateStrokes(this.strokes, ids, -dx, -dy); },
    });
    this.redoStack.length = 0;
  }

  /**
   * Swap one stroke for another at the SAME index, as one undo step. This is how shape
   * recognition lands: the freehand stroke the user drew is replaced by the clean shape, and a
   * single undo brings the original stroke back exactly as it was.
   */
  replaceStroke(id: string, next: Stroke): void {
    const index = this.strokes.findIndex(s => s.id === id);
    if (index === -1) return;
    const previous = this.strokes[index];
    this.strokes[index] = next;
    this.undoStack.push({
      execute: () => {
        const i = this.strokes.findIndex(s => s.id === previous.id);
        if (i !== -1) this.strokes[i] = next;
      },
      undo: () => {
        const i = this.strokes.findIndex(s => s.id === next.id);
        if (i !== -1) this.strokes[i] = previous;
      },
    });
    this.redoStack.length = 0;
  }

  clearAll(): void {
    const saved = [...this.strokes];
    this.strokes.length = 0;
    this.undoStack.push({
      execute: () => { this.strokes.length = 0; },
      undo: () => { this.strokes.push(...saved); },
    });
    this.redoStack.length = 0;
  }

  /**
   * Record a command whose effect the caller has ALREADY applied (the same contract
   * `addStroke`/`moveStroke` follow internally). This is how the text layer joins the one
   * undo timeline: a label create/edit/move/delete lands on this stack in the order the user
   * performed it, interleaved with strokes, instead of on a parallel history of its own.
   */
  push(command: Command): void {
    this.undoStack.push(command);
    this.redoStack.length = 0;
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.execute();
    this.undoStack.push(cmd);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  reset(): void {
    this.strokes.length = 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
