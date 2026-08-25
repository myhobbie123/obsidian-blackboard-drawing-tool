import { describe, it, expect } from 'vitest';
import {
  MIN_AREA_HEIGHT,
  MIN_AREA_WIDTH,
  clamp,
  commitSize,
  isBelowMinimum,
  isPointInside,
  selectionRect,
} from '../src/presentation/area-selection-rect';

const BOUNDS = { left: 100, top: 50, right: 900, bottom: 650 };

describe('selectionRect', () => {
  it('tracks a top-left to bottom-right drag exactly', () => {
    expect(selectionRect({ x: 200, y: 150 }, { x: 500, y: 400 }, BOUNDS))
      .toEqual({ left: 200, top: 150, width: 300, height: 250 });
  });

  it('tracks a drag in every direction, anchored at the start point', () => {
    // Up-left: the rectangle grows towards the start corner.
    expect(selectionRect({ x: 500, y: 400 }, { x: 200, y: 150 }, BOUNDS))
      .toEqual({ left: 200, top: 150, width: 300, height: 250 });
    // Down-left.
    expect(selectionRect({ x: 500, y: 150 }, { x: 200, y: 400 }, BOUNDS))
      .toEqual({ left: 200, top: 150, width: 300, height: 250 });
    // Up-right.
    expect(selectionRect({ x: 200, y: 400 }, { x: 500, y: 150 }, BOUNDS))
      .toEqual({ left: 200, top: 150, width: 300, height: 250 });
  });

  it('is a zero-size rect at the moment of the press', () => {
    expect(selectionRect({ x: 300, y: 300 }, { x: 300, y: 300 }, BOUNDS))
      .toEqual({ left: 300, top: 300, width: 0, height: 0 });
  });

  it('does NOT apply the minimum during the drag — the preview must follow the pointer', () => {
    const tiny = selectionRect({ x: 300, y: 300 }, { x: 310, y: 305 }, BOUNDS);
    expect(tiny.width).toBe(10);
    expect(tiny.height).toBe(5);
    expect(tiny.width).toBeLessThan(MIN_AREA_WIDTH);
  });

  it('shrinks back down as the pointer returns towards the start', () => {
    const start = { x: 300, y: 300 };
    const big = selectionRect(start, { x: 800, y: 600 }, BOUNDS);
    const small = selectionRect(start, { x: 320, y: 310 }, BOUNDS);
    expect(big.width).toBe(500);
    expect(small.width).toBe(20);
  });

  it('clips to the editor surface instead of overflowing it', () => {
    const rect = selectionRect({ x: 800, y: 600 }, { x: 5000, y: 5000 }, BOUNDS);
    expect(rect.left + rect.width).toBeLessThanOrEqual(BOUNDS.right);
    expect(rect.top + rect.height).toBeLessThanOrEqual(BOUNDS.bottom);
  });

  it('never produces a rect that starts outside the surface', () => {
    const rect = selectionRect({ x: 150, y: 100 }, { x: -5000, y: -5000 }, BOUNDS);
    expect(rect.left).toBeGreaterThanOrEqual(BOUNDS.left);
    expect(rect.top).toBeGreaterThanOrEqual(BOUNDS.top);
  });

  it('handles a zero-area surface without producing NaN', () => {
    const degenerate = { left: 10, top: 10, right: 10, bottom: 10 };
    const rect = selectionRect({ x: 10, y: 10 }, { x: 50, y: 50 }, degenerate);
    expect(Number.isFinite(rect.left)).toBe(true);
    expect(Number.isFinite(rect.width)).toBe(true);
  });
});

describe('the minimum applies at commit, not during the drag', () => {
  it('raises a below-minimum drag to the minimum drawing size', () => {
    expect(commitSize({ width: 10, height: 5 }))
      .toEqual({ width: MIN_AREA_WIDTH, height: MIN_AREA_HEIGHT });
  });

  it('raises each axis independently', () => {
    expect(commitSize({ width: 600, height: 20 }))
      .toEqual({ width: 600, height: MIN_AREA_HEIGHT });
    expect(commitSize({ width: 20, height: 600 }))
      .toEqual({ width: MIN_AREA_WIDTH, height: 600 });
  });

  it('leaves an above-minimum drag alone, rounded to whole pixels', () => {
    expect(commitSize({ width: 640.4, height: 480.6 })).toEqual({ width: 640, height: 481 });
  });

  it('flags a below-minimum drag so the preview can show it', () => {
    expect(isBelowMinimum({ width: 239, height: 400 })).toBe(true);
    expect(isBelowMinimum({ width: 400, height: 159 })).toBe(true);
    expect(isBelowMinimum({ width: MIN_AREA_WIDTH, height: MIN_AREA_HEIGHT })).toBe(false);
    expect(isBelowMinimum({ width: 0, height: 0 })).toBe(true);
  });

  it('exactly at the minimum is not below it, and commits unchanged', () => {
    const at = { width: MIN_AREA_WIDTH, height: MIN_AREA_HEIGHT };
    expect(isBelowMinimum(at)).toBe(false);
    expect(commitSize(at)).toEqual(at);
  });
});

describe('helpers', () => {
  it('clamp bounds a value on both sides', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });

  it('isPointInside is inclusive on the edges', () => {
    expect(isPointInside(BOUNDS, 100, 50)).toBe(true);
    expect(isPointInside(BOUNDS, 900, 650)).toBe(true);
    expect(isPointInside(BOUNDS, 99, 300)).toBe(false);
    expect(isPointInside(BOUNDS, 500, 651)).toBe(false);
  });
});
