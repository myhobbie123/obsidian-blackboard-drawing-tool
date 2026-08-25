import type { DrawingEngine } from '../infrastructure/canvas-renderer';
import type { ToolName } from '../domain/entities';

export type { ToolName };

/**
 * The contract the global floating toolbar drives. Implemented by each drawing
 * surface (the standalone BlackboardView and every canvas embed) over its engine,
 * so one shared toolbar can control whichever drawing is currently active.
 */
export interface DrawingSurface {
  setTool(tool: ToolName): void;
  setColor(color: string): void;
  setSize(size: number): void;
  undo(): void;
  redo(): void;
  readonly activeTool: ToolName;
  readonly activeColor: string;
  readonly activeSize: number;
  /** Pen color regardless of the active tool — lets the toolbar tint the pen glyph. */
  readonly penColor: string;
  /** Highlighter color regardless of the active tool — lets the toolbar tint the highlighter glyph. */
  readonly highlighterColor: string;
  /** Text colour regardless of the active tool — lets the toolbar tint the T glyph. */
  readonly textColor: string;
  canUndo(): boolean;
  canRedo(): boolean;
}

/**
 * The part of the marquee-selection tool the toolbar has to know about: a colour picked while
 * something is selected recolours the SELECTION (as one undo step), not just the pen.
 */
export interface SurfaceSelection {
  applyColor(color: string): boolean;
}

/** Build a DrawingSurface backed by a DrawingEngine + a save callback. */
export function engineSurface(
  engine: DrawingEngine,
  save: () => void,
  selection?: SurfaceSelection,
): DrawingSurface {
  return {
    setTool: (t) => engine.toolManager.setTool(t),
    setColor: (c) => {
      engine.toolManager.setColor(c);
      // The selection tool's colour IS the pen colour (see ToolManager), so the tool state is
      // updated either way; with a live selection the colour is also applied to it.
      selection?.applyColor(c);
    },
    setSize: (s) => engine.toolManager.setSize(s),
    undo: () => { engine.strokeManager.undo(); engine.staticDirty = true; engine.requestRender(); save(); },
    redo: () => { engine.strokeManager.redo(); engine.staticDirty = true; engine.requestRender(); save(); },
    get activeTool() { return engine.toolManager.activeTool; },
    get activeColor() { return engine.toolManager.activeColor; },
    get activeSize() { return engine.toolManager.activeSize; },
    get penColor() { return engine.toolManager.penColor; },
    get highlighterColor() { return engine.toolManager.highlighterColor; },
    get textColor() { return engine.toolManager.textColor; },
    canUndo: () => engine.strokeManager.canUndo(),
    canRedo: () => engine.strokeManager.canRedo(),
  };
}
