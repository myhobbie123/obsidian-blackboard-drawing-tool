export type ShortcutTool = 'pen' | 'eraser' | 'text';

/**
 * Elements that own the keyboard. A tool shortcut must NEVER be swallowed while one of these
 * has focus, or typing "e" in a note would silently switch the drawing tool.
 * `.cm-editor`, `[contenteditable]`, `input`, `textarea` and `select` are unconditional;
 * modals, prompts and menus are included for the same reason.
 */
const TYPING_SELECTOR =
  'input,textarea,select,[contenteditable="true"],[contenteditable=""],[contenteditable],' +
  '.cm-editor,.modal-container,.prompt,.menu,.blackboard-text-editor';

/** Blackboard chrome: the shortcut layer is "armed" only while the user is working here. */
const BLACKBOARD_CHROME =
  '.blackboard-drawing-container,.blackboard-view-container,.blackboard-global-toolbar,' +
  '.blackboard-global-toolbar-pill,.blackboard-text-editor,.blackboard-text-item';

export function isTypingTarget(target: EventTarget | null, fallback?: Element | null): boolean {
  const el = target instanceof Element ? target : (fallback ?? null);
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(TYPING_SELECTOR) !== null;
}

export function isBlackboardChrome(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(BLACKBOARD_CHROME) !== null;
}

/**
 * Which tool a keydown selects, or null for "not one of ours". The matcher behind the
 * physical-key fallback in `tool-commands.ts` — which is the only caller, so the fallback
 * and these rules cannot drift apart.
 *
 * Matching is on `event.code` — the PHYSICAL key — and never on `event.key`. On a Cyrillic
 * layout the same three keys produce й/у/е, and matching by character would leave the
 * shortcuts dead there (which is exactly what Obsidian's own hotkeys do); matching by
 * position keeps them where the user's fingers are on every layout. Any modifier, or an
 * auto-repeat, means the keystroke is not ours.
 */
export function shortcutToolFor(event: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  defaultPrevented?: boolean;
}): ShortcutTool | null {
  if (event.defaultPrevented) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return null;
  switch (event.code) {
    case 'KeyQ': return 'pen';
    case 'KeyE': return 'eraser';
    case 'KeyT': return 'text';
    default: return null;
  }
}

/**
 * Whether a keystroke means "delete the selected label". Delete and Backspace both, because
 * neither is universally present on every keyboard (Backspace only on many laptops, Delete
 * the obvious choice on a full keyboard). Modifiers and auto-repeat are not ours, on the
 * same reasoning as the tool shortcuts — and the caller is responsible for refusing to run
 * this while the label editor is open, where Backspace means "delete a character".
 */
export function isDeleteSelectionKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}): boolean {
  if (event.defaultPrevented) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return false;
  return event.key === 'Delete' || event.key === 'Backspace';
}

/**
 * What a document-level pointerdown should do, given only where it landed. Factored out of
 * the DOM handler so the "commit vs. commit-and-consume" rule — the one part of the text
 * layer that can silently break unrelated clicks — is directly testable.
 */
export type PointerDownAction =
  /** Inside the open editor: shield it from the drawing surface, change nothing. */
  | 'shield-editor'
  /** Commit the open editor, leave the pen selected, and let the click reach its target. */
  | 'commit'
  /** Commit, drop back to the pen, and consume the event (it landed on a drawing surface). */
  | 'commit-and-consume'
  /** On a label with no editor open: shield it so a stray drag does not start a stroke. */
  | 'shield-item'
  /** On a label with the text tool active: select it, and arm a possible drag. */
  | 'select-text-item'
  /** Text mode on an empty spot of a drawing: create a label here. */
  | 'create-text'
  | 'ignore';

export function decidePointerDown(ctx: {
  inEditor: boolean;
  editorOpen: boolean;
  inDrawingContainer: boolean;
  onTextItem: boolean;
  textMode: boolean;
}): PointerDownAction {
  if (ctx.inEditor) return 'shield-editor';
  if (ctx.editorOpen) {
    // A click anywhere commits, but only a click that landed on a drawing surface is
    // consumed. Consuming unconditionally is what made clicking the ribbon, a tab or a note
    // do nothing at all while a label was being edited.
    return ctx.inDrawingContainer ? 'commit-and-consume' : 'commit';
  }
  // With the text tool active a label is grabbable: the press selects it and may become a
  // move. Without it, the label is inert chrome that must merely not start a stroke.
  if (ctx.onTextItem) return ctx.textMode ? 'select-text-item' : 'shield-item';
  if (ctx.textMode && ctx.inDrawingContainer) return 'create-text';
  return 'ignore';
}
