import type { DrawingEngine } from '../infrastructure/canvas-renderer';
import type { TextDocument } from '../application/text-document';
import type { TextItem, TextItemBox } from '../domain/text-item';
import {
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_SIZE,
  estimateTextItemBox,
  textBoxHitByCircle,
  textItemAt,
} from '../domain/text-item';
import type { TextItemsHost } from '../domain/text-commands';
import {
  createTextCommand,
  deleteTextCommand,
  deleteTextItemsCommand,
  editTextCommand,
  moveTextCommand,
} from '../domain/text-commands';
import { dragDelta, exceedsDragThreshold } from '../domain/text-drag';

interface ActiveEditor {
  item: TextItem;
  el: HTMLTextAreaElement;
  /** True when the item was created by this edit and has never been committed. */
  isNew: boolean;
  originalText: string;
}

/**
 * State of one eraser gesture over this layer. Every label's box is measured ONCE, at
 * pointerdown, into flat parallel arrays: a pointermove then walks numbers only, forcing no
 * layout and allocating nothing, which is the same contract the stroke eraser's cached AABB
 * pre-test keeps. `items[i] = null` marks an already-erased slot instead of splicing.
 */
interface EraseGesture {
  items: Array<TextItem | null>;
  widths: number[];
  heights: number[];
  removed: Array<{ item: TextItem; index: number }>;
}

interface ActiveDrag {
  id: string;
  pointerId: number;
  /** The captured element, so the capture is released on exactly the node that holds it. */
  node: HTMLElement;
  /** Press position in DRAWING space, and in screen space for the movement threshold. */
  fromDrawing: { x: number; y: number };
  fromScreen: { x: number; y: number };
  origin: { x: number; y: number };
  /** The surface rect measured ONCE at drag start; a pointermove forces no layout. */
  rect: DOMRect;
  moved: boolean;
  /** Latest drawing-space translation, applied to the model only on release. */
  delta: { dx: number; dy: number };
}

/**
 * The CSS text overlay of one drawing surface: a `.blackboard-text-layer` positioned over the
 * canvases, holding one absolutely-positioned `.blackboard-text-item` per label.
 *
 * Labels are DOM, not canvas, so they stay selectable/editable and crisp at any zoom. They
 * are kept in drawing space and re-projected whenever the engine's view transform or display
 * size changes — the engine announces that through `onViewChange`, which is why this needs no
 * wrapper around the engine's methods.
 *
 * Every mutation (create, edit, move, delete, erase) goes onto the engine's ONE undo stack via
 * `domain/text-commands`, so Ctrl+Z walks strokes and labels back in the order they happened,
 * and every mutation is written through the shared document's ONE debounced save.
 */
export class TextLayer {
  readonly layerEl: HTMLElement;
  private items: TextItem[] = [];
  private nodes = new Map<string, HTMLElement>();
  private editor: ActiveEditor | null = null;
  private editingId: string | null = null;
  /**
   * Selected labels. One entry is the text tool's own selection (click a label); several is a
   * marquee selection from the select tool. One mechanism, one `.is-selected` class.
   */
  private selectedIds = new Set<string>();
  /** Live drag preview offsets for a group move; the model moves only on release. */
  private preview: { ids: ReadonlySet<string>; dx: number; dy: number } | null = null;
  private drag: ActiveDrag | null = null;
  private textMode = false;
  private destroyed = false;
  private syncHandle = 0;
  private erase: EraseGesture | null = null;
  private unsubscribeView: () => void;
  // Owns every DOM listener this layer registers, so teardown is one abort() that
  // cannot miss one — the same contract the surfaces use for their mounts.
  private abort = new AbortController();

  /** The undo stack's view of this layer: the whole item list, in and out. */
  private readonly host: TextItemsHost = {
    getItems: () => this.items,
    setItems: (items) => {
      this.items = items;
      this.pruneSelection();
      this.render();
      this.persist();
    },
  };

  constructor(
    private engine: DrawingEngine,
    readonly container: HTMLElement,
    /**
     * The drawing's text layer. Resolved lazily and nullable: a standalone view only joins
     * the shared document once Obsidian has handed it the file, and a surface mounted
     * without a store has no document at all (labels then live in memory for the session).
     */
    private document: () => TextDocument | null,
    /** Fired after a label edit lands on the undo stack, so derived UI (the toolbar's
     * undo/redo enablement) refreshes the instant a label changes — the same guarantee
     * strokes get from `notifyStrokeEnd`. */
    private onEdit?: () => void,
  ) {
    // Built through the container (not the global document) so every element belongs to the
    // surface's own document — the text layer has to work in a pop-out window too.
    this.layerEl = container.createDiv({ cls: 'blackboard-text-layer' });
    this.unsubscribeView = engine.onViewChange(() => this.scheduleSync());
    // A drag is captured on the label node, so its moves bubble here. Registering on the
    // layer (not the document) keeps the listeners scoped to this surface's own window.
    const signal = this.abort.signal;
    this.layerEl.addEventListener('pointermove', this.onDragMove, { signal });
    this.layerEl.addEventListener('pointerup', this.onDragUp, { signal });
    this.layerEl.addEventListener('pointercancel', this.onDragCancel, { signal });
    this.layerEl.addEventListener('lostpointercapture', this.onDragCancel, { signal });
  }

  private get doc(): Document {
    return this.container.ownerDocument;
  }

  private get win(): Window {
    return this.doc.defaultView ?? window;
  }

  /**
   * Adopt the canonical labels of the shared document and paint them. Called on mount, when
   * the surface joins the document, and whenever a sibling surface (or an external edit)
   * changes it — the text counterpart of reloading canonical strokes.
   */
  sync(): void {
    if (this.destroyed) return;
    const doc = this.document();
    if (!doc) return;
    // Never clobber text the user is actively editing, or a label being dragged.
    if (this.editor || this.drag) return;
    this.items = doc.getItems();
    this.editingId = null;
    this.pruneSelection();
    this.render();
  }

  /** Drop selected ids that no longer exist (an undo, a sibling edit, an erase). */
  private pruneSelection(): void {
    if (this.selectedIds.size === 0) return;
    for (const id of Array.from(this.selectedIds)) {
      if (!this.items.some((i) => i.id === id)) this.selectedIds.delete(id);
    }
  }

  /** The live labels. Read-only to callers: mutations go through the commands. */
  getItems(): TextItem[] {
    return this.items;
  }

  /** The undo stack's view of this layer, so group commands can write labels the same way. */
  get commandHost(): TextItemsHost {
    return this.host;
  }

  /**
   * A label's box in DRAWING units: measured from its node where one has been laid out, and
   * estimated from the font size otherwise. The one measurement rule, shared by the hit test,
   * the eraser and the marquee selection.
   */
  measureBox(item: TextItem): TextItemBox {
    const node = this.nodes.get(item.id);
    const scale = this.engine.getViewTransform().scale || 1;
    if (!node || !node.offsetWidth || !node.offsetHeight) return estimateTextItemBox(item);
    return { width: node.offsetWidth / scale, height: node.offsetHeight / scale };
  }

  get hasLabels(): boolean {
    return this.items.length > 0;
  }

  isTextMode(): boolean {
    return this.textMode;
  }

  setTextMode(on: boolean): void {
    this.textMode = on;
    this.layerEl.classList.toggle('is-text-mode', on);
    if (!on) {
      this.commitEditor();
      // Leaving the text tool drops the selection: a Delete pressed while drawing must
      // never remove a label the user last touched minutes ago.
      this.select(null);
    }
  }

  /** The label element a DOM node belongs to, if any. */
  itemForElement(el: Element | null): TextItem | null {
    const host = el?.closest<HTMLElement>('.blackboard-text-item');
    const id = host?.dataset.textId;
    if (!id) return null;
    return this.items.find((i) => i.id === id) ?? null;
  }

  /**
   * The topmost label under a viewport point, by geometry rather than by hit-testing the DOM.
   * Used to decide whether a press starts a label drag or creates a new label, so a press in
   * a label's leading/trailing whitespace — which is inside its box but may not be its event
   * target — grabs the label instead of stacking a second one on top of it.
   */
  itemAt(clientX: number, clientY: number, rect?: DOMRect): TextItem | null {
    const [x, y] = this.engine.screenToDrawing(clientX, clientY, this.container, rect);
    return textItemAt(this.items, x, y, (item) => this.measureBox(item));
  }

  /** Create a new (empty) label at a viewport position and open its editor. */
  createAt(clientX: number, clientY: number): void {
    if (this.destroyed || this.editor || !this.layerEl.isConnected) return;
    const [x, y] = this.engine.screenToDrawing(clientX, clientY, this.container);
    const tools = this.engine.toolManager;
    const item: TextItem = {
      id: crypto.randomUUID(),
      x,
      y,
      text: '',
      // The text tool's own font size and colour seed a NEW label; existing labels keep
      // whatever they were stored with.
      fontSize: tools.textFontSize || DEFAULT_TEXT_FONT_SIZE,
      color: tools.textColor || DEFAULT_TEXT_COLOR,
    };
    this.openEditor(item, true);
  }

  edit(item: TextItem): void {
    this.openEditor(item, false);
  }

  /** The selected label when exactly one is selected — the one Delete/Backspace acts on. */
  get selectedItem(): TextItem | null {
    if (this.selectedIds.size !== 1) return null;
    const [id] = this.selectedIds;
    return this.items.find((i) => i.id === id) ?? null;
  }

  /** Select a label (or clear the selection with null). Visible as `.is-selected`. */
  select(id: string | null): void {
    this.selectIds(id === null ? [] : [id]);
  }

  /** Select several labels at once — the marquee selection's entry point. */
  selectIds(ids: readonly string[]): void {
    if (ids.length === this.selectedIds.size && ids.every((id) => this.selectedIds.has(id))) return;
    this.selectedIds = new Set(ids);
    this.render();
  }

  /** The ids currently selected. */
  get selectedItemIds(): string[] {
    return Array.from(this.selectedIds);
  }

  /**
   * Show a group move in progress by offsetting the selected labels' nodes only. The model —
   * and therefore the document and the undo stack — moves once, on release, exactly as a
   * single-label drag already does.
   */
  previewTranslate(ids: readonly string[], dx: number, dy: number): void {
    this.preview = ids.length === 0 ? null : { ids: new Set(ids), dx, dy };
    this.render();
  }

  /** Drop a move preview and repaint from the model. */
  clearPreview(): void {
    if (!this.preview) return;
    this.preview = null;
    this.render();
  }

  /**
   * Remove the selected label as one undo step. Refused while the editor is open — there
   * Backspace means "delete a character" and belongs to the textarea.
   */
  deleteSelected(): boolean {
    if (this.destroyed || this.editor) return false;
    const item = this.selectedItem;
    if (!item) return false;
    const index = this.items.findIndex((i) => i.id === item.id);
    this.selectedIds.clear();
    this.apply(deleteTextCommand(this.host, item, index));
    return true;
  }

  /**
   * Begin a press on a label: select it, capture the pointer, and arm a possible move. The
   * gesture only becomes a move once it passes the threshold; a press that never moves opens
   * the editor on release.
   */
  beginDrag(item: TextItem, event: PointerEvent): void {
    if (this.destroyed || this.editor) return;
    this.select(item.id);
    const node = this.nodes.get(item.id);
    if (!node) return;
    // One measurement for the whole gesture: every move is arithmetic on this rect.
    const rect = this.container.getBoundingClientRect();
    const [x, y] = this.engine.screenToDrawing(event.clientX, event.clientY, this.container, rect);
    try { node.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
    this.drag = {
      id: item.id,
      pointerId: event.pointerId,
      node,
      fromDrawing: { x, y },
      fromScreen: { x: event.clientX, y: event.clientY },
      origin: { x: item.x, y: item.y },
      rect,
      moved: false,
      delta: { dx: 0, dy: 0 },
    };
  }

  /** Whether a label is currently being dragged (the controller suppresses the editor then). */
  isDragging(): boolean {
    return this.drag !== null && this.drag.moved;
  }

  /**
   * Commit the open editor. An empty brand-new label is dropped rather than persisted, so a
   * mis-tap in text mode leaves nothing behind. A real change becomes one undo step.
   */
  commitEditor(): void {
    const editor = this.editor;
    if (!editor) return;
    this.editor = null;
    this.editingId = null;
    const value = editor.el.value;
    editor.el.remove();

    if (editor.isNew) {
      // A new label lives only in the editor until it commits, so an abandoned one needs
      // no cleanup — there is nothing in `items` to remove.
      if (value.trim() === '') { this.render(); return; }
      this.selectedIds = new Set([editor.item.id]);
      this.apply(createTextCommand(this.host, { ...editor.item, text: value }, this.items.length));
      return;
    }
    if (editor.originalText !== value) {
      this.apply(editTextCommand(this.host, editor.item.id, editor.originalText, value));
      return;
    }
    this.render();
  }

  /** Escape: drop a never-committed new label; an existing one was never mutated. */
  cancelEditor(): void {
    const editor = this.editor;
    if (!editor) return;
    this.editor = null;
    this.editingId = null;
    editor.el.remove();
    this.render();
  }

  hasOpenEditor(): boolean {
    return this.editor !== null;
  }

  destroy(): void {
    if (this.destroyed) return;
    // Commit first: unmounting mid-edit must not silently discard what was typed.
    this.commitEditor();
    this.destroyed = true;
    this.erase = null;
    this.endDrag();
    this.abort.abort();
    this.unsubscribeView();
    if (this.syncHandle !== 0) {
      this.win.cancelAnimationFrame(this.syncHandle);
      this.syncHandle = 0;
    }
    this.nodes.clear();
    this.layerEl.remove();
  }

  /** Run a text command and record it on the engine's single undo timeline. */
  private apply(command: { execute(): void; undo(): void }): void {
    command.execute();
    this.engine.strokeManager.push(command);
    this.onEdit?.();
  }

  /**
   * Begin an eraser gesture: measure every label once. A label that has been laid out is
   * measured from its node (screen px back into drawing units); one that has not — a fresh
   * mount, a headless caller — falls back to the font-size estimate. Nothing is measured
   * again until the gesture ends.
   */
  beginErase(): void {
    if (this.destroyed) return;
    const items: Array<TextItem | null> = [];
    const widths: number[] = [];
    const heights: number[] = [];
    for (const item of this.items) {
      const measured = this.measureBox(item);
      items.push(item);
      widths.push(measured.width);
      heights.push(measured.height);
    }
    this.erase = { items, widths, heights, removed: [] };
  }

  /**
   * Erase every label the eraser disc covers at this sample. Returns whether anything went.
   * The loop is deliberately index-based over the pre-measured arrays: no closures, no boxes,
   * no layout reads — a miss (the overwhelmingly common case) allocates nothing at all.
   */
  eraseAt(worldX: number, worldY: number, radius: number): boolean {
    const gesture = this.erase;
    if (!gesture || this.destroyed) return false;
    let hit = false;
    for (let i = 0; i < gesture.items.length; i++) {
      const item = gesture.items[i];
      if (item === null) continue;
      if (!textBoxHitByCircle(item.x, item.y, gesture.widths[i], gesture.heights[i], worldX, worldY, radius)) {
        continue;
      }
      gesture.items[i] = null;
      const index = this.items.findIndex((it) => it.id === item.id);
      if (index === -1) continue;
      gesture.removed.push({ item, index });
      hit = true;
    }
    if (!hit) return false;
    // The removal is applied now (so the label disappears under the eraser) and recorded as
    // one command at the end of the gesture.
    const erasedIds = new Set(gesture.removed.map((r) => r.item.id));
    this.host.setItems(this.items.filter((i) => !erasedIds.has(i.id)));
    return true;
  }

  /**
   * End an eraser gesture, recording everything it removed as a SINGLE undo step — matching
   * how a stroke erase persists once for the whole gesture rather than once per sample.
   */
  endErase(): boolean {
    const gesture = this.erase;
    this.erase = null;
    if (!gesture || gesture.removed.length === 0) return false;
    for (const removed of gesture.removed) this.selectedIds.delete(removed.item.id);
    // Already applied by eraseAt: recorded, not re-executed (the `StrokeManager.push` contract).
    this.engine.strokeManager.push(deleteTextItemsCommand(this.host, gesture.removed));
    this.onEdit?.();
    return true;
  }

  /** Whether an eraser gesture is currently open on this layer. */
  isErasing(): boolean {
    return this.erase !== null;
  }

  private persist(): void {
    this.document()?.setItems(this.items);
  }

  private readonly onDragMove = (event: Event): void => {
    const drag = this.drag;
    const e = event as PointerEvent;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const screen = dragDelta(drag.fromScreen, { x: e.clientX, y: e.clientY });
    if (!drag.moved && !exceedsDragThreshold(screen.dx, screen.dy)) return;
    drag.moved = true;
    e.preventDefault();
    const [x, y] = this.engine.screenToDrawing(e.clientX, e.clientY, this.container, drag.rect);
    drag.delta = dragDelta(drag.fromDrawing, { x, y });
    // Preview on the node only: the model (and therefore the sidecar and the undo stack)
    // moves once, on release.
    const node = this.nodes.get(drag.id);
    const item = this.items.find((i) => i.id === drag.id);
    if (node && item) {
      this.position(node, { ...item, x: drag.origin.x + drag.delta.dx, y: drag.origin.y + drag.delta.dy }, false);
    }
  };

  private readonly onDragUp = (event: Event): void => {
    const drag = this.drag;
    const e = event as PointerEvent;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    const { dx, dy } = drag.delta;
    const id = drag.id;
    this.endDrag();
    if (moved) {
      if (dx !== 0 || dy !== 0) this.apply(moveTextCommand(this.host, id, dx, dy));
      else this.render();
      return;
    }
    // A press that never moved is a click: edit the label.
    const item = this.items.find((i) => i.id === id);
    if (item) this.edit(item);
  };

  private readonly onDragCancel = (event: Event): void => {
    const drag = this.drag;
    const e = event as PointerEvent;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.endDrag();
    // An interrupted drag commits nothing; repaint the label back at its model position.
    this.render();
  };

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    try {
      if (drag.node.hasPointerCapture(drag.pointerId)) drag.node.releasePointerCapture(drag.pointerId);
    } catch { /* capture may already be gone */ }
  }

  private openEditor(item: TextItem, isNew: boolean): void {
    this.commitEditor();
    if (this.destroyed) return;
    this.editingId = item.id;
    this.selectedIds = new Set([item.id]);
    this.render();

    const el = this.layerEl.createEl('textarea', { cls: 'blackboard-text-editor' });
    el.value = item.text;
    el.style.color = item.color;
    this.position(el, item, true);

    el.addEventListener('blur', () => this.commitEditor());
    el.addEventListener('keydown', (e) => {
      // The editor owns the keyboard while open: neither the tool shortcuts nor Obsidian's
      // own bindings may see these keystrokes.
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelEditor();
      }
    });

    this.editor = { item, el, isNew, originalText: item.text };
    // Focus on the next tick: focusing an element that was appended in this same task can be
    // undone by the pointerdown that is still being dispatched.
    this.win.setTimeout(() => {
      try {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        // A detached editor (surface torn down in between) simply never focuses.
      }
    }, 0);
  }

  /** Coalesce re-projection to one per animation frame; the engine can fire several a frame. */
  private scheduleSync(): void {
    if (this.destroyed || this.syncHandle !== 0) return;
    this.syncHandle = this.win.requestAnimationFrame(() => {
      this.syncHandle = 0;
      if (this.destroyed || !this.layerEl.isConnected) return;
      this.render();
      if (this.editor) this.position(this.editor.el, this.editor.item, true);
    });
  }

  private render(): void {
    if (this.destroyed) return;
    const seen = new Set<string>();
    for (const item of this.items) {
      // The item being edited is represented by the textarea, not by a label.
      if (item.id === this.editingId) continue;
      seen.add(item.id);
      let node = this.nodes.get(item.id);
      if (!node || !node.isConnected) {
        node = this.layerEl.createDiv({ cls: 'blackboard-text-item' });
        node.dataset.textId = item.id;
        this.nodes.set(item.id, node);
      }
      // Assign only on change: re-setting textContent every frame would blow away any
      // selection the user has inside a label and force a needless relayout.
      if (node.textContent !== item.text) node.textContent = item.text;
      if (node.style.color !== item.color) node.style.color = item.color;
      node.classList.toggle('is-selected', this.selectedIds.has(item.id));
      const offset = this.preview && this.preview.ids.has(item.id) ? this.preview : null;
      this.position(node, offset ? { ...item, x: item.x + offset.dx, y: item.y + offset.dy } : item, false);
    }
    for (const [id, node] of Array.from(this.nodes)) {
      if (seen.has(id)) continue;
      node.remove();
      this.nodes.delete(id);
    }
  }

  /** Project a drawing-space label onto the surface through the engine's view transform. */
  private position(el: HTMLElement, item: TextItem, editing: boolean): void {
    const view = this.engine.getViewTransform();
    el.style.left = `${item.x * view.scale + view.offsetX}px`;
    el.style.top = `${item.y * view.scale + view.offsetY}px`;
    el.style.fontSize = `${item.fontSize * view.scale}px`;
    if (editing) {
      el.style.width = `${Math.max(140, 260 * view.scale)}px`;
      el.style.minHeight = `${Math.max(36, 48 * view.scale)}px`;
    }
  }
}
