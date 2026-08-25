import { describe, it, expect } from 'vitest';
import {
  MIGRATED_SIDECAR_SUFFIX,
  TEXT_SIDECAR_SUFFIX,
  migratedSidecarPath,
  readTextSidecar,
  textSidecarPath,
} from '../src/application/text-sidecar';

/** The labels a sidecar's bytes yield, ignoring whether anything was unreadable. */
const parse = (raw: string) => readTextSidecar(raw).items;
import {
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_SIZE,
  isValidTextItem,
  normalizeTextItem,
  type TextItem,
} from '../src/domain/text-item';

const item = (over: Partial<TextItem> = {}): TextItem => ({
  id: 'a1',
  x: 10,
  y: 20,
  text: 'hello',
  fontSize: 20,
  color: '#ffffff',
  ...over,
});

describe('textSidecarPath', () => {
  it('substitutes the .blackboard extension', () => {
    expect(textSidecarPath('Folder/Note.blackboard')).toBe('Folder/Note' + TEXT_SIDECAR_SUFFIX);
  });

  it('is case-insensitive on the extension', () => {
    expect(textSidecarPath('A.BLACKBOARD')).toBe('A' + TEXT_SIDECAR_SUFFIX);
  });

  it('keeps a vault-root path at the root', () => {
    expect(textSidecarPath('Drawing 1.blackboard')).toBe('Drawing 1' + TEXT_SIDECAR_SUFFIX);
  });

  it('does not eat a .blackboard occurring mid-path', () => {
    expect(textSidecarPath('.blackboard/Note.blackboard'))
      .toBe('.blackboard/Note' + TEXT_SIDECAR_SUFFIX);
  });

  it('appends rather than substitutes for a non-drawing path (mapping stays total)', () => {
    expect(textSidecarPath('Note.md')).toBe('Note.md' + TEXT_SIDECAR_SUFFIX);
  });

  it('never maps a drawing onto itself', () => {
    const p = 'X.blackboard';
    expect(textSidecarPath(p)).not.toBe(p);
  });
});

describe('migratedSidecarPath', () => {
  it('moves a sidecar aside without changing where it lives', () => {
    const sidecar = textSidecarPath('Folder/Note.blackboard');
    expect(migratedSidecarPath(sidecar)).toBe(sidecar + MIGRATED_SIDECAR_SUFFIX);
  });

  it('is not itself a sidecar path, so a retired file is never re-imported', () => {
    const sidecar = textSidecarPath('N.blackboard');
    expect(migratedSidecarPath(sidecar)).not.toBe(sidecar);
    expect(migratedSidecarPath(sidecar).endsWith(TEXT_SIDECAR_SUFFIX)).toBe(false);
  });
});

describe('readTextSidecar reports what it could not read', () => {
  it('a fully readable sidecar is safe to retire', () => {
    const raw = JSON.stringify({ version: 1, items: [item(), item({ id: 'b2' })] });
    expect(readTextSidecar(raw)).toEqual({ items: [item(), item({ id: 'b2' })], unreadable: false });
  });

  it('an EMPTY file is understood, not damaged (nothing to lose by retiring it)', () => {
    expect(readTextSidecar('')).toEqual({ items: [], unreadable: false });
    expect(readTextSidecar('  \n ')).toEqual({ items: [], unreadable: false });
  });

  it('unparseable JSON is unreadable', () => {
    expect(readTextSidecar('{ "items": [').unreadable).toBe(true);
    expect(readTextSidecar('not json').unreadable).toBe(true);
  });

  it('a missing or non-array items list is unreadable', () => {
    expect(readTextSidecar('{"version":1}').unreadable).toBe(true);
    expect(readTextSidecar('{"version":1,"items":{}}').unreadable).toBe(true);
    expect(readTextSidecar('null').unreadable).toBe(true);
  });

  it('one broken entry among good ones marks the whole file unreadable', () => {
    const raw = JSON.stringify({ version: 1, items: [item(), { id: 'x' }] });
    const read = readTextSidecar(raw);
    expect(read.items.map((i) => i.id)).toEqual(['a1']);
    expect(read.unreadable).toBe(true);
  });

  it('a repairable entry (missing fontSize) is NOT unreadable', () => {
    const raw = JSON.stringify({ version: 1, items: [{ id: 'z', x: 1, y: 2, text: 't' }] });
    expect(readTextSidecar(raw).unreadable).toBe(false);
  });

  it('preserves every field of every item it can read', () => {
    const items = [item(), item({ id: 'b2', x: -4.5, y: 0, text: 'line\nbreak', fontSize: 42, color: '#ff0000' })];
    expect(parse(JSON.stringify({ version: 1, items }))).toEqual(items);
  });
});

describe('readTextSidecar tolerates damage', () => {
  it('returns [] for an empty file', () => {
    expect(parse('')).toEqual([]);
    expect(parse('   \n ')).toEqual([]);
  });

  it('returns [] for malformed JSON instead of throwing', () => {
    expect(() => parse('{ "items": [')).not.toThrow();
    expect(parse('{ "items": [')).toEqual([]);
    expect(parse('not json at all')).toEqual([]);
  });

  it('returns [] when items is missing or not an array', () => {
    expect(parse('{"version":1}')).toEqual([]);
    expect(parse('{"version":1,"items":{}}')).toEqual([]);
    expect(parse('null')).toEqual([]);
    expect(parse('[]')).toEqual([]);
  });

  it('keeps the readable items and drops only the broken ones', () => {
    const raw = JSON.stringify({
      version: 1,
      items: [
        item(),
        { id: 'no-coords', text: 'x' },
        { id: 'nan', x: NaN, y: 0, text: 'x' },
        null,
        'string',
        item({ id: 'c3', text: 'kept' }),
      ],
    });
    expect(parse(raw).map((i) => i.id)).toEqual(['a1', 'c3']);
  });

  it('repairs a missing or invalid fontSize/color rather than dropping the item', () => {
    const raw = JSON.stringify({ version: 1, items: [{ id: 'z', x: 1, y: 2, text: 't' }] });
    expect(parse(raw)).toEqual([
      { id: 'z', x: 1, y: 2, text: 't', fontSize: DEFAULT_TEXT_FONT_SIZE, color: DEFAULT_TEXT_COLOR },
    ]);
  });

  it('a sidecar written before the text tool existed still reads, field for field', () => {
    // Regression guard for the wave-0/1 sidecars this build has to import: none of the
    // schema work may add, rename or reorder a field an existing file relies on.
    const legacy = JSON.stringify({
      version: 1,
      items: [
        { id: 'old-1', x: 12, y: 34, text: 'written by wave 0', fontSize: 20, color: '#ffffff' },
      ],
    }, null, 2);

    expect(readTextSidecar(legacy)).toEqual({
      items: [{ id: 'old-1', x: 12, y: 34, text: 'written by wave 0', fontSize: 20, color: '#ffffff' }],
      unreadable: false,
    });
  });

  it('accepts a sidecar written by a future version (forward tolerance)', () => {
    const raw = JSON.stringify({ version: 99, items: [item()], extra: true });
    expect(parse(raw)).toEqual([item()]);
  });
});

describe('text item validation', () => {
  it('requires id, finite coordinates and text', () => {
    expect(isValidTextItem(item())).toBe(true);
    expect(isValidTextItem({ ...item(), id: 1 })).toBe(false);
    expect(isValidTextItem({ ...item(), x: Infinity })).toBe(false);
    expect(isValidTextItem({ ...item(), text: undefined })).toBe(false);
    expect(isValidTextItem(undefined)).toBe(false);
  });

  it('accepts an empty string as text (a label being typed)', () => {
    expect(isValidTextItem(item({ text: '' }))).toBe(true);
  });

  it('rejects a non-positive fontSize by repairing it', () => {
    expect(normalizeTextItem({ ...item(), fontSize: 0 }).fontSize).toBe(DEFAULT_TEXT_FONT_SIZE);
    expect(normalizeTextItem({ ...item(), fontSize: -3 }).fontSize).toBe(DEFAULT_TEXT_FONT_SIZE);
  });
});
