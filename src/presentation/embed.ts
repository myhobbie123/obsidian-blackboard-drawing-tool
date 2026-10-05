import { Notice, type App } from 'obsidian';
import type { IDrawingRepository } from '../domain/ports';
import type { BlackboardFile, PluginSettings } from '../domain/entities';
import { DrawingEngine } from '../infrastructure/canvas-renderer';
import type { ToolManager } from '../domain/tool-manager';
import { effectiveEraserSize, eraseAtPoint } from '../application/eraser-service';
import { isShapeTool } from '../domain/shapes';
import { applyShapeRecognition, isRecognizableTool } from '../application/shape-recognition-service';
import { SelectionController } from './selection-controller';
import { inputDebugEnabled, inputDebugLog } from '../dev/input-debug';

// Replaced by esbuild `define` (true in dev builds, false in production, where the
// branch and the src/dev module behind it are eliminated from the bundle).
declare const __DEV_BUILD__: boolean;
import type { SurfaceManager } from './surface-manager';
import type { DocumentStore, SharedDocumentHandle } from '../application/document-store';
import { engineSurface } from './drawing-surface';
import { handleTextDocument, memoryTextDocument } from '../application/text-document';
import { stampFormatVersion, withTextItems, FORMAT_VERSION } from '../application/file-format';
import type { TextController } from './text-controller';
import { planEmbedSizeEdit, findEmbedLinks, parseEmbedAlias } from './embed-size';
import { hostMarkdownView, editableNote, resolveEmbedLink, commitNoteEdit } from './embed-note';
import { attachBoardControls } from './embed-controls';
import { RESIZE_DIRECTIONS, resizeFromDrag, type ResizeDirection, type ResizeStart } from './embed-resize';

function dbgTarget(t: EventTarget | null): string {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return '?';
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
  return el.tagName.toLowerCase() + cls;
}

function isDrawingInput(e: PointerEvent): boolean {
  return e.pointerType === 'pen' || e.pointerType === 'mouse';
}

/**
 * Obsidian's mobile bottom editing toolbar appears whenever the Markdown editor (CodeMirror)
 * holds focus. In Live Preview the embed is rendered INSIDE that editor, so a pen-down can
 * leave the editor focused — which raises the bottom toolbar and lets iPadOS Scribble take
 * over the Pencil (drawing then turns into handwriting-to-text). Blurring the focused editor
 * at stroke start keeps that toolbar down, so Scribble never engages. Only blur a genuinely
 * editable/CodeMirror element; never steal focus from anything else.
 */
function suppressEditorFocus(doc: Document): void {
  const active = doc.activeElement as HTMLElement | null;
  if (!active || typeof active.blur !== 'function') return;
  const isEditor = active.isContentEditable || active.closest('.cm-editor') !== null;
  if (isEditor) active.blur();
}

/** Persist only through an editable CM6 buffer: isolated history, no disk writes. */
export async function persistEmbedSize(
  app: App, embedEl: HTMLElement, filePath: string, width: number, height: number,
): Promise<void> {
  const view = hostMarkdownView(app, embedEl);
  if (!editableNote(view)) {
    new Notice('Blackboard: resize requires an editable note. No changes made.');
    return;
  }
  const source = view.editor.getValue();
  const link = resolveEmbedLink(app, view, embedEl, filePath, source);
  if (!link || parseEmbedAlias(link.alias).ambiguous) {
    new Notice('Blackboard: this embed cannot be identified safely. No changes made.');
    return;
  }
  const edit = planEmbedSizeEdit(source, path => path === link.linkpath, width, height,
    findEmbedLinks(source).filter(m => m.linkpath === link.linkpath).findIndex(m => m.start === link.start));
  if (edit) commitNoteEdit(view, source, edit);
}

interface ActiveResize extends ResizeStart {
  pointerId: number;
  direction: ResizeDirection;
  clientX: number;
  clientY: number;
  /** The inline margins to restore on release (the drag-time ones are transient). */
  inlineMarginLeft: string;
  inlineMarginTop: string;
  /** Latest size produced by the drag; what release commits. */
  currentWidth: number;
  currentHeight: number;
  moved: boolean;
}

/**
 * Eight drag handles (four edges, four corners) on a Markdown embed. Dragging resizes the
 * embed live; the release commits the final size via `commit`.
 *
 * Only the drag-start box is measured — every move is arithmetic on the captured rect
 * (`embed-resize.ts`), so a pointermove forces no layout. The pointer is captured on the
 * handle, so a drag that leaves the embed (or the window) still terminates.
 */
export function attachResizeHandles(
  embedEl: HTMLElement,
  signal: AbortSignal,
  win: Window,
  commit: (width: number, height: number) => void,
): () => void {
  const handles: HTMLElement[] = [];
  let active: ActiveResize | null = null;

  const finish = () => {
    if (!active) return;
    const drag = active;
    active = null;
    embedEl.removeClass('blackboard-resizing');
    // The negative margins were a drag-time trick to anchor the opposite edge; the
    // persisted alias carries size only, so restore the layout's own margins.
    embedEl.style.marginLeft = drag.inlineMarginLeft;
    embedEl.style.marginTop = drag.inlineMarginTop;
    if (drag.moved) commit(drag.currentWidth, drag.currentHeight);
  };

  for (const direction of RESIZE_DIRECTIONS) {
    const handle = embedEl.createDiv({ cls: `blackboard-resize-handle ${direction}` });
    handles.push(handle);
    handle.dataset.direction = direction;
    handle.setAttribute('aria-label', `Resize Blackboard ${direction.replace('-', ' ')}`);

    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return;
      // The embed swallows clicks and the drawing surface claims pointerdown at the
      // document's capture phase; a handle drag must reach neither.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const box = embedEl.getBoundingClientRect();
      const computed = win.getComputedStyle(embedEl);
      active = {
        pointerId: e.pointerId,
        direction,
        clientX: e.clientX,
        clientY: e.clientY,
        width: box.width,
        height: box.height,
        marginLeft: parseFloat(computed.marginLeft) || 0,
        marginTop: parseFloat(computed.marginTop) || 0,
        inlineMarginLeft: embedEl.style.marginLeft,
        inlineMarginTop: embedEl.style.marginTop,
        currentWidth: box.width,
        currentHeight: box.height,
        moved: false,
      };
      embedEl.addClass('blackboard-resizing');
      try { handle.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    }, { signal });

    handle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!active || e.pointerId !== active.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const next = resizeFromDrag(
        active.direction,
        { width: active.width, height: active.height, marginLeft: active.marginLeft, marginTop: active.marginTop },
        e.clientX - active.clientX,
        e.clientY - active.clientY,
      );
      // Size is applied to the host element only; the engine follows through the mount's
      // ResizeObserver, which is also what re-fits the view for any other host resize.
      embedEl.style.marginLeft = `${next.marginLeft}px`;
      embedEl.style.marginTop = `${next.marginTop}px`;
      embedEl.style.width = `${next.width}px`;
      embedEl.style.height = `${next.height}px`;
      active.moved = true;
      active.currentWidth = next.width;
      active.currentHeight = next.height;
    }, { signal });

    const release = (e: PointerEvent) => {
      if (!active || e.pointerId !== active.pointerId) return;
      try {
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      } catch { /* capture may already be gone */ }
      finish();
    };
    handle.addEventListener('pointerup', (e: PointerEvent) => {
      if (!active || e.pointerId !== active.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      release(e);
    }, { signal });
    handle.addEventListener('pointercancel', release, { signal });
    handle.addEventListener('lostpointercapture', release, { signal });
  }

  return () => {
    active = null;
    for (const handle of handles) handle.remove();
    handles.length = 0;
  };
}

/**
 * Cleanups of every live embed mount. Plugin reloads (store update, sync restart,
 * dev hot-swap, manual toggle) MUST unmount all embeds via unmountAllEmbeds():
 * otherwise the surviving DOM keeps dataset.bbMounted='true', the next plugin
 * instance refuses to re-mount, and the user draws on an orphaned engine whose
 * surface the new toolbar has never heard of (dead/disabled toolbar until the
 * note is reopened) — plus the orphan's document-level listeners leak.
 */
const liveMounts = new Set<() => void>();

export function unmountAllEmbeds(): void {
  for (const cleanup of Array.from(liveMounts)) cleanup();
  liveMounts.clear();
}

export async function mountBlackboardEmbed(repo: IDrawingRepository, embedEl: HTMLElement, filePath: string, settings: PluginSettings, surfaceManager?: SurfaceManager, toolManager?: ToolManager, store?: DocumentStore, textController?: TextController, app?: App): Promise<() => void> {
  if (embedEl.dataset.bbMounted === 'true') return () => {};
  embedEl.dataset.bbMounted = 'true';
  // Every DOM listener this mount registers is tied to one AbortController, so teardown is a
  // single abort() that cannot forget one. The previous code removed only the document-level
  // pointer/touch handlers, leaking a click and a dblclick handler on the embed element and
  // both touch handlers on the drawing container on every remount.
  const abort = new AbortController();
  const signal = abort.signal;
  // Never assume the global document: an embed can be mounted in a pop-out window.
  const doc = embedEl.ownerDocument;
  const win = doc.defaultView ?? window;
  embedEl.empty();
  embedEl.addClass('blackboard-embed');
  // Inline (not a class): embedEl carries host classes (.internal-embed etc.) whose
  // app/theme rules these must always beat.
  embedEl.setCssStyles({ position: 'relative', display: 'flex', flexDirection: 'column' });

  // The shared document is the single source of truth for this path: the engine renders
  // from its canonical strokes and writes through it, so sibling surfaces stay in sync
  // (B2). Without a store (back-compat / isolated tests) we fall back to the repo directly.
  const handle: SharedDocumentHandle | null = store ? await store.acquire(filePath, repo) : null;
  const file = handle ? handle.getFile() : (await repo.load(filePath)).file;
  // Saved width/height describe the drawing at save time; using them as the fit reference
  // (rather than the live, growing content bounds) keeps an edit-and-remount round trip
  // scale-stable (B3).
  const refFile = () => (handle ? handle.getFile() : file);

  const drawingContainer = createDiv();
  drawingContainer.className = 'blackboard-drawing-container blackboard-embedded-drawing';
  // Inline (not a class): position:relative must override .blackboard-embedded-drawing's
  // position:absolute for the flex-child layout used here.
  drawingContainer.setCssStyles({ position: 'relative', width: '100%', flex: '1', minHeight: '150px' });
  // Board background (issue #13): paint the surface so a whiteboard/blackboard shows here too.
  drawingContainer.style.backgroundColor = settings.boardBackground;
  embedEl.appendChild(drawingContainer);

  // Display size is measured from the drawing surface element (the same one the pointer
  // mapping uses), in layout px. Measuring the outer embed element or the zoom-scaled
  // rect causes pen-tip/stroke drift when Obsidian Canvas is zoomed.
  function hostBox(): { w: number; h: number } {
    const w = drawingContainer.clientWidth || drawingContainer.offsetWidth || 400;
    const h = drawingContainer.clientHeight || drawingContainer.offsetHeight || 300;
    return { w, h };
  }

  const swallow = (e: Event) => {
    if ((e.target as HTMLElement).closest('.bb-frame-controls')) return;
    e.stopPropagation(); e.stopImmediatePropagation();
  };
  embedEl.addEventListener('click', swallow, { capture: true, signal });
  embedEl.addEventListener('dblclick', swallow, { capture: true, signal });

  // Non-listener teardown only (observers, store handle); listeners belong to `abort`.
  const teardowns: Array<() => void> = [];

  let canvasNode: HTMLElement | null = null;
  let el: HTMLElement | null = embedEl;
  while (el) {
    if (el.classList.contains('canvas-node')) { canvasNode = el; break; }
    el = el.parentElement;
  }
  if (canvasNode) {
    const hideBlocker = () => {
      const blocker = canvasNode.querySelector<HTMLElement>('.canvas-node-content-blocker');
      if (blocker) blocker.setCssStyles({ display: 'none' });
    };
    hideBlocker();
    const observer = new MutationObserver(hideBlocker);
    observer.observe(canvasNode, { childList: true, subtree: true });
    teardowns.push(() => observer.disconnect());
  }

  // Markdown embeds (no .canvas-node ancestor) are a fixed-scale fit-to-content FRAME that
  // never upscales past natural size (maxScale = 1 → letterbox/centre a small drawing crisp).
  // Canvas-node embeds keep the uncapped fill (maxScale = Infinity) and, after the one-time
  // mount fit, behave as a fixed-scale window that extends/clips on node resize.
  const maxFitScale = canvasNode ? Infinity : 1;

  const box0 = hostBox();
  // Share the plugin's single ToolManager so tool/colour/size are global across every
  // surface (fix-tool-state-isolation).
  const engine = new DrawingEngine(drawingContainer, box0.w, box0.h, toolManager);
  engine.loadStrokes(handle ? handle.getStrokes() : file.strokes);
  engine.setDisplaySize(box0.w, box0.h);
  engine.fitReferenceSize(refFile().width, refFile().height, 8, maxFitScale);
  engine.render();

  // A sibling surface committing notifies us: reload the canonical strokes and repaint the
  // static layer, KEEPING our own view transform (no re-fit/re-centre on refresh). We never
  // persist in response to a notification — only commit writes (no save feedback loop).
  // Labels live in the same document as the strokes; without a store they live in memory for
  // the life of the mount (the legacy no-store path).
  const localText = memoryTextDocument(file.text?.items ?? []);
  const textDocument = () => (handle ? handleTextDocument(handle) : localText);

  // The node's LOGICAL rect (canvas units): offsetWidth/offsetHeight and the inline-transform
  // translate. NOT getBoundingClientRect, whose pixel size changes on canvas zoom — keying off
  // logical size makes a pure zoom a non-event for the frame logic.
  function nodeLogicalRect(): { x: number; y: number; w: number; h: number } {
    const node = canvasNode!;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const tr = node.style.transform || '';
    const m = tr.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/);
    const x = m ? parseFloat(m[1]) : node.offsetLeft;
    const y = m ? parseFloat(m[2]) : node.offsetTop;
    return { x, y, w, h };
  }

  // Canvas-node embeds: record the initial logical rect so resize deltas anchor the opposite
  // (non-dragged) edge. Markdown embeds don't use this.
  let prevLogical = canvasNode ? nodeLogicalRect() : null;

  // Host resize handling. A Markdown embed re-fits (host-driven sizing, capped at 1× so it
  // never upscales). A canvas-node embed is a FIXED-SCALE FRAME: it keeps the established
  // scale and resizes the backing store (resizeBox, transform-preserving) so the drag side
  // reveals/clips drawable area while the opposite edge stays anchored — never re-fitting.
  // One forced layout per animation frame instead of two per pointermove (handlePoint's own
  // clamp read plus screenToDrawing's). Dropped on pointerdown and whenever the box resizes.
  let containerRect: DOMRect | null = null;
  const rect = (): DOMRect => {
    if (containerRect) return containerRect;
    const r = drawingContainer.getBoundingClientRect();
    containerRect = r;
    win.requestAnimationFrame(() => { containerRect = null; });
    return r;
  };

  const ro = new ResizeObserver(() => {
    containerRect = null;
    if (canvasNode && prevLogical) {
      const cur = nodeLogicalRect();
      const dw = cur.w - prevLogical.w;
      const dh = cur.h - prevLogical.h;
      // Pure canvas zoom (or any change with no logical-size delta): do nothing.
      if (dw === 0 && dh === 0) return;
      // resizeBox preserves the view transform -> right/bottom drag anchors content top-left.
      engine.resizeBox(cur.w, cur.h);
      // Left edge moved (logical x changed): nudge content right/left by Δw so the right edge
      // stays anchored. Top edge moved (logical y changed): nudge by Δh to anchor the bottom.
      if (cur.x !== prevLogical.x) engine.panBy(dw, 0);
      if (cur.y !== prevLogical.y) engine.panBy(0, dh);
      prevLogical = cur;
    } else {
      const b = hostBox();
      engine.setDisplaySize(b.w, b.h);
      engine.fitReferenceSize(refFile().width, refFile().height, 8, maxFitScale);
    }
  });
  ro.observe(drawingContainer);
  teardowns.push(() => ro.disconnect());

  async function saveDrawing(): Promise<void> {
    try {
      const b = engine.getContentBounds();
      // Text is carried through from the canonical document: the engine holds strokes only,
      // so rebuilding the file from it must never be what drops a label.
      const fileToSave: BlackboardFile = stampFormatVersion(withTextItems({
        version: FORMAT_VERSION,
        width: b.width || 800,
        height: b.height || 600,
        strokes: structuredClone(engine.strokeManager.strokes),
        background: { color: 'transparent' },
        contentBounds: (b.width > 0 && b.height > 0) ? b : undefined,
      }, textDocument().getItems()));
      // The store is the single writer: commit persists (debounced) and refreshes siblings.
      if (handle) handle.commit(fileToSave);
      else await repo.save(filePath, fileToSave);
    } catch {
      // Best-effort save; the next stroke end retries. Never break drawing over I/O.
    }
  }

  // The text overlay is a sibling of the canvases inside the same drawing container, so it
  // inherits the container's position and follows the engine's view transform.
  const text = textController?.attach(engine, drawingContainer, textDocument);
  if (text) teardowns.push(text.detach);

  // The same marquee-selection tool the standalone view mounts, over this embed's engine and
  // text layer. Its keyboard shortcuts are deliberately NOT bound here: inside a note or a
  // Canvas node, Delete belongs to the host.
  const selection = new SelectionController(
    engine,
    () => text?.layer ?? null,
    () => { void saveDrawing(); },
    () => surfaceManager?.refresh(),
  );
  teardowns.push(engine.toolManager.onChange(() => {
    if (engine.toolManager.activeTool !== 'select') selection.clear();
  }));

  // A sibling surface committing notifies us: reload the canonical strokes and labels and
  // repaint, KEEPING our own view transform (no re-fit/re-centre on refresh). We never
  // persist in response to a notification — only commit writes (no save feedback loop).
  if (handle) {
    handle.subscribe(() => {
      engine.loadStrokes(handle.getStrokes());
      engine.staticDirty = true;
      engine.requestRender();
      text?.layer.sync();
      selection.syncToContent();
    });
  }

  const surface = engineSurface(engine, () => { void saveDrawing(); }, selection);
  // Markdown embeds are user-resizable: eight handles that rewrite the `|WxH` alias in the
  // host note. Canvas nodes are resized by the canvas itself and get none.
  if (!canvasNode && app) {
    const detachHandles = attachResizeHandles(embedEl, signal, win, (w, h) => {
      void persistEmbedSize(app, embedEl, filePath, w, h);
    });
    teardowns.push(detachHandles);
    teardowns.push(attachBoardControls(app, embedEl, filePath, signal, () => surfaceManager?.setActive(surface)));
  }

  surfaceManager?.register(surface, drawingContainer);
  // Auto-show the shared toolbar when a page/node already contains a drawing, instead
  // of waiting for the first pointer interaction.
  surfaceManager?.setActive(surface);

  let strokeActive = false;

  function isInsideDrawing(e: PointerEvent): boolean {
    const target = e.target as HTMLElement;
    return drawingContainer.contains(target) && !target.closest('.blackboard-toolbar');
  }

  function eraseAt(localX: number, localY: number): void {
    const size = engine.toolManager.activeSize;
    // The same disc erases labels; the text layer writes them through the shared document.
    text?.layer.eraseAt(localX, localY, effectiveEraserSize(size));
    const erased = eraseAtPoint(
      engine.strokeManager,
      localX, localY,
      size,
    );
    if (erased) {
      engine.staticDirty = true;
      engine.requestRender();
    }
  }

  function handlePoint(e: PointerEvent): void {
    // Clamp to the surface boundary: document-level pointermove fires everywhere once a
    // stroke is active, so dragging past the node edge must not append out-of-bounds points.
    const r = rect();
    if (r.width > 0 && r.height > 0 &&
        (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) {
      return;
    }
    const [localX, localY] = engine.screenToDrawing(e.clientX, e.clientY, drawingContainer, r);
    const tool = engine.toolManager.activeTool;
    if (tool === 'eraser') { eraseAt(localX, localY); return; }
    if (tool === 'select') { selection.pointerMove(localX, localY, e.clientX, e.clientY); return; }
    if (isShapeTool(tool)) { engine.updateShape(localX, localY, e.shiftKey); return; }
    engine.addPoint([localX, localY, e.pressure || 0.5]);
  }

  /** The press point in drawing space, through the same cached rect a move uses. */
  function pressPoint(e: PointerEvent): [number, number] {
    return engine.screenToDrawing(e.clientX, e.clientY, drawingContainer, rect());
  }

  /**
   * Shape recognition (opt-in, `settings.recognizeShapes`): replace a freehand stroke the
   * recogniser is confident about with the clean shape, as a SECOND undo step, so one Ctrl+Z
   * brings the original stroke back.
   */
  function recognizeLastStroke(): void {
    if (!settings.recognizeShapes) return;
    if (!isRecognizableTool(engine.toolManager.activeTool)) return;
    const last = engine.strokeManager.strokes[engine.strokeManager.strokes.length - 1];
    if (!last) return;
    if (!applyShapeRecognition(engine.strokeManager, last)) return;
    engine.staticDirty = true;
    engine.requestRender();
  }

  const onDocPointerDown = (e: PointerEvent) => {
    const inside = isInsideDrawing(e);
    const drawInput = isDrawingInput(e);
    if (__DEV_BUILD__ && inputDebugEnabled()) {
      inputDebugLog(`DOWN ${e.pointerType} in=${inside ? 'Y' : 'N'} draw=${drawInput ? 'Y' : 'N'} tgt=${dbgTarget(e.target)}${inside && drawInput ? ' OK' : ' REJECT'}`);
    }
    if (!inside) return;
    if (!drawInput) return;
    // The text tool never draws: a press the text layer did not consume (a surface that is
    // not the active one) must leave no stroke behind. See blackboard-view for the twin.
    if (engine.toolManager.activeTool === 'text') return;

    e.stopPropagation();
    e.preventDefault();
    // Drop editor focus before anything else so Obsidian's mobile bottom toolbar (the
    // Scribble trigger) never raises for a drawing stroke.
    suppressEditorFocus(doc);
    drawingContainer.setCssStyles({ touchAction: 'none' });
    containerRect = null;
    strokeActive = true;
    // Guarantees a terminal pointerup/pointercancel even when the pointer leaves the embed
    // or the browser claims the gesture, so `strokeActive` can never latch true.
    try { drawingContainer.setPointerCapture(e.pointerId); } catch { /* best-effort */ }

    surfaceManager?.setActive(surface);
    surfaceManager?.notifyStrokeStart();

    const tool = engine.toolManager.activeTool;
    if (tool === 'select') {
      const [px, py] = pressPoint(e);
      selection.pointerDown(px, py, e.clientX, e.clientY);
    } else if (isShapeTool(tool)) {
      const [px, py] = pressPoint(e);
      engine.beginShape(tool, px, py);
    } else if (tool !== 'eraser') {
      engine.beginStroke(e.pointerType);
    } else {
      // Measure the labels once for the whole gesture (see TextLayer.beginErase).
      text?.layer.beginErase();
    }
    handlePoint(e);
  };

  const onDocPointerMove = (e: PointerEvent) => {
    if (!strokeActive) return;
    if (!isDrawingInput(e)) return;
    e.stopPropagation();
    e.preventDefault();
    // A throw mid-stroke must not skip the release bookkeeping below.
    try { handlePoint(e); } catch { /* drop this sample */ }
  };

  const releaseCapture = (pointerId: number) => {
    try {
      if (drawingContainer.hasPointerCapture(pointerId)) drawingContainer.releasePointerCapture(pointerId);
    } catch { /* capture may already be gone */ }
  };

  const onDocPointerUp = (e: PointerEvent) => {
    if (!strokeActive) return;
    if (!isDrawingInput(e)) return;
    strokeActive = false;
    e.stopPropagation();
    releaseCapture(e.pointerId);
    const tool = engine.toolManager.activeTool;
    if (tool === 'select') {
      // The controller writes through saveDrawing itself when the gesture committed anything.
      selection.pointerUp();
      surfaceManager?.notifyStrokeEnd();
      return;
    } else if (isShapeTool(tool)) {
      engine.endShape();
    } else if (tool !== 'eraser') {
      const before = engine.strokeManager.strokes.length;
      engine.endStroke();
      if (engine.strokeManager.strokes.length > before) recognizeLastStroke();
    } else {
      // Erased labels become ONE undo step for the gesture.
      text?.layer.endErase();
    }
    if (__DEV_BUILD__ && inputDebugEnabled()) inputDebugLog(`UP committed total=${engine.strokeManager.strokes.length}`);
    // Tell the toolbar a stroke just committed so it re-syncs undo/redo enablement now,
    // instead of leaving the undo arrow greyed out until the next tap (QA3).
    surfaceManager?.notifyStrokeEnd();
    // Do not re-fit the view on stroke end: the view is fitted once on mount and only
    // re-fitted by the ResizeObserver above. Strokes beyond the node edge are clipped.
    void saveDrawing();
  };

  // An interrupted stroke never delivers a pointerup; without these the surface stayed
  // stuck in `strokeActive` and refused every later stroke.
  const onDocPointerCancel = (e: PointerEvent) => {
    if (!strokeActive) return;
    strokeActive = false;
    releaseCapture(e.pointerId);
    const cancelTool = engine.toolManager.activeTool;
    if (cancelTool === 'select') { selection.cancel(); surfaceManager?.notifyStrokeEnd(); return; }
    if (isShapeTool(cancelTool)) engine.cancelShape();
    else if (cancelTool !== 'eraser') engine.endStroke();
    else text?.layer.endErase();
    surfaceManager?.notifyStrokeEnd();
    void saveDrawing();
  };

  doc.addEventListener('pointerdown', onDocPointerDown, { capture: true, signal });
  doc.addEventListener('pointermove', onDocPointerMove, { capture: true, signal });
  doc.addEventListener('pointerup', onDocPointerUp, { capture: true, signal });
  doc.addEventListener('pointercancel', onDocPointerCancel, { capture: true, signal });
  drawingContainer.addEventListener('lostpointercapture', onDocPointerCancel, { signal });

  // iPadOS Scribble intercepts Apple Pencil pointer events that look like handwriting,
  // dropping whole strokes before they reach the page. The proven fix (the one Excalidraw
  // shipped in #4705) is an UNCONDITIONAL non-passive touchstart/touchmove preventDefault on
  // the drawing surface. We previously gated this on `touchType === 'stylus'`, but inside a
  // Markdown embed the iPad WKWebView does NOT reliably report the Pencil as a stylus, so the
  // guard no-opped and Scribble won. Suppress every touch over the embed/drawing surface;
  // the note still scrolls from outside the embed (accepted tradeoff). Pen draws via pointer
  // events, which still fire.
  embedEl.setCssStyles({ padding: '0' });
  // Frame buttons must retain native touch clicks. They are outside the drawing
  // surface; the grip prevents default itself while dragging.
  const isFrameControl = (e: Event) => !!(e.target as Element | null)?.closest?.('.bb-frame-controls');
  const blockScribble = (e: TouchEvent) => { if (!isFrameControl(e)) e.preventDefault(); };
  embedEl.addEventListener('touchstart', blockScribble, { passive: false, signal });
  embedEl.addEventListener('touchmove', blockScribble, { passive: false, signal });
  drawingContainer.addEventListener('touchstart', blockScribble, { passive: false, signal });
  drawingContainer.addEventListener('touchmove', blockScribble, { passive: false, signal });

  // The element-level guards above only fire when the touch's DOM target is the embed or
  // the drawing container. A Pencil that lands a few px outside the embed border — or on
  // the host note's contenteditable within Scribble's activation slop, or in any rendered
  // gap inside the embed not covered by the inner container — is dispatched to the note,
  // so those listeners never run and Scribble swallows the stroke as text. Back them with
  // a GEOMETRIC, document-level, capture-phase guard: for any touch whose client coordinates
  // fall within the embed's rendered rect expanded by an edge margin, call preventDefault
  // regardless of event.target. The stylus check is intentionally omitted — the Pencil is not
  // reliably reported as a stylus in the embed, so gating on it let Scribble through. Touches
  // outside the embed rect+margin are left alone so the note still scrolls. (Real-device
  // confirmation only; see tasks.md §4.)
  const SCRIBBLE_EDGE_MARGIN = 12;
  const blockScribbleDoc = (e: TouchEvent) => {
    if (isFrameControl(e)) return;
    const t = e.touches[0] || e.changedTouches[0];
    if (!t) return;
    const rect = embedEl.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return;
    const m = SCRIBBLE_EDGE_MARGIN;
    const within =
      t.clientX >= rect.left - m && t.clientX <= rect.right + m &&
      t.clientY >= rect.top - m && t.clientY <= rect.bottom + m;
    if (within) e.preventDefault();
  };
  doc.addEventListener('touchstart', blockScribbleDoc, { passive: false, capture: true, signal });
  doc.addEventListener('touchmove', blockScribbleDoc, { passive: false, capture: true, signal });

  const cleanup = () => {
    liveMounts.delete(cleanup);
    abort.abort();
    for (const teardown of teardowns) teardown();
    teardowns.length = 0;
    surfaceManager?.unregister(surface);
    engine.destroy();
    handle?.release();
    embedEl.dataset.bbMounted = 'false';
  };
  liveMounts.add(cleanup);
  return cleanup;
}
