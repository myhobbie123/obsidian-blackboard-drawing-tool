import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
// Generated from the exact previous release commit by check-drag-fixture.mjs.
import { attachBoardControls } from '../../release/drag-fixture/legacy-controls';
import { MarkdownView } from './legacy-host';
import { findEmbedLinks } from '../../src/presentation/embed-size';
import { moveTargetAt } from '../../src/presentation/embed-move';

let view: EditorView;
let captureLostBeforeRelease = false;
let released = false;
const cleanups: Array<() => void> = [];
const doc = document;
// The old production control uses Obsidian DOM helpers. Do not mock any CM method,
// capture method, event, bounds, RAF or target planner.
(HTMLElement.prototype as any).createDiv = function (options?: { cls?: string }) {
  const el = doc.createElement('div'); el.className = options?.cls ?? ''; this.appendChild(el); return el;
};
(HTMLElement.prototype as any).createEl = function (tag: string) { const el = doc.createElement(tag); this.appendChild(el); return el; };
(HTMLElement.prototype as any).setCssStyles = function (styles: Record<string, string>) { Object.assign(this.style, styles); };

class LegacyBoard extends WidgetType {
  constructor(readonly start: number) { super(); }
  toDOM() {
    const el = doc.createElement('span'); el.className = 'internal-embed blackboard-embed mock-board'; el.setAttribute('src', 'x.blackboard');
    const host = new MarkdownView() as any;
    host.file = { path: 'Fixture.md' }; host.getMode = () => 'source'; host.contentEl = doc.getElementById('editor');
    host.editor = { cm: view, getValue: () => view.state.doc.toString(), posToOffset: () => this.start, getCursor: () => ({ line: 0, ch: this.start }) };
    const app: any = {
      workspace: { getActiveViewOfType: () => host, iterateAllLeaves: () => {} },
      metadataCache: { getFirstLinkpathDest: (path: string) => ({ path }) },
    };
    // EditorView is not yet assigned while constructing widgets. Mount controls
    // after the first paint, when the native view and DOM positions exist.
    requestAnimationFrame(() => {
      host.editor.cm = view;
      const abort = new AbortController();
      const stop = attachBoardControls(app, el, 'x.blackboard', abort.signal, () => {});
      cleanups.push(() => { abort.abort(); stop(); });
      el.querySelector('.bb-move-grip')!.addEventListener('lostpointercapture', () => { if (!released) captureLostBeforeRelease = true; });
    });
    return el;
  }
  ignoreEvent() { return true; }
}
(window as any).legacy = {
  mount(source: string) {
    for (const stop of cleanups.splice(0)) stop();
    view?.destroy(); released = false; captureLostBeforeRelease = false;
    const link = findEmbedLinks(source)[0];
    const decoration = Decoration.replace({ widget: new LegacyBoard(link.start) }).range(link.start, link.end);
    view = new EditorView({ state: EditorState.create({ doc: source, extensions: [EditorView.lineWrapping, EditorView.decorations.of(Decoration.set([decoration]))] }), parent: doc.getElementById('editor')! });
    doc.addEventListener('pointerup', () => { released = true; }, { once: true, capture: true });
  },
  point(line: number) { const c = view.coordsAtPos(view.state.doc.line(line).from)!; return { x: c.left + 20, y: c.top + (c.bottom - c.top) * 0.75 }; },
  evidence() {
    const line = view.state.doc.line(2); const c = view.coordsAtPos(line.from)!;
    const pos = view.posAtCoords({ x: c.left + 20, y: c.top + (c.bottom - c.top) * 0.75 }, false)!;
    const grip = doc.querySelector('.bb-move-grip') as HTMLElement;
    return { target: moveTargetAt(view.state.doc.toString(), pos, true), indicatorHidden: (doc.querySelector('.bb-drop-indicator') as HTMLElement).hidden, captureLostBeforeRelease, hasCoords: !!c, documentTop: view.documentTop, captured: grip.hasPointerCapture(1) };
  },
  source: () => view.state.doc.toString(),
};
