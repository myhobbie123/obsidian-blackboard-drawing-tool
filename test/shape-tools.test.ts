import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DrawingEngine } from '../src/infrastructure/canvas-renderer';
import { ToolManager } from '../src/domain/tool-manager';
import { DEFAULT_TOOL_STATE } from '../src/domain/entities';
import { strokeBox } from '../src/domain/stroke-cache';

let mockCtx: Record<string, any>;

function createMockContext() {
  return {
    save: vi.fn(), restore: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(),
    closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), strokeRect: vi.fn(), fillRect: vi.fn(),
    setLineDash: vi.fn(), scale: vi.fn(), translate: vi.fn(),
    canvas: { width: 800, height: 600 },
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 1,
  };
}

beforeEach(() => {
  mockCtx = createMockContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockCtx as any);
});

function container(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 600 });
  return el;
}

function engineWith(tool: 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'select' = 'line'): DrawingEngine {
  const tools = new ToolManager({ ...DEFAULT_TOOL_STATE, penColor: '#123456', penSize: 6 });
  tools.setTool(tool);
  return new DrawingEngine(container(), 800, 600, tools);
}

describe('shape tools on the engine', () => {
  it('a drag commits exactly one stroke carrying the pen colour and width', () => {
    const engine = engineWith('rectangle');
    engine.beginShape('rectangle', 10, 10);
    engine.updateShape(110, 60);
    const stroke = engine.endShape();

    expect(stroke).not.toBeNull();
    expect(engine.strokeManager.strokes).toHaveLength(1);
    expect(stroke!.color).toBe('#123456');
    expect(stroke!.size).toBe(6);
    expect(stroke!.tool).toBe('pen');
    const box = strokeBox(stroke!);
    expect([box.minX, box.minY, box.maxX, box.maxY]).toEqual([10, 10, 110, 60]);
  });

  it('is one undo step', () => {
    const engine = engineWith('ellipse');
    engine.beginShape('ellipse', 0, 0);
    engine.updateShape(100, 100);
    engine.endShape();
    expect(engine.strokeManager.canUndo()).toBe(true);
    engine.strokeManager.undo();
    expect(engine.strokeManager.strokes).toHaveLength(0);
    expect(engine.strokeManager.canUndo()).toBe(false);
  });

  it('applies the Shift constraint while dragging', () => {
    const engine = engineWith('ellipse');
    engine.beginShape('ellipse', 0, 0);
    engine.updateShape(100, 40, true);
    const stroke = engine.endShape()!;
    const box = strokeBox(stroke);
    expect(box.maxX - box.minX).toBeCloseTo(box.maxY - box.minY, 6);
  });

  it('a drag that never moved commits nothing', () => {
    const engine = engineWith('line');
    engine.beginShape('line', 5, 5);
    engine.updateShape(5, 5);
    expect(engine.endShape()).toBeNull();
    expect(engine.strokeManager.strokes).toHaveLength(0);
  });

  it('a cancelled drag commits nothing and leaves no preview', () => {
    const engine = engineWith('arrow');
    engine.beginShape('arrow', 0, 0);
    engine.updateShape(100, 100);
    expect(engine.isShaping()).toBe(true);
    engine.cancelShape();
    expect(engine.isShaping()).toBe(false);
    expect(engine.strokeManager.strokes).toHaveLength(0);
  });

  it('previews on the ACTIVE canvas only — the static layer is never repainted mid-drag', () => {
    const engine = engineWith('rectangle');
    engine.render();
    engine.staticDirty = false;
    engine.beginShape('rectangle', 0, 0);
    engine.updateShape(50, 50);
    engine.updateShape(60, 60);
    engine.render();
    expect(engine.staticDirty).toBe(false);
    // Committing does dirty the static layer (the shape now lives there).
    engine.endShape();
    expect(engine.staticDirty).toBe(true);
  });

  it('the committed shape reuses its cached Path2D across repaints (no re-tessellation)', () => {
    const engine = engineWith('ellipse');
    engine.beginShape('ellipse', 0, 0);
    engine.updateShape(100, 100);
    engine.endShape();

    engine.render();
    const first = mockCtx.fill.mock.calls.map((c: unknown[]) => c[0]);
    mockCtx.fill.mockClear();
    engine.staticDirty = true;
    engine.render();
    const second = mockCtx.fill.mock.calls.map((c: unknown[]) => c[0]);
    expect(second[0]).toBe(first[0]);
  });
});

describe('selection chrome on the engine', () => {
  it('draws the marquee and the selection box on the active layer without dirtying the static one', () => {
    const engine = engineWith('select');
    engine.beginShape('rectangle', 0, 0); // any content
    engine.updateShape(50, 50);
    const stroke = engine.endShape()!;
    engine.render();
    engine.staticDirty = false;
    mockCtx.strokeRect.mockClear();

    engine.setSelectionChrome({
      marquee: { x: 0, y: 0, width: 80, height: 80 },
      strokeIds: [stroke.id],
      bounds: { x: 0, y: 0, width: 50, height: 50 },
      dx: 0,
      dy: 0,
    });
    expect(engine.staticDirty).toBe(false);
    engine.render();
    expect(mockCtx.strokeRect).toHaveBeenCalledTimes(2); // bounds + marquee
    expect(mockCtx.setLineDash).toHaveBeenCalled();
  });

  it('hiding the dragged strokes repaints the static layer once and skips them', () => {
    const engine = engineWith('rectangle');
    engine.beginShape('rectangle', 0, 0);
    engine.updateShape(50, 50);
    const stroke = engine.endShape()!;
    engine.render();
    mockCtx.fill.mockClear();

    // Hiding marks the static layer dirty once for the whole drag; the hidden stroke is then
    // not drawn on it at all.
    engine.setHiddenStrokes([stroke.id]);
    expect(engine.staticDirty).toBe(true);
    engine.render();
    expect(mockCtx.fill).not.toHaveBeenCalled();

    // Un-hiding brings it back with one more repaint.
    engine.setHiddenStrokes([]);
    engine.render();
    expect(mockCtx.fill).toHaveBeenCalled();
  });
});
