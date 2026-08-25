import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DrawingEngine } from '../src/infrastructure/canvas-renderer';
import type { Stroke } from '../src/domain/entities';

interface RecordingPath { ops: Array<[string, ...number[]]> }

let mockCtx: Record<string, any>;

function createMockContext() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    canvas: { width: 800, height: 600 },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
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

function stroke(over: Partial<Stroke> = {}): Stroke {
  return {
    id: 's1',
    tool: 'pen',
    color: '#ffffff',
    size: 6,
    opacity: 1,
    hasPressure: false,
    timestamp: 0,
    points: [[10, 10, 0.5], [40, 20, 0.5], [70, 60, 0.5], [90, 30, 0.5]],
    ...over,
  };
}

/** The Path2D objects handed to ctx.fill(), in draw order, for the last render. */
function filledPaths(): RecordingPath[] {
  return mockCtx.fill.mock.calls.map((c: unknown[]) => c[0] as RecordingPath);
}

function repaint(engine: DrawingEngine): void {
  engine.staticDirty = true;
  engine.render();
}

describe('static renderer Path2D cache', () => {
  it('renders the same stroke twice as the same sequence of path ops', () => {
    const engine = new DrawingEngine(container());
    engine.loadStrokes([stroke()]);

    repaint(engine);
    const first = filledPaths()[0].ops;
    mockCtx.fill.mockClear();

    repaint(engine);
    const second = filledPaths()[0].ops;

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(3);
    engine.destroy();
  });

  it('reuses the identical Path2D instance across repaints (the outline is not re-solved)', () => {
    const engine = new DrawingEngine(container());
    engine.loadStrokes([stroke()]);

    repaint(engine);
    const first = filledPaths()[0];
    mockCtx.fill.mockClear();
    repaint(engine);
    const second = filledPaths()[0];

    expect(second).toBe(first);
    engine.destroy();
  });

  it('a pan does not invalidate the cache — the path is in drawing space', () => {
    const engine = new DrawingEngine(container());
    engine.loadStrokes([stroke()]);
    repaint(engine);
    const first = filledPaths()[0];

    engine.panBy(37, -12);
    mockCtx.fill.mockClear();
    engine.render();

    expect(filledPaths()[0]).toBe(first);
    engine.destroy();
  });

  it('mutating a stroke in place (moveStroke) invalidates the cache', () => {
    const engine = new DrawingEngine(container());
    engine.loadStrokes([stroke()]);
    repaint(engine);
    const before = filledPaths()[0];
    const beforeOps = before.ops.map((op) => [...op]);

    engine.strokeManager.moveStroke('s1', 100, 50);
    mockCtx.fill.mockClear();
    repaint(engine);
    const after = filledPaths()[0];

    expect(after).not.toBe(before);
    // The geometry really did move: every coordinate pair is offset by (100, 50).
    const firstMoveBefore = beforeOps.find((op) => op[0] === 'moveTo')!;
    const firstMoveAfter = after.ops.find((op) => op[0] === 'moveTo')!;
    expect(firstMoveAfter[1]).toBeCloseTo((firstMoveBefore[1] as number) + 100, 6);
    expect(firstMoveAfter[2]).toBeCloseTo((firstMoveBefore[2] as number) + 50, 6);
    engine.destroy();
  });

  it('undoing a move invalidates the cache back to the original geometry', () => {
    const engine = new DrawingEngine(container());
    engine.loadStrokes([stroke()]);
    repaint(engine);
    const original = filledPaths()[0].ops.map((op) => [...op]);

    engine.strokeManager.moveStroke('s1', 100, 50);
    repaint(engine);
    engine.strokeManager.undo();
    mockCtx.fill.mockClear();
    repaint(engine);

    expect(filledPaths()[0].ops).toEqual(original);
    engine.destroy();
  });

  it('appending points to a stroke invalidates the cache (length is part of the key)', () => {
    const engine = new DrawingEngine(container());
    engine.loadStrokes([stroke()]);
    repaint(engine);
    const before = filledPaths()[0];

    engine.strokeManager.strokes[0].points.push([120, 90, 0.5]);
    mockCtx.fill.mockClear();
    repaint(engine);

    expect(filledPaths()[0]).not.toBe(before);
    engine.destroy();
  });

  it('two strokes with identical geometry get their own cache entries', () => {
    const engine = new DrawingEngine(container());
    engine.loadStrokes([stroke({ id: 'a' }), stroke({ id: 'b' })]);
    repaint(engine);
    const paths = filledPaths();

    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths[0].ops).toEqual(paths[1].ops);
    engine.destroy();
  });

  it('the in-progress stroke is drawn uncached, straight onto the context', () => {
    const engine = new DrawingEngine(container());
    engine.beginStroke('pen');
    engine.addPoint([10, 10, 0.5]);
    engine.addPoint([50, 40, 0.5]);
    engine.addPoint([80, 20, 0.5]);
    engine.render();

    // The active layer builds its outline with ctx.beginPath()/moveTo(), not a Path2D.
    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.fill).toHaveBeenCalledWith();
    engine.destroy();
  });

  it('committed geometry matches what the live stroke drew (cache changes nothing visually)', () => {
    const engine = new DrawingEngine(container());
    engine.beginStroke('pen');
    for (const p of [[10, 10, 0.5], [40, 20, 0.5], [70, 60, 0.5], [90, 30, 0.5]] as const) {
      engine.addPoint([p[0], p[1], p[2]]);
    }
    engine.render();
    const live: Array<[string, ...number[]]> = [];
    for (const call of mockCtx.moveTo.mock.calls) live.push(['moveTo', ...(call as number[])]);
    for (const call of mockCtx.quadraticCurveTo.mock.calls) live.push(['quadraticCurveTo', ...(call as number[])]);

    engine.endStroke();
    mockCtx.fill.mockClear();
    repaint(engine);
    const cached = filledPaths()[0].ops;

    const cachedMoves = cached.filter((op) => op[0] === 'moveTo');
    const cachedCurves = cached.filter((op) => op[0] === 'quadraticCurveTo');
    expect(cachedMoves).toEqual(live.filter((op) => op[0] === 'moveTo'));
    expect(cachedCurves).toEqual(live.filter((op) => op[0] === 'quadraticCurveTo'));
    engine.destroy();
  });
});
