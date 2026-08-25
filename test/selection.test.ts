import { describe, it, expect } from 'vitest';
import type { Stroke } from '../src/domain/entities';
import type { TextItem } from '../src/domain/text-item';
import {
  MARQUEE_MIN_DRAG_PX,
  hitsSelection,
  isMarqueeDrag,
  marqueeRect,
  rectContainsBox,
  rectContainsPoint,
  selectStrokesIn,
  selectTextItemsIn,
  selectionBounds,
  strokeInMarquee,
  textItemInMarquee,
} from '../src/domain/selection';
import {
  deleteSelectionCommand,
  isEmptySelection,
  moveSelectionCommand,
  recolorSelectionCommand,
} from '../src/domain/selection-commands';
import { StrokeManager } from '../src/domain/stroke-manager';
import { strokeBox } from '../src/domain/stroke-cache';
import { findStrokesAtPoint } from '../src/application/eraser-service';

function stroke(id: string, points: Array<[number, number]>, color = '#ffffff'): Stroke {
  return {
    id, tool: 'pen', color, size: 4, opacity: 1,
    points: points.map(([x, y]) => [x, y, 0.5] as [number, number, number]),
    hasPressure: false, timestamp: 0,
  };
}

function label(id: string, x: number, y: number, text = 'hi'): TextItem {
  return { id, x, y, text, fontSize: 20, color: '#ffffff' };
}

function textHost(items: TextItem[]) {
  let current = items;
  return {
    getItems: () => current,
    setItems: (next: TextItem[]) => { current = next; },
    get items() { return current; },
  };
}

describe('marquee hit determination — full containment', () => {
  const rect = marqueeRect(0, 0, 100, 100);

  it('normalises a drag from any corner', () => {
    expect(marqueeRect(100, 100, 0, 0)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(marqueeRect(0, 100, 100, 0)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('selects a stroke that is wholly inside', () => {
    expect(strokeInMarquee(stroke('a', [[10, 10], [90, 90]]), rect)).toBe(true);
  });

  it('does NOT select a stroke that merely intersects (this is not the eraser)', () => {
    // Crosses the marquee from side to side; an intersection rule would catch it.
    expect(strokeInMarquee(stroke('a', [[-50, 50], [150, 50]]), rect)).toBe(false);
    // One point outside is enough to keep it out.
    expect(strokeInMarquee(stroke('a', [[10, 10], [50, 50], [101, 50]]), rect)).toBe(false);
  });

  it('counts the boundary as inside (edges inclusive)', () => {
    expect(strokeInMarquee(stroke('a', [[0, 0], [100, 100]]), rect)).toBe(true);
    expect(strokeInMarquee(stroke('a', [[0, 0], [100.0001, 100]]), rect)).toBe(false);
  });

  it('never selects an empty stroke', () => {
    expect(strokeInMarquee(stroke('a', []), rect)).toBe(false);
    expect(strokeInMarquee(stroke('a', []), marqueeRect(-1e6, -1e6, 1e6, 1e6))).toBe(false);
  });

  it('a zero-area marquee selects nothing but a point-stroke exactly under it', () => {
    expect(selectStrokesIn([stroke('a', [[10, 10], [11, 11]])], marqueeRect(5, 5, 5, 5))).toEqual([]);
    expect(selectStrokesIn([stroke('a', [[5, 5]])], marqueeRect(5, 5, 5, 5))).toEqual(['a']);
  });

  it('reports every contained stroke, in board order', () => {
    const strokes = [
      stroke('a', [[10, 10], [20, 20]]),
      stroke('b', [[200, 200], [220, 220]]),
      stroke('c', [[30, 30], [40, 40]]),
    ];
    expect(selectStrokesIn(strokes, rect)).toEqual(['a', 'c']);
  });

  it('applies the same containment rule to labels, using the measured box when given', () => {
    const item = label('t1', 10, 10);
    expect(textItemInMarquee(item, rect, { width: 50, height: 20 })).toBe(true);
    expect(textItemInMarquee(item, rect, { width: 200, height: 20 })).toBe(false);
    expect(selectTextItemsIn([item], rect, () => ({ width: 50, height: 20 }))).toEqual(['t1']);
    // With no measurement the font-size estimate is used.
    expect(selectTextItemsIn([label('t2', 10, 10, 'x')], rect)).toEqual(['t2']);
  });

  it('rectContainsBox / rectContainsPoint are inclusive of the edges', () => {
    expect(rectContainsBox(rect, 0, 0, 100, 100)).toBe(true);
    expect(rectContainsBox(rect, -0.5, 0, 100, 100)).toBe(false);
    expect(rectContainsPoint(rect, 0, 100)).toBe(true);
    expect(rectContainsPoint(rect, 100.5, 50)).toBe(false);
  });
});

describe('selection bounds and grab', () => {
  it('spans strokes and labels together', () => {
    const strokes = [stroke('a', [[10, 10], [50, 50]]), stroke('b', [[300, 300], [310, 310]])];
    const items = [label('t1', 60, 5)];
    const bounds = selectionBounds(strokes, new Set(['a']), items, new Set(['t1']), () => ({ width: 40, height: 10 }));
    expect(bounds).toEqual({ x: 10, y: 5, width: 90, height: 45 });
  });

  it('is null for an empty selection', () => {
    expect(selectionBounds([stroke('a', [[0, 0]])], new Set())).toBeNull();
  });

  it('a press inside the selection box (plus tolerance) grabs it', () => {
    const bounds = { x: 0, y: 0, width: 50, height: 50 };
    expect(hitsSelection(bounds, 25, 25)).toBe(true);
    expect(hitsSelection(bounds, -4, 25)).toBe(true); // within the grab tolerance
    expect(hitsSelection(bounds, -50, 25)).toBe(false);
    expect(hitsSelection(null, 0, 0)).toBe(false);
  });

  it('a press that never travels is a click, not a marquee', () => {
    expect(isMarqueeDrag(0, 0)).toBe(false);
    expect(isMarqueeDrag(MARQUEE_MIN_DRAG_PX - 0.01, 0)).toBe(false);
    expect(isMarqueeDrag(MARQUEE_MIN_DRAG_PX, 0)).toBe(true);
  });
});

describe('group operations — one undo step each', () => {
  it('moves strokes and labels together, and undo puts everything back', () => {
    const manager = new StrokeManager();
    manager.addStroke(stroke('a', [[0, 0], [10, 10]]));
    manager.addStroke(stroke('b', [[100, 100], [110, 110]]));
    const text = textHost([label('t1', 5, 5), label('t2', 500, 500)]);

    const command = moveSelectionCommand(manager, text, ['a'], ['t1'], 20, 30);
    command.execute();
    manager.push(command);

    expect(manager.strokes[0].points[0]).toEqual([20, 30, 0.5]);
    expect(manager.strokes[1].points[0]).toEqual([100, 100, 0.5]);
    expect(text.items[0]).toMatchObject({ x: 25, y: 35 });
    expect(text.items[1]).toMatchObject({ x: 500, y: 500 });

    manager.undo();
    expect(manager.strokes[0].points[0]).toEqual([0, 0, 0.5]);
    expect(text.items[0]).toMatchObject({ x: 5, y: 5 });
    manager.redo();
    expect(manager.strokes[0].points[0]).toEqual([20, 30, 0.5]);
  });

  it('a group move invalidates the bounds cache, so the eraser does not go stale', () => {
    const manager = new StrokeManager();
    manager.addStroke(stroke('a', [[0, 0], [10, 10]]));
    // Warm the cache at the old position.
    expect(strokeBox(manager.strokes[0]).minX).toBe(0);
    expect(findStrokesAtPoint(manager.strokes, 5, 5, 3)).toEqual(['a']);

    const command = moveSelectionCommand(manager, textHost([]), ['a'], [], 500, 0);
    command.execute();
    manager.push(command);

    expect(strokeBox(manager.strokes[0]).minX).toBe(500);
    expect(findStrokesAtPoint(manager.strokes, 5, 5, 3)).toEqual([]);
    expect(findStrokesAtPoint(manager.strokes, 505, 5, 3)).toEqual(['a']);

    manager.undo();
    expect(strokeBox(manager.strokes[0]).minX).toBe(0);
    expect(findStrokesAtPoint(manager.strokes, 5, 5, 3)).toEqual(['a']);
  });

  it('is exactly one undo step no matter how much it moved', () => {
    const manager = new StrokeManager();
    manager.addStroke(stroke('a', [[0, 0]]));
    manager.addStroke(stroke('b', [[1, 1]]));
    const command = moveSelectionCommand(manager, textHost([]), ['a', 'b'], [], 10, 10);
    command.execute();
    manager.push(command);

    manager.undo();
    expect(manager.strokes[0].points[0]).toEqual([0, 0, 0.5]);
    expect(manager.strokes[1].points[0]).toEqual([1, 1, 0.5]);
    // The next undo is the second stroke's own creation — nothing left of the move.
    manager.undo();
    expect(manager.strokes).toHaveLength(1);
  });

  it('deletes strokes and labels as one step, restoring paint order on undo', () => {
    const manager = new StrokeManager();
    manager.addStroke(stroke('a', [[0, 0]]));
    manager.addStroke(stroke('b', [[1, 1]]));
    manager.addStroke(stroke('c', [[2, 2]]));
    const text = textHost([label('t1', 0, 0), label('t2', 1, 1), label('t3', 2, 2)]);

    const command = deleteSelectionCommand(manager, text, ['a', 'c'], ['t2']);
    command.execute();
    manager.push(command);

    expect(manager.strokes.map((s) => s.id)).toEqual(['b']);
    expect(text.items.map((i) => i.id)).toEqual(['t1', 't3']);

    manager.undo();
    expect(manager.strokes.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(text.items.map((i) => i.id)).toEqual(['t1', 't2', 't3']);
    manager.redo();
    expect(manager.strokes.map((s) => s.id)).toEqual(['b']);
  });

  it('recolours strokes and labels as one step, restoring a mixed selection exactly', () => {
    const manager = new StrokeManager();
    manager.addStroke(stroke('a', [[0, 0]], '#ff0000'));
    manager.addStroke(stroke('b', [[1, 1]], '#00ff00'));
    const text = textHost([label('t1', 0, 0)]);

    const command = recolorSelectionCommand(manager, text, ['a', 'b'], ['t1'], '#0000ff');
    command.execute();
    manager.push(command);

    expect(manager.strokes.map((s) => s.color)).toEqual(['#0000ff', '#0000ff']);
    expect(text.items[0].color).toBe('#0000ff');

    manager.undo();
    expect(manager.strokes.map((s) => s.color)).toEqual(['#ff0000', '#00ff00']);
    expect(text.items[0].color).toBe('#ffffff');
  });

  it('knows an empty selection', () => {
    expect(isEmptySelection(new Set(), new Set())).toBe(true);
    expect(isEmptySelection(new Set(['a']), new Set())).toBe(false);
  });
});
