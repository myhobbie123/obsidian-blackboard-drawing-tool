import type { Stroke } from './entities';
import type { Command } from './stroke-manager';
import { translateStrokes } from './stroke-manager';
import type { TextItemsHost } from './text-commands';
import type { TextItem } from './text-item';

/**
 * Group operations on a marquee selection: move, delete and recolour, each as exactly ONE
 * entry on the engine's single undo stack no matter how much it touched.
 *
 * The strokes are reached through this narrow host (the live `StrokeManager` satisfies it), so
 * the commands stay in the domain and are testable against a plain array; the text side reuses
 * the very same `TextItemsHost` the label commands already use, so a group operation and a
 * single-label one write through one code path.
 *
 * Every command follows the established contract: it is CONSTRUCTED with the state to restore,
 * the caller runs `execute()` and then `StrokeManager.push`es it.
 */
export interface StrokeListHost {
  strokes: Stroke[];
}

const idSet = (ids: readonly string[]): ReadonlySet<string> => new Set(ids);

/**
 * Translate strokes and labels together. Strokes move in place via `translateStrokes` (the one
 * mutation path, which invalidates the bounds and Path2D caches so the eraser's AABB test can
 * never go stale); labels are patched immutably like every other text command.
 */
export function moveSelectionCommand(
  strokeHost: StrokeListHost,
  textHost: TextItemsHost,
  strokeIds: readonly string[],
  textIds: readonly string[],
  dx: number,
  dy: number,
): Command {
  const strokes = idSet(strokeIds);
  const texts = idSet(textIds);
  const shift = (sx: number, sy: number) => {
    translateStrokes(strokeHost.strokes, strokes, sx, sy);
    if (texts.size === 0) return;
    textHost.setItems(
      textHost.getItems().map((i) => (texts.has(i.id) ? { ...i, x: i.x + sx, y: i.y + sy } : i)),
    );
  };
  return {
    execute: () => shift(dx, dy),
    undo: () => shift(-dx, -dy),
  };
}

/**
 * Delete everything in the selection. Both lists remember the INDEX each item was removed
 * from, so undo restores paint order as well as content.
 */
export function deleteSelectionCommand(
  strokeHost: StrokeListHost,
  textHost: TextItemsHost,
  strokeIds: readonly string[],
  textIds: readonly string[],
): Command {
  const strokes = idSet(strokeIds);
  const texts = idSet(textIds);
  const removedStrokes: Array<{ stroke: Stroke; index: number }> = [];
  strokeHost.strokes.forEach((stroke, index) => {
    if (strokes.has(stroke.id)) removedStrokes.push({ stroke, index });
  });
  const removedText: Array<{ item: TextItem; index: number }> = [];
  textHost.getItems().forEach((item, index) => {
    if (texts.has(item.id)) removedText.push({ item: { ...item }, index });
  });

  return {
    execute: () => {
      if (removedStrokes.length > 0) {
        const kept = strokeHost.strokes.filter((s) => !strokes.has(s.id));
        strokeHost.strokes.length = 0;
        strokeHost.strokes.push(...kept);
      }
      if (removedText.length > 0) {
        textHost.setItems(textHost.getItems().filter((i) => !texts.has(i.id)));
      }
    },
    undo: () => {
      if (removedStrokes.length > 0) {
        // Ascending index order: each insertion re-creates the slot the next one refers to.
        for (const entry of removedStrokes) {
          strokeHost.strokes.splice(Math.min(entry.index, strokeHost.strokes.length), 0, entry.stroke);
        }
      }
      if (removedText.length > 0) {
        const items = textHost.getItems().slice();
        for (const entry of removedText) {
          items.splice(Math.min(entry.index, items.length), 0, { ...entry.item });
        }
        textHost.setItems(items);
      }
    },
  };
}

/**
 * Apply one colour to everything in the selection. Each item's previous colour is captured up
 * front, so undo restores a mixed-colour selection exactly rather than flattening it.
 */
export function recolorSelectionCommand(
  strokeHost: StrokeListHost,
  textHost: TextItemsHost,
  strokeIds: readonly string[],
  textIds: readonly string[],
  color: string,
): Command {
  const strokes = idSet(strokeIds);
  const texts = idSet(textIds);
  const previousStroke = new Map<string, string>();
  for (const stroke of strokeHost.strokes) {
    if (strokes.has(stroke.id)) previousStroke.set(stroke.id, stroke.color);
  }
  const previousText = new Map<string, string>();
  for (const item of textHost.getItems()) {
    if (texts.has(item.id)) previousText.set(item.id, item.color);
  }

  const applyStrokes = (pick: (id: string) => string | undefined) => {
    for (const stroke of strokeHost.strokes) {
      const next = pick(stroke.id);
      if (next !== undefined) stroke.color = next;
    }
  };
  const applyText = (pick: (id: string) => string | undefined) => {
    if (previousText.size === 0) return;
    textHost.setItems(
      textHost.getItems().map((i) => {
        const next = pick(i.id);
        return next === undefined ? i : { ...i, color: next };
      }),
    );
  };

  return {
    execute: () => {
      applyStrokes((id) => (previousStroke.has(id) ? color : undefined));
      applyText((id) => (previousText.has(id) ? color : undefined));
    },
    undo: () => {
      applyStrokes((id) => previousStroke.get(id));
      applyText((id) => previousText.get(id));
    },
  };
}

/** Whether a selection holds anything at all. */
export function isEmptySelection(strokeIds: ReadonlySet<string>, textIds: ReadonlySet<string>): boolean {
  return strokeIds.size === 0 && textIds.size === 0;
}
