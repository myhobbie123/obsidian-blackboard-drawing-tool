import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkdownView, TFile } from 'obsidian';
import { attachResizeHandles, persistEmbedSize } from '../src/presentation/embed';
import { RESIZE_DIRECTIONS } from '../src/presentation/embed-resize';

function makeEmbed(width = 400, height = 300): HTMLElement {
  const el = document.createElement('div');
  el.className = 'internal-embed blackboard-embed';
  el.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function pointer(type: string, init: Partial<PointerEventInit> = {}): PointerEvent {
  return new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true, cancelable: true, ...init });
}

function handleOf(el: HTMLElement, direction: string): HTMLElement {
  return el.querySelector<HTMLElement>(`.blackboard-resize-handle.${direction}`)!;
}

describe('attachResizeHandles', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('adds one handle per direction, labelled and tagged', () => {
    const el = makeEmbed();
    attachResizeHandles(el, new AbortController().signal, window, vi.fn());
    const handles = el.querySelectorAll('.blackboard-resize-handle');
    expect(handles).toHaveLength(8);
    for (const direction of RESIZE_DIRECTIONS) {
      const handle = handleOf(el, direction);
      expect(handle).toBeTruthy();
      expect(handle.dataset.direction).toBe(direction);
      expect(handle.getAttribute('aria-label')).toBe(`Resize Blackboard ${direction.replace('-', ' ')}`);
    }
  });

  it('resizes live while dragging and commits the final size on release', () => {
    const el = makeEmbed();
    const commit = vi.fn();
    attachResizeHandles(el, new AbortController().signal, window, commit);
    const handle = handleOf(el, 'bottom-right');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    handle.dispatchEvent(pointer('pointerdown', { clientX: 400, clientY: 300 }));
    expect(el.classList.contains('blackboard-resizing')).toBe(true);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);

    handle.dispatchEvent(pointer('pointermove', { clientX: 450, clientY: 330 }));
    expect(el.style.width).toBe('450px');
    expect(el.style.height).toBe('330px');
    expect(commit).not.toHaveBeenCalled();

    handle.dispatchEvent(pointer('pointerup', { clientX: 450, clientY: 330 }));
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(el.classList.contains('blackboard-resizing')).toBe(false);
    expect(commit).toHaveBeenCalledWith(450, 330);
  });

  it('restores the inline margins a left/top drag borrowed', () => {
    const el = makeEmbed();
    el.style.marginLeft = '4px';
    attachResizeHandles(el, new AbortController().signal, window, vi.fn());
    const handle = handleOf(el, 'left');
    handle.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0 }));
    handle.dispatchEvent(pointer('pointermove', { clientX: -60, clientY: 0 }));
    expect(el.style.width).toBe('460px');
    expect(el.style.marginLeft).toBe('-56px');
    handle.dispatchEvent(pointer('pointerup', { clientX: -60, clientY: 0 }));
    expect(el.style.marginLeft).toBe('4px');
  });

  it('never goes below the 150x100 minimum', () => {
    const el = makeEmbed();
    const commit = vi.fn();
    attachResizeHandles(el, new AbortController().signal, window, commit);
    const handle = handleOf(el, 'bottom-right');
    handle.dispatchEvent(pointer('pointerdown', { clientX: 400, clientY: 300 }));
    handle.dispatchEvent(pointer('pointermove', { clientX: -900, clientY: -900 }));
    expect(el.style.width).toBe('150px');
    expect(el.style.height).toBe('100px');
    handle.dispatchEvent(pointer('pointerup', { clientX: -900, clientY: -900 }));
    expect(commit).toHaveBeenCalledWith(150, 100);
  });

  it('does not commit when the pointer never moved', () => {
    const el = makeEmbed();
    const commit = vi.fn();
    attachResizeHandles(el, new AbortController().signal, window, commit);
    const handle = handleOf(el, 'top');
    handle.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0 }));
    handle.dispatchEvent(pointer('pointerup', { clientX: 0, clientY: 0 }));
    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores secondary buttons and non-primary pointers', () => {
    const el = makeEmbed();
    attachResizeHandles(el, new AbortController().signal, window, vi.fn());
    const handle = handleOf(el, 'right');
    handle.dispatchEvent(pointer('pointerdown', { button: 2 }));
    expect(el.classList.contains('blackboard-resizing')).toBe(false);
    handle.dispatchEvent(pointer('pointerdown', { isPrimary: false }));
    expect(el.classList.contains('blackboard-resizing')).toBe(false);
  });

  it('ends the drag on pointercancel and on lost capture', () => {
    for (const terminator of ['pointercancel', 'lostpointercapture']) {
      document.body.innerHTML = '';
      const el = makeEmbed();
      const commit = vi.fn();
      attachResizeHandles(el, new AbortController().signal, window, commit);
      const handle = handleOf(el, 'bottom');
      handle.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 300 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: 0, clientY: 350 }));
      handle.dispatchEvent(pointer(terminator, { clientX: 0, clientY: 350 }));
      expect(el.classList.contains('blackboard-resizing')).toBe(false);
      expect(commit).toHaveBeenCalledWith(400, 350);
      // A later move must not keep resizing after the drag ended.
      handle.dispatchEvent(pointer('pointermove', { clientX: 0, clientY: 900 }));
      expect(el.style.height).toBe('350px');
    }
  });

  it('ignores events from a second, unrelated pointer', () => {
    const el = makeEmbed();
    const commit = vi.fn();
    attachResizeHandles(el, new AbortController().signal, window, commit);
    const handle = handleOf(el, 'right');
    handle.dispatchEvent(pointer('pointerdown', { clientX: 400, clientY: 0 }));
    handle.dispatchEvent(pointer('pointermove', { pointerId: 7, clientX: 900, clientY: 0 }));
    expect(el.style.width).toBe('');
    handle.dispatchEvent(pointer('pointerup', { pointerId: 7, clientX: 900, clientY: 0 }));
    expect(commit).not.toHaveBeenCalled();
  });

  it('aborting the signal removes every handle listener', () => {
    const el = makeEmbed();
    const commit = vi.fn();
    const abort = new AbortController();
    const detach = attachResizeHandles(el, abort.signal, window, commit);

    abort.abort();

    for (const direction of RESIZE_DIRECTIONS) {
      const handle = handleOf(el, direction);
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        handle.dispatchEvent(pointer(type, { clientX: 900, clientY: 900 }));
      }
    }
    expect(el.classList.contains('blackboard-resizing')).toBe(false);
    expect(el.style.width).toBe('');
    expect(commit).not.toHaveBeenCalled();

    detach();
    expect(el.querySelectorAll('.blackboard-resize-handle')).toHaveLength(0);
  });

  it('detaching mid-drag drops the pending drag', () => {
    const el = makeEmbed();
    const commit = vi.fn();
    const detach = attachResizeHandles(el, new AbortController().signal, window, commit);
    const handle = handleOf(el, 'bottom-right');
    handle.dispatchEvent(pointer('pointerdown', { clientX: 400, clientY: 300 }));
    handle.dispatchEvent(pointer('pointermove', { clientX: 500, clientY: 400 }));
    detach();
    handle.dispatchEvent(pointer('pointerup', { clientX: 500, clientY: 400 }));
    expect(commit).not.toHaveBeenCalled();
  });
});

function makeApp(view: any, extra: Partial<any> = {}) {
  return {
    workspace: {
      getActiveViewOfType: vi.fn(() => view),
      iterateAllLeaves: vi.fn((cb: (leaf: any) => void) => { if (view) cb({ view }); }),
    },
    metadataCache: {
      getFirstLinkpathDest: vi.fn((linkpath: string) => ({ path: linkpath })),
    },
    vault: { process: vi.fn(), read: vi.fn(), modify: vi.fn() },
    ...extra,
  } as any;
}

function makeView(source: string, embeds: HTMLElement[], withEditor = true) {
  const view = new MarkdownView() as any;
  view.contentEl = document.createElement('div');
  for (const e of embeds) view.contentEl.appendChild(e);
  const file = new TFile();
  file.path = 'Note.md';
  view.file = file;
  view.getMode = () => withEditor ? 'source' : 'preview';
  view.editor = withEditor
    ? {
        getValue: vi.fn(() => source),
        offsetToPos: vi.fn((offset: number) => ({ line: 0, ch: offset })),
        replaceRange: vi.fn(),
        cm: { dispatch: vi.fn(), requestMeasure: vi.fn() },
      }
    : undefined;
  return view;
}

function embedFor(src: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'internal-embed';
  el.setAttribute('src', src);
  return el;
}

describe('persistEmbedSize', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('rewrites the alias through the editor, addressing only the embed', async () => {
    const source = 'intro\n![[D.blackboard|10x10]]\n';
    const embed = embedFor('D.blackboard');
    const view = makeView(source, [embed]);
    await persistEmbedSize(makeApp(view), embed, 'D.blackboard', 640, 480);
    expect(view.editor.cm.dispatch).toHaveBeenCalledWith(
      { changes: { insert: '![[D.blackboard|640x480]]', from: source.indexOf('![['), to: source.indexOf(']]') + 2 }, annotations: [{ isolateHistory: 'full' }] },
    );
  });

  it('adds an alias to an embed that had none', async () => {
    const embed = embedFor('D.blackboard');
    const view = makeView('![[D.blackboard]]', [embed]);
    await persistEmbedSize(makeApp(view), embed, 'D.blackboard', 300, 200);
    expect(view.editor.cm.dispatch.mock.calls[0][0].changes.insert).toBe('![[D.blackboard|300x200]]');
  });

  it('rewrites the second embed when the second one was dragged', async () => {
    const source = '![[D.blackboard|1x1]]\n![[D.blackboard|2x2]]\n';
    const first = embedFor('D.blackboard');
    const second = embedFor('D.blackboard');
    const view = makeView(source, [first, second]);
    await persistEmbedSize(makeApp(view), second, 'D.blackboard', 640, 480);
    const { from, to } = view.editor.cm.dispatch.mock.calls[0][0].changes;
    expect(from).toBe(source.lastIndexOf('![['));
    expect(to).toBe(source.length - 1);
  });

  it('refuses when DOM and source counts disagree', async () => {
    // Live Preview may have virtualised one of the two source embeds away.
    const source = '![[D.blackboard|1x1]]\n![[D.blackboard|2x2]]\n';
    const only = embedFor('D.blackboard');
    const view = makeView(source, [only]);
    await persistEmbedSize(makeApp(view), only, 'D.blackboard', 640, 480);
    expect(view.editor.cm.dispatch).not.toHaveBeenCalled();
  });

  it('does nothing when the note only mentions the drawing in a code fence', async () => {
    const embed = embedFor('D.blackboard');
    const view = makeView('```\n![[D.blackboard|1x1]]\n```\n', [embed]);
    await persistEmbedSize(makeApp(view), embed, 'D.blackboard', 640, 480);
    expect(view.editor.cm.dispatch).not.toHaveBeenCalled();
  });

  it('does nothing when the size is already what the alias says', async () => {
    const embed = embedFor('D.blackboard');
    const view = makeView('![[D.blackboard|640x480]]', [embed]);
    await persistEmbedSize(makeApp(view), embed, 'D.blackboard', 640, 480);
    expect(view.editor.cm.dispatch).not.toHaveBeenCalled();
  });

  it('resolves links through the metadata cache, ignoring same-named other drawings', async () => {
    const embed = embedFor('Sub/D.blackboard');
    const view = makeView('![[Other.blackboard]]\n![[Sub/D.blackboard]]\n', [embed]);
    const app = makeApp(view);
    await persistEmbedSize(app, embed, 'Sub/D.blackboard', 640, 480);
    expect(view.editor.cm.dispatch.mock.calls[0][0].changes.insert).toBe('![[Sub/D.blackboard|640x480]]');
  });

  it('refuses disk-only edits without an undo-capable editor', async () => {
    const embed = embedFor('D.blackboard');
    const view = makeView('![[D.blackboard|1x1]]\n', [embed], false);
    const app = makeApp(view);
    await persistEmbedSize(app, embed, 'D.blackboard', 640, 480);
    expect(app.vault.process).not.toHaveBeenCalled();
  });

  it('does nothing when no Markdown view hosts the embed', async () => {
    const embed = embedFor('D.blackboard');
    const app = makeApp(null);
    await persistEmbedSize(app, embed, 'D.blackboard', 640, 480);
    expect(app.vault.process).not.toHaveBeenCalled();
  });

  it('finds the host view among the leaves when it is not the active one', async () => {
    const embed = embedFor('D.blackboard');
    const view = makeView('![[D.blackboard]]', [embed]);
    const app = makeApp(view);
    app.workspace.getActiveViewOfType = vi.fn(() => null);
    await persistEmbedSize(app, embed, 'D.blackboard', 640, 480);
    expect(view.editor.cm.dispatch).toHaveBeenCalled();
  });
});
