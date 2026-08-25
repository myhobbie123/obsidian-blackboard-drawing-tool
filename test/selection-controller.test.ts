import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DrawingEngine } from '../src/infrastructure/canvas-renderer';
import { ToolManager } from '../src/domain/tool-manager';
import { DEFAULT_TOOL_STATE, type Stroke } from '../src/domain/entities';
import { strokeBox } from '../src/domain/stroke-cache';
import { findStrokesAtPoint } from '../src/application/eraser-service';
import { SelectionController } from '../src/presentation/selection-controller';
import type { TextLayer } from '../src/presentation/text-layer';
import type { TextItem } from '../src/domain/text-item';

let mockCtx: Record<string, any>;

beforeEach(() => {
  mockCtx = {
    save: vi.fn(), restore: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(),
    closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), strokeRect: vi.fn(), fillRect: vi.fn(),
    setLineDash: vi.fn(), scale: vi.fn(), translate: vi.fn(),
    canvas: { width: 800, height: 600 },
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 1,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockCtx as any);
});

function stroke(id: string, points: Array<[number, number]>, color = '#ffffff'): Stroke {
  return {
    id, tool: 'pen', color, size: 4, opacity: 1,
    points: points.map(([x, y]) => [x, y, 0.5] as [number, number, number]),
    hasPressure: false, timestamp: 0,
  };
}

/** The slice of TextLayer the selection tool uses, backed by a plain array. */
function fakeTextLayer(items: TextItem[]) {
  let current = items;
  const state = {
    selected: [] as string[],
    preview: null as { ids: readonly string[]; dx: number; dy: number } | null,
    persisted: 0,
    get items() { return current; },
  };
  const layer = {
    getItems: () => current,
    measureBox: () => ({ width: 40, height: 20 }),
    selectIds: (ids: readonly string[]) => { state.selected = [...ids]; },
    previewTranslate: (ids: readonly string[], dx: number, dy: number) => { state.preview = { ids: [...ids], dx, dy }; },
    clearPreview: () => { state.preview = null; },
    commandHost: {
      getItems: () => current,
      setItems: (next: TextItem[]) => { current = next; state.persisted++; },
    },
  };
  return { layer: layer as unknown as TextLayer, state };
}

function setup(strokes: Stroke[] = [], items: TextItem[] = []) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 600 });
  const tools = new ToolManager({ ...DEFAULT_TOOL_STATE });
  tools.setTool('select');
  const engine = new DrawingEngine(el, 800, 600, tools);
  for (const s of strokes) engine.strokeManager.addStroke(s);
  const text = fakeTextLayer(items);
  const persist = vi.fn();
  const onChange = vi.fn();
  const selection = new SelectionController(engine, () => text.layer, persist, onChange);
  return { engine, selection, text, persist, onChange };
}

/** A marquee drag from (x0,y0) to (x1,y1); drawing and screen space coincide at scale 1. */
function marquee(selection: SelectionController, x0: number, y0: number, x1: number, y1: number): void {
  selection.pointerDown(x0, y0, x0, y0);
  selection.pointerMove(x1, y1, x1, y1);
  selection.pointerUp();
}

const label = (id: string, x: number, y: number): TextItem =>
  ({ id, x, y, text: 'hi', fontSize: 20, color: '#ffffff' });

describe('SelectionController — marquee', () => {
  it('selects what the marquee fully contains, strokes and labels alike', () => {
    const { selection, text } = setup(
      [stroke('a', [[10, 10], [40, 40]]), stroke('b', [[10, 10], [400, 40]])],
      [label('t1', 20, 60), label('t2', 500, 500)],
    );

    marquee(selection, 0, 0, 200, 200);

    expect(selection.selectedStrokeIds).toEqual(['a']);
    expect(selection.selectedTextIds).toEqual(['t1']);
    expect(text.state.selected).toEqual(['t1']);
    expect(selection.hasSelection).toBe(true);
  });

  it('a click on empty space clears the selection', () => {
    const { selection, text } = setup([stroke('a', [[10, 10], [40, 40]])], [label('t1', 20, 60)]);
    marquee(selection, 0, 0, 200, 200);
    expect(selection.hasSelection).toBe(true);

    // Press and release without travelling: a click, not a marquee.
    selection.pointerDown(600, 600, 600, 600);
    selection.pointerUp();

    expect(selection.hasSelection).toBe(false);
    expect(text.state.selected).toEqual([]);
  });

  it('clear() drops everything (Escape, tool switch, drawing switch all land here)', () => {
    const { selection, text } = setup([stroke('a', [[10, 10], [40, 40]])], [label('t1', 20, 60)]);
    marquee(selection, 0, 0, 200, 200);
    selection.clear();
    expect(selection.hasSelection).toBe(false);
    expect(text.state.selected).toEqual([]);
  });

  it('prunes ids that no longer exist when the drawing is reloaded', () => {
    const { engine, selection } = setup([stroke('a', [[10, 10], [40, 40]])]);
    marquee(selection, 0, 0, 200, 200);
    expect(selection.selectedStrokeIds).toEqual(['a']);

    engine.loadStrokes([stroke('z', [[0, 0], [1, 1]])]);
    selection.syncToContent();
    expect(selection.hasSelection).toBe(false);
  });
});

describe('SelectionController — group move', () => {
  it('moves strokes and labels once, on release, as one undo step', () => {
    const { engine, selection, text, persist } = setup(
      [stroke('a', [[10, 10], [40, 40]])],
      [label('t1', 20, 60)],
    );
    marquee(selection, 0, 0, 200, 200);
    persist.mockClear();

    selection.pointerDown(20, 20, 20, 20);
    selection.pointerMove(120, 20, 120, 20);
    // Mid-drag the model has not moved: only the preview has.
    expect(engine.strokeManager.strokes[0].points[0][0]).toBe(10);
    expect(text.state.preview).toEqual({ ids: ['t1'], dx: 100, dy: 0 });

    selection.pointerUp();

    expect(engine.strokeManager.strokes[0].points[0][0]).toBe(110);
    expect(text.state.items[0].x).toBe(120);
    expect(text.state.preview).toBeNull();
    expect(persist).toHaveBeenCalled();

    engine.strokeManager.undo();
    expect(engine.strokeManager.strokes[0].points[0][0]).toBe(10);
    expect(text.state.items[0].x).toBe(20);
  });

  it('a group move refreshes the stroke bounds cache (the eraser cannot go stale)', () => {
    const { engine, selection } = setup([stroke('a', [[10, 10], [40, 40]])]);
    marquee(selection, 0, 0, 200, 200);
    expect(strokeBox(engine.strokeManager.strokes[0]).minX).toBe(10);
    expect(findStrokesAtPoint(engine.strokeManager.strokes, 20, 20, 4)).toEqual(['a']);

    selection.pointerDown(20, 20, 20, 20);
    selection.pointerMove(320, 20, 320, 20);
    selection.pointerUp();

    expect(strokeBox(engine.strokeManager.strokes[0]).minX).toBe(310);
    expect(findStrokesAtPoint(engine.strokeManager.strokes, 20, 20, 4)).toEqual([]);
    expect(findStrokesAtPoint(engine.strokeManager.strokes, 320, 20, 4)).toEqual(['a']);
  });

  it('a press below the drag threshold moves nothing', () => {
    const { engine, selection } = setup([stroke('a', [[10, 10], [40, 40]])]);
    marquee(selection, 0, 0, 200, 200);

    selection.pointerDown(20, 20, 20, 20);
    selection.pointerMove(21, 20, 21, 20);
    selection.pointerUp();

    expect(engine.strokeManager.strokes[0].points[0][0]).toBe(10);
  });

  it('a cancelled move commits nothing', () => {
    const { engine, selection, text } = setup([stroke('a', [[10, 10], [40, 40]])], [label('t1', 20, 60)]);
    marquee(selection, 0, 0, 200, 200);

    selection.pointerDown(20, 20, 20, 20);
    selection.pointerMove(120, 20, 120, 20);
    selection.cancel();

    expect(engine.strokeManager.strokes[0].points[0][0]).toBe(10);
    expect(text.state.preview).toBeNull();
  });
});

describe('SelectionController — delete and recolour', () => {
  it('deletes strokes and labels as one undo step', () => {
    const { engine, selection, text, persist } = setup(
      [stroke('a', [[10, 10], [40, 40]]), stroke('b', [[500, 500], [510, 510]])],
      [label('t1', 20, 60)],
    );
    marquee(selection, 0, 0, 200, 200);

    expect(selection.deleteSelection()).toBe(true);
    expect(engine.strokeManager.strokes.map((s) => s.id)).toEqual(['b']);
    expect(text.state.items).toEqual([]);
    expect(persist).toHaveBeenCalled();
    expect(selection.hasSelection).toBe(false);

    engine.strokeManager.undo();
    expect(engine.strokeManager.strokes.map((s) => s.id)).toEqual(['a', 'b']);
    expect(text.state.items.map((i) => i.id)).toEqual(['t1']);
  });

  it('applies a colour to the whole selection as one undo step', () => {
    const { engine, selection, text } = setup(
      [stroke('a', [[10, 10], [40, 40]], '#ff0000')],
      [label('t1', 20, 60)],
    );
    marquee(selection, 0, 0, 200, 200);

    expect(selection.applyColor('#00ff00')).toBe(true);
    expect(engine.strokeManager.strokes[0].color).toBe('#00ff00');
    expect(text.state.items[0].color).toBe('#00ff00');

    engine.strokeManager.undo();
    expect(engine.strokeManager.strokes[0].color).toBe('#ff0000');
    expect(text.state.items[0].color).toBe('#ffffff');
  });

  it('does nothing at all with an empty selection', () => {
    const { selection } = setup([stroke('a', [[10, 10], [40, 40]])]);
    expect(selection.deleteSelection()).toBe(false);
    expect(selection.applyColor('#00ff00')).toBe(false);
  });
});
