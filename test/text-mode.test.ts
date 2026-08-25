import { describe, it, expect } from 'vitest';
import {
  decidePointerDown,
  isBlackboardChrome,
  isDeleteSelectionKey,
  isTypingTarget,
  shortcutToolFor,
} from '../src/presentation/text-mode';

function key(over: Partial<Parameters<typeof shortcutToolFor>[0]> = {}) {
  return { code: 'KeyQ', ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...over };
}

describe('shortcutToolFor — physical-key matching', () => {
  it('maps KeyQ/KeyE/KeyT to pen/eraser/text', () => {
    expect(shortcutToolFor(key({ code: 'KeyQ' }))).toBe('pen');
    expect(shortcutToolFor(key({ code: 'KeyE' }))).toBe('eraser');
    expect(shortcutToolFor(key({ code: 'KeyT' }))).toBe('text');
  });

  it('ignores any other key', () => {
    for (const code of ['KeyA', 'KeyW', 'Digit1', 'Space', 'Escape', 'KeyQQ', '']) {
      expect(shortcutToolFor(key({ code }))).toBeNull();
    }
  });

  it('works on a Cyrillic layout, where the same physical keys emit й/у/е', () => {
    // The layout changes event.key but never event.code, which is exactly why the matcher
    // reads code. Passing the Cyrillic characters as `key` must not disturb the result.
    const cyrillic = [
      { code: 'KeyQ', key: 'й', tool: 'pen' },
      { code: 'KeyE', key: 'у', tool: 'eraser' },
      { code: 'KeyT', key: 'е', tool: 'text' },
    ] as const;
    for (const c of cyrillic) {
      expect(shortcutToolFor({ ...key({ code: c.code }), key: c.key } as never)).toBe(c.tool);
    }
  });

  it('never matches on event.key: a Cyrillic е on another physical key is not the text tool', () => {
    expect(shortcutToolFor({ ...key({ code: 'KeyU' }), key: 'е' } as never)).toBeNull();
  });

  it('bails on ctrl / meta / alt so app shortcuts keep working', () => {
    expect(shortcutToolFor(key({ ctrlKey: true }))).toBeNull();
    expect(shortcutToolFor(key({ metaKey: true }))).toBeNull();
    expect(shortcutToolFor(key({ altKey: true }))).toBeNull();
  });

  it('bails on auto-repeat', () => {
    expect(shortcutToolFor(key({ repeat: true }))).toBeNull();
  });

  it('bails when another handler already consumed the event', () => {
    expect(shortcutToolFor(key({ defaultPrevented: true }))).toBeNull();
  });

  it('shift alone still selects (no modifier gate on shift)', () => {
    expect(shortcutToolFor({ ...key({ code: 'KeyT' }), shiftKey: true } as never)).toBe('text');
  });
});

describe('isTypingTarget — a shortcut must never eat a keystroke', () => {
  function make(html: string): Element {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild!;
  }

  it('treats input, textarea and select as typing targets', () => {
    for (const tag of ['<input>', '<textarea></textarea>', '<select></select>']) {
      expect(isTypingTarget(make(tag))).toBe(true);
    }
  });

  it('treats contenteditable as a typing target, in every spelling', () => {
    expect(isTypingTarget(make('<div contenteditable="true"></div>'))).toBe(true);
    expect(isTypingTarget(make('<div contenteditable=""></div>'))).toBe(true);
  });

  it('treats the CodeMirror editor as a typing target, including nested targets', () => {
    const editor = make('<div class="cm-editor"><div class="cm-content"><span>x</span></div></div>');
    expect(isTypingTarget(editor)).toBe(true);
    expect(isTypingTarget(editor.querySelector('span'))).toBe(true);
  });

  it('treats modals, prompts and menus as typing targets', () => {
    expect(isTypingTarget(make('<div class="modal-container"></div>'))).toBe(true);
    expect(isTypingTarget(make('<div class="prompt"></div>'))).toBe(true);
    expect(isTypingTarget(make('<div class="menu"></div>'))).toBe(true);
  });

  it('treats the label editor as a typing target (it owns the keyboard while open)', () => {
    expect(isTypingTarget(make('<textarea class="blackboard-text-editor"></textarea>'))).toBe(true);
  });

  it('does not treat the drawing surface as a typing target', () => {
    expect(isTypingTarget(make('<div class="blackboard-drawing-container"></div>'))).toBe(false);
  });

  it('is false for a null target with no fallback', () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it('falls back to the supplied active element when the target is not an Element', () => {
    expect(isTypingTarget(null, make('<input>'))).toBe(true);
  });
});

describe('isBlackboardChrome', () => {
  it('recognises the surface, the view container, the toolbar, the pill, labels and the editor', () => {
    const classes = [
      'blackboard-drawing-container',
      'blackboard-view-container',
      'blackboard-global-toolbar',
      'blackboard-global-toolbar-pill',
      'blackboard-text-editor',
      'blackboard-text-item',
    ];
    for (const cls of classes) {
      const el = document.createElement('div');
      el.className = cls;
      expect(isBlackboardChrome(el)).toBe(true);
    }
  });

  it('is false for unrelated app chrome', () => {
    const el = document.createElement('div');
    el.className = 'workspace-tab-header';
    expect(isBlackboardChrome(el)).toBe(false);
    expect(isBlackboardChrome(null)).toBe(false);
  });
});

describe('decidePointerDown — commit vs. commit-and-consume', () => {
  const base = {
    inEditor: false,
    editorOpen: false,
    inDrawingContainer: false,
    onTextItem: false,
    textMode: false,
  };

  it('shields a click inside the open editor', () => {
    expect(decidePointerDown({ ...base, inEditor: true, editorOpen: true })).toBe('shield-editor');
  });

  it('commits AND consumes a click that lands on a drawing surface', () => {
    expect(decidePointerDown({ ...base, editorOpen: true, inDrawingContainer: true }))
      .toBe('commit-and-consume');
  });

  it('commits WITHOUT consuming a click anywhere else, so the click reaches its target', () => {
    expect(decidePointerDown({ ...base, editorOpen: true })).toBe('commit');
  });

  it('commit-without-consume also applies to a click on a label outside the surface', () => {
    expect(decidePointerDown({ ...base, editorOpen: true, onTextItem: true })).toBe('commit');
  });

  it('shields a label when no editor is open (a drag must not start a stroke on it)', () => {
    expect(decidePointerDown({ ...base, onTextItem: true })).toBe('shield-item');
  });

  it('selects a label instead, when the text tool is active (a press may become a move)', () => {
    expect(decidePointerDown({ ...base, onTextItem: true, textMode: true })).toBe('select-text-item');
    expect(decidePointerDown({ ...base, onTextItem: true, textMode: true, inDrawingContainer: true }))
      .toBe('select-text-item');
  });

  it('an open editor still wins over selecting a label', () => {
    expect(decidePointerDown({ ...base, onTextItem: true, textMode: true, editorOpen: true }))
      .toBe('commit');
  });

  it('creates a label in text mode on the surface', () => {
    expect(decidePointerDown({ ...base, textMode: true, inDrawingContainer: true }))
      .toBe('create-text');
  });

  it('does not create a label in text mode outside the surface', () => {
    expect(decidePointerDown({ ...base, textMode: true })).toBe('ignore');
  });

  it('ignores an ordinary click on the surface when text mode is off', () => {
    expect(decidePointerDown({ ...base, inDrawingContainer: true })).toBe('ignore');
  });

  it('never consumes anything while no editor is open and text mode is off', () => {
    const actions = new Set<string>();
    for (const inDrawingContainer of [false, true]) {
      for (const onTextItem of [false, true]) {
        actions.add(decidePointerDown({ ...base, inDrawingContainer, onTextItem }));
      }
    }
    expect(actions).toEqual(new Set(['ignore', 'shield-item']));
  });
});

describe('isDeleteSelectionKey', () => {
  function key(over: Record<string, unknown> = {}) {
    return { key: 'Delete', ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...over } as never;
  }

  it('matches Delete and Backspace', () => {
    expect(isDeleteSelectionKey(key({ key: 'Delete' }))).toBe(true);
    expect(isDeleteSelectionKey(key({ key: 'Backspace' }))).toBe(true);
  });

  it('matches nothing else', () => {
    for (const k of ['d', 'Escape', 'Enter', 'ArrowLeft', 'x', '']) {
      expect(isDeleteSelectionKey(key({ key: k }))).toBe(false);
    }
  });

  it('bails on ctrl / meta / alt, auto-repeat, and an already-consumed event', () => {
    expect(isDeleteSelectionKey(key({ ctrlKey: true }))).toBe(false);
    expect(isDeleteSelectionKey(key({ metaKey: true }))).toBe(false);
    expect(isDeleteSelectionKey(key({ altKey: true }))).toBe(false);
    expect(isDeleteSelectionKey(key({ repeat: true }))).toBe(false);
    expect(isDeleteSelectionKey(key({ defaultPrevented: true }))).toBe(false);
  });

  it('is layout-independent by construction: Delete/Backspace emit the same key everywhere', () => {
    // Unlike the letter shortcuts, these are named keys — no layout produces a character
    // for them, so matching on `key` is correct here and needs no physical-key fallback.
    expect(isDeleteSelectionKey(key({ key: 'Backspace', code: 'Backspace' }))).toBe(true);
  });
});
