import { MarkdownView, Notice, type App, type Editor, type EditorPosition } from 'obsidian';
import type { PluginSettings } from '../domain/entities';
import type { IDrawingRepository } from '../domain/ports';
import type { CreateDrawingUseCase } from '../application/use-cases/create-drawing';
import {
  clamp,
  commitSize,
  isBelowMinimum,
  isPointInside,
  selectionRect,
  type SelectionRect,
} from './area-selection-rect';

/** Below this drag distance the gesture is a click, not an area selection. */
const DRAG_THRESHOLD = 6;
/** Attempts to find the freshly inserted embed in order to focus it. */
const FOCUS_ATTEMPTS = 12;
const FOCUS_INTERVAL_MS = 100;

export interface AreaSelectionDeps {
  app: App;
  settings: PluginSettings;
  createDrawing: CreateDrawingUseCase;
  repo: IDrawingRepository;
}

/** Map a viewport point to an editor position, falling back to the caret. */
function editorPositionAt(view: MarkdownView, x: number, y: number): EditorPosition {
  const editor = view.editor as Editor & { cm?: { posAtCoords?(c: { x: number; y: number }, precise?: boolean): number | null } };
  try {
    const cm = editor.cm;
    if (cm?.posAtCoords && typeof editor.offsetToPos === 'function') {
      const offset = cm.posAtCoords({ x, y }, false);
      if (typeof offset === 'number') return editor.offsetToPos(offset);
    }
  } catch {
    // CodeMirror internals are not API; any failure just means "use the caret".
  }
  return editor.getCursor();
}

/**
 * Move focus into the drawing we just inserted, once Obsidian has rendered its embed.
 * Bounded: it gives up rather than polling forever if the embed never materialises.
 */
function focusInsertedDrawing(view: MarkdownView, fileName: string): void {
  const win = view.contentEl.ownerDocument.defaultView ?? window;
  let attempts = 0;
  const tick = () => {
    attempts++;
    const embeds = Array.from(view.contentEl.querySelectorAll<HTMLElement>('.internal-embed'));
    const embed = embeds.find((el) => {
      const src = el.getAttribute('src') ?? '';
      return src === fileName || src.endsWith('/' + fileName);
    });
    const drawing = embed?.querySelector<HTMLElement>('.blackboard-drawing-container');
    if (drawing) {
      drawing.setAttribute('tabindex', '-1');
      drawing.focus({ preventScroll: true });
      return;
    }
    if (attempts < FOCUS_ATTEMPTS) win.setTimeout(tick, FOCUS_INTERVAL_MS);
  };
  win.setTimeout(tick, 0);
}

async function createAndInsert(
  deps: AreaSelectionDeps,
  view: MarkdownView,
  rect: SelectionRect,
  position: EditorPosition,
): Promise<void> {
  const editor = view.editor;
  const { width, height } = commitSize(rect);
  let drawingPath: string | null = null;
  try {
    drawingPath = await deps.createDrawing.execute(deps.settings, 'fixed');
    const loaded = await deps.repo.load(drawingPath);
    // Persist the chosen size as the drawing's own dimensions, so the embed and the file
    // agree even if the `|WxH` alias is later edited away.
    await deps.repo.save(drawingPath, { ...loaded.file, width, height });
    const fileName = drawingPath.split('/').pop() ?? drawingPath;
    const safeLine = clamp(position.line, 0, Math.max(0, editor.lineCount() - 1));
    editor.replaceRange(`![[${fileName}|${width}x${height}]]\n`, { line: safeLine, ch: 0 });
    focusInsertedDrawing(view, fileName);
  } catch {
    // Never leave an orphan drawing behind when the insertion itself failed.
    if (drawingPath) {
      try { await deps.repo.delete(drawingPath); } catch { /* nothing more we can do */ }
    }
    new Notice('Blackboard could not create the selected drawing area.');
  }
}

/**
 * Start an area selection in the active Markdown note: the user drags a rectangle and a
 * correspondingly sized drawing embed is inserted there.
 *
 * Returns a cancel function; calling it (Escape, a second invocation, plugin unload) removes
 * the preview and every listener.
 */
export function beginAreaSelection(deps: AreaSelectionDeps): () => void {
  const view = deps.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view || view.getMode() !== 'source' || !view.editor) {
    new Notice('Open an editable Markdown note to draw a blackboard area.');
    return () => {};
  }

  const doc = view.contentEl.ownerDocument;
  const win = doc.defaultView ?? window;
  const editorSurface =
    view.contentEl.querySelector<HTMLElement>('.markdown-source-view .cm-scroller') ??
    view.contentEl.querySelector<HTMLElement>('.cm-scroller');
  if (!editorSurface) {
    new Notice('Blackboard area selection requires live preview or source mode.');
    return () => {};
  }

  const abort = new AbortController();
  const signal = abort.signal;
  const preview = doc.body.createDiv({ cls: 'blackboard-area-selection-preview' });
  preview.hidden = true;
  view.contentEl.addClass('blackboard-area-selecting');

  let started = false;
  let finished = false;
  let pointerId: number | null = null;
  let start = { x: 0, y: 0 };
  let currentRect: SelectionRect | null = null;

  const bounds = () => {
    const r = editorSurface.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };

  const updatePreview = (rect: SelectionRect) => {
    preview.hidden = false;
    // Transform, not left/top: the preview moves on every pointermove, and a transform keeps
    // each of those frames compositor-only.
    preview.style.transform = `translate(${Math.round(rect.left)}px,${Math.round(rect.top)}px)`;
    preview.style.width = `${rect.width}px`;
    preview.style.height = `${rect.height}px`;
    // The rectangle always tracks the pointer exactly; a drag below the minimum is shown as
    // such instead of being silently clamped (which made the preview stop following).
    preview.classList.toggle('is-below-min', isBelowMinimum(rect));
    preview.dataset.size = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  };

  const cleanup = () => {
    if (finished) return;
    finished = true;
    abort.abort();
    preview.remove();
    view.contentEl.removeClass('blackboard-area-selecting');
    for (const stale of Array.from(doc.querySelectorAll('.blackboard-area-selecting'))) {
      stale.removeClass('blackboard-area-selecting');
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button === 2) { event.preventDefault(); cleanup(); return; }
    if (event.button !== 0) return;
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    const b = bounds();
    if (!isPointInside(b, event.clientX, event.clientY)) return;
    started = true;
    pointerId = event.pointerId;
    start = { x: clamp(event.clientX, b.left, b.right), y: clamp(event.clientY, b.top, b.bottom) };
    currentRect = selectionRect(start, start, b);
    updatePreview(currentRect);
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!started || event.pointerId !== pointerId) return;
    const b = bounds();
    const current = {
      x: clamp(event.clientX, b.left, b.right),
      y: clamp(event.clientY, b.top, b.bottom),
    };
    currentRect = selectionRect(start, current, b);
    updatePreview(currentRect);
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!started || event.pointerId !== pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved < DRAG_THRESHOLD || !currentRect) {
      cleanup();
      new Notice('Drag a rectangle to create a blackboard drawing area.');
      return;
    }
    const rect = currentRect;
    const position = editorPositionAt(
      view,
      rect.left + Math.min(12, rect.width / 2),
      rect.top + Math.min(12, rect.height / 2),
    );
    cleanup();
    void createAndInsert(deps, view, rect, position);
  };

  const onCancel = () => cleanup();
  const onContextMenu = (event: Event) => { event.preventDefault(); cleanup(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
  };

  doc.addEventListener('pointerdown', onPointerDown, { capture: true, signal });
  doc.addEventListener('pointermove', onPointerMove, { capture: true, signal });
  doc.addEventListener('pointerup', onPointerUp, { capture: true, signal });
  doc.addEventListener('pointercancel', onCancel, { capture: true, signal });
  doc.addEventListener('contextmenu', onContextMenu, { capture: true, signal });
  doc.addEventListener('keydown', onKeyDown, { capture: true, signal });
  editorSurface.addEventListener('scroll', onCancel, { capture: true, signal });
  win.addEventListener('blur', onCancel, { capture: true, signal });

  new Notice('Drag in the note to choose the blackboard drawing area. Esc cancels.');
  return cleanup;
}
