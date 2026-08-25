import type { TextItem } from '../domain/text-item';
import type { SharedDocumentHandle } from './document-store';

/**
 * The text layer of ONE drawing as its presentation layer sees it: read the labels, write the
 * labels. Everything behind it — versioning, the debounce, the dirty flag, notifying sibling
 * surfaces — is the shared document's job, exactly as it is for strokes.
 *
 * Narrow on purpose: it is what lets `TextLayer` be tested against a plain array while the
 * real implementation commits into the `.blackboard` file.
 */
export interface TextDocument {
  getItems(): TextItem[];
  setItems(items: TextItem[]): void;
}

/** The text layer of a shared document handle. */
export function handleTextDocument(handle: SharedDocumentHandle): TextDocument {
  return {
    getItems: () => handle.getTextItems(),
    setItems: (items) => { handle.commitText(items); },
  };
}

/**
 * A detached text layer, for a surface with no shared document (an embed mounted without a
 * store, and tests). Labels behave normally and simply are not persisted.
 */
export function memoryTextDocument(initial: TextItem[] = []): TextDocument {
  let items = initial.map((i) => ({ ...i }));
  return {
    getItems: () => items.map((i) => ({ ...i })),
    setItems: (next) => { items = next.map((i) => ({ ...i })); },
  };
}
