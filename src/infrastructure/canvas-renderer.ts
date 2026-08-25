import { getStroke } from 'perfect-freehand';
import type { Point, Stroke } from '../domain/entities';
import { StrokeManager } from '../domain/stroke-manager';
import { ToolManager } from '../domain/tool-manager';
import { fitContentToBox, screenToContent, centerContentInBox, type ViewTransform } from '../domain/geometry';
import { strokeEpoch } from '../domain/stroke-cache';
import type { ShapeKind, ShapeSpec } from '../domain/shapes';
import { constrainShapeEnd, createShapeStroke, isShapeDragMeaningful, shapeStrokePoints } from '../domain/shapes';
import type { SelectionRect } from '../domain/selection';

/**
 * A stroke's `perfect-freehand` outline solved once and kept as a `Path2D`. Solving the
 * outline is by far the most expensive part of a static repaint, and the static layer is
 * repainted on every pan, zoom, resize, erase and sibling refresh — none of which change the
 * geometry of the strokes already on the board. The key is everything the outline depends on:
 * the points array identity, its length, the brush size, the pressure flag, and the stroke's
 * geometry epoch (bumped by an in-place `moveStroke`). The Path2D is in drawing-space, so the
 * view transform is applied by the context and never invalidates the cache.
 */
interface CachedPath {
  points: Point[];
  length: number;
  size: number;
  hasPressure: boolean;
  epoch: number;
  path: Path2D | null;
}
const pathCache = new WeakMap<Stroke, CachedPath>();

/**
 * Selection chrome: what the ACTIVE canvas paints on top of the untouched static layer while
 * the select tool is in use. Keeping it here (rather than repainting the static layer with
 * selected strokes drawn differently) is what makes a marquee drag cost one active-layer
 * repaint per frame instead of a full re-fill of every stroke on the board.
 */
export interface SelectionChrome {
  /** The rubber-band rectangle, while one is being dragged. */
  marquee: SelectionRect | null;
  /** Ids of the selected strokes; their cached Path2Ds are re-filled in the accent colour. */
  strokeIds: readonly string[];
  /** Box around the whole selection, drawn dashed. */
  bounds: SelectionRect | null;
  /** Live translation of a group move, applied to the overlay only until the drag commits. */
  dx: number;
  dy: number;
}

/** Accent used for every piece of selection chrome. */
const SELECTION_ACCENT = '#4d9bff';

/** View-scale clamp shared by the presentation-facing transform mutators. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

export class DrawingEngine {
  readonly: boolean = false;
  warnings: string[] = [];
  strokeManager: StrokeManager;
  toolManager: ToolManager;

  private container: HTMLElement;
  private staticCanvas: HTMLCanvasElement;
  private activeCanvas: HTMLCanvasElement;
  private staticCtx: CanvasRenderingContext2D;
  private activeCtx: CanvasRenderingContext2D;
  private activePoints: Point[] = [];
  /**
   * The in-progress shape drag. Only the two corners are stored: a pointermove writes two
   * numbers and marks the active layer dirty, and the tessellation happens once per FRAME in
   * `renderActive` (exactly like the freehand preview), never per pointer sample.
   */
  private shapeDrag: { kind: ShapeKind; fromX: number; fromY: number; toX: number; toY: number } | null = null;
  private selectionChrome: SelectionChrome | null = null;
  private selectedIds: Set<string> = new Set();
  /**
   * Strokes the static layer must skip: the selection being dragged, which the active layer
   * draws translated instead. Set once at drag start and cleared once at the end, so a group
   * move costs two static repaints in total.
   */
  private hiddenIds: Set<string> = new Set();
  private activePointerType: string = '';
  private isDrawing: boolean = false;
  staticDirty: boolean = true;
  private activeDirty: boolean = false;
  private rafId: number = 0;
  drawingWidth: number;
  drawingHeight: number;
  private displayWidth = 0;
  private displayHeight = 0;
  private contentBounds: { x: number; y: number; width: number; height: number } | null = null;
  private view: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
  /**
   * Overlays drawn in CSS on top of the canvas (the text layer) must follow the view
   * transform and the display size exactly. Rather than wrapping or subclassing the engine
   * from outside, every transform/size mutator announces itself here.
   */
  private viewListeners = new Set<() => void>();

  constructor(container: HTMLElement, width?: number, height?: number, toolManager?: ToolManager) {
    this.container = container;
    this.strokeManager = new StrokeManager();
    // Tool state is global: when the plugin injects a shared ToolManager, every surface
    // reads and drives the same selection (fix-tool-state-isolation). Falls back to a
    // private manager for back-compat (standalone construction / tests).
    this.toolManager = toolManager ?? new ToolManager();

    this.drawingWidth = width ?? (container.clientWidth || 800);
    this.drawingHeight = height ?? (container.clientHeight || 600);

    // Layout (absolute overlay filling the container) comes from the
    // .blackboard-static/.blackboard-active rules in styles.css.
    this.staticCanvas = createEl('canvas');
    this.staticCanvas.className = 'blackboard-static';

    this.activeCanvas = createEl('canvas');
    this.activeCanvas.className = 'blackboard-active';

    container.appendChild(this.staticCanvas);
    container.appendChild(this.activeCanvas);

    // The ACTIVE canvas keeps `desynchronized: true`: it is repainted on every pointer
    // move and the flag lowers input-to-paint latency for stylus drawing.
    //
    // The STATIC canvas must NOT be desynchronized. A desynchronized 2D canvas asks
    // Chromium/Electron to present through a hardware overlay outside the normal
    // compositor. When overlay promotion fails (fractional devicePixelRatio such as
    // 1.75, a canvas stacked UNDER another canvas, some Windows GPU paths) the backing
    // buffer still holds the pixels (getImageData sees the strokes) but nothing is
    // composited to screen — committed strokes silently vanish the moment they move
    // from the active to the static layer ("line disappears on pointer up"). Static
    // repaints are rare (commit/resize/zoom), so the flag buys nothing here anyway.
    this.staticCtx = this.staticCanvas.getContext('2d')!;
    this.activeCtx = this.activeCanvas.getContext('2d')!;

    this.setCanvasSize(this.drawingWidth, this.drawingHeight);
  }

  loadStrokes(strokes: Stroke[]): void {
    this.strokeManager.reset();
    for (const stroke of strokes) {
      // structuredClone is a native deep copy: no serialize/parse round trip, and it keeps
      // the numeric point tuples as-is. The clone is required — the engine owns mutable
      // strokes and must not alias the canonical document's arrays.
      this.strokeManager.strokes.push(structuredClone(stroke));
    }
    this.staticDirty = true;
    this.notifyViewChange();
  }

  beginStroke(pointerType: string): void {
    this.isDrawing = true;
    this.activePointerType = pointerType;
    this.activePoints = [];
  }

  addPoint(point: Point): void {
    if (!this.isDrawing) return;
    // Skip zero-length segments (e.g. the pointerup point landing on the last move
    // position) so capturing the release point doesn't add a duplicate.
    const last = this.activePoints[this.activePoints.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) return;
    this.activePoints.push(point);
    this.activeDirty = true;
    this.requestRender();
  }

  endStroke(): void {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    if (this.activePoints.length >= 1) {
      const tool = this.toolManager.activeTool === 'highlighter' ? 'highlighter' : 'pen';
      const stroke: Stroke = {
        id: crypto.randomUUID(),
        tool,
        color: this.toolManager.activeColor,
        size: this.toolManager.activeSize,
        opacity: this.toolManager.activeOpacity,
        points: [...this.activePoints],
        hasPressure: this.activePoints.some(p => p[2] !== 0.5),
        timestamp: Date.now(),
      };
      this.strokeManager.addStroke(stroke);
      this.staticDirty = true;
    }

    this.activePoints = [];
    this.activeDirty = true;
    this.requestRender();
  }

  /** Begin a shape drag at a drawing-space point. */
  beginShape(kind: ShapeKind, x: number, y: number): void {
    this.shapeDrag = { kind, fromX: x, fromY: y, toX: x, toY: y };
    this.activeDirty = true;
    this.requestRender();
  }

  /** Move the free corner of the shape drag. `constrain` is the Shift modifier. */
  updateShape(x: number, y: number, constrain = false): void {
    const drag = this.shapeDrag;
    if (!drag) return;
    if (constrain) {
      const [cx, cy] = constrainShapeEnd(drag.kind, drag.fromX, drag.fromY, x, y);
      drag.toX = cx;
      drag.toY = cy;
    } else {
      drag.toX = x;
      drag.toY = y;
    }
    this.activeDirty = true;
    this.requestRender();
  }

  /** The spec the current shape drag would commit, or null when there is no drag. */
  private shapeSpec(): ShapeSpec | null {
    const drag = this.shapeDrag;
    if (!drag) return null;
    return { kind: drag.kind, from: [drag.fromX, drag.fromY], to: [drag.toX, drag.toY] };
  }

  /**
   * Commit the shape drag as ONE stroke (and therefore one undo step), or nothing at all when
   * the drag never left the press point.
   */
  endShape(): Stroke | null {
    const drag = this.shapeDrag;
    this.shapeDrag = null;
    this.activeDirty = true;
    this.requestRender();
    if (!drag) return null;
    if (!isShapeDragMeaningful(drag.fromX, drag.fromY, drag.toX, drag.toY)) return null;
    const tools = this.toolManager;
    const stroke = createShapeStroke(
      { kind: drag.kind, from: [drag.fromX, drag.fromY], to: [drag.toX, drag.toY] },
      {
        color: tools.activeColor,
        size: tools.activeSize,
        opacity: tools.activeOpacity,
        tool: tools.activeTool === 'highlighter' ? 'highlighter' : 'pen',
      },
      crypto.randomUUID(),
      Date.now(),
    );
    this.strokeManager.addStroke(stroke);
    this.staticDirty = true;
    this.requestRender();
    return stroke;
  }

  /** Abandon a shape drag (pointercancel, tool switch) without committing anything. */
  cancelShape(): void {
    if (!this.shapeDrag) return;
    this.shapeDrag = null;
    this.activeDirty = true;
    this.requestRender();
  }

  isShaping(): boolean {
    return this.shapeDrag !== null;
  }

  /** Set (or clear) the selection overlay. Repaints the ACTIVE layer only. */
  setSelectionChrome(chrome: SelectionChrome | null): void {
    this.selectionChrome = chrome;
    this.selectedIds = new Set(chrome?.strokeIds ?? []);
    this.activeDirty = true;
    this.requestRender();
  }

  /**
   * Hide strokes from the static layer (they are being dragged and the active layer draws
   * them). Costs one static repaint when the set changes, and none while the drag runs.
   */
  setHiddenStrokes(ids: readonly string[]): void {
    if (ids.length === 0 && this.hiddenIds.size === 0) return;
    this.hiddenIds = new Set(ids);
    this.staticDirty = true;
    this.requestRender();
  }

  render(): void {
    if (this.staticDirty) {
      this.renderStatic();
      this.staticDirty = false;
    }
    if (this.activeDirty) {
      this.renderActive();
      this.activeDirty = false;
    }
    this.rafId = 0;
  }

  requestRender(): void {
    if (this.rafId !== 0) return;
    this.rafId = window.requestAnimationFrame(() => this.render());
  }

  exportThumbnail(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const bounds = this.getContentBounds();
      if (bounds.width === 0 || bounds.height === 0) {
        resolve(null);
        return;
      }

      const thumbCanvas = createEl('canvas');
      const maxSize = 256;
      const scale = Math.min(maxSize / bounds.width, maxSize / bounds.height);
      thumbCanvas.width = Math.ceil(bounds.width * scale);
      thumbCanvas.height = Math.ceil(bounds.height * scale);

      const ctx = thumbCanvas.getContext('2d')!;
      ctx.scale(scale, scale);
      ctx.translate(-bounds.x, -bounds.y);
      this.renderStrokes(ctx, this.strokeManager.strokes);

      thumbCanvas.toBlob((blob) => resolve(blob));
    });
  }

  getContentBounds(): { x: number; y: number; width: number; height: number } {
    const strokes = this.strokeManager.strokes;
    if (strokes.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxSize = 0;

    for (const stroke of strokes) {
      if (stroke.size > maxSize) maxSize = stroke.size;
      for (const point of stroke.points) {
        if (point[0] < minX) minX = point[0];
        if (point[1] < minY) minY = point[1];
        if (point[0] > maxX) maxX = point[0];
        if (point[1] > maxY) maxY = point[1];
      }
    }

    const pad = maxSize / 2;
    return {
      x: minX - pad,
      y: minY - pad,
      width: (maxX - minX) + maxSize,
      height: (maxY - minY) + maxSize,
    };
  }


  setCanvasSize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.drawingWidth = width;
    this.drawingHeight = height;
    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;
    this.staticCanvas.width = width * dpr;
    this.staticCanvas.height = height * dpr;
    this.activeCanvas.width = width * dpr;
    this.activeCanvas.height = height * dpr;
    this.staticDirty = true;
    this.activeDirty = true;
    this.requestRender();
    this.notifyViewChange();
  }

  /** Size the backing store to the display box (CSS px) and recompute the view. */
  setDisplaySize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.displayWidth = width;
    this.displayHeight = height;
    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;
    this.staticCanvas.width = width * dpr;
    this.staticCanvas.height = height * dpr;
    this.activeCanvas.width = width * dpr;
    this.activeCanvas.height = height * dpr;
    this.recomputeView();
    this.staticDirty = true;
    this.activeDirty = true;
    this.requestRender();
    this.notifyViewChange();
  }

  /**
   * Standalone view: size the backing store to a CSS box and centre the content at
   * scale 1 (no zoom). Empty content centres the drawing-space origin in the box.
   */
  centerInBox(boxW: number, boxH: number): void {
    if (boxW <= 0 || boxH <= 0) return;
    this.resizeBackingStore(boxW, boxH);
    const b = this.getContentBounds();
    this.contentBounds = (b.width > 0 && b.height > 0) ? b : null;
    this.view = centerContentInBox({ width: boxW, height: boxH }, this.contentBounds);
    this.staticDirty = true;
    this.activeDirty = true;
    this.requestRender();
    this.notifyViewChange();
  }

  /**
   * Replace the view transform wholesale (presentation-facing pan/zoom). `scale` is clamped
   * to [MIN_SCALE, MAX_SCALE]; the render pipeline is untouched (it still composes
   * `view.scale`/`view.offset` with DPR). Marks both layers dirty and requests a render.
   */
  setView(view: ViewTransform): void {
    this.view = {
      scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale)),
      offsetX: view.offsetX,
      offsetY: view.offsetY,
    };
    this.staticDirty = true;
    this.activeDirty = true;
    this.requestRender();
    this.notifyViewChange();
  }

  /** Translate the view offset by (dx, dy) display px without changing the scale. */
  panBy(dx: number, dy: number): void {
    this.view = { scale: this.view.scale, offsetX: this.view.offsetX + dx, offsetY: this.view.offsetY + dy };
    this.staticDirty = true;
    this.activeDirty = true;
    this.requestRender();
    this.notifyViewChange();
  }

  /**
   * Focal-point zoom: scale by `factor` about the box-local point (cx, cy), clamped to
   * [MIN_SCALE, MAX_SCALE], keeping the content under (cx, cy) fixed on screen.
   */
  zoomAt(factor: number, cx: number, cy: number): void {
    const scale = this.view.scale;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    this.view = {
      scale: newScale,
      offsetX: cx - (cx - this.view.offsetX) / scale * newScale,
      offsetY: cy - (cy - this.view.offsetY) / scale * newScale,
    };
    this.staticDirty = true;
    this.activeDirty = true;
    this.requestRender();
    this.notifyViewChange();
  }

  /** Resize the backing store to a CSS box without changing the view transform. */
  resizeBox(boxW: number, boxH: number): void {
    if (boxW <= 0 || boxH <= 0) return;
    this.resizeBackingStore(boxW, boxH);
    this.staticDirty = true;
    this.activeDirty = true;
    this.requestRender();
    this.notifyViewChange();
  }

  private resizeBackingStore(boxW: number, boxH: number): void {
    this.displayWidth = boxW;
    this.displayHeight = boxH;
    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;
    this.staticCanvas.width = boxW * dpr;
    this.staticCanvas.height = boxH * dpr;
    this.activeCanvas.width = boxW * dpr;
    this.activeCanvas.height = boxH * dpr;
  }

  /** Recompute the content bbox from current strokes and re-fit. Call on idle, NOT mid-stroke. */
  refitToContent(padding = 0): void {
    const b = this.getContentBounds();
    this.contentBounds = (b.width > 0 && b.height > 0) ? b : null;
    this.recomputeView(padding);
    this.staticDirty = true;
    this.activeDirty = true;
    this.requestRender();
    this.notifyViewChange();
  }

  /**
   * Fit content to the display box using an explicit caller-supplied reference size
   * (the file's saved `width`/`height`) instead of the live recomputed content bounds.
   *
   * The reference rectangle is anchored at the live content origin but takes its
   * DIMENSIONS from the caller, so the resulting scale is `min(boxW/refW, boxH/refH)`
   * regardless of how the content has since grown. Because the saved dimensions are the
   * stable description of the drawing at save time, fitting against them reproduces the
   * same scale across a save→reload round trip — existing strokes keep their on-screen
   * size when an embedded surface is unmounted and remounted after an edit (B3). Anchoring
   * at the live origin makes the content's top-left land at the same screen position too,
   * since the origin cancels in the letterbox offset. Like refitToContent/resizeBox, apply
   * this on layout/resize only, never per stroke.
   */
  fitReferenceSize(refWidth: number, refHeight: number, padding = 0, maxScale = Infinity): void {
    const b = this.getContentBounds();
    const hasContent = b.width > 0 && b.height > 0;
    const reference = (refWidth > 0 && refHeight > 0)
      ? { x: hasContent ? b.x : 0, y: hasContent ? b.y : 0, width: refWidth, height: refHeight }
      : null;
    this.contentBounds = reference;
    this.view = fitContentToBox(
      { width: this.displayWidth || this.drawingWidth, height: this.displayHeight || this.drawingHeight },
      reference,
      padding,
      maxScale,
    );
    this.staticDirty = true;
    this.activeDirty = true;
    this.requestRender();
    this.notifyViewChange();
  }

  private recomputeView(padding = 0): void {
    this.view = fitContentToBox(
      { width: this.displayWidth || this.drawingWidth, height: this.displayHeight || this.drawingHeight },
      this.contentBounds,
      padding,
    );
  }

  /** Subscribe to view-transform / display-size changes. Returns an unsubscribe function. */
  onViewChange(cb: () => void): () => void {
    this.viewListeners.add(cb);
    return () => { this.viewListeners.delete(cb); };
  }

  private notifyViewChange(): void {
    for (const cb of this.viewListeners) cb();
  }

  getViewTransform(): ViewTransform {
    return { ...this.view };
  }

  /**
   * Map a pointer event to drawing-space coordinates. `el` must be the same element
   * whose layout size drives `setDisplaySize`. Divides by rect.width/height before
   * inverting the view transform to compensate for any CSS zoom applied by
   * Obsidian Canvas (pointer offsets are in rendered px, not layout px).
   */
  screenToDrawing(clientX: number, clientY: number, el: HTMLElement, cachedRect?: DOMRect): [number, number] {
    const rect = cachedRect ?? el.getBoundingClientRect();
    const sx = rect.width ? el.clientWidth / rect.width : 1;
    const sy = rect.height ? el.clientHeight / rect.height : 1;
    const p = screenToContent((clientX - rect.left) * sx, (clientY - rect.top) * sy, this.view);
    return [p.x, p.y];
  }

  destroy(): void {
    if (this.rafId !== 0) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.viewListeners.clear();
    this.staticCanvas.remove();
    this.activeCanvas.remove();
  }

  private renderStatic(): void {
    const ctx = this.staticCtx;
    const w = this.staticCanvas.width;
    const h = this.staticCanvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.restore();

    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;
    ctx.save();
    ctx.setTransform(dpr * this.view.scale, 0, 0, dpr * this.view.scale, dpr * this.view.offsetX, dpr * this.view.offsetY);

    // Two ordered passes over the one array instead of two filter() allocations per frame.
    // Pen first, then the highlighter under it via destination-over — identical draw order.
    const strokes = this.strokeManager.strokes;
    const hidden = this.hiddenIds;
    for (const stroke of strokes) {
      if (stroke.tool === 'pen' && !hidden.has(stroke.id)) this.renderSingleStroke(ctx, stroke);
    }

    ctx.globalCompositeOperation = 'destination-over';
    for (const stroke of strokes) {
      if (stroke.tool === 'highlighter' && !hidden.has(stroke.id)) this.renderSingleStroke(ctx, stroke);
    }

    ctx.restore();
  }

  private renderActive(): void {
    const ctx = this.activeCtx;
    const w = this.activeCanvas.width;
    const h = this.activeCanvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.restore();

    const spec = this.shapeSpec();
    if (this.activePoints.length < 1 && !spec && !this.selectionChrome) return;

    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;
    ctx.save();
    ctx.setTransform(dpr * this.view.scale, 0, 0, dpr * this.view.scale, dpr * this.view.offsetX, dpr * this.view.offsetY);

    if (this.activePoints.length >= 1) {
      const outlinePoints = getStroke(this.activePoints, {
        size: this.toolManager.activeSize,
        thinning: 0.5,
        simulatePressure: !this.activePoints.some(p => p[2] !== 0.5),
      });
      ctx.globalAlpha = this.toolManager.activeOpacity;
      ctx.fillStyle = this.toolManager.activeColor;
      this.fillOutline(ctx, outlinePoints);
    }

    if (spec) {
      // The preview is solved on the active layer exactly like a freehand stroke: once per
      // frame, never per pointer sample, and the static layer is not touched at all.
      const outlinePoints = getStroke(shapeStrokePoints(spec), {
        size: this.toolManager.activeSize,
        thinning: 0.5,
        simulatePressure: false,
      });
      ctx.globalAlpha = this.toolManager.activeOpacity;
      ctx.fillStyle = this.toolManager.activeColor;
      this.fillOutline(ctx, outlinePoints);
    }

    if (this.selectionChrome) this.renderSelectionChrome(ctx, this.selectionChrome);

    ctx.restore();
  }

  /**
   * The selection overlay: every selected stroke re-filled in the accent colour (from its
   * CACHED Path2D — nothing is re-tessellated), a dashed box around the selection, and the
   * rubber band itself. Dash lengths and line widths are divided by the view scale so they
   * stay constant on screen at any zoom.
   */
  private renderSelectionChrome(ctx: CanvasRenderingContext2D, chrome: SelectionChrome): void {
    const scale = this.view.scale || 1;
    const line = 1.5 / scale;

    if (this.selectedIds.size > 0) {
      ctx.save();
      if (chrome.dx !== 0 || chrome.dy !== 0) ctx.translate(chrome.dx, chrome.dy);
      ctx.globalAlpha = 1;
      for (const stroke of this.strokeManager.strokes) {
        if (!this.selectedIds.has(stroke.id)) continue;
        const path = this.strokePath(stroke);
        if (!path) continue;
        ctx.globalAlpha = stroke.opacity;
        ctx.fillStyle = stroke.color;
        ctx.fill(path);
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = SELECTION_ACCENT;
        ctx.fill(path);
      }
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    ctx.strokeStyle = SELECTION_ACCENT;
    ctx.lineWidth = line;
    if (chrome.bounds) {
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.strokeRect(
        chrome.bounds.x + chrome.dx - line,
        chrome.bounds.y + chrome.dy - line,
        chrome.bounds.width + line * 2,
        chrome.bounds.height + line * 2,
      );
    }
    if (chrome.marquee) {
      ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = SELECTION_ACCENT;
      ctx.fillRect(chrome.marquee.x, chrome.marquee.y, chrome.marquee.width, chrome.marquee.height);
      ctx.globalAlpha = 1;
      ctx.strokeRect(chrome.marquee.x, chrome.marquee.y, chrome.marquee.width, chrome.marquee.height);
    }
    ctx.setLineDash([]);
  }

  private renderStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]): void {
    for (const stroke of strokes) {
      if (stroke.tool === 'pen') this.renderSingleStroke(ctx, stroke);
    }
    for (const stroke of strokes) {
      if (stroke.tool === 'highlighter') this.renderSingleStroke(ctx, stroke);
    }
  }

  private renderSingleStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
    if (stroke.points.length < 1) return;
    const path = this.strokePath(stroke);
    if (!path) return;
    ctx.globalAlpha = stroke.opacity;
    ctx.fillStyle = stroke.color;
    ctx.fill(path);
  }

  /**
   * The stroke's outline as a cached `Path2D`. Built by exactly the same point walk as
   * `fillOutline`, so a cached committed stroke and the live uncached one paint identically.
   */
  private strokePath(stroke: Stroke): Path2D | null {
    const epoch = strokeEpoch(stroke);
    const cached = pathCache.get(stroke);
    if (
      cached &&
      cached.points === stroke.points &&
      cached.length === stroke.points.length &&
      cached.size === stroke.size &&
      cached.hasPressure === stroke.hasPressure &&
      cached.epoch === epoch
    ) {
      return cached.path;
    }

    const outlinePoints = getStroke(stroke.points, {
      size: stroke.size,
      thinning: 0.5,
      simulatePressure: !stroke.hasPressure,
    });
    const path = this.buildPath(outlinePoints);
    pathCache.set(stroke, {
      points: stroke.points,
      length: stroke.points.length,
      size: stroke.size,
      hasPressure: stroke.hasPressure,
      epoch,
      path,
    });
    return path;
  }

  /** The outline walk, emitted into a Path2D. Mirrors `fillOutline` exactly. */
  private buildPath(points: number[][]): Path2D | null {
    if (points.length === 0) return null;
    const path = new Path2D();
    path.moveTo(points[0][0], points[0][1]);

    if (points.length < 3) {
      for (let i = 1; i < points.length; i++) {
        path.lineTo(points[i][0], points[i][1]);
      }
    } else {
      path.lineTo((points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2);
      for (let i = 1; i < points.length - 1; i++) {
        const nextMidX = (points[i][0] + points[i + 1][0]) / 2;
        const nextMidY = (points[i][1] + points[i + 1][1]) / 2;
        path.quadraticCurveTo(points[i][0], points[i][1], nextMidX, nextMidY);
      }
      const last = points[points.length - 1];
      path.lineTo(last[0], last[1]);
    }

    path.closePath();
    return path;
  }

  /** Direct-to-context outline fill, used only for the in-progress (uncached) stroke. */
  private fillOutline(ctx: CanvasRenderingContext2D, points: number[][]): void {
    if (points.length === 0) return;

    ctx.beginPath();

    if (points.length < 3) {
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
    } else {
      ctx.moveTo(points[0][0], points[0][1]);

      let midX = (points[0][0] + points[1][0]) / 2;
      let midY = (points[0][1] + points[1][1]) / 2;
      ctx.lineTo(midX, midY);

      for (let i = 1; i < points.length - 1; i++) {
        const nextMidX = (points[i][0] + points[i + 1][0]) / 2;
        const nextMidY = (points[i][1] + points[i + 1][1]) / 2;
        ctx.quadraticCurveTo(points[i][0], points[i][1], nextMidX, nextMidY);
      }

      const last = points[points.length - 1];
      ctx.lineTo(last[0], last[1]);
    }

    ctx.closePath();
    ctx.fill();
  }
}
