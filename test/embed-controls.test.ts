import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownView, TFile } from 'obsidian';
import { attachBoardControls, moveActiveBoard, setActiveNoteBoard } from '../src/presentation/embed-controls';
import { applyEmbedLayout, readRenderedAlias } from '../src/presentation/embed-layout';
import { commitNoteEdit, resolveEmbedLink } from '../src/presentation/embed-note';
import { parseEmbedAlias } from '../src/presentation/embed-size';

const board = '![[x.blackboard|right|300]]';
function fixture(initial = `first\n\n${board}\n\nlast`, mode = 'source') {
  let source = initial;
  let cursor = initial.indexOf('![[');
  const view = new MarkdownView() as any;
  view.file = Object.assign(new TFile(), { path: 'Note.md' });
  view.getMode = () => mode;
  view.contentEl = document.body.createDiv();
  const root = view.contentEl.createDiv({ cls: mode === 'source' ? 'markdown-source-view' : 'markdown-preview-view' });
  const el = root.createDiv({ cls: 'internal-embed blackboard-embed' });
  el.setAttribute('src', 'x.blackboard');
  el.setAttribute('alt', '300'); // last-segment-only DOM: source must recover right
  const pane = root.createDiv({ cls: 'cm-scroller' });
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 600, width: 600, height: 600 }) as DOMRect;
  const history: string[] = [];
  const cm = {
    dispatch: vi.fn((tx: any) => {
      history.push(source);
      source = source.slice(0, tx.changes.from) + tx.changes.insert + source.slice(tx.changes.to);
      if (tx.selection) cursor = tx.selection.anchor;
    }),
    requestMeasure: vi.fn(),
    scrollDOM: pane,
    posAtCoords: vi.fn(() => source.indexOf('last')),
    coordsAtPos: vi.fn(() => ({ top: 500, bottom: 520, left: 0, right: 600 })),
    lineBlockAt: vi.fn(() => ({ from: 0, to: 1, top: 500, bottom: 520 })),
    documentTop: 0,
  };
  view.editor = { cm, getValue: () => source, getCursor: () => ({ line: 0, ch: cursor }), posToOffset: (pos: any) => pos.ch };
  const app = {
    workspace: { getActiveViewOfType: () => view, iterateAllLeaves: (cb: any) => cb({ view }) },
    metadataCache: { getFirstLinkpathDest: (path: string) => ({ path }) },
    vault: { process: vi.fn(), cachedRead: vi.fn(async () => source) },
  } as any;
  const abort = new AbortController();
  const cleanup = attachBoardControls(app, el, 'x.blackboard', abort.signal, vi.fn());
  return { app, view, el, cm, history, pane, abort, cleanup, source: () => source, changeSource: (next: string) => { source = next; }, undo: () => { source = history.pop()!; } };
}
const pointer = (type: string, x = 100, y = 100) => new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, button: 0, clientX: x, clientY: y });
afterEach(() => { setActiveNoteBoard(null); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('note controls and write transactions', () => {
  it('moves the source cursor board with an isolated undo step, then moves it again', () => {
    const f = fixture();
    moveActiveBoard(f.app, 1);
    expect(f.source()).toBe(`first\n\nlast\n\n${board}`);
    expect(f.cm.dispatch).toHaveBeenCalledTimes(1);
    expect(f.cm.dispatch.mock.calls[0][0].annotations).toEqual([{ isolateHistory: 'full' }]);
    expect(f.cm.requestMeasure).toHaveBeenCalledTimes(1);
    moveActiveBoard(f.app, -1);
    expect(f.source()).toBe(`first\n\n${board}\n\nlast`);
    f.undo(); expect(f.source()).toBe(`first\n\nlast\n\n${board}`);
    f.undo(); expect(f.source()).toBe(`first\n\n${board}\n\nlast`);
    f.cleanup();
  });
  it('layout button preserves size, updates toggles, and never draws on the surface', () => {
    const f = fixture();
    const surface = f.el.createDiv({ cls: 'blackboard-drawing-container' });
    const stroke = vi.fn(); surface.addEventListener('pointerdown', stroke);
    const left = f.el.querySelector<HTMLButtonElement>('[aria-label="Left, text wraps right"]')!;
    left.dispatchEvent(pointer('pointerdown')); left.click();
    expect(stroke).not.toHaveBeenCalled();
    expect(f.source()).toContain('![[x.blackboard|left|300]]');
    expect(f.el.classList.contains('bb-wrap-preview')).toBe(true);
    expect(left.getAttribute('aria-pressed')).toBe('true');
    expect(f.cm.dispatch).toHaveBeenCalledTimes(1);
    f.cleanup();
  });
  it('hides move in Reading view, disables layout writes, and still renders its source alias', async () => {
    const f = fixture(undefined, 'preview');
    expect(f.el.querySelector<HTMLButtonElement>('.bb-move-grip')!.hidden).toBe(true);
    const alias = await readRenderedAlias(f.app, f.el, 'x.blackboard');
    expect(alias.layout).toBe('right');
    applyEmbedLayout(f.el, alias);
    expect(f.el.classList.contains('bb-layout-right')).toBe(true);
    expect(f.el.classList.contains('bb-wrap-preview')).toBe(false);
    moveActiveBoard(f.app, 1);
    expect(f.cm.dispatch).not.toHaveBeenCalled();
    expect(f.app.vault.process).not.toHaveBeenCalled();
    f.cleanup();
  });
  it('disables moving an inline board with an explanatory tooltip', () => {
    const f = fixture(`text ${board} more`);
    const grip = f.el.querySelector<HTMLButtonElement>('.bb-move-grip')!;
    expect(grip.disabled).toBe(true); expect(grip.title).toContain('own line');
    moveActiveBoard(f.app, 1); expect(f.cm.dispatch).not.toHaveBeenCalled();
    f.cleanup();
  });
  it('refuses stale source and unidentifiable virtualised duplicates', () => {
    const f = fixture(`${board}\n\nfirst\n\n${board}`);
    expect(resolveEmbedLink(f.app, f.view, f.el, 'x.blackboard', f.source())).toBeNull();
    f.cm.posAtDOM = () => f.source().lastIndexOf('![[');
    expect(resolveEmbedLink(f.app, f.view, f.el, 'x.blackboard', f.source())?.start).toBe(f.source().lastIndexOf('![['));
    expect(commitNoteEdit(f.view, 'stale', { start: 0, end: 0, text: 'bad' })).toBe(false);
    expect(f.cm.dispatch).not.toHaveBeenCalled();
    f.cleanup();
  });
  it('changes only presentation on narrow notes and excludes canvas nodes', () => {
    const f = fixture();
    expect(f.el.closest('.markdown-source-view')?.classList.contains('bb-narrow-note')).toBe(true);
    const canvas = document.body.createDiv({ cls: 'canvas-node' });
    const el = canvas.createDiv(); applyEmbedLayout(el, parseEmbedAlias('left|300'));
    expect(el.classList.contains('bb-layout-left')).toBe(false);
    expect(f.source()).toContain('|right|300');
    f.cleanup();
  });
});

describe('drag movement', () => {
  function dragFixture(initial?: string) {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { callbacks.set(++id, cb); return id; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(i => { callbacks.delete(i); });
    const f = fixture(initial);
    const grip = f.el.querySelector<HTMLButtonElement>('.bb-move-grip')!;
    const frame = () => { const queued = [...callbacks.values()]; callbacks.clear(); queued.forEach(cb => cb(0)); };
    const start = () => { grip.dispatchEvent(pointer('pointerdown')); grip.dispatchEvent(pointer('pointermove', 100, 550)); frame(); };
    return { ...f, grip, frame, start };
  }
  it('shows a block boundary indicator and commits one edit on drop', () => {
    const f = dragFixture(); f.start();
    expect(document.querySelector<HTMLDivElement>('.bb-drop-indicator')!.hidden).toBe(false);
    f.grip.dispatchEvent(pointer('pointerup', 100, 550));
    expect(f.source()).toBe(`first\n\nlast\n\n${board}`);
    expect(f.cm.dispatch).toHaveBeenCalledTimes(1); f.cleanup();
  });
  it('Escape, pointer cancellation, and cleanup cancel without writing', () => {
    for (const kind of ['escape', 'pointercancel', 'cleanup']) {
      const f = dragFixture(); f.start();
      if (kind === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else if (kind === 'pointercancel') f.grip.dispatchEvent(pointer('pointercancel'));
      else f.cleanup();
      f.grip.dispatchEvent(pointer('pointerup', 100, 550));
      expect(f.cm.dispatch).not.toHaveBeenCalled(); f.cleanup();
    }
  });
  it('hides the indicator inside a protected block and refuses the drop', () => {
    const f = dragFixture(`${board}\n\n> [!note]\n> last`); f.start();
    expect(document.querySelector<HTMLDivElement>('.bb-drop-indicator')!.hidden).toBe(true);
    f.grip.dispatchEvent(pointer('pointerup', 100, 550)); expect(f.cm.dispatch).not.toHaveBeenCalled(); f.cleanup();
  });
  it('does not write when dropped in the original gap or without a drag', () => {
    const f = dragFixture();
    f.cm.posAtCoords.mockReturnValue(0); // after first block = original gap
    f.start(); f.grip.dispatchEvent(pointer('pointerup', 100, 550));
    expect(f.cm.dispatch).not.toHaveBeenCalled();
    f.grip.dispatchEvent(pointer('pointerdown'));
    f.grip.dispatchEvent(pointer('pointerup'));
    expect(f.cm.dispatch).not.toHaveBeenCalled(); f.cleanup();
  });
  it('rechecks forbidden release coordinates after a valid preview', () => {
    const f = dragFixture(`${board}\n\nlast\n\n> [!note]\n> body`); f.start();
    f.cm.posAtCoords.mockReturnValue(f.source().indexOf('body'));
    f.grip.dispatchEvent(pointer('pointerup', 100, 550)); expect(f.cm.dispatch).not.toHaveBeenCalled(); f.cleanup();
  });
  it('refuses changes during drag and autoscrolls near pane edges', () => {
    const f = dragFixture(); f.start();
    f.grip.dispatchEvent(pointer('pointermove', 100, 590)); f.frame();
    expect(f.pane.scrollTop).toBeGreaterThan(0);
    f.changeSource(f.source() + '\nchanged'); f.frame();
    f.grip.dispatchEvent(pointer('pointerup', 100, 550)); expect(f.cm.dispatch).not.toHaveBeenCalled(); f.cleanup();
  });
});
