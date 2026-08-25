import { describe, it, expect } from 'vitest';
import {
  RESIZE_DIRECTIONS,
  MIN_EMBED_WIDTH,
  MIN_EMBED_HEIGHT,
  resizeFromDrag,
  type ResizeStart,
} from '../src/presentation/embed-resize';

const start: ResizeStart = { width: 400, height: 300, marginLeft: 0, marginTop: 0 };

describe('resizeFromDrag', () => {
  it('exposes the eight handle directions', () => {
    expect([...RESIZE_DIRECTIONS]).toEqual([
      'top', 'bottom', 'left', 'right',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
    ]);
  });

  it('right edge changes width only', () => {
    expect(resizeFromDrag('right', start, 60, 999)).toEqual({ width: 460, height: 300, marginLeft: 0, marginTop: 0 });
  });

  it('left edge grows towards the pointer and shifts the margin to anchor the right edge', () => {
    // Dragging left by 60 widens by 60; the left margin absorbs the same 60 so the
    // element's right edge does not move.
    expect(resizeFromDrag('left', start, -60, 0)).toEqual({ width: 460, height: 300, marginLeft: -60, marginTop: 0 });
  });

  it('left edge dragged inward shrinks and pushes the margin positive', () => {
    expect(resizeFromDrag('left', start, 60, 0)).toEqual({ width: 340, height: 300, marginLeft: 60, marginTop: 0 });
  });

  it('bottom edge changes height only', () => {
    expect(resizeFromDrag('bottom', start, 999, 50)).toEqual({ width: 400, height: 350, marginLeft: 0, marginTop: 0 });
  });

  it('top edge changes height and anchors the bottom edge via the top margin', () => {
    expect(resizeFromDrag('top', start, 0, -50)).toEqual({ width: 400, height: 350, marginLeft: 0, marginTop: -50 });
  });

  it('bottom-right corner changes both axes, no margins', () => {
    expect(resizeFromDrag('bottom-right', start, 40, 20)).toEqual({ width: 440, height: 320, marginLeft: 0, marginTop: 0 });
  });

  it('bottom-left corner shifts the left margin only', () => {
    expect(resizeFromDrag('bottom-left', start, -40, 20)).toEqual({ width: 440, height: 320, marginLeft: -40, marginTop: 0 });
  });

  it('top-right corner shifts the top margin only', () => {
    expect(resizeFromDrag('top-right', start, 40, -20)).toEqual({ width: 440, height: 320, marginLeft: 0, marginTop: -20 });
  });

  it('top-left corner shifts both margins', () => {
    expect(resizeFromDrag('top-left', start, -40, -20)).toEqual({ width: 440, height: 320, marginLeft: -40, marginTop: -20 });
  });

  it('preserves pre-existing margins on axes the handle does not touch', () => {
    const offset: ResizeStart = { width: 400, height: 300, marginLeft: 12, marginTop: 8 };
    expect(resizeFromDrag('right', offset, 10, 10)).toEqual({ width: 410, height: 300, marginLeft: 12, marginTop: 8 });
    expect(resizeFromDrag('top-left', offset, -10, -10)).toEqual({ width: 410, height: 310, marginLeft: 2, marginTop: -2 });
  });

  it('rounds fractional pointer deltas', () => {
    expect(resizeFromDrag('bottom-right', start, 10.6, -0.4)).toMatchObject({ width: 411, height: 300 });
  });

  it('clamps every direction to the minimum box', () => {
    for (const direction of RESIZE_DIRECTIONS) {
      const shrunk = resizeFromDrag(direction, start, direction.includes('left') ? 5000 : -5000, direction.includes('top') ? 5000 : -5000);
      expect(shrunk.width).toBeGreaterThanOrEqual(MIN_EMBED_WIDTH);
      expect(shrunk.height).toBeGreaterThanOrEqual(MIN_EMBED_HEIGHT);
    }
  });

  it('stops at exactly 150x100 when dragged past the minimum', () => {
    expect(resizeFromDrag('bottom-right', start, -1000, -1000)).toEqual({
      width: MIN_EMBED_WIDTH, height: MIN_EMBED_HEIGHT, marginLeft: 0, marginTop: 0,
    });
  });

  it('freezes the margin once clamped, so a clamped left drag does not drift', () => {
    // width clamps at 150 -> margin absorbs the 250 the box actually lost, no more.
    expect(resizeFromDrag('left', start, 1000, 0)).toEqual({ width: 150, height: 300, marginLeft: 250, marginTop: 0 });
  });

  it('resumes immediately when dragged back out of the clamp', () => {
    // Each move is computed from the drag-start box, so there is no accumulated debt:
    // going 1000 past the minimum and back to -50 gives the same box as -50 alone.
    const clamped = resizeFromDrag('bottom-right', start, -1000, -1000);
    expect(clamped.width).toBe(MIN_EMBED_WIDTH);
    expect(resizeFromDrag('bottom-right', start, -50, -50)).toEqual({ width: 350, height: 250, marginLeft: 0, marginTop: 0 });
  });

  it('clamps the vertical axis independently of the horizontal one', () => {
    expect(resizeFromDrag('bottom-right', start, 100, -1000)).toEqual({
      width: 500, height: MIN_EMBED_HEIGHT, marginLeft: 0, marginTop: 0,
    });
  });
});
