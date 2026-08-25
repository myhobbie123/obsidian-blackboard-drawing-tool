import type { BlackboardFile } from '../domain/entities';
import { validateFileData } from '../domain/entities';
import type { TextItem } from '../domain/text-item';

/**
 * Format version of a drawing that carries strokes only. Unchanged since upstream 1.2.1, so a
 * text-free fork drawing is byte-identical to an upstream one and opens there without a
 * "newer than supported" warning.
 */
export const FORMAT_VERSION = 3;

/**
 * Format version of a drawing that carries an in-file text layer. The bump is what tells an
 * older reader that this document holds content it does not understand; it is stamped ONLY
 * when the document actually has labels (`stampFormatVersion`), so adding the feature does
 * not rewrite — or downgrade the compatibility of — every existing drawing on disk.
 */
export const FORMAT_VERSION_TEXT = 4;

/** The highest version this build can read. Anything above it loads read-only. */
export const SUPPORTED_FORMAT_VERSION = FORMAT_VERSION_TEXT;

/** Schema version of the `text` field itself, independent of the file version. */
export const TEXT_LAYER_VERSION = 1;

const emptyFile = (): BlackboardFile => ({
  version: FORMAT_VERSION,
  width: 800,
  height: 600,
  strokes: [],
  background: { color: 'transparent' },
});

/** Whether a document carries at least one label. */
export function hasTextLayer(file: BlackboardFile): boolean {
  return (file.text?.items.length ?? 0) > 0;
}

/** The version a document should be written at, given its content. */
export function formatVersionFor(file: BlackboardFile): number {
  return hasTextLayer(file) ? FORMAT_VERSION_TEXT : FORMAT_VERSION;
}

/**
 * Stamp the version implied by the content, returning the SAME object when it already
 * matches so the common path allocates nothing. Every writer funnels through here, which is
 * what keeps "has labels" and "declares version 4" from ever disagreeing on disk.
 */
export function stampFormatVersion(file: BlackboardFile): BlackboardFile {
  const version = formatVersionFor(file);
  return file.version === version ? file : { ...file, version };
}

/**
 * Replace a document's text layer. An empty list drops the field entirely rather than writing
 * `"text": {"items": []}`, so deleting the last label leaves a file byte-identical to one that
 * never had any.
 */
export function withTextItems(file: BlackboardFile, items: TextItem[]): BlackboardFile {
  if (items.length === 0) {
    if (!file.text) return stampFormatVersion(file);
    const rest = { ...file };
    delete rest.text;
    return stampFormatVersion(rest);
  }
  return stampFormatVersion({ ...file, text: { version: TEXT_LAYER_VERSION, items } });
}

/** The document's labels, or an empty list. */
export function textItemsOf(file: BlackboardFile): TextItem[] {
  return file.text?.items ?? [];
}

export function serialize(file: BlackboardFile): string {
  return JSON.stringify(file, null, 2);
}

export function deserialize(data: string): { file: BlackboardFile; warnings: string[]; readonly: boolean } {
  const warnings: string[] = [];
  let readonly = false;

  if (!data || data.trim() === '') {
    return { file: emptyFile(), warnings: [], readonly: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    warnings.push('Invalid JSON');
    return { file: emptyFile(), warnings, readonly: true };
  }

  const version =
    typeof parsed === 'object' && parsed !== null && 'version' in parsed
      ? parsed.version
      : undefined;
  if (typeof version === 'number' && version > SUPPORTED_FORMAT_VERSION) {
    // Read what we can and refuse to write: a future version may hold fields this build would
    // silently drop on the next save.
    warnings.push(
      'File version ' + String(version) + ' is newer than supported version ' +
      String(SUPPORTED_FORMAT_VERSION),
    );
    readonly = true;
  }

  const validated = validateFileData(parsed);
  if (!validated) {
    warnings.push('Invalid file structure');
    return { file: emptyFile(), warnings, readonly: true };
  }

  return { file: validated, warnings, readonly };
}
