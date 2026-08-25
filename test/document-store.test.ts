import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocumentStore } from '../src/application/document-store';
import { serialize, textItemsOf, withTextItems, FORMAT_VERSION_TEXT } from '../src/application/file-format';
import type { TextItem } from '../src/domain/text-item';
import type { BlackboardFile, Stroke } from '../src/domain/entities';
import type { IDrawingRepository } from '../src/domain/ports';

function stroke(id: string): Stroke {
  return { id, tool: 'pen', color: '#fff', size: 2, opacity: 1, points: [[0, 0, 0.5]], hasPressure: false, timestamp: 0 };
}

function file(strokes: Stroke[]): BlackboardFile {
  return { version: 3, width: 800, height: 600, strokes, background: { color: 'transparent' } };
}

function mockRepo(initial: BlackboardFile): IDrawingRepository & { save: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn().mockResolvedValue({ file: initial, warnings: [], readonly: false }),
    save: vi.fn().mockResolvedValue(undefined),
    writeRaw: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(''),
    exists: vi.fn().mockReturnValue(true),
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('DocumentStore', () => {
  let store: DocumentStore;
  beforeEach(() => { store = new DocumentStore({ saveDelayMs: 0 }); });

  it('loads strokes from the repo on first acquire', async () => {
    const repo = mockRepo(file([stroke('a')]));
    const h = await store.acquire('Draw.blackboard', repo);

    expect(repo.load).toHaveBeenCalledTimes(1);
    expect(h.getStrokes().map((s) => s.id)).toEqual(['a']);
  });

  it('a second acquire of the same path shares the canonical document without reloading', async () => {
    const repo = mockRepo(file([stroke('a')]));
    const h1 = await store.acquire('Draw.blackboard', repo);
    const h2 = await store.acquire('Draw.blackboard', repo);

    expect(repo.load).toHaveBeenCalledTimes(1);
    expect(h2.getStrokes().map((s) => s.id)).toEqual(['a']);
    expect(h1).not.toBe(h2); // distinct handles (distinct subscriber identities)
  });

  it('commit notifies sibling subscribers but NOT the committing handle (B2)', async () => {
    const repo = mockRepo(file([stroke('a')]));
    const h1 = await store.acquire('Draw.blackboard', repo);
    const h2 = await store.acquire('Draw.blackboard', repo);
    const onH1 = vi.fn();
    const onH2 = vi.fn();
    h1.subscribe(onH1);
    h2.subscribe(onH2);

    h1.commit(file([stroke('a'), stroke('b')]));

    expect(onH1).not.toHaveBeenCalled();           // committer is not re-notified
    expect(onH2).toHaveBeenCalledTimes(1);          // sibling refreshes
    expect(h2.getStrokes().map((s) => s.id)).toEqual(['a', 'b']); // canonical updated
  });

  it('commit persists the file through the repo', async () => {
    const repo = mockRepo(file([stroke('a')]));
    const h = await store.acquire('Draw.blackboard', repo);

    h.commit(file([stroke('a'), stroke('b')]));
    await new Promise((r) => setTimeout(r, 1)); // let the (0ms) debounce flush

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save.mock.calls[0][0]).toBe('Draw.blackboard');
    expect((repo.save.mock.calls[0][1] as BlackboardFile).strokes.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('flushAll writes a pending debounced save immediately (iPad lock-screen safety)', async () => {
    const slow = new DocumentStore({ saveDelayMs: 10_000 }); // long debounce, would not fire in test
    const repo = mockRepo(file([stroke('a')]));
    const h = await slow.acquire('Draw.blackboard', repo);

    h.commit(file([stroke('a'), stroke('b')]));
    expect(repo.save).not.toHaveBeenCalled(); // still within the debounce window

    slow.flushAll(); // app backgrounding — force the write now

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect((repo.save.mock.calls[0][1] as BlackboardFile).strokes.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('flushAll is a no-op when there is no pending save', async () => {
    const repo = mockRepo(file([stroke('a')]));
    await store.acquire('Draw.blackboard', repo);
    store.flushAll();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('reconcile with foreign disk content replaces strokes and notifies ALL subscribers', async () => {
    const repo = mockRepo(file([stroke('a')]));
    const h1 = await store.acquire('Draw.blackboard', repo);
    const h2 = await store.acquire('Draw.blackboard', repo);
    const onH1 = vi.fn();
    const onH2 = vi.fn();
    h1.subscribe(onH1);
    h2.subscribe(onH2);

    store.reconcile('Draw.blackboard', serialize(file([stroke('x'), stroke('y')])));

    expect(onH1).toHaveBeenCalledTimes(1);
    expect(onH2).toHaveBeenCalledTimes(1);
    expect(h1.getStrokes().map((s) => s.id)).toEqual(['x', 'y']);
  });

  it('reconcile ignores our own last-written content (no save->modify->reload loop)', async () => {
    const repo = mockRepo(file([stroke('a')]));
    const h = await store.acquire('Draw.blackboard', repo);
    const onChange = vi.fn();
    h.subscribe(onChange);

    const committed = file([stroke('a'), stroke('b')]);
    h.commit(committed);
    onChange.mockClear(); // committer wasn't notified anyway

    store.reconcile('Draw.blackboard', serialize(committed)); // our own write echoing back

    expect(onChange).not.toHaveBeenCalled();
  });

  it('releasing the last handle drops the entry so the next acquire reloads from disk', async () => {
    const repo = mockRepo(file([stroke('a')]));
    const h1 = await store.acquire('Draw.blackboard', repo);
    const h2 = await store.acquire('Draw.blackboard', repo);

    h1.release();
    h2.release();
    await store.acquire('Draw.blackboard', repo);

    expect(repo.load).toHaveBeenCalledTimes(2); // reloaded after the entry was dropped
  });
});


const label = (over: Partial<TextItem> = {}): TextItem => ({
  id: 't1', x: 10, y: 20, text: 'hello', fontSize: 20, color: '#ffffff', ...over,
});

describe('DocumentStore text layer', () => {
  it('hands out the document\'s labels alongside its strokes', async () => {
    const store = new DocumentStore({ saveDelayMs: 0 });
    const repo = mockRepo(withTextItems(file([stroke('a')]), [label()]));
    const h = await store.acquire('D.blackboard', repo);

    expect(h.getTextItems()).toEqual([label()]);
    expect(h.getStrokes().map((s) => s.id)).toEqual(['a']);
  });

  it('a text commit persists through the SAME debounced save as strokes', async () => {
    vi.useFakeTimers();
    const store = new DocumentStore({ saveDelayMs: 250 });
    const repo = mockRepo(file([stroke('a')]));
    const h = await store.acquire('D.blackboard', repo);

    h.commitText([label()]);
    h.commitText([label({ text: 'still typing' })]);
    expect(repo.save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(textItemsOf(repo.save.mock.calls[0][1])).toEqual([label({ text: 'still typing' })]);
    vi.useRealTimers();
  });

  it('a text commit refreshes sibling surfaces but not the committer', async () => {
    const store = new DocumentStore({ saveDelayMs: 0 });
    const repo = mockRepo(file([]));
    const h1 = await store.acquire('D.blackboard', repo);
    const h2 = await store.acquire('D.blackboard', repo);
    const onH1 = vi.fn();
    const onH2 = vi.fn();
    h1.subscribe(onH1);
    h2.subscribe(onH2);

    h1.commitText([label()]);

    expect(onH1).not.toHaveBeenCalled();
    expect(onH2).toHaveBeenCalledTimes(1);
    expect(h2.getTextItems()).toEqual([label()]);
  });

  it('a stroke commit does not drop the labels that are already in the document', async () => {
    const store = new DocumentStore({ saveDelayMs: 0 });
    const repo = mockRepo(file([]));
    const h = await store.acquire('D.blackboard', repo);
    h.commitText([label()]);

    // A surface rebuilding the file from its engine carries the text through (buildFile does).
    h.commit(withTextItems(file([stroke('a')]), h.getTextItems()));

    expect(h.getTextItems()).toEqual([label()]);
    expect(h.getStrokes()).toHaveLength(1);
  });

  it('stamps the bumped format version once a document carries labels, and back again', async () => {
    const store = new DocumentStore({ saveDelayMs: 0 });
    const repo = mockRepo(file([]));
    const h = await store.acquire('D.blackboard', repo);

    h.commitText([label()]);
    expect(h.getFile().version).toBe(FORMAT_VERSION_TEXT);

    h.commitText([]);
    expect(h.getFile().version).toBe(3);
    expect(h.getFile().text).toBeUndefined();
  });
});

describe('DocumentStore first-open migration', () => {
  it('runs the migration once, before any surface can observe the document', async () => {
    const repo = mockRepo(file([stroke('a')]));
    const migrate = vi.fn(async (_path: string, f: BlackboardFile) => withTextItems(f, [label()]));
    const store = new DocumentStore({ saveDelayMs: 0, migrate });

    const h = await store.acquire('D.blackboard', repo);

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(h.getTextItems()).toEqual([label()]);
  });

  it('does not re-run for a second surface of the same path', async () => {
    const repo = mockRepo(file([]));
    const migrate = vi.fn(async (_p: string, f: BlackboardFile) => f);
    const store = new DocumentStore({ saveDelayMs: 0, migrate });

    await store.acquire('D.blackboard', repo);
    await store.acquire('D.blackboard', repo);

    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('a drawing opened in two panes AT ONCE loads, and migrates, exactly once', async () => {
    const repo = mockRepo(file([stroke('a')]));
    const migrate = vi.fn(async (_p: string, f: BlackboardFile) => withTextItems(f, [label()]));
    const store = new DocumentStore({ saveDelayMs: 0, migrate });

    // Both acquires start in the same tick — the failure mode this guards is the second one
    // replacing the first one's entry (orphaning its subscribers) and migrating again.
    const [h1, h2] = await Promise.all([
      store.acquire('D.blackboard', repo),
      store.acquire('D.blackboard', repo),
    ]);

    expect(repo.load).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledTimes(1);
    const onH2 = vi.fn();
    h2.subscribe(onH2);
    h1.commit(file([stroke('a'), stroke('b')]));
    expect(onH2).toHaveBeenCalledTimes(1);
  });

  it('the migration\'s own write does not come back as a foreign external edit', async () => {
    const repo = mockRepo(file([]));
    const migrated = withTextItems(file([]), [label()]);
    const store = new DocumentStore({ saveDelayMs: 0, migrate: async () => migrated });
    const h = await store.acquire('D.blackboard', repo);
    const onChange = vi.fn();
    h.subscribe(onChange);

    // The `modify` echo of the migration write arrives after the document is published.
    store.reconcile('D.blackboard', serialize(h.getFile()));

    expect(onChange).not.toHaveBeenCalled();
    expect(h.getTextItems()).toEqual([label()]);
  });

  it('an external edit that adds labels reaches every surface', async () => {
    const store = new DocumentStore({ saveDelayMs: 0 });
    const repo = mockRepo(file([]));
    const h = await store.acquire('D.blackboard', repo);
    const onChange = vi.fn();
    h.subscribe(onChange);

    store.reconcile('D.blackboard', serialize(withTextItems(file([]), [label({ text: 'from another device' })])));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(h.getTextItems()).toEqual([label({ text: 'from another device' })]);
  });
});

describe('DocumentStore refuses to write what it cannot represent', () => {
  it('skips the migration for a readonly (corrupt or future-version) document', async () => {
    const repo = mockRepo(file([]));
    repo.load = vi.fn().mockResolvedValue({
      file: { version: 9, width: 800, height: 600, strokes: [], background: { color: 'transparent' } },
      warnings: ['newer'],
      readonly: true,
    });
    const migrate = vi.fn(async (_p: string, f: BlackboardFile) => withTextItems(f, [label()]));
    const store = new DocumentStore({ saveDelayMs: 0, migrate });

    const h = await store.acquire('D.blackboard', repo);

    expect(migrate).not.toHaveBeenCalled();
    expect(h.getTextItems()).toEqual([]);
    expect(h.getFile().version).toBe(9);
  });
});
