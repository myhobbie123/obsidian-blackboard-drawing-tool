import type { BlackboardFile } from '../domain/entities';
import type { TextItem } from '../domain/text-item';
import { hasTextLayer } from './file-format';
import { readTextSidecar } from './text-sidecar';

/**
 * What to do about a `<drawing>.blackboard-text.json` sidecar found next to a drawing that is
 * being opened. Kept as a pure decision so every failure mode below is a table-testable
 * function rather than a branch buried in vault I/O.
 */
export type TextMigrationPlan =
  | { action: 'skip'; reason: 'no-sidecar' | 'document-has-text' }
  | {
      action: 'import';
      items: TextItem[];
      /**
       * Whether the sidecar may be moved aside after the drawing has been written. False when
       * any part of it was unreadable: we import what we understood and LEAVE THE FILE, so
       * nothing the user typed can be lost to a parser we got wrong.
       */
      retire: boolean;
      /** Non-empty when the sidecar was (partly) unreadable; logged, never surfaced as an error. */
      warning?: string;
    };

/**
 * Decide the migration for one drawing.
 *
 * - A drawing that already carries labels wins outright: text is in the document, and a stale
 *   sidecar (an older copy resurrected by sync, say) must never overwrite it. This is also
 *   what makes migration idempotent — the second open sees in-file text and skips.
 * - No sidecar, nothing to do.
 * - Otherwise import every label we could read, and retire the file only if we read all of it.
 */
export function planTextMigration(file: BlackboardFile, sidecarRaw: string | null): TextMigrationPlan {
  if (hasTextLayer(file)) return { action: 'skip', reason: 'document-has-text' };
  if (sidecarRaw === null) return { action: 'skip', reason: 'no-sidecar' };

  const { items, unreadable } = readTextSidecar(sidecarRaw);
  if (!unreadable) return { action: 'import', items, retire: true };
  return {
    action: 'import',
    items,
    retire: false,
    warning: items.length > 0
      ? `imported ${String(items.length)} label(s); the sidecar also holds entries this build cannot read and is kept`
      : 'the sidecar could not be read; it is kept untouched',
  };
}
