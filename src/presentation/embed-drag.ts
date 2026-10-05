import { dropLines, dropSlotAt, inspectDropSource, isCurrentDropSlot, planEmbedDrop, type DropSlot, type DropLine } from './embed-drop';
import { MOVE_MESSAGES, type EmbedMoveEdit } from './embed-move';

type Coords = { top: number; bottom: number; left: number; right: number };
/** Geometry uses viewport coordinates. Host modules and history stay in the adapter. */
export interface DragEditor {
  getValue(): string;
  posAtCoords(point: { x: number; y: number }): number | null;
  lineBlockAt(pos: number): { from: number; to: number; top: number; bottom: number } | null;
  coordsAtPos(pos: number, side?: number): Coords | null;
  dispatch(original: string, edit: EmbedMoveEdit): boolean;
  scrollDOM: HTMLElement;
}
export interface DragBinding { editor: DragEditor; occurrence: number; }
export interface DragOptions {
  bind(): DragBinding | { reason: string };
  notice(message: string): void;
  debug?: () => boolean;
  dropped?: () => void;
}

export function attachEmbedDrag(board: HTMLElement, grip: HTMLElement, options: DragOptions): () => void {
  const doc = board.ownerDocument;
  const win = doc.defaultView!;
  const abort = new win.AbortController();
  const listeners = { capture: true, signal: abort.signal };
  // Standard DOM is intentional: this controller also runs outside Obsidian.
  const indicator = doc.createElement('div');
  indicator.className = 'bb-drop-indicator'; indicator.hidden = true;
  const ghost = doc.createElement('div');
  ghost.className = 'bb-drag-ghost'; ghost.hidden = true; ghost.textContent = 'Moving board';
  for (const overlay of [indicator, ghost]) { overlay.setAttribute('aria-hidden', 'true'); doc.body.appendChild(overlay); }
  let disposed = false;
  let frame: number | null = null;
  let drag: (DragBinding & { source: string; lines: DropLine[]; pointer: number; startX: number; startY: number; x: number; y: number; offsetX: number; offsetY: number; moved: boolean; slot: DropSlot | null; reason: string; previousSlot: number | null }) | null = null;
  // Guard at call sites: no debug records/formatting are allocated when disabled.
  const debug = () => options.debug?.() === true;
  const log = (event: string, detail?: unknown) => console.debug('[bb-drag]', event, detail ?? '');
  const cleanup = () => { abort.abort(); indicator.remove(); ghost.remove(); };
  const cancel = (reason: string) => {
    const pointer = drag?.pointer;
    drag = null; indicator.hidden = ghost.hidden = true;
    doc.body.classList.remove('bb-dragging');
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    if (pointer !== undefined) {
      if (reason !== 'release' && debug()) log('drop', { result: 'cancelled', reason });
      try { doc.body.releasePointerCapture(pointer); } catch { /* document capture remains the fallback */ }
    }
    if (disposed) cleanup();
  };
  const update = (scroll: boolean) => {
    if (!drag?.moved) return;
    const state = drag;
    ghost.hidden = false;
    ghost.style.transform = `translate(${state.x - state.offsetX}px, ${state.y - state.offsetY}px)`;
    indicator.hidden = true; state.slot = null;
    if (!state.editor.scrollDOM.isConnected || state.editor.getValue() !== state.source) {
      options.notice('The note changed or closed during the grab. Grab the board again.'); cancel('note changed or closed'); return;
    }
    const rect = state.editor.scrollDOM.getBoundingClientRect();
    state.reason = 'Drop inside the note pane, between lines.';
    if (state.x < rect.left || state.x > rect.right || state.y < rect.top - 30 || state.y > rect.bottom + 30) return;
    if (scroll) {
      const delta = state.y < rect.top + 40 ? -12 : state.y > rect.bottom - 40 ? 12 : 0;
      if (delta) state.editor.scrollDOM.scrollTop += delta;
    }
    const y = Math.min(rect.bottom - 2, Math.max(rect.top + 2, state.y));
    const pos = state.editor.posAtCoords({ x: state.x, y });
    if (pos === null) { state.reason = 'The editor could not locate that line. Drop over visible note text.'; return; }
    const block = state.editor.lineBlockAt(pos);
    const coords = state.editor.coordsAtPos(pos);
    const top = coords?.top ?? block?.top, bottom = coords?.bottom ?? block?.bottom;
    if (top === undefined || bottom === undefined) { state.reason = 'The editor could not measure that line. Drop over visible note text.'; return; }
    const after = y >= (top + bottom) / 2;
    const slot = dropSlotAt(state.source, pos, after, state.lines);
    if (!slot) {
      state.reason = 'Drop outside note properties, code, tables or math blocks.';
      if (state.previousSlot !== null) {
        state.previousSlot = null;
        if (debug()) log('slot refused', state.reason);
      }
      return;
    }
    const lines = state.lines;
    const line = lines.find(l => pos >= l.from && pos <= l.to)!;
    const caret = state.editor.coordsAtPos(after ? line.to : line.from, after ? -1 : 1);
    if (!caret) { state.reason = 'The editor could not measure that boundary. Drop over visible note text.'; return; }
    state.slot = slot;
    indicator.dataset.line = String(slot.line);
    indicator.style.left = `${rect.left + 8 + (slot.indent ?? 0) * 8}px`;
    indicator.style.width = `${Math.max(20, rect.width - 16 - (slot.indent ?? 0) * 8)}px`;
    indicator.style.top = `${after ? caret.bottom : caret.top}px`;
    indicator.hidden = false;
    if (state.previousSlot !== slot.offset) {
      state.previousSlot = slot.offset;
      if (debug()) log('slot', { line: slot.line, offset: slot.offset });
    }
  };
  const tick = () => { frame = null; update(true); if (drag?.moved) frame = win.requestAnimationFrame(tick); };
  doc.addEventListener('pointerdown', e => {
    const target = e.target as Node | null;
    if (disposed || !target || !board.contains(target)) return;
    const grabbed = grip.contains(target) || e.altKey;
    if (!grabbed) return;
    if (e.button !== 0 || !e.isPrimary || drag) {
      if (debug()) log('pointerdown refused', 'Use the primary pointer and left button.');
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    const binding = options.bind();
    if ('reason' in binding) { if (debug()) log('pointerdown refused', binding.reason); options.notice(binding.reason); return; }
    const source = binding.editor.getValue();
    const info = inspectDropSource(source, binding.occurrence);
    if ('reason' in info) { if (debug()) log('pointerdown refused', info.reason); options.notice(MOVE_MESSAGES[info.reason]); return; }
    const rect = board.getBoundingClientRect();
    drag = { ...binding, source, lines: dropLines(source), pointer: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, moved: false, slot: null, reason: '', previousSlot: null };
    ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`;
    if (debug()) log('pointerdown accepted', { occurrence: binding.occurrence, pointer: e.pointerId });
    // body survives widget refresh/virtualisation. Document listeners also work when
    // a host denies pointer capture; failure is visible only with debugDrag enabled.
    try { doc.body.setPointerCapture(e.pointerId); if (debug()) log('capture set', e.pointerId); }
    catch { if (debug()) log('capture refused', 'Using document capture listeners.'); }
  }, listeners);
  doc.addEventListener('pointermove', e => {
    if (drag?.pointer !== e.pointerId) return;
    e.preventDefault(); e.stopImmediatePropagation();
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= 4) {
      drag.moved = true; doc.body.classList.add('bb-dragging');
      if (debug()) log('first move', { x: e.clientX, y: e.clientY });
    }
    if (drag.moved) { update(false); if (frame === null && drag) frame = win.requestAnimationFrame(tick); }
  }, listeners);
  doc.addEventListener('pointerup', e => {
    if (drag?.pointer !== e.pointerId) return;
    e.preventDefault(); e.stopImmediatePropagation();
    drag.x = e.clientX; drag.y = e.clientY; update(false);
    const state = drag;
    cancel('release');
    if (!state?.moved) { if (debug()) log('drop', 'click: hold the grip and move at least 4px'); return; }
    if (!state.slot) { if (debug()) log('drop refused', state.reason); options.notice(state.reason); return; }
    const edit = planEmbedDrop(state.source, state.occurrence, state.slot);
    if (!edit) {
      const ownLine = isCurrentDropSlot(state.source, state.occurrence, state.slot);
      if (debug()) log('drop', ownLine ? 'no-op: current slot' : 'refused: unsafe extraction');
      if (!ownLine) options.notice('This move would leave an empty parent list item or change protected syntax. Choose another slot or move the token manually.');
      return;
    }
    const committed = state.editor.dispatch(state.source, edit);
    if (debug()) log('drop', { result: committed ? 'moved' : 'refused: note changed', line: state.slot.line });
    if (committed) options.dropped?.();
  }, listeners);
  doc.addEventListener('pointercancel', e => { if (drag?.pointer === e.pointerId) cancel('pointercancel'); }, listeners);
  doc.body.addEventListener('lostpointercapture', e => { if (drag?.pointer === e.pointerId) { if (debug()) log('capture lost', e.pointerId); cancel('capture lost'); } }, { signal: abort.signal });
  doc.addEventListener('keydown', e => { if (drag && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel('Escape'); } }, listeners);
  win.addEventListener('blur', () => cancel('window lost focus'), { signal: abort.signal });
  return () => {
    disposed = true;
    // CM may virtualise the source widget while auto-scrolling. Finish this gesture
    // against its frozen source/editor; remove its listeners as soon as it ends.
    if (drag && board.isConnected) cancel('controls disposed');
    else if (!drag) cleanup();
  };
}
