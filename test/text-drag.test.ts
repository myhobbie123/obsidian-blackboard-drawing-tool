import { describe, it, expect } from 'vitest';
import {
  TEXT_DRAG_THRESHOLD_PX,
  dragDelta,
  exceedsDragThreshold,
} from '../src/domain/text-drag';
import {
  estimateTextItemBox,
  hitTestTextItem,
  textItemAt,
} from '../src/domain/text-item';
import type { TextItem } from '../src/domain/text-item';

const item = (over: Partial<TextItem> = {}): TextItem => ({
  id: 'a1', x: 100, y: 200, text: 'hello', fontSize: 20, color: '#ffffff', ...over,
});

describe('drag threshold — click-to-edit vs. drag-to-move', () => {
  it('a motionless press is a click', () => {
    expect(exceedsDragThreshold(0, 0)).toBe(false);
  });

  it('a stylus wobble below the threshold is still a click', () => {
    expect(exceedsDragThreshold(2, 2)).toBe(false); // hypot ~2.83
  });

  it('movement at or beyond the threshold is a drag, in any direction', () => {
    expect(exceedsDragThreshold(TEXT_DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(exceedsDragThreshold(0, -TEXT_DRAG_THRESHOLD_PX)).toBe(true);
    expect(exceedsDragThreshold(-3, 3)).toBe(true); // hypot ~4.24
  });

  it('takes an explicit threshold', () => {
    expect(exceedsDragThreshold(5, 0, 10)).toBe(false);
    expect(exceedsDragThreshold(11, 0, 10)).toBe(true);
  });
});

describe('dragDelta', () => {
  it('is the straight difference between two points', () => {
    expect(dragDelta({ x: 10, y: 10 }, { x: 4, y: 25 })).toEqual({ dx: -6, dy: 15 });
  });

  it('is unaffected by where the drag started (pan cancels out in a difference)', () => {
    const a = dragDelta({ x: 0, y: 0 }, { x: 7, y: -3 });
    const b = dragDelta({ x: 500, y: 900 }, { x: 507, y: 897 });
    expect(a).toEqual(b);
  });
});

describe('hit-testing a point against a label box', () => {
  it('the anchor is the label\'s TOP-LEFT, so the box extends right and down', () => {
    const box = { width: 40, height: 25 };
    expect(hitTestTextItem(item(), 100, 200, box)).toBe(true);
    expect(hitTestTextItem(item(), 139, 224, box)).toBe(true);
    expect(hitTestTextItem(item(), 99, 200, box)).toBe(false);
    expect(hitTestTextItem(item(), 100, 199, box)).toBe(false);
    expect(hitTestTextItem(item(), 141, 200, box)).toBe(false);
    expect(hitTestTextItem(item(), 100, 226, box)).toBe(false);
  });

  it('tolerance widens the box on every side', () => {
    const box = { width: 40, height: 25 };
    expect(hitTestTextItem(item(), 96, 196, box)).toBe(false);
    expect(hitTestTextItem(item(), 96, 196, box, 5)).toBe(true);
  });

  it('estimates a box from the font size when nothing has been measured', () => {
    const box = estimateTextItemBox(item({ text: 'hello', fontSize: 20 }));
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeCloseTo(25); // one line at 1.25 line-height
    expect(hitTestTextItem(item(), 105, 210)).toBe(true);
  });

  it('estimates a multi-line label as several lines tall and as wide as its longest', () => {
    const one = estimateTextItemBox(item({ text: 'ab' }));
    const many = estimateTextItemBox(item({ text: 'ab\nabcdefgh\nc' }));
    expect(many.height).toBeCloseTo(one.height * 3);
    expect(many.width).toBeGreaterThan(one.width);
  });

  it('an empty label still has a grabbable box', () => {
    const box = estimateTextItemBox(item({ text: '' }));
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });
});

describe('textItemAt', () => {
  const a = item({ id: 'a', x: 0, y: 0 });
  const b = item({ id: 'b', x: 0, y: 0 });

  it('returns the topmost (last painted) label when labels overlap', () => {
    expect(textItemAt([a, b], 5, 5)?.id).toBe('b');
  });

  it('returns null when the point misses every label', () => {
    expect(textItemAt([a, b], -50, -50)).toBeNull();
  });

  it('uses the measured box when one is supplied', () => {
    const measured = textItemAt([a], 300, 5, () => ({ width: 400, height: 30 }));
    expect(measured?.id).toBe('a');
    expect(textItemAt([a], 300, 5)).toBeNull(); // the estimate is much narrower
  });
});
