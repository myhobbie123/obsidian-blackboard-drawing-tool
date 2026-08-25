import type { TextItem } from '../domain/text-item';
import { hasUnreadableTextItems, parseTextItems } from '../domain/text-item';

export const TEXT_SIDECAR_SUFFIX = '.blackboard-text.json';

/**
 * Suffix appended to a sidecar once its labels live in the drawing. Retiring by RENAME rather
 * than delete is deliberate: the sidecar is the user's only copy until the drawing has been
 * written, and a rename that we get wrong costs a stray file, while a delete that we get wrong
 * costs their text.
 */
export const MIGRATED_SIDECAR_SUFFIX = '.migrated';

/**
 * Sidecar path for a drawing: `Folder/Note.blackboard` -> `Folder/Note.blackboard-text.json`.
 * Case-insensitive on the extension because Obsidian preserves whatever case the user typed.
 * A path that is not a `.blackboard` file gets the suffix appended rather than substituted,
 * so the mapping stays total and never collides with the drawing itself.
 */
export function textSidecarPath(drawingPath: string): string {
  return /\.blackboard$/i.test(drawingPath)
    ? drawingPath.replace(/\.blackboard$/i, TEXT_SIDECAR_SUFFIX)
    : drawingPath + TEXT_SIDECAR_SUFFIX;
}

/** Where a sidecar is moved once its labels are safely inside the drawing. */
export function migratedSidecarPath(sidecarPath: string): string {
  return sidecarPath + MIGRATED_SIDECAR_SUFFIX;
}

/** What a sidecar's bytes turned out to hold. */
export interface SidecarRead {
  items: TextItem[];
  /**
   * True when SOMETHING in the file could not be read: unparseable JSON, a non-object root, a
   * missing/non-array `items`, or an entry that is not a usable label. It gates retirement —
   * a sidecar we did not fully understand is never moved aside.
   */
  unreadable: boolean;
}

/**
 * Read a sidecar. Never throws: the labels we can read are returned whatever else is wrong
 * with the file, because refusing to open a drawing over a damaged text sidecar would be
 * worse than showing the drawing without (some of) its labels.
 */
export function readTextSidecar(raw: string): SidecarRead {
  // An empty file is fully understood and holds nothing — safe to retire.
  if (!raw || raw.trim() === '') return { items: [], unreadable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { items: [], unreadable: true };
  }
  if (typeof parsed !== 'object' || parsed === null) return { items: [], unreadable: true };
  const rawItems = (parsed as { items?: unknown }).items;
  return { items: parseTextItems(rawItems), unreadable: hasUnreadableTextItems(rawItems) };
}
