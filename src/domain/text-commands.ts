import type { Command } from './stroke-manager';
import type { TextItem } from './text-item';

/**
 * The text layer as the undo stack sees it: a getter and a setter for the whole item list.
 * Keeping it this narrow is what lets text commands live in the domain and be tested with a
 * plain array, while the presentation layer's setter also re-renders and persists the sidecar.
 */
export interface TextItemsHost {
  getItems(): TextItem[];
  setItems(items: TextItem[]): void;
}

/** Deep-ish copy of one item; items are flat, so a spread is a real copy. */
const copy = (item: TextItem): TextItem => ({ ...item });

/**
 * Insert a label back at the index it was created/removed at, so redo restores the paint
 * order as well as the item. An index past the end simply appends.
 */
function insertAt(items: TextItem[], item: TextItem, index: number): TextItem[] {
  const next = items.slice();
  next.splice(Math.min(Math.max(index, 0), next.length), 0, item);
  return next;
}

function removeId(items: TextItem[], id: string): TextItem[] {
  return items.filter((i) => i.id !== id);
}

function patch(items: TextItem[], id: string, apply: (item: TextItem) => TextItem): TextItem[] {
  return items.map((i) => (i.id === id ? apply(i) : i));
}

/**
 * Creating a label. `execute` is what REDO runs — the item is re-inserted with the same id,
 * at the same index, so a redone label is indistinguishable from the original.
 */
export function createTextCommand(host: TextItemsHost, item: TextItem, index: number): Command {
  const snapshot = copy(item);
  return {
    execute: () => { host.setItems(insertAt(removeId(host.getItems(), snapshot.id), copy(snapshot), index)); },
    undo: () => { host.setItems(removeId(host.getItems(), snapshot.id)); },
  };
}

/** Deleting a label; undo puts it back at the index it was removed from. */
export function deleteTextCommand(host: TextItemsHost, item: TextItem, index: number): Command {
  const snapshot = copy(item);
  return {
    execute: () => { host.setItems(removeId(host.getItems(), snapshot.id)); },
    undo: () => { host.setItems(insertAt(removeId(host.getItems(), snapshot.id), copy(snapshot), index)); },
  };
}

/**
 * Removing several labels as ONE undo step — the eraser, which sweeps over whatever it passes
 * and must reverse in a single Ctrl+Z like an erase gesture over strokes. Undo re-inserts in
 * reverse removal order, so every label lands back at the index it was taken from.
 */
export function deleteTextItemsCommand(
  host: TextItemsHost,
  removed: Array<{ item: TextItem; index: number }>,
): Command {
  const snapshot = removed.map((r) => ({ item: copy(r.item), index: r.index }));
  return {
    execute: () => {
      let items = host.getItems();
      for (const r of snapshot) items = removeId(items, r.item.id);
      host.setItems(items);
    },
    undo: () => {
      let items = host.getItems();
      for (let i = snapshot.length - 1; i >= 0; i--) {
        items = insertAt(removeId(items, snapshot[i].item.id), copy(snapshot[i].item), snapshot[i].index);
      }
      host.setItems(items);
    },
  };
}

/** Editing a label's text. Both directions are recorded, so redo is not a re-typing. */
export function editTextCommand(host: TextItemsHost, id: string, before: string, after: string): Command {
  return {
    execute: () => { host.setItems(patch(host.getItems(), id, (i) => ({ ...i, text: after }))); },
    undo: () => { host.setItems(patch(host.getItems(), id, (i) => ({ ...i, text: before }))); },
  };
}

/** Moving a label by a drawing-space delta — one command for a whole drag, not one per sample. */
export function moveTextCommand(host: TextItemsHost, id: string, dx: number, dy: number): Command {
  return {
    execute: () => { host.setItems(patch(host.getItems(), id, (i) => ({ ...i, x: i.x + dx, y: i.y + dy }))); },
    undo: () => { host.setItems(patch(host.getItems(), id, (i) => ({ ...i, x: i.x - dx, y: i.y - dy }))); },
  };
}
