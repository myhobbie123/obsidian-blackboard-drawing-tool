import type { Point, Stroke, ToolName } from './entities';

/**
 * Shapes are MATERIALISED AS ORDINARY STROKES: a shape tool tessellates its geometry into a
 * normal `Stroke.points` list at commit time, and nothing downstream can tell it apart from a
 * freehand one.
 *
 * The alternative — a distinct shape entity in the file — would have meant a new format
 * version, plus a second code path in the eraser's AABB/segment test, in the Path2D cache, in
 * the SVG exporter, in the content-bounds calculation, in the marquee selection and in
 * `moveStroke`, for a feature whose only extra affordance would be re-editing a shape's
 * parameters after the fact. With a point list all of that works unchanged, a drawing with
 * shapes stays format version 3 (so upstream 1.2.1 opens it and renders the shapes correctly
 * rather than merely "degrading"), and the Path2D cache keys — points identity, length, size,
 * pressure flag, geometry epoch — need no new member.
 *
 * The point list is built ONCE, on release, at a density derived from the shape's size in
 * drawing units; the view transform is applied by the canvas, so a committed shape is as crisp
 * at 8x zoom as a freehand stroke and is never re-tessellated.
 */
export type ShapeKind = 'line' | 'arrow' | 'rectangle' | 'ellipse';

/** The four shape tools, in toolbar order. */
export const SHAPE_KINDS: readonly ShapeKind[] = ['line', 'arrow', 'rectangle', 'ellipse'];

export function isShapeTool(tool: ToolName): tool is ShapeKind {
  return tool === 'line' || tool === 'arrow' || tool === 'rectangle' || tool === 'ellipse';
}

/**
 * What to build, in drawing space. The two-point forms come from a drag (`from` is the press,
 * `to` the current pointer); `polygon` is what the shape recogniser emits for a triangle, and
 * what the rectangle builder is itself expressed in.
 */
export type ShapeSpec =
  | { kind: ShapeKind; from: readonly [number, number]; to: readonly [number, number] }
  | { kind: 'polygon'; vertices: ReadonlyArray<readonly [number, number]>; closed: boolean };

export interface ShapeStyle {
  color: string;
  size: number;
  opacity: number;
  tool: 'pen' | 'highlighter';
}

/** Shift-constrained angles for line/arrow, in degrees. */
export const ANGLE_SNAP_DEG = 15;

/** Every shape point carries this pressure, so a shape has one uniform width end to end. */
export const SHAPE_PRESSURE = 0.5;

/** Target segment length (drawing units) of the tessellation. */
const SEGMENT_LENGTH = 6;
const MIN_SEGMENTS = 2;
const MAX_SEGMENTS_PER_EDGE = 96;
const MAX_ELLIPSE_SEGMENTS = 160;

/** Arrow-head geometry: barb length as a fraction of the shaft, and its opening angle. */
const HEAD_FRACTION = 0.22;
const HEAD_MIN = 6;
const HEAD_MAX = 48;
const HEAD_ANGLE = (28 * Math.PI) / 180;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function segmentsFor(length: number, max = MAX_SEGMENTS_PER_EDGE): number {
  if (!Number.isFinite(length) || length <= 0) return MIN_SEGMENTS;
  return clamp(Math.ceil(length / SEGMENT_LENGTH), MIN_SEGMENTS, max);
}

/**
 * Shift-constrain the free end of a line/arrow drag to a multiple of `ANGLE_SNAP_DEG`,
 * preserving the drag's length. Exactly half-way between two increments rounds up (7.5 -> 15).
 */
export function snapAngle(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  stepDeg = ANGLE_SNAP_DEG,
): [number, number] {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [toX, toY];
  const step = (stepDeg * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [fromX + Math.cos(angle) * length, fromY + Math.sin(angle) * length];
}

/**
 * Shift-constrain a rectangle/ellipse drag to a square/circle. The larger of the two drag
 * extents wins, so the constrained shape always covers the dragged one and the corner keeps
 * the drag's direction.
 */
export function snapSquare(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): [number, number] {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  return [fromX + sx * size, fromY + sy * size];
}

/** Apply the Shift constraint appropriate to `kind`. */
export function constrainShapeEnd(
  kind: ShapeKind,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): [number, number] {
  if (kind === 'line' || kind === 'arrow') return snapAngle(fromX, fromY, toX, toY);
  return snapSquare(fromX, fromY, toX, toY);
}

/** Push the samples of a straight segment, excluding the start point (the caller emits it). */
function pushSegment(out: Point[], ax: number, ay: number, bx: number, by: number): void {
  const n = segmentsFor(Math.hypot(bx - ax, by - ay));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push([ax + (bx - ax) * t, ay + (by - ay) * t, SHAPE_PRESSURE]);
  }
}

function polylinePoints(
  vertices: ReadonlyArray<readonly [number, number]>,
  closed: boolean,
): Point[] {
  const out: Point[] = [];
  if (vertices.length === 0) return out;
  out.push([vertices[0][0], vertices[0][1], SHAPE_PRESSURE]);
  for (let i = 1; i < vertices.length; i++) {
    pushSegment(out, vertices[i - 1][0], vertices[i - 1][1], vertices[i][0], vertices[i][1]);
  }
  if (closed && vertices.length > 2) {
    const last = vertices[vertices.length - 1];
    pushSegment(out, last[0], last[1], vertices[0][0], vertices[0][1]);
  }
  return out;
}

function ellipsePoints(fromX: number, fromY: number, toX: number, toY: number): Point[] {
  const cx = (fromX + toX) / 2;
  const cy = (fromY + toY) / 2;
  const rx = Math.abs(toX - fromX) / 2;
  const ry = Math.abs(toY - fromY) / 2;
  // The mean-radius circumference is within a few percent of the true perimeter and only
  // decides how many samples the outline gets, so the cheap approximation is the right one.
  const perimeter = Math.PI * (rx + ry);
  // Rounded up to a multiple of 4 so the four extreme points are always sampled: the shape's
  // bounding box then matches the drag box exactly, which everything downstream (the eraser's
  // AABB, the marquee's containment test, the exporter's viewBox) measures against.
  const n = Math.ceil(clamp(Math.ceil(perimeter / SEGMENT_LENGTH), 16, MAX_ELLIPSE_SEGMENTS) / 4) * 4;
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry, SHAPE_PRESSURE]);
  }
  return out;
}

/** The two barb tips of an arrow head pointing from `from` to `tip`. */
export function arrowHead(
  fromX: number,
  fromY: number,
  tipX: number,
  tipY: number,
): { left: [number, number]; right: [number, number] } {
  const dx = tipX - fromX;
  const dy = tipY - fromY;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { left: [tipX, tipY], right: [tipX, tipY] };
  const head = clamp(length * HEAD_FRACTION, Math.min(HEAD_MIN, length), HEAD_MAX);
  // The barbs point BACK along the shaft, opened by +/- HEAD_ANGLE.
  const back = Math.atan2(-dy, -dx);
  return {
    left: [tipX + Math.cos(back - HEAD_ANGLE) * head, tipY + Math.sin(back - HEAD_ANGLE) * head],
    right: [tipX + Math.cos(back + HEAD_ANGLE) * head, tipY + Math.sin(back + HEAD_ANGLE) * head],
  };
}

/**
 * Tessellate a shape into a stroke point list, in drawing units. Density follows the shape's
 * size (one sample per ~6 units, clamped), which is what makes a shape look like a stroke the
 * user drew rather than a four-point polygon under `perfect-freehand`.
 *
 * The arrow is ONE stroke: shaft to the tip, out to a barb, back to the tip, out to the other
 * barb — the path a hand takes drawing an arrow in one go.
 */
export function shapeStrokePoints(spec: ShapeSpec): Point[] {
  if (spec.kind === 'polygon') return polylinePoints(spec.vertices, spec.closed);
  const [fx, fy] = spec.from;
  const [tx, ty] = spec.to;
  switch (spec.kind) {
    case 'line':
      return polylinePoints([[fx, fy], [tx, ty]], false);
    case 'arrow': {
      const { left, right } = arrowHead(fx, fy, tx, ty);
      return polylinePoints([[fx, fy], [tx, ty], left, [tx, ty], right], false);
    }
    case 'rectangle':
      return polylinePoints([[fx, fy], [tx, fy], [tx, ty], [fx, ty]], true);
    case 'ellipse':
      return ellipsePoints(fx, fy, tx, ty);
  }
}

/** Whether a drag is big enough to be a shape at all (a tap must leave nothing behind). */
export function isShapeDragMeaningful(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  return Math.hypot(toX - fromX, toY - fromY) >= 2;
}

/**
 * Materialise a shape as a stroke. `hasPressure` is true and every point carries the same
 * pressure, so `perfect-freehand` uses the given (constant) pressure instead of simulating a
 * taper — a shape has one even width, unlike a hand-drawn line.
 */
export function createShapeStroke(
  spec: ShapeSpec,
  style: ShapeStyle,
  id: string,
  timestamp = 0,
): Stroke {
  return {
    id,
    tool: style.tool,
    color: style.color,
    size: style.size,
    opacity: style.opacity,
    points: shapeStrokePoints(spec),
    hasPressure: true,
    timestamp,
  };
}
