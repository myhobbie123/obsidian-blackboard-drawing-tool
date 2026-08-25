import type { DrawingEngine } from '../infrastructure/canvas-renderer';
import type { TextItem } from '../domain/text-item';
import {
  hitsSelection,
  isMarqueeDrag,
  marqueeRect,
  selectStrokesIn,
  selectTextItemsIn,
  selectionBounds,
  type SelectionRect,
} from '../domain/selection';
import {
  deleteSelectionCommand,
  moveSelectionCommand,
  recolorSelectionCommand,
} from '../domain/selection-commands';
import type { Command } from '../domain/stroke-manager';
import type { TextLayer } from './text-layer';

/**
 * The marquee-selection tool of ONE drawing surface: which strokes and labels are selected, the
 * drag that produced them, and the group operations on them.
 *
 * Not to be confused with `presentation/area-selection.ts`, which drags a rectangle in a
 * MARKDOWN NOTE to insert a sized embed and has nothing to do with the board's contents. This
 * one is the drawing-surface tool; everything here is in drawing space.
 *
 * The host (the standalone view, an embed) owns the pointer plumbing and calls in with
 * drawing-space coordinates plus the raw screen ones (the click-vs-drag threshold is a screen
 * distance, so it means the same thing at any zoom). All the geometry lives in
 * `domain/selection`, all the undo steps in `domain/selection-commands`, and the chrome is
 * painted by the engine on its ACTIVE canvas — a marquee drag never repaints the static layer.
 */
export class SelectionController {
  private strokeIds = new Set<string>();
  private textIds = new Set<string>();
  private mode: 'marquee' | 'move' | null = null;
  private from = { x: 0, y: 0 };
  private to = { x: 0, y: 0 };
  private fromScreen = { x: 0, y: 0 };
  private moved = false;

  constructor(
    private engine: DrawingEngine,
    private textLayer: () => TextLayer | null,
    private persist: () => void,
    /** Fired after anything the toolbar mirrors changes (undo/redo enablement). */
    private onChange?: () => void,
  ) {}

  get hasSelection(): boolean {
    return this.strokeIds.size > 0 || this.textIds.size > 0;
  }

  get selectedStrokeIds(): string[] {
    return Array.from(this.strokeIds);
  }

  get selectedTextIds(): string[] {
    return Array.from(this.textIds);
  }

  isDragging(): boolean {
    return this.mode !== null;
  }

  private labels(): TextItem[] {
    return this.textLayer()?.getItems() ?? [];
  }

  private boxFor = (item: TextItem) => this.textLayer()?.measureBox(item);

  private bounds(): SelectionRect | null {
    return selectionBounds(
      this.engine.strokeManager.strokes,
      this.strokeIds,
      this.labels(),
      this.textIds,
      this.boxFor,
    );
  }

  /** Push the current selection (and any live drag) to the engine's overlay. */
  private paint(marquee: SelectionRect | null, dx = 0, dy = 0): void {
    if (!marquee && !this.hasSelection) {
      this.engine.setSelectionChrome(null);
      return;
    }
    this.engine.setSelectionChrome({
      marquee,
      strokeIds: this.selectedStrokeIds,
      bounds: this.bounds(),
      dx,
      dy,
    });
  }

  /**
   * Clear the selection. The documented triggers — Escape, a click on empty space, switching
   * tools, and switching or reloading the drawing — all land here.
   */
  clear(): void {
    this.endGesture();
    if (!this.hasSelection) {
      this.engine.setSelectionChrome(null);
      return;
    }
    this.strokeIds.clear();
    this.textIds.clear();
    this.textLayer()?.selectIds([]);
    this.engine.setSelectionChrome(null);
    this.onChange?.();
  }

  /**
   * Drop ids that no longer exist. Called after the canonical strokes are reloaded (a sibling
   * surface committed, an undo landed), so the overlay can never point at a deleted stroke.
   */
  syncToContent(): void {
    if (!this.hasSelection) return;
    const live = new Set(this.engine.strokeManager.strokes.map((s) => s.id));
    for (const id of Array.from(this.strokeIds)) {
      if (!live.has(id)) this.strokeIds.delete(id);
    }
    const labels = new Set(this.labels().map((i) => i.id));
    for (const id of Array.from(this.textIds)) {
      if (!labels.has(id)) this.textIds.delete(id);
    }
    this.textLayer()?.selectIds(this.selectedTextIds);
    this.paint(null);
  }

  /** Press: either grab the existing selection to move it, or start a new marquee. */
  pointerDown(x: number, y: number, screenX: number, screenY: number): void {
    this.from = { x, y };
    this.to = { x, y };
    this.fromScreen = { x: screenX, y: screenY };
    this.moved = false;
    this.mode = this.hasSelection && hitsSelection(this.bounds(), x, y) ? 'move' : 'marquee';
    if (this.mode === 'marquee') this.paint(null);
  }

  pointerMove(x: number, y: number, screenX: number, screenY: number): void {
    if (!this.mode) return;
    this.to = { x, y };
    if (!this.moved && !isMarqueeDrag(screenX - this.fromScreen.x, screenY - this.fromScreen.y)) return;
    if (!this.moved) {
      this.moved = true;
      // A group move hides the dragged strokes from the STATIC layer once, for the whole drag;
      // the active layer draws them translated instead.
      if (this.mode === 'move') this.engine.setHiddenStrokes(this.selectedStrokeIds);
    }

    if (this.mode === 'marquee') {
      const rect = marqueeRect(this.from.x, this.from.y, x, y);
      this.strokeIds = new Set(selectStrokesIn(this.engine.strokeManager.strokes, rect));
      this.textIds = new Set(selectTextItemsIn(this.labels(), rect, this.boxFor));
      this.textLayer()?.selectIds(this.selectedTextIds);
      this.paint(rect);
      return;
    }

    const dx = x - this.from.x;
    const dy = y - this.from.y;
    this.textLayer()?.previewTranslate(this.selectedTextIds, dx, dy);
    this.paint(null, dx, dy);
  }

  /** Release: commit the marquee's catch, or the group move, as ONE undo step. */
  pointerUp(): void {
    const mode = this.mode;
    const moved = this.moved;
    const dx = this.to.x - this.from.x;
    const dy = this.to.y - this.from.y;
    this.endGesture();

    if (mode === 'marquee') {
      // A click on empty space (no drag) clears the selection.
      if (!moved) { this.clear(); return; }
      this.paint(null);
      this.onChange?.();
      return;
    }

    if (mode === 'move') {
      this.textLayer()?.clearPreview();
      this.engine.setHiddenStrokes([]);
      if (moved && (dx !== 0 || dy !== 0)) {
        this.run(moveSelectionCommand(
          this.engine.strokeManager,
          this.textHost(),
          this.selectedStrokeIds,
          this.selectedTextIds,
          dx,
          dy,
        ));
      }
      this.paint(null);
    }
  }

  /** An interrupted gesture commits nothing. */
  cancel(): void {
    if (!this.mode) return;
    const wasMove = this.mode === 'move';
    this.endGesture();
    if (wasMove) {
      this.textLayer()?.clearPreview();
      this.engine.setHiddenStrokes([]);
    }
    this.paint(null);
  }

  /** Delete everything selected, as one undo step. */
  deleteSelection(): boolean {
    if (!this.hasSelection) return false;
    const command = deleteSelectionCommand(
      this.engine.strokeManager,
      this.textHost(),
      this.selectedStrokeIds,
      this.selectedTextIds,
    );
    this.run(command);
    this.strokeIds.clear();
    this.textIds.clear();
    this.textLayer()?.selectIds([]);
    this.paint(null);
    return true;
  }

  /** Apply the current tool colour to every selected stroke and label, as one undo step. */
  applyColor(color: string): boolean {
    if (!this.hasSelection) return false;
    this.run(recolorSelectionCommand(
      this.engine.strokeManager,
      this.textHost(),
      this.selectedStrokeIds,
      this.selectedTextIds,
      color,
    ));
    this.paint(null);
    return true;
  }

  private textHost() {
    const layer = this.textLayer();
    // With no text layer (a surface mounted without one) the text half of every group command
    // is a no-op over an empty list rather than a special case at each call site.
    return layer ? layer.commandHost : { getItems: () => [], setItems: () => {} };
  }

  /**
   * Apply a group command and record it on the engine's ONE undo stack — the same
   * execute-then-push contract the text layer follows.
   */
  private run(command: Command): void {
    command.execute();
    this.engine.strokeManager.push(command);
    this.engine.staticDirty = true;
    this.engine.requestRender();
    this.persist();
    this.onChange?.();
  }

  private endGesture(): void {
    this.mode = null;
    this.moved = false;
  }
}
