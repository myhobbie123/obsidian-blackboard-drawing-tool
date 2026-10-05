import { MarkdownView, Menu, Notice, type App } from 'obsidian';
import { findEmbedLinks, findEmbedTokens, parseEmbedAlias, type EmbedLayout } from './embed-size';
import { noteBlocks, movableBlock, planEmbedMove, planEmbedStep, planEmbedOwnLine, planEmbedWrap, inspectEmbedMove, embedRefusalAtCursor, MOVE_MESSAGES, moveTargetAt, type MoveRefusal } from './embed-move';
import { hostMarkdownView, editableNote, resolveEmbedLink, commitNoteEdit, noteCM } from './embed-note';
import { applyEmbedLayout, watchEmbedLayout } from './embed-layout';
import { attachPaneTooltip } from './embed-tooltip';

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
  const raw = findEmbedTokens(source).find(link => cursor >= link.start && cursor < link.end);
  if (raw) return links.findIndex(link => link.start === raw.start);
  const exact = links.findIndex(link => cursor >= link.start && cursor < link.end);
  if (exact >= 0) return exact;
  const onLine = links.filter(link => {
    const start = source.lastIndexOf('\n', link.start - 1) + 1;
    const end = source.indexOf('\n', link.end);
    return cursor >= start && cursor <= (end < 0 ? source.length : end);
  });
  return onLine.length === 1 ? links.indexOf(onLine[0]) : -1;
}

function refuse(reason?: MoveRefusal): void { new Notice('Blackboard: ' + (reason ? MOVE_MESSAGES[reason] : 'Open an editable note in Live Preview or Source mode and choose a board. Drop only between top-level blocks.')); }

function sourceRefusal(source: string, occurrence: number): void {
  const info = inspectEmbedMove(source, occurrence);
  refuse('reason' in info ? info.reason : 'ambiguous');
}

function moveBoard(app: App, view: MarkdownView, direction: -1 | 1, el?: HTMLElement, path?: string): void {
  if (!editableNote(view)) { refuse(); return; }
  const source = view.editor.getValue();
  const occurrence = boardOccurrence(app, view, source, el, path);
  const info = inspectEmbedMove(source, occurrence);
  if ('reason' in info) { refuse(!el && info.reason === 'ambiguous' ? embedRefusalAtCursor(source, view.editor.posToOffset(view.editor.getCursor())) : info.reason); return; }
  const edit = planEmbedStep(source, occurrence, direction);
  if (!edit) {
    new Notice(direction < 0
      ? 'Blackboard: this board is already at the first movable block. Use Move down or drag it to another gap.'
      : 'Blackboard: this board is already at the last block. Use Move up or drag it to another gap.');
    return;
  }
  if (commitNoteEdit(view, source, edit, edit.boardStart)) setActiveNoteBoard(null);
}

function ownLine(app: App, view: MarkdownView, el?: HTMLElement, path?: string): void {
  if (!editableNote(view)) { refuse(); return; }
  const source = view.editor.getValue();
  const occurrence = boardOccurrence(app, view, source, el, path);
  const info = inspectEmbedMove(source, occurrence);
  if ('reason' in info) { refuse(!el && info.reason === 'ambiguous' ? embedRefusalAtCursor(source, view.editor.posToOffset(view.editor.getCursor())) : info.reason); return; }
  const edit = planEmbedOwnLine(source, occurrence);
  if (!edit) { new Notice('Blackboard: this board already has its own paragraph. Use the arrows to reposition it.'); return; }
  if (edit && commitNoteEdit(view, source, edit, edit.boardStart)) setActiveNoteBoard(null);
}

export function putActiveBoardOnOwnLine(app: App): void {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) { refuse(); return; }
  const el = activeBoard && view.contentEl.contains(activeBoard) ? activeBoard : undefined;
  const src = el?.getAttribute('src');
  const path = src ? app.metadataCache.getFirstLinkpathDest(src, view.file?.path ?? '')?.path : undefined;
  ownLine(app, view, el, path);
}

export function moveActiveBoard(app: App, direction: -1 | 1): void {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) { refuse(); return; }
  const el = activeBoard && view.contentEl.contains(activeBoard) ? activeBoard : undefined;
  const src = el?.getAttribute('src');
  const path = src ? app.metadataCache.getFirstLinkpathDest(src, view.file?.path ?? '')?.path : undefined;
  moveBoard(app, view, direction, el, path);
}

export function attachBoardControls(app: App, el: HTMLElement, path: string, signal: AbortSignal, activate: () => void, experimentalWrap: () => boolean = () => false, openWrapSetting: () => void = () => {}): () => void {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  const controls = el.createDiv({ cls: 'bb-frame-controls' });
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Board position and text wrap');
  controls.addEventListener('pointerdown', e => { e.stopPropagation(); activate(); setActiveNoteBoard(el); }, { signal });
  controls.addEventListener('click', e => e.stopPropagation(), { signal });
  controls.addEventListener('focusin', () => { activate(); setActiveNoteBoard(el); refresh(); }, { signal });
  const stopTooltips: Array<() => void> = [];
  const button = (text: string, title: string, action?: () => void) => {
    const b = controls.createEl('button');
    b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', title);
    stopTooltips.push(attachPaneTooltip(b, () => hostMarkdownView(app, el)?.contentEl ?? el, signal));
    if (action) b.addEventListener('click', action, { signal });
    return b;
  };
  const grip = button('⠿', 'Drag to move board');
  grip.classList.add('bb-move-grip');
  grip.addEventListener('click', () => {
    const view = hostMarkdownView(app, el);
    if (!editableNote(view)) { refuse(); return; }
    const source = view.editor.getValue();
    const info = inspectEmbedMove(source, boardOccurrence(app, view, source, el, path));
    if ('reason' in info) refuse(info.reason);
  }, { signal });
  const up = button('▲', 'Move up', () => { const view = hostMarkdownView(app, el); if (view) moveBoard(app, view, -1, el, path); });
  const down = button('▼', 'Move down', () => { const view = hostMarkdownView(app, el); if (view) moveBoard(app, view, 1, el, path); });
  const extract = button('↵', 'Put on its own line', () => { const view = hostMarkdownView(app, el); if (view) ownLine(app, view, el, path); });
  grip.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    const menu = new Menu();
    menu.addItem(item => item.setTitle('Put on its own line').onClick(() => { const view = hostMarkdownView(app, el); if (view) ownLine(app, view, el, path); }));
    menu.showAtMouseEvent(e);
  }, { signal });
  const layouts = (['center', 'left', 'right'] as EmbedLayout[]).map(layout => button(
    layout === 'center' ? '↔' : layout === 'left' ? '◧' : '◨',
    layout === 'center' ? 'Center' : layout === 'left' ? 'Board left, text on the right' : 'Board right, text on the left',
    () => {
      const view = hostMarkdownView(app, el);
      if (!editableNote(view)) { refuse(); return; }
      const source = view.editor.getValue();
      const occurrence = boardOccurrence(app, view, source, el, path);
      const info = inspectEmbedMove(source, occurrence);
      if ('reason' in info) { refuse(info.reason); return; }
      if (parseEmbedAlias(info.link.alias).ambiguous) { refuse('alias'); return; }
      const edit = planEmbedWrap(source, occurrence, layout);
      if (edit && commitNoteEdit(view, source, edit, edit.boardStart)) {
        applyEmbedLayout(el, parseEmbedAlias(findEmbedLinks(edit.source).find(m => m.start === edit.boardStart)?.alias), experimentalWrap(), openWrapSetting);
        refresh();
      }
    }));
  function refresh() {
    const view = hostMarkdownView(app, el);
    const editable = editableNote(view);
    for (const b of [grip, up, down, extract]) b.hidden = !editable;
    for (let index = 0; index < layouts.length; index++) {
      layouts[index].disabled = !editable;
      layouts[index].setAttribute('aria-pressed', String((el.dataset.bbLayout ?? 'center') === ['center', 'left', 'right'][index]));
    }
  }
  refresh();
  el.addEventListener('pointerenter', refresh, { signal });
  const stopLayout = watchEmbedLayout(el, () => {
    const view = hostMarkdownView(app, el);
    if (view?.editor) noteCM(view.editor)?.requestMeasure?.();
  });
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
          const info = inspectEmbedMove(source, drag.occurrence);
          drag.self = !('reason' in info) && info.standalone && (target === from || target === from + 1);
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
    if (movableBlock(source, occurrence) < 0) { sourceRefusal(source, occurrence); return; }
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
  return () => { cancel(); for (const stop of stopTooltips) stop(); controls.remove(); indicator.remove(); stopLayout(); if (activeBoard === el) setActiveNoteBoard(null); };
}
