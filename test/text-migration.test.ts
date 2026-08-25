import { describe, it, expect, vi } from 'vitest';
import { planTextMigration } from '../src/application/text-migration';
import { MigrateTextSidecarUseCase } from '../src/application/use-cases/migrate-text-sidecar';
import {
  migratedSidecarPath,
  textSidecarPath,
} from '../src/application/text-sidecar';
import {
  FORMAT_VERSION,
  FORMAT_VERSION_TEXT,
  deserialize,
  serialize,
  textItemsOf,
  withTextItems,
} from '../src/application/file-format';
import type { BlackboardFile } from '../src/domain/entities';
import type { IDrawingRepository, ITextSidecarRepository } from '../src/domain/ports';
import type { TextItem } from '../src/domain/text-item';

const DRAWING = 'Folder/D.blackboard';
const SIDECAR = textSidecarPath(DRAWING);
const RETIRED = migratedSidecarPath(SIDECAR);

const label = (over: Partial<TextItem> = {}): TextItem => ({
  id: 't1', x: 10, y: 20, text: 'hello', fontSize: 20, color: '#ffffff', ...over,
});

const drawing = (over: Partial<BlackboardFile> = {}): BlackboardFile => ({
  version: FORMAT_VERSION, width: 800, height: 600, strokes: [], background: { color: 'transparent' }, ...over,
});

const sidecarBytes = (items: TextItem[]) => JSON.stringify({ version: 1, items }, null, 2);

/** A vault holding raw bytes for both file kinds, so migration can be watched end to end. */
function vault(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const drawings: IDrawingRepository = {
    load: vi.fn(async (p: string) => deserialize(store.get(p) ?? '')),
    save: vi.fn(async (p: string, f: BlackboardFile) => { store.set(p, serialize(f)); }),
    writeRaw: vi.fn(async (p: string, c: string) => { store.set(p, c); }),
    create: vi.fn(async () => ''),
    exists: vi.fn((p: string) => store.has(p)),
    ensureFolder: vi.fn(async () => {}),
    delete: vi.fn(async (p: string) => { store.delete(p); }),
    rename: vi.fn(async () => {}),
  };
  const sidecars: ITextSidecarRepository = {
    read: vi.fn(async (p: string) => store.get(p) ?? null),
    rename: vi.fn(async (a: string, b: string) => {
      const v = store.get(a);
      if (v === undefined || store.has(b)) return;
      store.delete(a);
      store.set(b, v);
    }),
    exists: vi.fn((p: string) => store.has(p)),
  };
  return { store, drawings, sidecars };
}

function useCase(v: ReturnType<typeof vault>, log: (m: string) => void = () => {}) {
  return new MigrateTextSidecarUseCase(v.drawings, v.sidecars, log);
}

describe('planTextMigration', () => {
  it('imports every label of a well-formed sidecar and clears it for retirement', () => {
    const plan = planTextMigration(drawing(), sidecarBytes([label(), label({ id: 't2' })]));
    expect(plan).toEqual({ action: 'import', items: [label(), label({ id: 't2' })], retire: true });
  });

  it('skips a drawing that already carries labels — in-file text always wins', () => {
    const file = withTextItems(drawing(), [label({ text: 'newer, in the document' })]);
    expect(planTextMigration(file, sidecarBytes([label({ text: 'older, in the sidecar' })])))
      .toEqual({ action: 'skip', reason: 'document-has-text' });
  });

  it('skips when there is no sidecar', () => {
    expect(planTextMigration(drawing(), null)).toEqual({ action: 'skip', reason: 'no-sidecar' });
  });

  it('an empty sidecar imports nothing and is still safe to retire', () => {
    expect(planTextMigration(drawing(), '')).toEqual({ action: 'import', items: [], retire: true });
  });

  it('a malformed sidecar is imported as far as it reads and NEVER retired', () => {
    const plan = planTextMigration(drawing(), '{ broken');
    expect(plan).toMatchObject({ action: 'import', items: [], retire: false });
    expect(plan.action === 'import' && plan.warning).toBeTruthy();
  });

  it('a partly-broken sidecar keeps its readable labels and is still not retired', () => {
    const raw = JSON.stringify({ version: 1, items: [label(), { id: 'unreadable' }] });
    const plan = planTextMigration(drawing(), raw);
    expect(plan).toMatchObject({ action: 'import', retire: false });
    expect(plan.action === 'import' && plan.items.map((i) => i.id)).toEqual(['t1']);
  });
});

describe('MigrateTextSidecarUseCase', () => {
  it('imports the sidecar into the drawing, saves it, then retires the sidecar', async () => {
    const v = vault({ [DRAWING]: serialize(drawing()), [SIDECAR]: sidecarBytes([label()]) });

    const migrated = await useCase(v).execute(DRAWING, drawing());

    expect(textItemsOf(migrated)).toEqual([label()]);
    expect(migrated.version).toBe(FORMAT_VERSION_TEXT);
    expect(textItemsOf(deserialize(v.store.get(DRAWING)!).file)).toEqual([label()]);
    expect(v.store.has(SIDECAR)).toBe(false);
    expect(v.store.get(RETIRED)).toBe(sidecarBytes([label()]));
  });

  it('is idempotent: a second open imports nothing and writes nothing', async () => {
    const v = vault({ [DRAWING]: serialize(drawing()), [SIDECAR]: sidecarBytes([label()]) });
    const first = await useCase(v).execute(DRAWING, drawing());
    vi.mocked(v.drawings.save).mockClear();

    // Second open: the drawing now carries the labels, and the sidecar has been retired.
    const second = await useCase(v).execute(DRAWING, first);

    expect(v.drawings.save).not.toHaveBeenCalled();
    expect(textItemsOf(second)).toEqual([label()]);
  });

  it('does not fire on a drawing that already has in-file text, even with a sidecar present', async () => {
    const inFile = withTextItems(drawing(), [label({ text: 'in the document' })]);
    const v = vault({ [DRAWING]: serialize(inFile), [SIDECAR]: sidecarBytes([label({ text: 'stale' })]) });

    const result = await useCase(v).execute(DRAWING, inFile);

    expect(result).toBe(inFile);
    expect(v.drawings.save).not.toHaveBeenCalled();
    expect(v.store.get(SIDECAR)).toBe(sidecarBytes([label({ text: 'stale' })]));
  });

  it('costs nothing when there is no sidecar (no vault read at all)', async () => {
    const v = vault({ [DRAWING]: serialize(drawing()) });

    await useCase(v).execute(DRAWING, drawing());

    expect(v.sidecars.read).not.toHaveBeenCalled();
    expect(v.drawings.save).not.toHaveBeenCalled();
  });

  it('a malformed sidecar is preserved untouched, and logged', async () => {
    const v = vault({ [DRAWING]: serialize(drawing()), [SIDECAR]: '{ broken' });
    const logged: string[] = [];

    const result = await useCase(v, (m) => logged.push(m)).execute(DRAWING, drawing());

    expect(v.store.get(SIDECAR)).toBe('{ broken');
    expect(v.store.has(RETIRED)).toBe(false);
    expect(textItemsOf(result)).toEqual([]);
    expect(logged.join(' ')).toContain('could not be read');
  });

  it('a partly-broken sidecar has its readable labels imported but is KEPT', async () => {
    const raw = JSON.stringify({ version: 1, items: [label(), { id: 'unreadable' }] });
    const v = vault({ [DRAWING]: serialize(drawing()), [SIDECAR]: raw });

    const result = await useCase(v).execute(DRAWING, drawing());

    expect(textItemsOf(result).map((i) => i.id)).toEqual(['t1']);
    expect(v.store.get(SIDECAR)).toBe(raw);
    expect(v.store.has(RETIRED)).toBe(false);
  });

  it('retires the sidecar ONLY after the drawing has been written', async () => {
    const v = vault({ [DRAWING]: serialize(drawing()), [SIDECAR]: sidecarBytes([label()]) });
    const order: string[] = [];
    v.drawings.save = vi.fn(async (p: string, f: BlackboardFile) => {
      order.push('save-drawing');
      v.store.set(p, serialize(f));
    });
    const realRename = v.sidecars.rename;
    v.sidecars.rename = vi.fn(async (a: string, b: string) => {
      order.push('retire-sidecar');
      await realRename(a, b);
    });

    await useCase(v).execute(DRAWING, drawing());

    expect(order).toEqual(['save-drawing', 'retire-sidecar']);
  });

  it('a crash between import and save loses nothing: the sidecar stays, the next open retries', async () => {
    const v = vault({ [DRAWING]: serialize(drawing()), [SIDECAR]: sidecarBytes([label()]) });
    v.drawings.save = vi.fn(async () => { throw new Error('vault went away mid-write'); });

    const result = await useCase(v).execute(DRAWING, drawing());

    // The labels are live in this session...
    expect(textItemsOf(result)).toEqual([label()]);
    // ...the drawing on disk is untouched, and the sidecar is still the record of them.
    expect(deserialize(v.store.get(DRAWING)!).file.text).toBeUndefined();
    expect(v.store.get(SIDECAR)).toBe(sidecarBytes([label()]));
    expect(v.sidecars.rename).not.toHaveBeenCalled();

    // The next open (with a working vault) completes the migration.
    const v2 = vault({ [DRAWING]: serialize(drawing()), [SIDECAR]: sidecarBytes([label()]) });
    expect(textItemsOf(await useCase(v2).execute(DRAWING, drawing()))).toEqual([label()]);
  });

  it('a crash between save and retire leaves a stray file, never a duplicate label', async () => {
    const v = vault({ [DRAWING]: serialize(drawing()), [SIDECAR]: sidecarBytes([label()]) });
    v.sidecars.rename = vi.fn(async () => { throw new Error('rename failed'); });
    const logged: string[] = [];

    const migrated = await useCase(v, (m) => logged.push(m)).execute(DRAWING, drawing());

    expect(textItemsOf(migrated)).toEqual([label()]);
    expect(v.store.has(SIDECAR)).toBe(true);
    expect(logged.join(' ')).toContain('could not move it aside');

    // Re-opening sees in-file text and skips: the stray sidecar can never be imported twice.
    const again = await useCase(v).execute(DRAWING, deserialize(v.store.get(DRAWING)!).file);
    expect(textItemsOf(again)).toEqual([label()]);
  });

  it('an unreadable sidecar file (vault throws) aborts with both files untouched', async () => {
    const v = vault({ [DRAWING]: serialize(drawing()), [SIDECAR]: sidecarBytes([label()]) });
    v.sidecars.read = vi.fn(async () => { throw new Error('EIO'); });

    const result = await useCase(v).execute(DRAWING, drawing());

    expect(result.text).toBeUndefined();
    expect(v.drawings.save).not.toHaveBeenCalled();
    expect(v.store.get(SIDECAR)).toBe(sidecarBytes([label()]));
  });

  it('never clobbers an existing retired file (a second sidecar simply stays put)', async () => {
    const v = vault({
      [DRAWING]: serialize(drawing()),
      [SIDECAR]: sidecarBytes([label()]),
      [RETIRED]: 'an earlier retirement',
    });

    await useCase(v).execute(DRAWING, drawing());

    expect(v.store.get(RETIRED)).toBe('an earlier retirement');
    expect(v.store.has(SIDECAR)).toBe(true);
  });
});
