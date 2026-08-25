import { describe, it, expect } from 'vitest';
import type { Stroke } from '../src/domain/entities';
import { findStrokesAtPoint } from '../src/application/eraser-service';
import { StrokeManager } from '../src/domain/stroke-manager';

/**
 * The naive hit test the optimised implementation must agree with EXACTLY: no bounding-box
 * pre-test, no squared-distance trick, `Math.sqrt` everywhere. This is the definition of
 * correctness for the eraser; the optimisation is only allowed to be faster.
 */
function referenceFindStrokesAtPoint(
  strokes: Stroke[],
  worldX: number,
  worldY: number,
  eraserSize: number,
): string[] {
  const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2);
  };

  const hits: string[] = [];
  for (const stroke of strokes) {
    let hit = false;
    for (let i = 0; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      if (Math.sqrt((p[0] - worldX) ** 2 + (p[1] - worldY) ** 2) < eraserSize) { hit = true; break; }
      if (i > 0) {
        const prev = stroke.points[i - 1];
        if (distToSegment(worldX, worldY, prev[0], prev[1], p[0], p[1]) < eraserSize) { hit = true; break; }
      }
    }
    if (hit) hits.push(stroke.id);
  }
  return hits;
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomStroke(rand: () => number, id: string): Stroke {
  const count = 1 + Math.floor(rand() * 8);
  const ox = rand() * 400 - 200;
  const oy = rand() * 400 - 200;
  const points: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    points.push([ox + rand() * 120 - 60, oy + rand() * 120 - 60, rand()]);
  }
  return {
    id,
    tool: rand() < 0.5 ? 'pen' : 'highlighter',
    color: '#ffffff',
    size: 1 + rand() * 20,
    opacity: 1,
    points,
    hasPressure: rand() < 0.5,
    timestamp: 0,
  };
}

describe('eraser hit test agrees with the naive reference', () => {
  it('reports identical hits over 4000 randomised probes — zero mismatches', () => {
    const rand = mulberry32(0x5eed);
    const strokes = Array.from({ length: 40 }, (_, i) => randomStroke(rand, `s${i}`));

    let mismatches = 0;
    let hitProbes = 0;
    const failures: string[] = [];

    for (let probe = 0; probe < 4000; probe++) {
      // Probes are drawn from the same region as the strokes, so a healthy fraction of them
      // actually hit — a test where everything misses would pass with a broken AABB.
      const x = rand() * 500 - 250;
      const y = rand() * 500 - 250;
      const size = 1 + rand() * 40;

      const actual = findStrokesAtPoint(strokes, x, y, size);
      const expected = referenceFindStrokesAtPoint(strokes, x, y, size);
      if (actual.length > 0) hitProbes++;
      if (actual.join(',') !== expected.join(',')) {
        mismatches++;
        if (failures.length < 3) {
          failures.push(`probe (${x}, ${y}, r=${size}): got [${actual}] want [${expected}]`);
        }
      }
    }

    expect(failures).toEqual([]);
    expect(mismatches).toBe(0);
    // Sanity: the probes are not all trivially misses.
    expect(hitProbes).toBeGreaterThan(200);
  });

  it('agrees on degenerate geometry: single points, duplicates and zero radius', () => {
    const strokes: Stroke[] = [
      { id: 'point', tool: 'pen', color: '#fff', size: 2, opacity: 1, hasPressure: false, timestamp: 0, points: [[0, 0, 0.5]] },
      { id: 'dup', tool: 'pen', color: '#fff', size: 2, opacity: 1, hasPressure: false, timestamp: 0, points: [[5, 5, 0.5], [5, 5, 0.5]] },
      { id: 'empty', tool: 'pen', color: '#fff', size: 2, opacity: 1, hasPressure: false, timestamp: 0, points: [] },
    ];
    const probes: Array<[number, number, number]> = [
      [0, 0, 0], [0, 0, 1], [5, 5, 0.001], [0.999, 0, 1], [1, 0, 1], [1000, 1000, 1],
    ];
    for (const [x, y, r] of probes) {
      expect(findStrokesAtPoint(strokes, x, y, r)).toEqual(referenceFindStrokesAtPoint(strokes, x, y, r));
    }
  });

  it('still agrees after moveStroke has mutated points in place (cache invalidation)', () => {
    const rand = mulberry32(99);
    const manager = new StrokeManager();
    for (let i = 0; i < 10; i++) manager.addStroke(randomStroke(rand, `m${i}`));

    // Warm the bounding-box cache, then move every stroke well away and re-probe.
    for (let p = 0; p < 200; p++) findStrokesAtPoint(manager.strokes, rand() * 200, rand() * 200, 20);
    for (const stroke of [...manager.strokes]) manager.moveStroke(stroke.id, 1000, -750);

    let mismatches = 0;
    for (let p = 0; p < 1000; p++) {
      const x = rand() * 1600 - 300;
      const y = rand() * 1200 - 900;
      const r = 1 + rand() * 30;
      if (findStrokesAtPoint(manager.strokes, x, y, r).join(',') !==
          referenceFindStrokesAtPoint(manager.strokes, x, y, r).join(',')) {
        mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it('still agrees after an undo of a move (the undo path invalidates too)', () => {
    const rand = mulberry32(1234);
    const manager = new StrokeManager();
    for (let i = 0; i < 8; i++) manager.addStroke(randomStroke(rand, `u${i}`));
    const ids = manager.strokes.map((s) => s.id);
    for (const id of ids) manager.moveStroke(id, 500, 500);
    for (let p = 0; p < 200; p++) findStrokesAtPoint(manager.strokes, 500 + rand() * 100, 500 + rand() * 100, 20);
    for (let i = 0; i < ids.length; i++) manager.undo();

    let mismatches = 0;
    for (let p = 0; p < 1000; p++) {
      const x = rand() * 800 - 400;
      const y = rand() * 800 - 400;
      const r = 1 + rand() * 30;
      if (findStrokesAtPoint(manager.strokes, x, y, r).join(',') !==
          referenceFindStrokesAtPoint(manager.strokes, x, y, r).join(',')) {
        mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it('still agrees after points are appended to a live stroke', () => {
    const rand = mulberry32(7);
    const stroke = randomStroke(rand, 'growing');
    stroke.points = [[0, 0, 0.5]];
    const strokes = [stroke];
    let mismatches = 0;
    for (let step = 0; step < 60; step++) {
      // Probe (warming the cache), then extend the stroke — the length change must invalidate.
      for (let p = 0; p < 20; p++) {
        const x = rand() * 300 - 50;
        const y = rand() * 300 - 50;
        const r = 1 + rand() * 15;
        if (findStrokesAtPoint(strokes, x, y, r).join(',') !==
            referenceFindStrokesAtPoint(strokes, x, y, r).join(',')) {
          mismatches++;
        }
      }
      stroke.points.push([step * 4, step * 3, 0.5]);
    }
    expect(mismatches).toBe(0);
  });
});
