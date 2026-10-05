import { MarkdownView, Notice, type App } from 'obsidian';
import { findEmbedLinks, parseEmbedAlias, planEmbedLayoutEdit, type EmbedLayout } from './embed-size';
import { noteBlocks, movableBlock, planEmbedMove, moveTargetAt } from './embed-move';
import { hostMarkdownView, editableNote, resolveEmbedLink, commitNoteEdit, noteCM } from './embed-note';
import { applyEmbedLayout, watchEmbedLayout } from './embed-layout';

let activeBoard: HTMLElement | null = null;
export function setActiveNoteBoard(el: HTMLElement | null): void {
  activeBoard?.classList.remove('bb-board-active');
  activeBoard = el?.closest<HTMLElement>('.blackboard-embed') ?? null;
  activeBoard?.classList.add('bb-board-active');
}

function boardOccurrence(app: App, view: MarkdownView, source: string, el?: HTMLElement, path?: string): number {
  const links = findEmbedLinks(source);
  if (el && path) {
    const link = resolveEmbedLink(app, view, el, path, source);
    return link ? links.findIndex(m => m.start === link.start) : -1;
  }
  const cursor = view.editor.posToOffset(view.editor.getCursor());
  return links.findIndex(link => {
    const start = source.lastIndexOf('\n', link.start - 1) + 1;
    const end = source.indexOf('\n', link.end);
    return cursor >= start && cursor <= (end < 0 ? source.length : end);
  });
}

function refuse(): void { new Notice('Blackboard: use a standalone embed in an editable note; ambiguous or unsafe moves are refused.'); }

function moveBoard(app: App, view: MarkdownView, direction: -1 | 1, el?: HTMLElement, path?: string): void {
  if (!editableNote(view)) { refuse(); return; }
  const source = view.editor.getValue();
  const occurrence = boardOccurrence(app, view, source, el, path);
  const index = movableBlock(source, occurrence);
  if (index < 0) { refuse(); return; }
  const target = direction < 0 ? index - 1 : index + 2;
  if (target < 0 || target > noteBlocks(source).length) return;
  const edit = planEmbedMove(source, occurrence, target);
  if (!edit) { refuse(); return; }
  if (commitNoteEdit(view, source, edit, edit.boardStart)) setActiveNoteBoard(null);
}

export function moveActiveBoard(app: App, direction: -1 | 1): void {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) { refuse(); return; }
  const el = activeBoard && view.contentEl.contains(activeBoard) ? activeBoard : undefined;
  const src = el?.getAttribute('src');
  const path = src ? app.metadataCache.getFirstLinkpathDest(src, view.file?.path ?? '')?.path : undefined;
  moveBoard(app, view, direction, el, path);
}

export function attachBoardControls(app: App, el: HTMLElement, path: string, signal: AbortSignal, activate: () => void): () => void {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  const controls = el.createDiv({ cls: 'bb-frame-controls' });
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Board position and text wrap');
  controls.addEventListener('pointerdown', e => { e.stopPropagation(); activate(); setActiveNoteBoard(el); }, { signal });
  controls.addEventListener('click', e => e.stopPropagation(), { signal });
  controls.addEventListener('focusin', () => { activate(); setActiveNoteBoard(el); refresh(); }, { signal });
  const button = (text: string, title: string, action?: () => void) => {
    const b = controls.createEl('button');
    b.type = 'button'; b.textContent = text; b.title = title; b.setAttribute('aria-label', title);
    if (action) b.addEventListener('click', action, { signal });
    return b;
  };
  const grip = button('⠿', 'Drag to move board');
  grip.classList.add('bb-move-grip');
  const up = button('▲', 'Move board up', () => { const view = hostMarkdownView(app, el); if (view) moveBoard(app, view, -1, el, path); });
  const down = button('▼', 'Move board down', () => { const view = hostMarkdownView(app, el); if (view) moveBoard(app, view, 1, el, path); });
  const layouts = (['center', 'left', 'right'] as EmbedLayout[]).map(layout => button(
    layout === 'center' ? '↔' : layout === 'left' ? '◧' : '◨',
    layout === 'center' ? 'Inline (center)' : layout === 'left' ? 'Left, text wraps right' : 'Right, text wraps left',
    () => {
      const view = hostMarkdownView(app, el);
      if (!editableNote(view)) { refuse(); return; }
      const source = view.editor.getValue();
      const link = resolveEmbedLink(app, view, el, path, source);
      if (!link || parseEmbedAlias(link.alias).ambiguous) { refuse(); return; }
      const edit = planEmbedLayoutEdit(source, p => p === link.linkpath, layout,
        findEmbedLinks(source).filter(m => m.linkpath === link.linkpath).findIndex(m => m.start === link.start));
      if (edit && commitNoteEdit(view, source, edit)) {
        applyEmbedLayout(el, parseEmbedAlias(findEmbedLinks(edit.source).find(m => m.start === link.start)?.alias));
        refresh();
      }
    }));
  function refresh() {
    const view = hostMarkdownView(app, el);
    const editable = editableNote(view);
    for (const b of [grip, up, down]) b.hidden = !editable;
    let movable = false;
    if (editable) {
      const source = view.editor.getValue();
      movable = movableBlock(source, boardOccurrence(app, view, source, el, path)) >= 0;
    }
    for (const b of [grip, up, down]) {
      b.disabled = !movable;
      if (!movable) b.title = 'Moving requires an unambiguous embed on its own line, outside nested or protected blocks.';
    }
    for (let index = 0; index < layouts.length; index++) {
      layouts[index].disabled = !editable;
      layouts[index].setAttribute('aria-pressed', String((el.dataset.bbLayout ?? 'center') === ['center', 'left', 'right'][index]));
    }
  }
  refresh();
  el.addEventListener('pointerenter', refresh, { signal });
  const stopLayout = watchEmbedLayout(el);
  const indicator = doc.body.createDiv();
  indicator.className = 'bb-drop-indicator'; indicator.hidden = true;
  let drag: { view: MarkdownView; source: string; occurrence: number; pointer: number; target: number | null; self: boolean; x: number; y: number; moved: boolean; startX: number; startY: number } | null = null;
  let frame: number | null = null;
  const cancel = () => {
    const pointer = drag?.pointer;
    drag = null; indicator.hidden = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    if (pointer !== undefined) { try { grip.releasePointerCapture(pointer); } catch { /* already released */ } }
  };
  const tick = () => {
    frame = null;
    if (!drag) return;
    const { view, source, x, y } = drag;
    indicator.hidden = true; drag.target = null; drag.self = false;
    if (view.editor.getValue() !== source || !editableNote(view)) { cancel(); refuse(); return; }
    const cm = noteCM(view.editor);
    const pane = cm?.scrollDOM;
    if (!cm?.posAtCoords || !pane) { cancel(); refuse(); return; }
    const rect = pane.getBoundingClientRect();
    if (drag.moved && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const delta = y < rect.top + 40 ? -12 : y > rect.bottom - 40 ? 12 : 0;
      if (delta) pane.scrollTop += delta;
      const pos = cm.posAtCoords({ x, y }, false);
      if (pos !== null) {
        const line = cm.lineBlockAt?.(pos);
        const top = line && cm.documentTop !== undefined ? line.top + cm.documentTop : cm.coordsAtPos?.(pos)?.top;
        const bottom = line && cm.documentTop !== undefined ? line.bottom + cm.documentTop : cm.coordsAtPos?.(pos)?.bottom;
        if (top !== undefined && bottom !== undefined) {
          const target = moveTargetAt(source, pos, y > (top + bottom) / 2);
          const from = movableBlock(source, drag.occurrence);
          drag.self = target === from || target === from + 1;
          if (target !== null && planEmbedMove(source, drag.occurrence, target)) {
            const blocks = noteBlocks(source);
            const boundary = target < blocks.length ? blocks[target].start : blocks[blocks.length - 1].end;
            const coords = cm.coordsAtPos?.(boundary, target < blocks.length ? 1 : -1);
            if (coords) {
              drag.target = target;
              indicator.style.left = `${rect.left}px`; indicator.style.width = `${rect.width}px`;
              indicator.style.top = `${target < blocks.length ? coords.top : coords.bottom}px`; indicator.hidden = false;
            }
          }
        }
      }
    }
    frame = win.requestAnimationFrame(tick);
  };
  grip.addEventListener('pointerdown', e => {
    if (grip.disabled || !e.isPrimary || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const view = hostMarkdownView(app, el);
    if (!editableNote(view)) { refuse(); return; }
    const source = view.editor.getValue();
    const occurrence = boardOccurrence(app, view, source, el, path);
    if (movableBlock(source, occurrence) < 0) { refuse(); return; }
    drag = { view, source, occurrence, pointer: e.pointerId, target: null, self: false, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
    try { grip.setPointerCapture(e.pointerId); } catch { cancel(); refuse(); return; }
    frame = win.requestAnimationFrame(tick);
  }, { signal });
  grip.addEventListener('pointermove', e => {
    if (drag?.pointer !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved ||= Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= 5;
  }, { signal });
  grip.addEventListener('pointerup', e => {
    if (drag?.pointer !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    // Recompute with the release coordinates, including protected-zone refusals.
    drag.x = e.clientX; drag.y = e.clientY;
    if (frame !== null) win.cancelAnimationFrame(frame);
    tick();
    const state = drag;
    cancel();
    if (!state || !state.moved) return;
    if (state.target === null) { if (!state.self) refuse(); return; }
    const edit = planEmbedMove(state.source, state.occurrence, state.target);
    if (edit && commitNoteEdit(state.view, state.source, edit, edit.boardStart)) setActiveNoteBoard(null);
  }, { signal });
  grip.addEventListener('pointercancel', cancel, { signal });
  grip.addEventListener('lostpointercapture', cancel, { signal });
  doc.addEventListener('keydown', e => { if (drag && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } }, { capture: true, signal });
  return () => { cancel(); controls.remove(); indicator.remove(); stopLayout(); if (activeBoard === el) setActiveNoteBoard(null); };
}
