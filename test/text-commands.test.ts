import { describe, it, expect } from 'vitest';
import { StrokeManager } from '../src/domain/stroke-manager';
import type { Stroke } from '../src/domain/entities';
import type { TextItem } from '../src/domain/text-item';
import type { TextItemsHost } from '../src/domain/text-commands';
import {
  createTextCommand,
  deleteTextCommand,
  deleteTextItemsCommand,
  editTextCommand,
  moveTextCommand,
} from '../src/domain/text-commands';

const item = (over: Partial<TextItem> = {}): TextItem => ({
  id: 'a1', x: 10, y: 20, text: 'hello', fontSize: 20, color: '#ffffff', ...over,
});

const stroke = (id: string): Stroke => ({
  id, tool: 'pen', color: '#fff', size: 2, opacity: 1,
  points: [[0, 0, 0.5]], hasPressure: false, timestamp: 0,
});

/** The in-memory equivalent of the text layer, plus a log of every write it received. */
function host(initial: TextItem[] = []): TextItemsHost & { items: TextItem[]; writes: TextItem[][] } {
  const state = {
    items: initial,
    writes: [] as TextItem[][],
    getItems: () => state.items,
    setItems: (items: TextItem[]) => { state.items = items; state.writes.push(items.map((i) => ({ ...i }))); },
  };
  return state;
}

describe('text commands', () => {
  it('create inserts at the given index and undo removes it again', () => {
    const h = host([item({ id: 'first' })]);
    const cmd = createTextCommand(h, item({ id: 'new' }), 1);

    cmd.execute();
    expect(h.items.map((i) => i.id)).toEqual(['first', 'new']);

    cmd.undo();
    expect(h.items.map((i) => i.id)).toEqual(['first']);
  });

  it('redo restores the SAME id and paint order, not a copy at the end', () => {
    const h = host([item({ id: 'a' }), item({ id: 'b' })]);
    const cmd = createTextCommand(h, item({ id: 'middle', text: 'mid' }), 1);
    cmd.execute();
    cmd.undo();

    cmd.execute();

    expect(h.items.map((i) => i.id)).toEqual(['a', 'middle', 'b']);
    expect(h.items[1].text).toBe('mid');
  });

  it('create does not alias the caller\'s item (a later mutation cannot leak in)', () => {
    const h = host();
    const original = item({ id: 'x', text: 'typed' });
    const cmd = createTextCommand(h, original, 0);
    original.text = 'mutated after the fact';

    cmd.execute();

    expect(h.items[0].text).toBe('typed');
  });

  it('delete removes the item and undo puts it back at its original index', () => {
    const h = host([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]);
    const cmd = deleteTextCommand(h, h.items[1], 1);

    cmd.execute();
    expect(h.items.map((i) => i.id)).toEqual(['a', 'c']);

    cmd.undo();
    expect(h.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('edit records both directions, so redo is not a re-typing', () => {
    const h = host([item({ id: 'a', text: 'before' })]);
    const cmd = editTextCommand(h, 'a', 'before', 'after');

    cmd.execute();
    expect(h.items[0].text).toBe('after');
    cmd.undo();
    expect(h.items[0].text).toBe('before');
    cmd.execute();
    expect(h.items[0].text).toBe('after');
  });

  it('move translates by the delta and undo translates back exactly', () => {
    const h = host([item({ id: 'a', x: 10, y: 20 })]);
    const cmd = moveTextCommand(h, 'a', 5, -7);

    cmd.execute();
    expect([h.items[0].x, h.items[0].y]).toEqual([15, 13]);
    cmd.undo();
    expect([h.items[0].x, h.items[0].y]).toEqual([10, 20]);
  });

  it('every command writes through the host, so each undo step re-persists the layer', () => {
    const h = host();
    createTextCommand(h, item({ id: 'a' }), 0).execute();
    editTextCommand(h, 'a', 'hello', 'bye').execute();
    moveTextCommand(h, 'a', 1, 1).execute();

    expect(h.writes).toHaveLength(3);
    expect(h.writes[2][0]).toMatchObject({ id: 'a', text: 'bye', x: 11, y: 21 });
  });

  it('a command applied to a missing id is a no-op rather than a throw', () => {
    const h = host([item({ id: 'a' })]);
    expect(() => editTextCommand(h, 'ghost', 'x', 'y').execute()).not.toThrow();
    expect(() => moveTextCommand(h, 'ghost', 1, 1).undo()).not.toThrow();
    expect(h.items).toHaveLength(1);
  });
});

describe('one undo timeline over strokes and text', () => {
  it('four undos reverse draw / label / draw / edit in exactly that reverse order', () => {
    const manager = new StrokeManager();
    const h = host();

    manager.addStroke(stroke('s1'));                                    // 1: draw
    const create = createTextCommand(h, item({ id: 't1', text: 'label' }), 0);
    create.execute(); manager.push(create);                             // 2: add label
    manager.addStroke(stroke('s2'));                                    // 3: draw
    const edit = editTextCommand(h, 't1', 'label', 'relabel');
    edit.execute(); manager.push(edit);                                 // 4: edit label

    expect(manager.strokes.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(h.items[0].text).toBe('relabel');

    manager.undo(); // the edit
    expect(h.items[0].text).toBe('label');
    expect(manager.strokes.map((s) => s.id)).toEqual(['s1', 's2']);

    manager.undo(); // the second stroke
    expect(manager.strokes.map((s) => s.id)).toEqual(['s1']);
    expect(h.items).toHaveLength(1);

    manager.undo(); // the label
    expect(h.items).toHaveLength(0);
    expect(manager.strokes.map((s) => s.id)).toEqual(['s1']);

    manager.undo(); // the first stroke
    expect(manager.strokes).toHaveLength(0);
    expect(manager.canUndo()).toBe(false);
  });

  it('redo replays the same interleaving forwards, restoring the label with its id', () => {
    const manager = new StrokeManager();
    const h = host();
    manager.addStroke(stroke('s1'));
    const create = createTextCommand(h, item({ id: 't1' }), 0);
    create.execute(); manager.push(create);

    manager.undo();
    manager.undo();
    expect(manager.strokes).toHaveLength(0);
    expect(h.items).toHaveLength(0);

    manager.redo();
    expect(manager.strokes.map((s) => s.id)).toEqual(['s1']);
    manager.redo();
    expect(h.items.map((i) => i.id)).toEqual(['t1']);
    expect(manager.canRedo()).toBe(false);
  });

  it('a new text edit clears the redo stack, exactly like a new stroke does', () => {
    const manager = new StrokeManager();
    const h = host();
    manager.addStroke(stroke('s1'));
    manager.undo();
    expect(manager.canRedo()).toBe(true);

    const create = createTextCommand(h, item({ id: 't1' }), 0);
    create.execute();
    manager.push(create);

    expect(manager.canRedo()).toBe(false);
  });

  it('push records a command WITHOUT running it (the caller already applied the effect)', () => {
    const manager = new StrokeManager();
    const h = host();
    const create = createTextCommand(h, item({ id: 't1' }), 0);
    create.execute();

    manager.push(create);

    expect(h.items).toHaveLength(1); // not inserted twice
    expect(manager.canUndo()).toBe(true);
  });
});

describe('deleteTextItemsCommand — one undo step for a whole erase gesture', () => {
  const three = () => [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];

  /** A host whose current list is readable after every mutation. */
  function mutableHost(initial: TextItem[]) {
    let items = initial;
    const h: TextItemsHost = { getItems: () => items, setItems: (i) => { items = i; } };
    return { host: h, ids: () => items.map((i) => i.id) };
  }

  it('undo restores every erased label at the index it was taken from', () => {
    const { host: h, ids } = mutableHost(three());
    // The gesture erased 'b' first, then 'a' — indices are captured against the shrinking list.
    const removed = [{ item: item({ id: 'b' }), index: 1 }, { item: item({ id: 'a' }), index: 0 }];
    const command = deleteTextItemsCommand(h, removed);

    command.execute();
    expect(ids()).toEqual(['c']);

    command.undo();
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('redo removes exactly the same labels again', () => {
    const { host: h, ids } = mutableHost(three());
    const command = deleteTextItemsCommand(h, [{ item: item({ id: 'b' }), index: 1 }]);
    command.execute();
    command.undo();
    command.execute();
    expect(ids()).toEqual(['a', 'c']);
  });

  it('snapshots the labels, so a later mutation of the originals cannot corrupt undo', () => {
    const { host: h, ids } = mutableHost(three());
    const erased = item({ id: 'b', text: 'original' });
    const command = deleteTextItemsCommand(h, [{ item: erased, index: 1 }]);
    command.execute();
    erased.text = 'mutated after the fact';

    command.undo();
    expect(h.getItems()[1].text).toBe('original');
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('an empty gesture is a no-op in both directions', () => {
    const { host: h, ids } = mutableHost(three());
    const command = deleteTextItemsCommand(h, []);
    command.execute();
    expect(ids()).toEqual(['a', 'b', 'c']);
    command.undo();
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('is a SINGLE entry on the shared undo stack', () => {
    const strokes = new StrokeManager();
    const { host: h, ids } = mutableHost(three());
    strokes.addStroke(stroke('s1'));
    const command = deleteTextItemsCommand(h, [
      { item: item({ id: 'a' }), index: 0 },
      { item: item({ id: 'b' }), index: 0 },
    ]);
    command.execute();
    strokes.push(command);

    strokes.undo();
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(strokes.strokes).toHaveLength(1);

    strokes.undo();
    expect(strokes.strokes).toHaveLength(0);
  });
});
