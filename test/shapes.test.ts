import { describe, it, expect } from 'vitest';
import {
  ANGLE_SNAP_DEG,
  SHAPE_KINDS,
  arrowHead,
  constrainShapeEnd,
  createShapeStroke,
  isShapeDragMeaningful,
  isShapeTool,
  shapeStrokePoints,
  snapAngle,
  snapSquare,
} from '../src/domain/shapes';
import type { Stroke } from '../src/domain/entities';
import { strokeBox } from '../src/domain/stroke-cache';
import { findStrokesAtPoint } from '../src/application/eraser-service';
import { exportSvg, getStrokeBounds } from '../src/application/export-service';
import { deserialize, serialize } from '../src/application/file-format';
import { marqueeRect, selectStrokesIn } from '../src/domain/selection';
import { StrokeManager } from '../src/domain/stroke-manager';

const style = { color: '#ff0000', size: 8, opacity: 1, tool: 'pen' as const };

function shape(kind: 'line' | 'arrow' | 'rectangle' | 'ellipse', from: [number, number], to: [number, number]): Stroke {
  return createShapeStroke({ kind, from, to }, style, `${kind}-1`, 1234);
}

const xs = (s: Stroke) => s.points.map((p) => p[0]);
const ys = (s: Stroke) => s.points.map((p) => p[1]);

describe('shape geometry', () => {
  it('knows which tools are shape tools', () => {
    for (const kind of SHAPE_KINDS) expect(isShapeTool(kind)).toBe(true);
    for (const tool of ['pen', 'highlighter', 'eraser', 'text', 'select'] as const) {
      expect(isShapeTool(tool)).toBe(false);
    }
  });

  it('a line runs from the press to the release, sampled along the way', () => {
    const line = shape('line', [0, 0], [100, 0]);
    expect(line.points[0][0]).toBe(0);
    expect(line.points[line.points.length - 1][0]).toBe(100);
    expect(line.points.length).toBeGreaterThan(4);
    for (const p of line.points) expect(p[1]).toBe(0);
  });

  it('a rectangle closes back on its start and spans the drag box', () => {
    const rect = shape('rectangle', [10, 20], [110, 80]);
    expect(Math.min(...xs(rect))).toBeCloseTo(10);
    expect(Math.max(...xs(rect))).toBeCloseTo(110);
    expect(Math.min(...ys(rect))).toBeCloseTo(20);
    expect(Math.max(...ys(rect))).toBeCloseTo(80);
    const first = rect.points[0];
    const last = rect.points[rect.points.length - 1];
    expect(Math.hypot(last[0] - first[0], last[1] - first[1])).toBeCloseTo(0, 6);
  });

  it('an ellipse is inscribed in the drag box and closes', () => {
    const ellipse = shape('ellipse', [0, 0], [200, 100]);
    expect(Math.min(...xs(ellipse))).toBeCloseTo(0, 6);
    expect(Math.max(...xs(ellipse))).toBeCloseTo(200, 6);
    expect(Math.min(...ys(ellipse))).toBeCloseTo(0, 6);
    expect(Math.max(...ys(ellipse))).toBeCloseTo(100, 6);
    // Every sample lies on the ellipse.
    for (const [x, y] of ellipse.points) {
      const nx = (x - 100) / 100;
      const ny = (y - 50) / 50;
      expect(Math.hypot(nx, ny)).toBeCloseTo(1, 6);
    }
  });

  it('an arrow is one stroke: shaft, barb, back to the tip, other barb', () => {
    const tip: [number, number] = [100, 0];
    const arrow = shape('arrow', [0, 0], tip);
    const head = arrowHead(0, 0, tip[0], tip[1]);
    // The barbs point back along the shaft and are symmetric about it.
    expect(head.left[0]).toBeLessThan(tip[0]);
    expect(head.right[0]).toBeLessThan(tip[0]);
    expect(head.left[1]).toBeCloseTo(-head.right[1], 6);
    // The path visits the tip twice.
    const atTip = arrow.points.filter((p) => Math.hypot(p[0] - tip[0], p[1] - tip[1]) < 1e-6);
    expect(atTip.length).toBe(2);
  });

  it('tessellates densely enough to draw as a stroke, and bounded for a huge shape', () => {
    expect(shapeStrokePoints({ kind: 'line', from: [0, 0], to: [60, 0] }).length).toBeGreaterThan(8);
    expect(shapeStrokePoints({ kind: 'ellipse', from: [0, 0], to: [100000, 100000] }).length)
      .toBeLessThanOrEqual(161);
  });

  it('a polygon spec closes when asked (the recogniser\'s triangle)', () => {
    const tri = shapeStrokePoints({ kind: 'polygon', vertices: [[0, 0], [50, 80], [100, 0]], closed: true });
    expect(Math.hypot(tri[tri.length - 1][0] - tri[0][0], tri[tri.length - 1][1] - tri[0][1]))
      .toBeCloseTo(0, 6);
  });

  it('a drag that never left the press point is not a shape', () => {
    expect(isShapeDragMeaningful(10, 10, 10, 10)).toBe(false);
    expect(isShapeDragMeaningful(10, 10, 11, 10)).toBe(false);
    expect(isShapeDragMeaningful(10, 10, 40, 40)).toBe(true);
  });
});

describe('shift constraints', () => {
  it('snaps a line to 15-degree increments, preserving the drag length', () => {
    expect(ANGLE_SNAP_DEG).toBe(15);
    const [x, y] = snapAngle(0, 0, 100, 10); // ~5.7deg -> 0deg
    expect(x).toBeCloseTo(Math.hypot(100, 10), 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('snaps at the boundary between two increments (7.5deg rounds up to 15)', () => {
    const length = 100;
    const at = (deg: number) => snapAngle(0, 0, Math.cos(deg * Math.PI / 180) * length, Math.sin(deg * Math.PI / 180) * length);
    const justUnder = at(7.4);
    const justOver = at(7.6);
    const exactly = at(7.5);
    expect(Math.atan2(justUnder[1], justUnder[0]) * 180 / Math.PI).toBeCloseTo(0, 6);
    expect(Math.atan2(justOver[1], justOver[0]) * 180 / Math.PI).toBeCloseTo(15, 6);
    expect(Math.atan2(exactly[1], exactly[0]) * 180 / Math.PI).toBeCloseTo(15, 6);
  });

  it('snaps every 15 degrees all the way round, including the negative half', () => {
    for (const deg of [15, 30, 45, 90, 135, 180, -45, -120]) {
      const rad = deg * Math.PI / 180;
      const [x, y] = snapAngle(5, 5, 5 + Math.cos(rad) * 80, 5 + Math.sin(rad) * 80);
      expect(Math.atan2(y - 5, x - 5)).toBeCloseTo(rad, 6);
    }
  });

  it('snaps a rectangle to a square (and an ellipse to a circle) in the drag direction', () => {
    expect(snapSquare(0, 0, 100, 40)).toEqual([100, 100]);
    expect(snapSquare(0, 0, -30, -90)).toEqual([-90, -90]);
    expect(snapSquare(10, 10, -50, 20)).toEqual([-50, 70]);
  });

  it('routes each kind to its own constraint', () => {
    expect(constrainShapeEnd('rectangle', 0, 0, 100, 40)).toEqual([100, 100]);
    expect(constrainShapeEnd('ellipse', 0, 0, 100, 40)).toEqual([100, 100]);
    const [lx, ly] = constrainShapeEnd('line', 0, 0, 100, 10);
    expect(ly).toBeCloseTo(0, 6);
    expect(lx).toBeGreaterThan(99);
    const constrainedSquare = createShapeStroke(
      { kind: 'ellipse', from: [0, 0], to: constrainShapeEnd('ellipse', 0, 0, 100, 40) },
      style, 'c', 0,
    );
    const box = strokeBox(constrainedSquare);
    expect(box.maxX - box.minX).toBeCloseTo(box.maxY - box.minY, 6);
  });
});

describe('a shape is an ordinary stroke', () => {
  it('takes the current colour, width and opacity, with a uniform (non-simulated) pressure', () => {
    const rect = createShapeStroke(
      { kind: 'rectangle', from: [0, 0], to: [40, 40] },
      { color: '#00ff00', size: 16, opacity: 0.3, tool: 'highlighter' },
      'r1',
    );
    expect(rect.color).toBe('#00ff00');
    expect(rect.size).toBe(16);
    expect(rect.opacity).toBe(0.3);
    expect(rect.tool).toBe('highlighter');
    expect(rect.hasPressure).toBe(true);
    for (const p of rect.points) expect(p[2]).toBe(0.5);
  });

  it('is one undo step, and undo removes the whole shape', () => {
    const manager = new StrokeManager();
    manager.addStroke(shape('ellipse', [0, 0], [50, 50]));
    expect(manager.strokes).toHaveLength(1);
    manager.undo();
    expect(manager.strokes).toHaveLength(0);
    manager.redo();
    expect(manager.strokes).toHaveLength(1);
  });

  it('round-trips through the file format at version 3 (upstream still opens it)', () => {
    const rect = shape('rectangle', [0, 0], [100, 50]);
    const file = {
      version: 3, width: 100, height: 50, strokes: [rect],
      background: { color: 'transparent' },
    };
    const { file: loaded, warnings, readonly } = deserialize(serialize(file));
    expect(warnings).toEqual([]);
    expect(readonly).toBe(false);
    expect(loaded.version).toBe(3);
    expect(loaded.strokes[0].points).toEqual(rect.points);
    expect(loaded.strokes[0].hasPressure).toBe(true);
  });

  it('a drawing that also has labels still stamps version 4, shapes or not', () => {
    const file = {
      version: 4, width: 100, height: 50, strokes: [shape('line', [0, 0], [50, 0])],
      background: { color: 'transparent' },
      text: { version: 1, items: [{ id: 't1', x: 0, y: 0, text: 'hi', fontSize: 20, color: '#fff' }] },
    };
    const { file: loaded, readonly } = deserialize(serialize(file));
    expect(readonly).toBe(false);
    expect(loaded.version).toBe(4);
    expect(loaded.text?.items).toHaveLength(1);
    expect(loaded.strokes[0].points).toEqual(file.strokes[0].points);
  });

  it('exports as an SVG path like any other stroke', () => {
    const svg = exportSvg([shape('ellipse', [0, 0], [80, 40])], { type: 'blank', color: '#000', grid: false, gridSize: 20 });
    expect(svg).toContain('<path d="M');
    expect(svg).toContain('fill="#ff0000"');
    const bounds = getStrokeBounds([shape('ellipse', [0, 0], [80, 40])]);
    expect(bounds.width).toBeCloseTo(80, 6);
    expect(bounds.height).toBeCloseTo(40, 6);
  });

  it('is erasable: the eraser hits its outline, and misses its empty middle', () => {
    const rect = shape('rectangle', [0, 0], [100, 100]);
    expect(findStrokesAtPoint([rect], 50, 0, 5)).toEqual(['rectangle-1']);
    expect(findStrokesAtPoint([rect], 50, 50, 5)).toEqual([]);
  });

  it('is selectable and movable like any stroke, and the bounds cache follows', () => {
    const manager = new StrokeManager();
    const ellipse = shape('ellipse', [0, 0], [100, 100]);
    manager.addStroke(ellipse);
    expect(selectStrokesIn(manager.strokes, marqueeRect(-10, -10, 110, 110))).toEqual(['ellipse-1']);
    expect(selectStrokesIn(manager.strokes, marqueeRect(-10, -10, 50, 50))).toEqual([]);

    manager.moveStroke('ellipse-1', 200, 0);
    const box = strokeBox(manager.strokes[0]);
    expect(box.minX).toBeCloseTo(200, 6);
    expect(box.maxX).toBeCloseTo(300, 6);
    expect(selectStrokesIn(manager.strokes, marqueeRect(190, -10, 310, 110))).toEqual(['ellipse-1']);
  });
});
