import { describe, it, expect } from 'vitest';
import { applyShapeRecognition, isRecognizableTool } from '../src/application/shape-recognition-service';
import { StrokeManager } from '../src/domain/stroke-manager';
import { DEFAULT_PLUGIN_SETTINGS, type Stroke, type Point } from '../src/domain/entities';
import { strokeBox } from '../src/domain/stroke-cache';

function noisyCircle(cx: number, cy: number, r: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = (i / 60) * Math.PI * 2;
    const wobble = 1 + Math.sin(t * 7) * 0.03;
    out.push([cx + Math.cos(t) * r * wobble, cy + Math.sin(t) * r * wobble, 0.5]);
  }
  return out;
}

function handwriting(): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= 400; i++) {
    const t = (i / 400) * Math.PI * 8;
    out.push([t * 6, Math.sin(t) * 14 + Math.sin(t * 2.7) * 6, 0.5]);
  }
  return out;
}

function freehand(points: Point[], over: Partial<Stroke> = {}): Stroke {
  return {
    id: 'freehand-1', tool: 'pen', color: '#abcdef', size: 7, opacity: 1,
    points, hasPressure: false, timestamp: 99, ...over,
  };
}

describe('shape recognition service', () => {
  it('is off by default — the setting has to be turned on', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.recognizeShapes).toBe(false);
  });

  it('only pen and highlighter strokes are ever offered to the recogniser', () => {
    expect(isRecognizableTool('pen')).toBe(true);
    expect(isRecognizableTool('highlighter')).toBe(true);
    for (const tool of ['eraser', 'text', 'select', 'line', 'rectangle']) {
      expect(isRecognizableTool(tool)).toBe(false);
    }
  });

  it('replaces a confident stroke with a clean shape that keeps its colour, width and tool', () => {
    const manager = new StrokeManager();
    const original = freehand(noisyCircle(100, 100, 60));
    manager.addStroke(original);

    const shape = applyShapeRecognition(manager, original);

    expect(shape).not.toBeNull();
    expect(manager.strokes).toHaveLength(1);
    expect(manager.strokes[0]).toBe(shape);
    expect(shape!.color).toBe('#abcdef');
    expect(shape!.size).toBe(7);
    expect(shape!.tool).toBe('pen');
    expect(shape!.timestamp).toBe(99);
    // A clean ellipse: every sample lies on the bounding box's inscribed ellipse.
    const box = strokeBox(shape!);
    const rx = (box.maxX - box.minX) / 2;
    const ry = (box.maxY - box.minY) / 2;
    for (const [x, y] of shape!.points) {
      expect(Math.hypot((x - (box.minX + rx)) / rx, (y - (box.minY + ry)) / ry)).toBeCloseTo(1, 6);
    }
  });

  it('keeps the shape at the same position in the stroke order', () => {
    const manager = new StrokeManager();
    manager.addStroke(freehand([[0, 0, 0.5]], { id: 'before' }));
    const original = freehand(noisyCircle(0, 0, 50));
    manager.addStroke(original);
    manager.addStroke(freehand([[9, 9, 0.5]], { id: 'after' }));

    applyShapeRecognition(manager, original);
    expect(manager.strokes.map((s) => s.id)[0]).toBe('before');
    expect(manager.strokes.map((s) => s.id)[2]).toBe('after');
  });

  it('ONE undo restores the exact original freehand stroke; a second removes it', () => {
    const manager = new StrokeManager();
    const original = freehand(noisyCircle(100, 100, 60));
    const originalPoints = original.points.map((p) => [...p]);
    manager.addStroke(original);

    applyShapeRecognition(manager, original);
    expect(manager.strokes[0].id).not.toBe('freehand-1');

    manager.undo();
    expect(manager.strokes).toHaveLength(1);
    expect(manager.strokes[0]).toBe(original);
    expect(manager.strokes[0].points).toEqual(originalPoints);

    manager.undo();
    expect(manager.strokes).toHaveLength(0);

    // Redo walks forward through both steps again.
    manager.redo();
    expect(manager.strokes[0]).toBe(original);
    manager.redo();
    expect(manager.strokes[0].id).not.toBe('freehand-1');
  });

  it('leaves handwriting alone — nothing is replaced and no undo step is added', () => {
    const manager = new StrokeManager();
    const original = freehand(handwriting());
    manager.addStroke(original);

    expect(applyShapeRecognition(manager, original)).toBeNull();
    expect(manager.strokes[0]).toBe(original);
    manager.undo();
    expect(manager.strokes).toHaveLength(0); // the stroke's own creation was the only step
  });

  it('respects the confidence threshold it is given', () => {
    const manager = new StrokeManager();
    const original = freehand(noisyCircle(0, 0, 60));
    manager.addStroke(original);
    expect(applyShapeRecognition(manager, original, { minConfidence: 1.01 })).toBeNull();
    expect(applyShapeRecognition(manager, original, { minConfidence: 0.5 })).not.toBeNull();
  });
});
