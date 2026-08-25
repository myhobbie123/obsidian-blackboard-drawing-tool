import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MIN_CONFIDENCE,
  convexHull,
  detectCorners,
  polygonArea,
  recognizeShape,
  resample,
  straightness,
  toPolyline,
  type Vec2,
} from '../src/domain/shape-recognition';

/**
 * Deterministic pseudo-random noise: every generated stroke below is wobbly the same way on
 * every run, so a tuning change that breaks a case breaks it reproducibly.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Hand tremor: a small random offset on every sample. */
function jitter(points: Vec2[], amount: number, seed = 7): Vec2[] {
  const r = rng(seed);
  return points.map(([x, y]) => [x + (r() - 0.5) * amount * 2, y + (r() - 0.5) * amount * 2] as Vec2);
}

function circle(cx: number, cy: number, radius: number, samples = 60, overshoot = 0): Vec2[] {
  const out: Vec2[] = [];
  const span = Math.PI * 2 + overshoot;
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * span;
    out.push([cx + Math.cos(t) * radius, cy + Math.sin(t) * radius]);
  }
  return out;
}

function polygon(vertices: Vec2[], perEdge = 14, closed = true): Vec2[] {
  const out: Vec2[] = [];
  const list = closed ? [...vertices, vertices[0]] : vertices;
  for (let i = 1; i < list.length; i++) {
    const [ax, ay] = list[i - 1];
    const [bx, by] = list[i];
    for (let s = i === 1 ? 0 : 1; s <= perEdge; s++) {
      const t = s / perEdge;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  }
  return out;
}

function line(ax: number, ay: number, bx: number, by: number, samples = 30): Vec2[] {
  return polygon([[ax, ay], [bx, by]], samples, false);
}

/** Shaft to the tip, then out to a barb, back to the tip and out to the other barb. */
function arrow(ax: number, ay: number, bx: number, by: number): Vec2[] {
  const angle = Math.atan2(by - ay, bx - ax);
  const head = Math.hypot(bx - ax, by - ay) * 0.22;
  const barb = (sign: number): Vec2 => [
    bx + Math.cos(angle + Math.PI + sign * 0.5) * head,
    by + Math.sin(angle + Math.PI + sign * 0.5) * head,
  ];
  return polygon([[ax, ay], [bx, by], barb(-1), [bx, by], barb(1)], 12, false);
}

/** A cursive-ish word: several loops and cusps in a short, wide box. */
function handwriting(): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= 400; i++) {
    const t = (i / 400) * Math.PI * 8;
    out.push([t * 6, Math.sin(t) * 14 + Math.sin(t * 2.7) * 6]);
  }
  return out;
}

/** A scribble: dense zig-zag back and forth over the same patch. */
function scribble(): Vec2[] {
  const out: Vec2[] = [];
  const r = rng(11);
  for (let i = 0; i < 200; i++) {
    out.push([20 + (i % 20) * 6 + r() * 4, 20 + Math.floor(i / 20) * 3 + (i % 2) * 40 + r() * 4]);
  }
  return out;
}

/** An open, deliberately curvy stroke — the "arbitrary curve" negative. */
function sCurve(): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    out.push([t * 200, Math.sin(t * Math.PI * 2) * 60]);
  }
  return out;
}

describe('shape recognition — primitives', () => {
  it('toPolyline drops the pressure channel and repeated points', () => {
    expect(toPolyline([[1, 2, 0.5], [1, 2, 0.9], [3, 4, 0.5]])).toEqual([[1, 2], [3, 4]]);
  });

  it('resample returns equidistant samples spanning the original path', () => {
    const pts = resample(line(0, 0, 100, 0, 5), 11);
    expect(pts).toHaveLength(11);
    expect(pts[0][0]).toBeCloseTo(0, 6);
    expect(pts[10][0]).toBeCloseTo(100, 6);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i][0] - pts[i - 1][0]).toBeCloseTo(10, 4);
    }
  });

  it('convexHull of a noisy square is the square, and its area matches', () => {
    const hull = convexHull(jitter(polygon([[0, 0], [100, 0], [100, 100], [0, 100]]), 1));
    expect(polygonArea(hull)).toBeGreaterThan(9500);
    expect(polygonArea(hull)).toBeLessThan(10600);
  });

  it('detectCorners finds the four corners of a square and none on a circle', () => {
    expect(detectCorners(resample(polygon([[0, 0], [100, 0], [100, 100], [0, 100]]))).length)
      .toBeGreaterThanOrEqual(3);
    expect(detectCorners(resample(circle(0, 0, 60)))).toHaveLength(0);
  });

  it('straightness is 1 for a segment and low for a loop', () => {
    expect(straightness(line(0, 0, 100, 0))).toBeCloseTo(1, 6);
    expect(straightness(circle(0, 0, 50))).toBeLessThan(0.05);
  });
});

describe('shape recognition — positives', () => {
  it('recognises a wobbly circle as an ellipse over its bounding box', () => {
    const result = recognizeShape(jitter(circle(100, 100, 60), 3, 3));
    expect(result?.kind).toBe('ellipse');
    expect(result!.confidence).toBeGreaterThanOrEqual(DEFAULT_MIN_CONFIDENCE);
    expect(result!.spec.kind).toBe('ellipse');
  });

  it('recognises a circle whose ends overshoot the start', () => {
    expect(recognizeShape(jitter(circle(0, 0, 80, 70, 0.6), 3, 5))?.kind).toBe('ellipse');
  });

  it('recognises an ellipse that is not a circle', () => {
    const pts = jitter(circle(0, 0, 1, 60).map(([x, y]) => [x * 120, y * 50] as Vec2), 3, 9);
    expect(recognizeShape(pts)?.kind).toBe('ellipse');
  });

  it('recognises a wobbly rectangle', () => {
    const result = recognizeShape(jitter(polygon([[10, 10], [210, 14], [208, 130], [12, 128]]), 3, 13));
    expect(result?.kind).toBe('rectangle');
    expect(result!.confidence).toBeGreaterThanOrEqual(DEFAULT_MIN_CONFIDENCE);
  });

  it('recognises a rectangle with rounded corners and an unclosed gap', () => {
    const pts = jitter(polygon([[0, 0], [150, 0], [150, 90], [0, 90]]), 2, 21).slice(0, -4);
    expect(recognizeShape(pts)?.kind).toBe('rectangle');
  });

  it('recognises a wobbly triangle', () => {
    const result = recognizeShape(jitter(polygon([[100, 0], [200, 160], [0, 160]]), 2, 31));
    expect(result?.kind).toBe('triangle');
    expect(result!.spec.kind).toBe('polygon');
  });

  it('recognises a shaky straight line', () => {
    const result = recognizeShape(jitter(line(0, 0, 240, 40), 3, 41));
    expect(result?.kind).toBe('line');
  });

  it('recognises a one-stroke arrow and puts the tip at the arrow head', () => {
    const result = recognizeShape(jitter(arrow(0, 0, 200, 0), 2, 51));
    expect(result?.kind).toBe('arrow');
    const spec = result!.spec;
    if (spec.kind === 'polygon') throw new Error('expected a two-point spec');
    expect(spec.to[0]).toBeGreaterThan(180);
  });
});

describe('shape recognition — negatives (must never fire)', () => {
  it('does not fire on handwriting', () => {
    expect(recognizeShape(handwriting())).toBeNull();
  });

  it('does not fire on a scribble', () => {
    expect(recognizeShape(scribble())).toBeNull();
  });

  it('does not fire on an open S-curve', () => {
    expect(recognizeShape(sCurve())).toBeNull();
  });

  it('does not fire on a quarter arc', () => {
    const arc = circle(0, 0, 90, 40).slice(0, 11);
    expect(recognizeShape(arc)).toBeNull();
  });

  it('does not fire on a tiny mark', () => {
    expect(recognizeShape(jitter(circle(0, 0, 6), 1))).toBeNull();
  });

  it('does not fire on too few samples', () => {
    expect(recognizeShape([[0, 0], [50, 0], [50, 50]])).toBeNull();
  });

  it('respects a raised confidence threshold', () => {
    const pts = jitter(circle(0, 0, 60), 6, 77);
    expect(recognizeShape(pts, { minConfidence: 0 })).not.toBeNull();
    expect(recognizeShape(pts, { minConfidence: 1.01 })).toBeNull();
  });
});

/**
 * A measured corpus rather than a handful of examples: many randomised, noisy instances of
 * each class, plus a negative set that must produce NO recognitions at all. The thresholds
 * asserted here are the numbers quoted for the feature — recall per class, and a
 * false-positive rate of exactly zero on the negatives.
 */
describe('shape recognition — measured accuracy on a synthetic corpus', () => {
  const SAMPLES = 40;

  function recall(make: (seed: number) => Vec2[], kinds: string[], _label = ''): number {
    let hits = 0;
    for (let seed = 1; seed <= SAMPLES; seed++) {
      const result = recognizeShape(make(seed));
      if (result && kinds.includes(result.kind)) hits++;
    }
    return hits / SAMPLES;
  }

  it('circles: at least 95% recall', () => {
    expect(recall((seed) => {
      const r = rng(seed);
      const radius = 40 + r() * 120;
      return jitter(circle(r() * 100, r() * 100, radius, 40 + Math.floor(r() * 40), r() * 0.8), radius * 0.06, seed);
    }, ['ellipse'], 'ellipse')).toBeGreaterThanOrEqual(0.95);
  });

  it('rectangles: at least 95% recall', () => {
    expect(recall((seed) => {
      const r = rng(seed);
      const w = 60 + r() * 180;
      const h = 50 + r() * 150;
      return jitter(polygon([[0, 0], [w, 0], [w, h], [0, h]], 10 + Math.floor(r() * 10)), Math.min(w, h) * 0.03, seed);
    }, ['rectangle'], 'rectangle')).toBeGreaterThanOrEqual(0.95);
  });

  it('triangles: at least 95% recall', () => {
    expect(recall((seed) => {
      const r = rng(seed);
      const w = 80 + r() * 160;
      const h = 80 + r() * 160;
      return jitter(polygon([[w / 2 + (r() - 0.5) * w * 0.3, 0], [w, h], [0, h]], 12), Math.min(w, h) * 0.03, seed);
    }, ['triangle'], 'triangle')).toBeGreaterThanOrEqual(0.95);
  });

  it('lines: at least 95% recall', () => {
    expect(recall((seed) => {
      const r = rng(seed);
      const length = 80 + r() * 220;
      const angle = r() * Math.PI * 2;
      return jitter(line(0, 0, Math.cos(angle) * length, Math.sin(angle) * length), length * 0.012, seed);
    }, ['line'], 'line')).toBeGreaterThanOrEqual(0.95);
  });

  it('arrows: at least 90% recall', () => {
    expect(recall((seed) => {
      const r = rng(seed);
      const length = 100 + r() * 200;
      const angle = r() * Math.PI * 2;
      return jitter(arrow(0, 0, Math.cos(angle) * length, Math.sin(angle) * length), length * 0.012, seed);
    }, ['arrow'], 'arrow')).toBeGreaterThanOrEqual(0.90);
  });

  it('negatives: zero false positives across handwriting, scribbles and arbitrary curves', () => {
    const negatives: Vec2[][] = [];
    for (let seed = 1; seed <= SAMPLES; seed++) {
      const r = rng(seed);
      negatives.push(jitter(handwriting(), 2, seed));
      negatives.push(jitter(scribble(), 2, seed));
      negatives.push(jitter(sCurve(), 2, seed));
      // A random open squiggle through four control points.
      const pts: Vec2[] = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        pts.push([
          t * 200 + Math.sin(t * 9 + r()) * 40,
          Math.cos(t * 7 + r() * 3) * 70 + t * 30,
        ]);
      }
      negatives.push(pts);
      // A partial arc: closed shapes that were abandoned half-way.
      negatives.push(jitter(circle(0, 0, 40 + r() * 80, 40).slice(0, 14), 2, seed));
    }
    const fired = negatives.filter((pts) => recognizeShape(pts) !== null);
    expect(fired).toHaveLength(0);
  });
});
