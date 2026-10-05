import { Annotation, EditorState, StateField, type ChangeSet } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { attachEmbedDrag } from '../../src/presentation/embed-drag';
import { findEmbedLinks } from '../../src/presentation/embed-size';
import { moveTargetAt } from '../../src/presentation/embed-move';

declare global { interface Window { harness: ReturnType<typeof createHarness>; } }
let view: EditorView;
let notices: string[] = [];
let writes = 0;
let strokes = 0;
let debug = true;
const isUndo = Annotation.define<boolean>();
// Offline CM state history: store actual inverse ChangeSets, never saved Markdown
// snapshots. The host's isolateHistory annotation is verified in embed-controls.test.
const history = StateField.define<ChangeSet[]>({
  create: () => [],
  update: (stack, tr) => tr.annotation(isUndo) ? stack.slice(0, -1) : tr.docChanged ? [...stack, tr.changes.invert(tr.startState.doc)] : stack,
});

class Board extends WidgetType {
  private stop?: () => void;
  constructor(readonly occurrence: number, readonly token: string) { super(); }
  eq(other: Board) { return other.occurrence === this.occurrence && other.token === this.token; }
  toDOM() {
    const board = document.createElement('span');
    board.className = 'blackboard-embed mock-board';
    const controls = board.appendChild(document.createElement('span'));
    controls.className = 'bb-frame-controls';
    const grip = controls.appendChild(document.createElement('button'));
    grip.className = 'bb-move-grip'; grip.textContent = '⠿'; grip.type = 'button'; grip.setAttribute('aria-label', 'Drag to move board');
    const surface = board.appendChild(document.createElement('span'));
    surface.className = 'blackboard-drawing-container'; surface.textContent = this.token;
    this.stop = attachEmbedDrag(board, grip, {
      debug: () => debug,
      notice: message => notices.push(message),
      bind: () => ({
        occurrence: this.occurrence,
        editor: {
          getValue: () => view.state.doc.toString(),
          posAtCoords: point => view.posAtCoords(point, false),
          lineBlockAt: pos => { const b = view.lineBlockAt(pos); return { from: b.from, to: b.to, top: b.top + view.documentTop, bottom: b.bottom + view.documentTop }; },
          coordsAtPos: (pos, side) => view.coordsAtPos(pos, side),
          scrollDOM: view.scrollDOM,
          dispatch: (original, edit) => {
            if (view.state.doc.toString() !== original) return false;
            writes++;
            view.dispatch({ changes: { from: edit.start, to: edit.end, insert: edit.text }, selection: { anchor: edit.boardStart } });
            return true;
          },
        },
      }),
    });
    return board;
  }
  ignoreEvent() { return true; }
  destroy() {
    // Production embed teardown is driven by a MutationObserver after DOM removal.
    // CM WidgetType.destroy runs before removal, so mirror that timing here.
    queueMicrotask(() => this.stop?.());
  }
}
const boards = StateField.define<DecorationSet>({
  create: state => decorations(state),
  update: (value, tr) => tr.docChanged ? decorations(tr.state) : value,
  provide: field => EditorView.decorations.from(field),
});
function decorations(state: EditorState) {
  const source = state.doc.toString();
  return Decoration.set(findEmbedLinks(source).map((link, occurrence) => Decoration.replace({ widget: new Board(occurrence, source.slice(link.start, link.end)) }).range(link.start, link.end)));
}
function createHarness() {
  return {
    mount(source: string) {
      view?.destroy(); document.querySelectorAll('.bb-drop-indicator,.bb-drag-ghost').forEach(el => el.remove());
      document.body.classList.remove('bb-dragging'); notices = []; writes = 0; strokes = 0;
      view = new EditorView({ state: EditorState.create({ doc: source, extensions: [history, boards, EditorView.lineWrapping] }), parent: document.getElementById('editor')! });
      view.scrollDOM.addEventListener('pointerdown', e => { if ((e.target as HTMLElement).closest('.blackboard-drawing-container')) strokes++; });
    },
    source: () => view.state.doc.toString(),
    writes: () => writes,
    strokes: () => strokes,
    notices: () => notices,
    debug: (on: boolean) => { debug = on; },
    undo() {
      const stack = view.state.field(history);
      if (!stack.length) return false;
      view.dispatch({ changes: stack[stack.length - 1], annotations: isUndo.of(true) });
      return true;
    },
    point(line: number, after: boolean, end = false) {
      const l = view.state.doc.line(line);
      const c = view.coordsAtPos(end ? l.to : l.from, after ? -1 : 1);
      if (!c) throw new Error('Line is not in the viewport: ' + line);
      const pane = view.scrollDOM.getBoundingClientRect();
      // Away from widgets and edges; quarter/three-quarter of the actual visual row.
      return { x: Math.min(pane.right - 30, c.left + 15), y: c.top + (c.bottom - c.top) * (after ? 0.75 : 0.25) };
    },
    scroll(line: number) {
      const anchor = view.state.doc.line(line).from;
      // CM also retains the current selection's line in the rendered DOM. Move only
      // that selection to exercise actual source-widget virtualisation, without edits.
      view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
    },
    scrollTop: () => view.scrollDOM.scrollTop,
    legacyTarget(line: number, after: boolean) {
      const l = view.state.doc.line(line), c = view.coordsAtPos(l.from)!;
      const pos = view.posAtCoords({ x: c.left + 20, y: c.top + (c.bottom - c.top) * (after ? 0.75 : 0.25) }, false)!;
      return { position: pos, target: moveTargetAt(view.state.doc.toString(), pos, after), hasCoords: !!c, documentTop: view.documentTop };
    },
    mutate(text: string) { view.dispatch({ changes: { from: view.state.doc.length, insert: text } }); },
    destroy() { view.destroy(); },
  };
}
window.harness = createHarness();
