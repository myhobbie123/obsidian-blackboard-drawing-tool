import { MarkdownView, Menu, Notice, type App } from 'obsidian';
import { findEmbedLinks, findEmbedTokens, parseEmbedAlias, type EmbedLayout } from './embed-size';
import { planEmbedStep, planEmbedOwnLine, planEmbedWrap, inspectEmbedMove, embedRefusalAtCursor, MOVE_MESSAGES, type MoveRefusal } from './embed-move';
import { hostMarkdownView, editableNote, resolveEmbedLink, commitNoteEdit, noteCM } from './embed-note';
import { applyEmbedLayout, watchEmbedLayout } from './embed-layout';
import { attachPaneTooltip } from './embed-tooltip';
import { attachEmbedDrag, type DragEditor } from './embed-drag';
import { inspectDropSource } from './embed-drop';

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

function refuse(reason?: MoveRefusal): void { new Notice('Blackboard: ' + (reason ? MOVE_MESSAGES[reason] : 'Open an editable note in Live Preview or Source mode and choose a board. Hold the grip or Alt+press the board, then drop between note lines.')); }


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
  if (!edit) { new Notice('Blackboard: this board already has its own paragraph. Hold the grip to reposition it.'); return; }
  if (edit && commitNoteEdit(view, source, edit, edit.boardStart)) setActiveNoteBoard(null);
}

export function moveActiveBoard(app: App, direction: -1 | 1): void {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) { refuse(); return; }
  const el = activeBoard && view.contentEl.contains(activeBoard) ? activeBoard : undefined;
  const src = el?.getAttribute('src');
  const path = src ? app.metadataCache.getFirstLinkpathDest(src, view.file?.path ?? '')?.path : undefined;
  moveBoard(app, view, direction, el, path);
}

export function attachBoardControls(app: App, el: HTMLElement, path: string, signal: AbortSignal, activate: () => void, experimentalWrap: () => boolean = () => false, openWrapSetting: () => void = () => {}, debugDrag: () => boolean = () => false): () => void {
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
    const info = inspectDropSource(source, boardOccurrence(app, view, source, el, path));
    if ('reason' in info) refuse(info.reason);
    else new Notice('Blackboard: hold the grip and move at least 4 pixels, or Alt+press the board. Release between note lines to place it.');
  }, { signal });
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
    grip.hidden = !editable;
    for (let index = 0; index < layouts.length; index++) {
      layouts[index].disabled = false;
      layouts[index].setAttribute('aria-pressed', String((el.dataset.bbLayout ?? 'center') === ['center', 'left', 'right'][index]));
    }
  }
  refresh();
  el.addEventListener('pointerenter', refresh, { signal });
  const stopLayout = watchEmbedLayout(el, () => {
    const view = hostMarkdownView(app, el);
    if (view?.editor) noteCM(view.editor)?.requestMeasure?.();
  });
  const stopDrag = attachEmbedDrag(el, grip, {
    debug: debugDrag,
    notice: message => { new Notice('Blackboard: ' + message); },
    dropped: () => setActiveNoteBoard(null),
    bind: () => {
      const view = hostMarkdownView(app, el);
      if (!editableNote(view)) return { reason: 'Open this note in Live Preview or Source mode to move the board.' };
      const cm = noteCM(view.editor);
      if (!cm?.scrollDOM || !cm.posAtCoords || !cm.lineBlockAt || !cm.coordsAtPos) return { reason: 'The editor cannot locate drop slots. Reopen the note in Live Preview and try again.' };
      const editor: DragEditor = {
        getValue: () => view.editor.getValue(),
        scrollDOM: cm.scrollDOM,
        posAtCoords: point => cm.posAtCoords!(point, false),
        coordsAtPos: (pos, side) => cm.coordsAtPos!(pos, side),
        lineBlockAt: pos => {
          const block = cm.lineBlockAt!(pos);
          const top = typeof cm.documentTop === 'number' ? block.top + cm.documentTop : cm.coordsAtPos!(block.from)?.top;
          return top === undefined ? null : { ...block, top, bottom: top + block.bottom - block.top };
        },
        dispatch: (original, edit) => commitNoteEdit(view, original, edit, edit.boardStart),
      };
      return { editor, occurrence: boardOccurrence(app, view, view.editor.getValue(), el, path) };
    },
  });
  // A virtualised widget can unmount during a grab; the controller keeps only that
  // gesture alive against its frozen source. Teardown is otherwise immediate.
  signal.addEventListener('abort', stopDrag, { once: true });
  return () => { stopDrag(); for (const stop of stopTooltips) stop(); controls.remove(); stopLayout(); if (activeBoard === el) setActiveNoteBoard(null); };
}
