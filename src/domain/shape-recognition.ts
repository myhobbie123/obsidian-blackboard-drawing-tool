import type { Point } from './entities';
import type { ShapeSpec } from './shapes';

/**
 * Shape recognition: turn a rough freehand stroke into a clean shape — circle, rectangle,
 * triangle, line or arrow — or, far more often, leave it alone.
 *
 * Everything here is pure and DOM-free: the input is a point list in drawing units and the
 * output is a `ShapeSpec` the shape builder already knows how to materialise, so a recognised
 * circle is byte-for-byte the stroke the ellipse tool would have produced.
 *
 * The bias is deliberate and one-sided. A recogniser that fires on an obvious circle and stays
 * silent on everything else is useful; one that fires often and wrongly makes the pen
 * untrustworthy and is worse than no feature at all. So every classifier scores in [0, 1],
 * nothing below `DEFAULT_MIN_CONFIDENCE` is ever returned, and three cheap global guards run
 * first: too few samples, too small a mark, and too much ink for the box it occupies (which is
 * what handwriting and scribbles look like from here).
 */
export type RecognizedKind = 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'triangle';

export interface RecognizedShape {
  kind: RecognizedKind;
  /** In [0, 1]; only results at or above the threshold are returned. */
  confidence: number;
  /** Ready for `shapeStrokePoints` — the same representation the shape TOOLS emit. */
  spec: ShapeSpec;
}

export interface RecognitionOptions {
  /** Minimum confidence to fire. Higher is stricter. */
  minConfidence?: number;
}

/** Tuned so obvious shapes fire and everything ambiguous does not. */
export const DEFAULT_MIN_CONFIDENCE = 0.72;

/** Below this many samples there is not enough evidence to classify anything. */
const MIN_POINTS = 8;
/** Below this bounding-box diagonal (drawing units) a mark is a dot or a tick, not a shape. */
const MIN_DIAGONAL = 24;
/**
 * Ink length as a multiple of the bounding-box diagonal. A circle is ~2.2, a square ~2.8, a
 * triangle ~2.4, a single-stroke arrow ~2.7. Handwriting and scribbles pack far more path into
 * their box, so anything past this is refused before a classifier ever sees it.
 */
const MAX_INK_RATIO = 4.6;
/** Resolution every metric is computed at, so wobble and sampling rate stop mattering. */
const RESAMPLE_COUNT = 64;

export type Vec2 = [number, number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Drop the pressure channel and any repeated point. */
export function toPolyline(points: ReadonlyArray<Point | Vec2>): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push([p[0], p[1]]);
  }
  return out;
}

export function pathLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

export interface Box { minX: number; minY: number; maxX: number; maxY: number }

export function boundsOf(points: readonly Vec2[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Equidistant resampling — the standard first step of every stroke recogniser (the $1
 * recogniser's, unchanged): walk the path, emit a point every `total / (count - 1)` units, and
 * continue measuring FROM the emitted point so a long input segment yields several samples.
 */
export function resample(points: readonly Vec2[], count = RESAMPLE_COUNT): Vec2[] {
  if (points.length < 2 || count < 2) return points.map((p) => [p[0], p[1]] as Vec2);
  const total = pathLength(points);
  if (total === 0) return points.map((p) => [p[0], p[1]] as Vec2);
  const interval = total / (count - 1);
  const src: Vec2[] = points.map((p) => [p[0], p[1]] as Vec2);
  const out: Vec2[] = [[src[0][0], src[0][1]]];
  let carried = 0;
  for (let i = 1; i < src.length && out.length < count; i++) {
    const d = Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1]);
    if (carried + d >= interval) {
      const t = d === 0 ? 0 : (interval - carried) / d;
      const q: Vec2 = [
        src[i - 1][0] + t * (src[i][0] - src[i - 1][0]),
        src[i - 1][1] + t * (src[i][1] - src[i - 1][1]),
      ];
      out.push(q);
      // Continue from the emitted point, so the remainder of this segment is measured too.
      src.splice(i, 0, q);
      carried = 0;
    } else {
      carried += d;
    }
  }
  const last = src[src.length - 1];
  while (out.length < count) out.push([last[0], last[1]]);
  return out;
}

/** Andrew's monotone chain. Returns the hull counter-clockwise, without the repeated point. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = points.map((p) => [p[0], p[1]] as Vec2).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Unsigned shoelace area of a closed polygon. */
export function polygonArea(points: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  }
  return Math.abs(area / 2);
}

/**
 * Corners, by accumulated turning angle over a window. The window is what makes this survive a
 * shaky hand: a rounded corner spreads its turn over several samples, and comparing directions
 * `window` samples apart adds those up instead of dismissing each one as noise.
 */
export function detectCorners(
  points: readonly Vec2[],
  thresholdDeg = 50,
  window = 3,
): number[] {
  const n = points.length;
  if (n < window * 2 + 1) return [];
  const threshold = (thresholdDeg * Math.PI) / 180;
  const turn: number[] = new Array<number>(n).fill(0);
  for (let i = window; i < n - window; i++) {
    const ax = points[i][0] - points[i - window][0];
    const ay = points[i][1] - points[i - window][1];
    const bx = points[i + window][0] - points[i][0];
    const by = points[i + window][1] - points[i][1];
    if ((ax === 0 && ay === 0) || (bx === 0 && by === 0)) continue;
    let angle = Math.atan2(by, bx) - Math.atan2(ay, ax);
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    turn[i] = Math.abs(angle);
  }
  const corners: number[] = [];
  for (let i = window; i < n - window; i++) {
    if (turn[i] < threshold) continue;
    // Non-maximum suppression inside one window, so a single rounded corner counts once.
    let isPeak = true;
    for (let j = Math.max(0, i - window); j <= Math.min(n - 1, i + window); j++) {
      if (turn[j] > turn[i]) { isPeak = false; break; }
    }
    if (isPeak && (corners.length === 0 || i - corners[corners.length - 1] > window)) corners.push(i);
  }
  return corners;
}

/** End-to-end distance as a fraction of path length: 1 is a perfect straight line. */
export function straightness(points: readonly Vec2[]): number {
  const length = pathLength(points);
  if (length === 0) return 0;
  const first = points[0];
  const last = points[points.length - 1];
  return Math.hypot(last[0] - first[0], last[1] - first[1]) / length;
}

/**
 * Three-point moving average, applied twice. Hand tremor pushes samples OUTWARD as often as
 * inward, which inflates the convex hull and drags down every area ratio computed from it;
 * smoothing after resampling removes that bias while barely rounding real corners (the samples
 * are equidistant, so the window is a fixed arc length).
 */
export function smooth(points: readonly Vec2[], passes = 2): Vec2[] {
  let current: Vec2[] = points.map((p) => [p[0], p[1]] as Vec2);
  for (let pass = 0; pass < passes; pass++) {
    const next: Vec2[] = current.map((p, i) => {
      if (i === 0 || i === current.length - 1) return [p[0], p[1]] as Vec2;
      return [
        (current[i - 1][0] + p[0] + current[i + 1][0]) / 3,
        (current[i - 1][1] + p[1] + current[i + 1][1]) / 3,
      ] as Vec2;
    });
    current = next;
  }
  return current;
}

interface Metrics {
  points: Vec2[];
  box: Box;
  width: number;
  height: number;
  diagonal: number;
  ink: number;
  closureGap: number;
  hull: Vec2[];
  hullArea: number;
  corners: number[];
}

function metricsOf(points: Vec2[]): Metrics {
  const box = boundsOf(points);
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const diagonal = Math.hypot(width, height);
  const first = points[0];
  const last = points[points.length - 1];
  return {
    points,
    box,
    width,
    height,
    diagonal,
    ink: pathLength(points),
    closureGap: diagonal === 0 ? 1 : Math.hypot(last[0] - first[0], last[1] - first[1]) / diagonal,
    hull: convexHull(points),
    hullArea: polygonArea(convexHull(points)),
    corners: detectCorners(points),
  };
}

/** A stroke counts as closed when its ends are within this fraction of the box diagonal. */
const CLOSURE_RATIO = 0.25;

/** Mean distance from the samples to the nearest bounding-box edge, relative to the diagonal. */
function rectangleResidual(m: Metrics): number {
  if (m.diagonal === 0) return 1;
  let total = 0;
  for (const [x, y] of m.points) {
    const d = Math.min(x - m.box.minX, m.box.maxX - x, y - m.box.minY, m.box.maxY - y);
    total += Math.max(0, d);
  }
  return total / m.points.length / m.diagonal;
}

/** Mean deviation of the samples from the bounding box's inscribed ellipse. */
function ellipseResidual(m: Metrics): number {
  const rx = m.width / 2;
  const ry = m.height / 2;
  if (rx <= 0 || ry <= 0) return 1;
  const cx = m.box.minX + rx;
  const cy = m.box.minY + ry;
  let total = 0;
  for (const [x, y] of m.points) {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    total += Math.abs(Math.hypot(nx, ny) - 1);
  }
  return total / m.points.length;
}

function ellipseScore(m: Metrics): number {
  const rx = m.width / 2;
  const ry = m.height / 2;
  if (rx <= 0 || ry <= 0) return 0;
  const residual = ellipseResidual(m);
  // Area of the samples' hull against the area of the bounding box's inscribed ellipse: 1 for
  // any ellipse however eccentric, ~1.27 for a rectangle, ~0.64 for a triangle. (Circularity,
  // 4*pi*A/P^2, would have been the obvious second term but it punishes eccentricity, which
  // would have made a long thin ellipse unrecognisable.)
  const fill = m.hullArea / (Math.PI * rx * ry);
  return 0.6 * clamp01(1 - residual / 0.20) + 0.4 * clamp01(1 - Math.abs(fill - 1) / 0.20);
}

function rectangleScore(m: Metrics): number {
  const boxArea = m.width * m.height;
  if (boxArea <= 0) return 0;
  const fill = m.hullArea / boxArea;
  // Rounded corners cost a little fill and a little residual; both budgets absorb that.
  return 0.55 * clamp01(1 - rectangleResidual(m) / 0.085) + 0.45 * clamp01((fill - 0.68) / 0.24);
}

/**
 * The largest-area triangle whose vertices are hull vertices. Robust where corner detection is
 * not: it does not care where the stroke started, how rounded the corners are, or whether the
 * seam closed cleanly.
 */
export function maxAreaTriangle(hull: readonly Vec2[]): { area: number; vertices: Vec2[] } | null {
  if (hull.length < 3) return null;
  let best: Vec2[] | null = null;
  let bestArea = 0;
  for (let a = 0; a < hull.length; a++) {
    for (let b = a + 1; b < hull.length; b++) {
      for (let c = b + 1; c < hull.length; c++) {
        const area = polygonArea([hull[a], hull[b], hull[c]]);
        if (area > bestArea) { bestArea = area; best = [hull[a], hull[b], hull[c]]; }
      }
    }
  }
  return best ? { area: bestArea, vertices: best } : null;
}

function triangleFrom(m: Metrics): { score: number; vertices: Vec2[] } | null {
  const fit = maxAreaTriangle(m.hull);
  if (!fit || fit.area <= 0 || m.hullArea <= 0) return null;
  // How much of the hull that triangle covers: ~1 for a real triangle, 0.5 for a rectangle,
  // 3*sqrt(3)/(4*pi) = 0.41 for a circle. This one ratio does nearly all the discriminating.
  const cover = fit.area / m.hullArea;
  const boxArea = m.width * m.height;
  const fill = boxArea > 0 ? m.hullArea / boxArea : 0;
  const score = 0.8 * clamp01((cover - 0.68) / 0.20) +
    0.2 * clamp01(1 - Math.abs(fill - 0.5) / 0.26);
  return { score, vertices: fit.vertices };
}

interface ArrowFit { score: number; from: Vec2; tip: Vec2 }

/**
 * A one-stroke arrow: a straight shaft, then a short head that doubles back on it. The tip is
 * the point farthest from the start; everything after it must stay near the tip and must leave
 * it at a sharp angle to the shaft, which is exactly what a head looks like and is not what a
 * curve, a corner or a hook looks like.
 */
function arrowFit(m: Metrics): ArrowFit | null {
  const pts = m.points;
  const start = pts[0];
  let tipDistance = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - start[0], pts[i][1] - start[1]);
    if (d > tipDistance) tipDistance = d;
  }
  // A single-stroke arrow passes through its tip TWICE (out to one barb, back, out to the
  // other), so the farthest sample is a near-tie between the two visits. Take the FIRST sample
  // within 2% of the maximum: the second visit would leave a tail too short to look like a head.
  let tipIndex = 0;
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(pts[i][0] - start[0], pts[i][1] - start[1]) >= tipDistance * 0.98) { tipIndex = i; break; }
  }
  if (tipIndex < 4 || tipIndex > pts.length - 4) return null;
  const shaft = pts.slice(0, tipIndex + 1);
  const tail = pts.slice(tipIndex);
  const shaftLength = pathLength(shaft);
  const tailLength = pathLength(tail);
  if (shaftLength <= 0) return null;
  const tailRatio = tailLength / shaftLength;
  // Too short a tail is a plain line; too long a one is a different shape entirely.
  if (tailRatio < 0.15 || tailRatio > 1.4) return null;

  const shaftStraightness = straightness(shaft);
  if (shaftStraightness < 0.90) return null;

  const tip = pts[tipIndex];
  // Every head sample must stay within half the shaft of the tip.
  let farthestTail = 0;
  for (const [x, y] of tail) {
    const d = Math.hypot(x - tip[0], y - tip[1]);
    if (d > farthestTail) farthestTail = d;
  }
  const spread = farthestTail / shaftLength;
  if (spread > 0.55) return null;

  // The head must leave the tip against the shaft direction.
  const shaftAngle = Math.atan2(tip[1] - start[1], tip[0] - start[0]);
  const next = tail[Math.min(2, tail.length - 1)];
  let turn = Math.abs(Math.atan2(next[1] - tip[1], next[0] - tip[0]) - shaftAngle);
  if (turn > Math.PI) turn = Math.PI * 2 - turn;
  if (turn < (100 * Math.PI) / 180) return null;

  const score = 0.5 * clamp01((shaftStraightness - 0.90) / 0.07) +
    0.3 * clamp01(1 - Math.abs(spread - 0.28) / 0.28) +
    0.2 * clamp01((turn - (100 * Math.PI) / 180) / ((60 * Math.PI) / 180));
  return { score, from: start, tip };
}

/**
 * Classify a freehand stroke, or return null. Null is the expected answer for handwriting,
 * scribbles, arbitrary curves, and anything the classifiers are merely lukewarm about.
 */
export function recognizeShape(
  rawPoints: ReadonlyArray<Point | Vec2>,
  options: RecognitionOptions = {},
): RecognizedShape | null {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const polyline = toPolyline(rawPoints);
  if (polyline.length < MIN_POINTS) return null;

  const raw = metricsOf(polyline);
  if (raw.diagonal < MIN_DIAGONAL) return null;
  // Handwriting and scribbles: far more ink than the box they occupy can justify.
  if (raw.ink / raw.diagonal > MAX_INK_RATIO) return null;

  // Two views of the same stroke. The closed-shape classifiers work on area ratios of the
  // convex hull, which tremor biases outward, so they read the SMOOTHED polyline; the open ones
  // measure straightness and the sharp reversal at an arrow's tip, which smoothing would blunt,
  // so they read the raw resampled one.
  const m = metricsOf(resample(polyline));
  const closedMetrics = metricsOf(smooth(m.points));
  const closed = m.closureGap <= CLOSURE_RATIO;

  const candidates: RecognizedShape[] = [];
  const offer = (kind: RecognizedKind, confidence: number, spec: ShapeSpec): void => {
    if (Number.isFinite(confidence) && confidence >= minConfidence) {
      candidates.push({ kind, confidence, spec });
    }
  };
  const boxSpec = {
    from: [m.box.minX, m.box.minY] as [number, number],
    to: [m.box.maxX, m.box.maxY] as [number, number],
  };

  if (closed) {
    offer('ellipse', ellipseScore(closedMetrics), { kind: 'ellipse', ...boxSpec });
    offer('rectangle', rectangleScore(closedMetrics), { kind: 'rectangle', ...boxSpec });
    // The triangle test reads the RAW polyline: its discriminator is how much of the hull the
    // largest inscribed triangle covers, and smoothing rounds exactly the corners that ratio
    // depends on (a rectangle still covers only ~0.5 and a circle ~0.43 either way).
    const triangle = triangleFrom(m);
    if (triangle) {
      offer('triangle', triangle.score, { kind: 'polygon', vertices: triangle.vertices, closed: true });
    }
  } else {
    const arrow = arrowFit(m);
    if (arrow) offer('arrow', arrow.score, { kind: 'arrow', from: arrow.from, to: arrow.tip });
    if (m.corners.length <= 1) {
      offer('line', clamp01((straightness(m.points) - 0.90) / 0.075), {
        kind: 'line',
        from: m.points[0],
        to: m.points[m.points.length - 1],
      });
    }
  }

  let best: RecognizedShape | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.confidence > best.confidence) best = candidate;
  }
  return best;
}
