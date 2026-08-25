import { TextFileView, WorkspaceLeaf } from 'obsidian';
import type { BlackboardFile, PluginSettings, Stroke } from '../domain/entities';
import { FILE_EXTENSION } from '../domain/entities';
import { FORMAT_VERSION, serialize, deserialize, stampFormatVersion, withTextItems } from '../application/file-format';
import { handleTextDocument, memoryTextDocument } from '../application/text-document';
import type { TextDocument } from '../application/text-document';
import { DrawingEngine } from '../infrastructure/canvas-renderer';
import type { ToolManager } from '../domain/tool-manager';
import type { IDrawingRepository } from '../domain/ports';
import type { DocumentStore, SharedDocumentHandle } from '../application/document-store';
import { effectiveEraserSize, eraseAtPoint } from '../application/eraser-service';
import { isShapeTool } from '../domain/shapes';
import { applyShapeRecognition, isRecognizableTool } from '../application/shape-recognition-service';
import { SelectionController } from './selection-controller';
import { isDeleteSelectionKey, isTypingTarget } from './text-mode';
import { inputDebugEnabled, inputDebugLog } from '../dev/input-debug';

// Replaced by esbuild `define` (true in dev builds, false in production, where the
// branch and the src/dev module behind it are eliminated from the bundle).
declare const __DEV_BUILD__: boolean;
import type { SurfaceManager } from './surface-manager';
import { engineSurface, type DrawingSurface } from './drawing-surface';
import type { TextController } from './text-controller';
import type { TextLayer } from './text-layer';

function dbgTarget(t: EventTarget | null): string {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return '?';
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
  return el.tagName.toLowerCase() + cls;
}


export const VIEW_TYPE = 'blackboard-view';
export { FILE_EXTENSION };

export class BlackboardView extends TextFileView {
  private engine: DrawingEngine | null = null;
  private drawingContainer: HTMLElement | null = null;
  private settings: PluginSettings;
  private surfaceManager: SurfaceManager | null;
  private toolManager: ToolManager | undefined;
  private store: DocumentStore | null;
  private repo: IDrawingRepository | null;
  private textController: TextController | null;
  private textLayer: TextLayer | null = null;
  /** The marquee-selection tool of this surface (see `selection-controller`). */
  private selection: SelectionController | null = null;
  private detachText: (() => void) | null = null;
  // Labels for a view that has not (yet) joined a shared document — before `setViewData`, and
  // on the legacy no-store path. Replaced by the document's own text the moment it is acquired.
  private localText: TextDocument = memoryTextDocument();
  // The view's shared-document handle when the store is active. When set, the STORE is the
  // single writer for this path: mutations commit through it (never Obsidian requestSave),
  // and getViewData mirrors the same serialized content so any incidental Obsidian write is
  // byte-identical and suppressed by the store's own-write guard (no save->modify->reload loop).
  private handle: SharedDocumentHandle | null = null;
  private attaching: boolean = false;
  // True once the engine has been populated with this file's strokes and represents the live
  // user state. Obsidian's TextFileView lifecycle can call clear() (which empties the engine)
  // during teardown/reuse/mobile-suspend and then getViewData() to persist; rebuilding from
  // the emptied engine would serialize a BLANK file and overwrite a real drawing (the iPad
  // lock-screen data loss). While this is false, getViewData() returns the last loaded bytes
  // instead of the empty engine, so a transient clear() can never blank the file on disk.
  private contentLoaded: boolean = false;
  private surface: DrawingSurface | null = null;
  private isEmbedded: boolean = false;
  // Non-listener teardown (observers). Every DOM listener is owned by `listenerAbort` instead.
  private teardowns: Array<() => void> = [];
  private strokeActive: boolean = false;
  // Erasing marks the document dirty per sample but persists ONCE, on pointer release.
  // Persisting per pointermove serialized the whole drawing dozens of times per second.
  private eraseDirty: boolean = false;
  // One AbortController per mount owns every DOM listener registered here (document-level,
  // element-level and window-level alike), so teardown is a single abort() that cannot miss one.
  private listenerAbort: AbortController | null = null;
  // The drawing container's bounding rect, memoised for one animation frame. A pointermove
  // otherwise costs 2-3 forced layouts; invalidated on pointerdown and on ResizeObserver fire.
  private containerRect: DOMRect | null = null;
  // Standalone view only: the surface fills the pane and is an infinite pan + zoom canvas
  // over the engine's view transform. On open (and on resize) the drawing is fitted into
  // the pane; once the user has drawn/panned/zoomed (`userInteracted`) the view is left
  // where they put it and a resize only resizes the backing store.
  private userInteracted: boolean = false;
  private resizeObserver: ResizeObserver | null = null;
  // Active finger (touch) pointers for standalone pan/pinch navigation, keyed by pointerId.
  // A single finger pans; two fingers pinch-zoom about the midpoint. Pen/mouse never enter
  // this map (they draw). Fingers are also kept out while a pen stroke is active (palm
  // rejection), and a stroke is not begun while this map is non-empty (finger gesture wins).
  private navPointers: Map<number, { x: number; y: number }> = new Map();
  private pinchPrev: { dist: number; x: number; y: number } | null = null;
  // Desktop space+drag pan state.
  private spaceDown: boolean = false;
  private spacePanActive: boolean = false;
  private spacePanPrev: { x: number; y: number } | null = null;

  constructor(leaf: WorkspaceLeaf, settings: PluginSettings, surfaceManager?: SurfaceManager, toolManager?: ToolManager, store?: DocumentStore, repo?: IDrawingRepository, textController?: TextController) {
    super(leaf);
    this.settings = settings;
    this.surfaceManager = surfaceManager ?? null;
    this.toolManager = toolManager;
    this.store = store ?? null;
    this.repo = repo ?? null;
    this.textController = textController ?? null;
  }

  /** The document this view actually lives in — never the global one (pop-out windows). */
  private get doc(): Document {
    return this.contentEl.ownerDocument;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'Drawing';
  }

  getIcon(): string {
    return 'pencil';
  }

  private editing: boolean = false;
  private fileData: string = '';
  /**
   * True once this surface has actually held content — loaded from the file or drawn here.
   *
   * Guards the clobber path. A surface remounted while the file is being written can come up
   * blank (empty or short-read `fileData`), and its first persist would then write an empty
   * 800x600 document over a drawing that is still on disk. A blank surface that never held
   * content has nothing worth saving, so it must not write at all. Erasing a drawing by hand
   * still saves, because that surface did hold content first.
   */
  private hadContent: boolean = false;

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('blackboard-view-container');

    this.isEmbedded = this.detectEmbedded();
    this.listenerAbort = new AbortController();
    this.enterEditMode();
  }

  private enterEditMode(): void {
    if (this.editing) return;
    this.editing = true;

    const container = this.contentEl;

    if (this.isEmbedded) {
      this.hideCanvasBlocker();
    }

    // The embedded (canvas-node) view fills its host with an absolute, overflow-hidden
    // surface. The standalone view instead fills the pane and scrolls when the drawing
    // is larger than the pane, so it must NOT use the embedded (absolute/clip) class.
    const containerCls = this.isEmbedded
      ? 'blackboard-drawing-container blackboard-embedded-drawing'
      : 'blackboard-drawing-container blackboard-standalone-drawing';
    this.drawingContainer = container.createDiv({ cls: containerCls });
    this.drawingContainer.style.touchAction = this.isEmbedded ? 'pan-x pan-y' : 'none';
    // Board background (issue #13): paint the surface (whiteboard/blackboard/etc.).
    this.drawingContainer.style.backgroundColor = this.settings.boardBackground;

    this.drawingContainer.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        e.preventDefault();
      }
    });

    // iPadOS Scribble swallows Apple Pencil pointer events that "look like" handwriting,
    // dropping whole strokes. A non-passive touchstart/touchmove preventDefault on the
    // drawing surface is the known fix (Pencil draws via pointer events, which still fire).
    const blockScribble = (e: TouchEvent) => { e.preventDefault(); };
    const signal = this.listenerAbort?.signal;
    this.drawingContainer.addEventListener('touchstart', blockScribble, { passive: false, signal });
    this.drawingContainer.addEventListener('touchmove', blockScribble, { passive: false, signal });

    // Standalone full-page view: the drawing container is centred, leaving margins of bare
    // contentEl around it. A stylus over those margins still lands on an editable region,
    // so Scribble can fire there. Extend the same non-passive guard to contentEl so a
    // Pencil anywhere over the pane is suppressed; a standalone Blackboard must never
    // trigger Scribble. Tracked for removal on close so the listener never leaks across the
    // view's reusable contentEl. (Embedded mode keeps the note scrollable, so it is not
    // extended here.) Real-device confirmation only; see tasks.md §4.
    if (!this.isEmbedded) {
      container.addEventListener('touchstart', blockScribble, { passive: false, signal });
      container.addEventListener('touchmove', blockScribble, { passive: false, signal });
    }

    // Parse file dimensions first
    let fileWidth = 800;
    let fileHeight = 600;
    let fileStrokes: Stroke[] = [];
    if (this.fileData) {
      try {
        const result = deserialize(this.fileData);
        fileWidth = result.file.width;
        fileHeight = result.file.height;
        fileStrokes = result.file.strokes;
        // Labels for the window before this view joins the shared document.
        this.localText.setItems(result.file.text?.items ?? []);
      } catch {
        // Unparseable data falls back to the 800x600 empty-drawing defaults above.
      }
    }

    // Share the plugin's single ToolManager so tool/colour/size are global across every
    // surface; the manager is seeded once at startup and is NOT re-seeded on mount, so
    // opening a file never clobbers the user's live selection (fix-tool-state-isolation).
    this.engine = new DrawingEngine(this.drawingContainer, fileWidth, fileHeight, this.toolManager);

    if (fileStrokes.length > 0) {
      this.engine.loadStrokes(fileStrokes);
    }
    if (fileStrokes.length > 0 || this.localText.getItems().length > 0) {
      this.hadContent = true;
    }
    // The engine now mirrors this.fileData (empty or not), so getViewData() may rebuild from it.
    this.contentLoaded = true;

    if (this.isEmbedded) {
      this.drawingContainer.style.width = fileWidth + 'px';
      this.drawingContainer.style.height = fileHeight + 'px';
    } else {
      // Standalone: an infinite pan + zoom canvas. The surface fills the pane and
      // navigation is via the view transform (pan/zoom), NOT document scroll.
      container.setCssStyles({ position: 'relative' });
      this.layoutStandalone();
      this.resizeObserver = new ResizeObserver(() => { this.containerRect = null; this.layoutStandalone(); });
      this.resizeObserver.observe(container);
    }

    this.engine.staticDirty = true;
    this.engine.render();

    // The text overlay lives inside the drawing container, above the canvases. Its file path
    // is read lazily: Obsidian only hands the view its file after setViewData().
    if (this.textController) {
      const attached = this.textController.attach(this.engine, this.drawingContainer, () => this.textDocument());
      this.textLayer = attached.layer;
      this.detachText = attached.detach;
    }

    // The selection tool needs the text layer (labels are selected and moved with strokes) and
    // the same persist path everything else writes through.
    this.selection = new SelectionController(
      this.engine,
      () => this.textLayer,
      () => this.persist(),
      () => this.surfaceManager?.refresh(),
    );
    // Switching tools drops the selection: a Delete pressed while drawing must never remove
    // content the user marqueed minutes ago.
    this.teardowns.push(this.engine.toolManager.onChange(() => {
      if (this.engine && this.engine.toolManager.activeTool !== 'select') this.selection?.clear();
    }));

    // Setting a colour with a live selection recolours the selection too (one undo step).
    this.surface = engineSurface(this.engine, () => this.persist(), this.selection);
    this.surfaceManager?.register(this.surface, this.drawingContainer);
    this.surfaceManager?.setActive(this.surface);

    this.setupDocumentListeners();

    // Join the shared document so sibling edits (embeds, Canvas nodes) reach this view and
    // this view's edits reach them. Fire-and-forget: the engine already renders from the
    // file data; once acquired we reseed from the canonical strokes.
    void this.attachToStore();
  }

  /**
   * Register this view's surface with the path's shared document. Single-writer design:
   * after acquiring, the store owns persistence (`persist()` commits, never `requestSave`),
   * and a sibling commit reloads canonical strokes here WITHOUT re-centring (the user's
   * scroll position / `userInteracted` state is preserved). Idempotent and torn-down safe.
   */
  private async attachToStore(): Promise<void> {
    if (!this.store || !this.repo || !this.file || this.handle || this.attaching || !this.engine) return;
    this.attaching = true;
    try {
      const handle = await this.store.acquire(this.file.path, this.repo);
      if (!this.engine) { handle.release(); return; } // torn down while awaiting
      this.handle = handle;
      this.engine.loadStrokes(handle.getStrokes());
      if (handle.getStrokes().length > 0) this.hadContent = true;
      this.engine.staticDirty = true;
      this.engine.render();
      // Labels are part of the same canonical document, so they come across with the strokes.
      this.textLayer?.sync();
      this.selection?.syncToContent();
      handle.subscribe(() => {
        if (!this.engine || !this.handle) return;
        // Reload canonical strokes and repaint only — never re-centre, never re-persist.
        this.engine.loadStrokes(this.handle.getStrokes());
        if (this.handle.getStrokes().length > 0) this.hadContent = true;
        this.engine.staticDirty = true;
        this.engine.requestRender();
        this.textLayer?.sync();
        this.selection?.syncToContent();
      });
    } finally {
      this.attaching = false;
    }
  }

  /** The drawing's text layer: the shared document's once acquired, otherwise an in-memory one. */
  private textDocument(): TextDocument {
    return this.handle ? handleTextDocument(this.handle) : this.localText;
  }

  /** Build the canonical file from the live engine; shared by getViewData and commit so the
   * store's serialized content matches what Obsidian would write (loop guard stays valid).
   * Text is carried through from the canonical document — the engine holds strokes only, so
   * rebuilding from it must never be what drops a label. */
  private buildFile(): BlackboardFile {
    const cb = this.engine!.getContentBounds();
    const hasContent = cb.width > 0 && cb.height > 0;
    const file: BlackboardFile = {
      version: FORMAT_VERSION,
      width: hasContent ? Math.round(cb.width) : 800,
      height: hasContent ? Math.round(cb.height) : 600,
      strokes: structuredClone(this.engine!.strokeManager.strokes),
      background: { color: 'transparent' },
      contentBounds: hasContent ? cb : undefined,
    };
    return stampFormatVersion(withTextItems(file, this.textDocument().getItems()));
  }

  /** Persist a mutation. With the store active it is the single writer (commit -> debounced
   * save + sibling refresh); otherwise fall back to Obsidian's debounced requestSave. */
  private persist(): void {
    const file = this.buildFile();
    const isEmpty = file.strokes.length === 0 && (file.text?.items?.length ?? 0) === 0;
    if (!isEmpty) this.hadContent = true;
    // A surface that is empty, never held content and was never touched by the user has
    // nothing to write — and writing anyway is exactly how a blank remount erases a drawing
    // that is still on disk. Erasing by hand sets `userInteracted`, so it still saves.
    if (isEmpty && !this.hadContent && !this.userInteracted) return;
    if (this.handle) this.handle.commit(file);
    else this.requestSave();
  }

  /**
   * Standalone view layout: the drawing surface FILLS the pane (no grow-to-content, no
   * document scroll). Navigation is over the engine's view transform (infinite pan + zoom).
   * While the user has not yet interacted, the loaded content is fitted into the pane
   * (aspect-preserved, centred) on open/resize. Once `userInteracted` is set, a resize only
   * resizes the backing store and the current pan/zoom is preserved (no re-fit jump).
   */
  private layoutStandalone(): void {
    if (!this.engine || !this.drawingContainer || this.isEmbedded) return;
    const pane = this.contentEl;
    const paneW = pane.clientWidth || 800;
    const paneH = pane.clientHeight || 600;
    this.drawingContainer.style.width = paneW + 'px';
    this.drawingContainer.style.height = paneH + 'px';
    if (this.userInteracted) {
      // Preserve the user's pan/zoom; only resize the backing store to the new pane size.
      this.engine.resizeBox(paneW, paneH);
    } else {
      // Size the backing store to the pane, then fit the content into it (empty content
      // yields the identity transform — a blank pane-filling canvas at scale 1).
      this.engine.setDisplaySize(paneW, paneH);
      this.engine.refitToContent();
    }
  }

  getViewData(): string {
    // width/height cache the content-bounds size (recomputable from strokes); embeds use
    // them to render a drawing at its natural size. Built via buildFile() so the bytes match
    // what the store commits, keeping the own-write guard valid when the store is active.
    //
    // Only rebuild from the engine when it actually holds the loaded drawing. After a
    // teardown/suspend clear() the engine is empty but the file still has strokes; rebuilding
    // then would return a blank drawing and let Obsidian overwrite the file (data loss). In
    // that state we return the last loaded bytes unchanged.
    if (this.engine && this.contentLoaded) this.fileData = serialize(this.buildFile());
    return this.fileData;
  }

  setViewData(data: string, clear: boolean): void {
    this.fileData = data;
    if (this.engine) {
      if (clear) this.engine.strokeManager.reset();
      try {
        const result = deserialize(data);
        this.engine.loadStrokes(result.file.strokes);
        if (result.file.strokes.length > 0 || (result.file.text?.items?.length ?? 0) > 0) {
          this.hadContent = true;
        }
        // Labels for the window before this view joins the shared document; once it has, the
        // document is authoritative and this is ignored.
        this.localText.setItems(result.file.text?.items ?? []);
        // The engine now mirrors the file: getViewData() may rebuild from it again.
        this.contentLoaded = true;
        if (this.isEmbedded) {
          this.engine.setCanvasSize(result.file.width, result.file.height);
          if (this.drawingContainer) {
            this.drawingContainer.style.width = result.file.width + 'px';
            this.drawingContainer.style.height = result.file.height + 'px';
          }
        } else {
          this.layoutStandalone();
        }
      } catch {
        // Layout during teardown can race a detached container; the next resize re-lays out.
      }
      this.engine.staticDirty = true;
      this.engine.render();
    }
    // The path becomes known once Obsidian loads the file; attach now if we haven't yet.
    void this.attachToStore();
    this.textLayer?.sync();
    // A different drawing (or a reload of this one) invalidates any selection wholesale.
    this.selection?.clear();
  }

  clear(): void {
    if (this.engine) this.engine.strokeManager.reset();
    // The engine no longer holds the file's strokes; getViewData() must fall back to the last
    // loaded bytes rather than serialize this empty engine over a real drawing (data loss).
    this.contentLoaded = false;
  }

  async onClose(): Promise<void> {
    // Flush any unsaved strokes before tearing down. When the store is active it is the
    // single writer and flushes its own pending debounced save on release(), so only the
    // legacy (no-store) path writes through Obsidian here (avoids a double-write).
    if (this.engine && this.file && !this.handle) {
      try {
        await this.app.vault.modify(this.file, this.getViewData());
      } catch {
        // Save is retried on the next stroke end; failing here must not break the view.
      }
    }
    if (this.handle) {
      this.handle.release();
      this.handle = null;
    }
    // Every DOM listener registered during this mount goes away with one abort.
    this.listenerAbort?.abort();
    this.listenerAbort = null;
    for (const teardown of this.teardowns) teardown();
    this.teardowns = [];
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.detachText) {
      this.detachText();
      this.detachText = null;
      this.textLayer = null;
    }
    this.selection = null;
    if (this.surface) {
      this.surfaceManager?.unregister(this.surface);
      this.surface = null;
    }
    if (this.engine) {
      this.engine.destroy();
      this.engine = null;
    }
    this.drawingContainer = null;
    this.navPointers.clear();
    this.pinchPrev = null;
    this.spaceDown = false;
    this.spacePanActive = false;
    this.spacePanPrev = null;
    this.containerRect = null;
    this.eraseDirty = false;
    this.editing = false;
  }

  private detectEmbedded(): boolean {
    let el: HTMLElement | null = this.contentEl;
    while (el) {
      if (el.classList.contains('canvas-node-content')) return true;
      el = el.parentElement;
    }
    return false;
  }

  private hideCanvasBlocker(): void {
    let canvasNode: HTMLElement | null = null;
    let el: HTMLElement | null = this.contentEl;
    while (el) {
      if (el.classList.contains('canvas-node')) {
        canvasNode = el;
        break;
      }
      el = el.parentElement;
    }
    if (!canvasNode) return;

    const hideBlocker = () => {
      const blocker = canvasNode.querySelector<HTMLElement>('.canvas-node-content-blocker');
      if (blocker) blocker.setCssStyles({ display: 'none' });
    };
    hideBlocker();

    const observer = new MutationObserver(hideBlocker);
    observer.observe(canvasNode, { childList: true, subtree: true });
    this.teardowns.push(() => observer.disconnect());

    // Registered through the mount's AbortController: these previously leaked one pair of
    // handlers onto the (surviving) canvas node on every remount of the view.
    const swallow = (e: Event) => {
      if (this.contentEl.contains(e.target as Node)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };
    const signal = this.listenerAbort?.signal;
    canvasNode.addEventListener('click', swallow, { capture: true, signal });
    canvasNode.addEventListener('dblclick', swallow, { capture: true, signal });
  }

  private setupDocumentListeners(): void {
    if (!this.drawingContainer || !this.engine) return;
    const dc = this.drawingContainer;
    const engine = this.engine;
    const doc = this.doc;
    const signal = this.listenerAbort?.signal;

    // One getBoundingClientRect per animation frame instead of two or three per pointermove.
    // Invalidated eagerly on pointerdown and by the ResizeObserver, so a layout change is
    // never read through a stale rect.
    const rect = (): DOMRect => {
      if (this.containerRect) return this.containerRect;
      const r = dc.getBoundingClientRect();
      this.containerRect = r;
      (dc.ownerDocument.defaultView ?? window).requestAnimationFrame(() => { this.containerRect = null; });
      return r;
    };

    const isInsideDrawing = (e: PointerEvent): boolean => {
      const target = e.target as HTMLElement;
      if (target.closest('.canvas-node-resize-handle')) return false;
      return dc.contains(target) && !target.closest('.blackboard-toolbar');
    };

    const localPoint = (e: PointerEvent): [number, number] => {
      let localX: number;
      let localY: number;
      if (this.isEmbedded) {
        const r = rect();
        const scaleX = engine.drawingWidth / r.width;
        const scaleY = engine.drawingHeight / r.height;
        localX = (e.clientX - r.left) * scaleX;
        localY = (e.clientY - r.top) * scaleY;
      } else {
        // Standalone: invert the full pan + zoom view transform (scale and offset).
        [localX, localY] = engine.screenToDrawing(e.clientX, e.clientY, dc, rect());
      }
      return [localX, localY];
    };

    const handlePoint = (e: PointerEvent): void => {
      const [localX, localY] = localPoint(e);
      const tool = engine.toolManager.activeTool;

      if (tool === 'eraser') {
        this.eraseAt(localX, localY);
        return;
      }
      if (tool === 'select') {
        this.selection?.pointerMove(localX, localY, e.clientX, e.clientY);
        return;
      }
      if (isShapeTool(tool)) {
        engine.updateShape(localX, localY, e.shiftKey);
        return;
      }
      engine.addPoint([localX, localY, e.pressure || 0.5]);
    };

    // A finger (touch) never draws: in the standalone view it navigates (pan/zoom), in the
    // embed it is ignored. Pen always draws; mouse draws (and pans with space held).
    const isDrawingInput = (e: PointerEvent): boolean => {
      if (e.pointerType === 'touch') return false;
      if (!this.isEmbedded) return true;
      return e.pointerType === 'pen' || e.pointerType === 'mouse';
    };

    const onDocPointerDown = (e: PointerEvent) => {
      const inside = isInsideDrawing(e);
      const drawInput = isDrawingInput(e);
      if (__DEV_BUILD__ && inputDebugEnabled()) {
        inputDebugLog(`DOWN ${e.pointerType} in=${inside ? 'Y' : 'N'} draw=${drawInput ? 'Y' : 'N'} tgt=${dbgTarget(e.target)}${inside && drawInput ? ' OK' : ' REJECT'}`);
      }
      if (!inside) return;

      // Standalone finger navigation: a touch pans/pinch-zooms the view, it never draws.
      // While a pen stroke is active, ignore fingers so a resting palm cannot pan.
      if (!this.isEmbedded && e.pointerType === 'touch') {
        if (this.strokeActive) return; // palm rejection
        e.stopPropagation();
        e.preventDefault();
        this.containerRect = null;
        this.userInteracted = true;
        this.navPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.pinchPrev = null; // re-baseline the pinch on the next move
        return;
      }

      // Standalone desktop space+drag pan (mouse held with the space bar down).
      if (!this.isEmbedded && this.spaceDown && e.pointerType !== 'touch') {
        e.stopPropagation();
        e.preventDefault();
        this.containerRect = null;
        this.userInteracted = true;
        this.spacePanActive = true;
        this.spacePanPrev = { x: e.clientX, y: e.clientY };
        return;
      }

      if (!drawInput) return;
      // The text tool never draws. A press on a surface it owns is consumed by the text
      // layer before it reaches here; on any OTHER surface (a second embed on the same
      // page) the press must simply do nothing, not leave a stroke at the font size.
      if (engine.toolManager.activeTool === 'text') return;
      // A finger gesture is in progress: do not begin a stroke (finger navigation wins).
      if (!this.isEmbedded && this.navPointers.size > 0) return;
      e.stopPropagation();
      e.preventDefault();
      this.containerRect = null;
      // Stop re-fitting the standalone view on resize once the user has drawn.
      this.userInteracted = true;
      this.strokeActive = true;
      this.eraseDirty = false;
      // Capturing the pointer guarantees a pointerup/pointercancel even if the pointer
      // leaves the element or the browser steals the gesture, so `strokeActive` cannot
      // latch true and swallow every later interaction.
      try { dc.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      if (this.surface) this.surfaceManager?.setActive(this.surface);
      this.surfaceManager?.notifyStrokeStart();
      const tool = engine.toolManager.activeTool;
      if (tool === 'select') {
        const [sx, sy] = localPoint(e);
        this.selection?.pointerDown(sx, sy, e.clientX, e.clientY);
      } else if (isShapeTool(tool)) {
        const [sx, sy] = localPoint(e);
        engine.beginShape(tool, sx, sy);
      } else if (tool !== 'eraser') {
        engine.beginStroke(e.pointerType);
      } else {
        // Measure the labels once for the whole gesture (see TextLayer.beginErase).
        this.textLayer?.beginErase();
      }
      handlePoint(e);
    };

    const onDocPointerMove = (e: PointerEvent) => {
      // Standalone finger navigation (pan / pinch-zoom) — decoupled from the DocumentStore.
      if (!this.isEmbedded && this.navPointers.has(e.pointerId)) {
        e.stopPropagation();
        e.preventDefault();
        const prev = this.navPointers.get(e.pointerId)!;
        this.navPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.navPointers.size >= 2) {
          const pts = [...this.navPointers.values()];
          const a = pts[0];
          const b = pts[1];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          const r = rect();
          const mx = (a.x + b.x) / 2 - r.left;
          const my = (a.y + b.y) / 2 - r.top;
          if (this.pinchPrev) {
            if (this.pinchPrev.dist > 0 && dist > 0) {
              engine.zoomAt(dist / this.pinchPrev.dist, mx, my);
            }
            const mdx = mx - this.pinchPrev.x;
            const mdy = my - this.pinchPrev.y;
            if (mdx || mdy) engine.panBy(mdx, mdy);
          }
          this.pinchPrev = { dist, x: mx, y: my };
        } else {
          const dx = e.clientX - prev.x;
          const dy = e.clientY - prev.y;
          if (dx || dy) engine.panBy(dx, dy);
        }
        return;
      }

      // Standalone desktop space+drag pan.
      if (!this.isEmbedded && this.spacePanActive && this.spacePanPrev) {
        e.stopPropagation();
        e.preventDefault();
        const dx = e.clientX - this.spacePanPrev.x;
        const dy = e.clientY - this.spacePanPrev.y;
        this.spacePanPrev = { x: e.clientX, y: e.clientY };
        if (dx || dy) engine.panBy(dx, dy);
        return;
      }

      if (!this.strokeActive) return;
      if (!isDrawingInput(e)) return;
      e.stopPropagation();
      e.preventDefault();
      // A throw mid-stroke (detached container, engine torn down under us) must not skip
      // the pointerup bookkeeping; swallow it and let the release finish the stroke.
      try { handlePoint(e); } catch { /* drop this sample */ }
    };

    const onDocPointerUp = (e: PointerEvent) => {
      if (!this.isEmbedded && this.navPointers.has(e.pointerId)) {
        this.navPointers.delete(e.pointerId);
        this.pinchPrev = null;
        e.stopPropagation();
        return;
      }
      if (!this.isEmbedded && this.spacePanActive) {
        this.spacePanActive = false;
        this.spacePanPrev = null;
        e.stopPropagation();
        return;
      }
      if (!this.strokeActive) return;
      if (!isDrawingInput(e)) return;
      this.strokeActive = false;
      e.stopPropagation();
      this.releaseCapture(dc, e.pointerId);
      const tool = engine.toolManager.activeTool;
      if (tool === 'select') {
        // The controller persists whatever the gesture committed (a move), or nothing.
        this.selection?.pointerUp();
      } else if (isShapeTool(tool)) {
        if (engine.endShape()) this.persist();
      } else if (tool !== 'eraser') {
        const before = engine.strokeManager.strokes.length;
        engine.endStroke();
        // Only a gesture that actually committed a stroke is offered to the recogniser.
        if (engine.strokeManager.strokes.length > before) this.recognizeLastStroke();
        this.persist();
      } else {
        // Erased labels become ONE undo step for the gesture; their save already went through
        // the shared document as they were removed.
        this.textLayer?.endErase();
        if (this.eraseDirty) {
          // One write for the whole erase gesture, not one per pointermove sample.
          this.eraseDirty = false;
          this.persist();
        }
      }
      // Re-sync the toolbar (undo/redo enablement) the instant a stroke or erase commits,
      // so the undo arrow lights up immediately rather than on the next tap (QA3).
      this.surfaceManager?.notifyStrokeEnd();
      if (__DEV_BUILD__ && inputDebugEnabled()) inputDebugLog(`UP committed total=${engine.strokeManager.strokes.length}`);
    };

    // An interrupted stroke (system gesture, pointer lost, window switch) never delivers a
    // pointerup. Without these, `strokeActive` stayed true forever and the surface went dead.
    const onDocPointerCancel = (e: PointerEvent) => {
      if (!this.isEmbedded && this.navPointers.has(e.pointerId)) {
        this.navPointers.delete(e.pointerId);
        this.pinchPrev = null;
        return;
      }
      if (!this.isEmbedded && this.spacePanActive) {
        this.spacePanActive = false;
        this.spacePanPrev = null;
        return;
      }
      if (!this.strokeActive) return;
      this.strokeActive = false;
      this.releaseCapture(dc, e.pointerId);
      const tool = engine.toolManager.activeTool;
      if (tool === 'select') {
        // The controller persists whatever the gesture committed (a move), or nothing.
        this.selection?.pointerUp();
      } else if (isShapeTool(tool)) {
        if (engine.endShape()) this.persist();
      } else if (tool !== 'eraser') {
        const before = engine.strokeManager.strokes.length;
        engine.endStroke();
        // Only a gesture that actually committed a stroke is offered to the recogniser.
        if (engine.strokeManager.strokes.length > before) this.recognizeLastStroke();
        this.persist();
      } else {
        this.textLayer?.endErase();
        if (this.eraseDirty) {
          this.eraseDirty = false;
          this.persist();
        }
      }
      this.surfaceManager?.notifyStrokeEnd();
    };

    // Selection keys, standalone view only: Escape clears, Delete/Backspace removes the
    // selection as one undo step. Deliberately NOT bound inside a Canvas node or a Markdown
    // embed, where Delete belongs to the host (it would remove the node or the note's text).
    const onSelectionKey = (e: KeyboardEvent) => {
      if (engine.toolManager.activeTool !== 'select') return;
      if (isTypingTarget(e.target)) return;
      const selection = this.selection;
      if (!selection?.hasSelection) return;
      if (e.key === 'Escape') {
        selection.clear();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (isDeleteSelectionKey(e) && selection.deleteSelection()) {
        e.preventDefault();
        e.stopPropagation();
        this.surfaceManager?.notifyStrokeEnd();
      }
    };
    if (!this.isEmbedded) doc.addEventListener('keydown', onSelectionKey, { capture: true, signal });

    doc.addEventListener('pointerdown', onDocPointerDown, { capture: true, signal });
    doc.addEventListener('pointermove', onDocPointerMove, { capture: true, signal });
    doc.addEventListener('pointerup', onDocPointerUp, { capture: true, signal });
    doc.addEventListener('pointercancel', onDocPointerCancel, { capture: true, signal });
    dc.addEventListener('lostpointercapture', onDocPointerCancel, { signal });

    // Standalone desktop navigation: Ctrl/Cmd+wheel zooms about the cursor; space+drag
    // pans (handled in the pointer handlers above). These mutate only the view transform.
    if (!this.isEmbedded) {
      const onWheel = (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (!dc.contains(e.target as Node)) return;
        e.preventDefault();
        e.stopPropagation();
        this.userInteracted = true;
        const r = rect();
        const cx = e.clientX - r.left;
        const cy = e.clientY - r.top;
        // deltaY < 0 (scroll up / pinch-out) zooms in; > 0 zooms out.
        const factor = Math.exp(-e.deltaY * 0.01);
        engine.zoomAt(factor, cx, cy);
      };
      dc.addEventListener('wheel', onWheel, { passive: false, signal });

      const onKeyDown = (e: KeyboardEvent) => { if (e.code === 'Space') this.spaceDown = true; };
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.code === 'Space') { this.spaceDown = false; this.spacePanActive = false; this.spacePanPrev = null; }
      };
      doc.addEventListener('keydown', onKeyDown, { capture: true, signal });
      doc.addEventListener('keyup', onKeyUp, { capture: true, signal });
    }
  }

  private eraseAt(localX: number, localY: number): void {
    if (!this.engine) return;
    const size = this.engine.toolManager.activeSize;
    // Labels are erased by the same disc as strokes, and the layer writes them through the
    // shared document itself; only the strokes need the deferred persist below.
    this.textLayer?.eraseAt(localX, localY, effectiveEraserSize(size));
    const erased = eraseAtPoint(
      this.engine.strokeManager,
      localX, localY,
      size,
    );
    if (erased) {
      this.engine.staticDirty = true;
      this.engine.requestRender();
      // Deliberately NOT persisted here: the gesture is written once on release.
      this.eraseDirty = true;
    }
  }

  /**
   * Shape recognition (opt-in, `settings.recognizeShapes`): check the stroke that just
   * committed and, when the recogniser is confident, replace it with the clean shape as a
   * SECOND undo step — so one Ctrl+Z restores the exact freehand stroke and recognition is
   * never a silent mutation of what the user drew.
   */
  private recognizeLastStroke(): void {
    if (!this.settings.recognizeShapes || !this.engine) return;
    if (!isRecognizableTool(this.engine.toolManager.activeTool)) return;
    const strokes = this.engine.strokeManager.strokes;
    const last = strokes[strokes.length - 1];
    if (!last) return;
    if (!applyShapeRecognition(this.engine.strokeManager, last)) return;
    this.engine.staticDirty = true;
    this.engine.requestRender();
  }

  private releaseCapture(el: HTMLElement, pointerId: number): void {
    try {
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    } catch { /* capture may already be gone */ }
  }
}
