import { describe, it, expect } from 'vitest';
import {
  TOOL_COMMANDS,
  fallbackCommandForKey,
  isCommandRebound,
  toolCommandFor,
} from '../src/presentation/tool-commands';

function key(over: Record<string, unknown> = {}) {
  return {
    code: 'KeyQ',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    ...over,
  } as never;
}

const never = () => false;

describe('the tool command table', () => {
  it('covers every tool, each with a stable id and a human name', () => {
    expect(TOOL_COMMANDS.map((c) => c.tool).sort()).toEqual(
      ['arrow', 'ellipse', 'eraser', 'highlighter', 'line', 'pen', 'rectangle', 'select', 'text'],
    );
    for (const command of TOOL_COMMANDS) {
      expect(command.id).toMatch(/^select-/);
      expect(command.name.length).toBeGreaterThan(0);
    }
  });

  it('registers no default hotkeys — Obsidian owns the keyboard until the user binds one', () => {
    for (const command of TOOL_COMMANDS) {
      expect((command as Record<string, unknown>).hotkeys).toBeUndefined();
      expect((command as Record<string, unknown>).defaultKey).toBeUndefined();
    }
  });

  it('keeps the fork\'s physical-key fallback on Q/E/T only', () => {
    expect(toolCommandFor('pen')?.code).toBe('KeyQ');
    expect(toolCommandFor('eraser')?.code).toBe('KeyE');
    expect(toolCommandFor('text')?.code).toBe('KeyT');
    // The highlighter never had one; adding it would claim W across every layout.
    expect(toolCommandFor('highlighter')?.code).toBeUndefined();
  });
});

describe('fallbackCommandForKey — physical-key matching', () => {
  it('maps the physical Q/E/T to the pen, eraser and text commands', () => {
    expect(fallbackCommandForKey(key({ code: 'KeyQ' }), never)?.id).toBe('select-pen');
    expect(fallbackCommandForKey(key({ code: 'KeyE' }), never)?.id).toBe('select-eraser');
    expect(fallbackCommandForKey(key({ code: 'KeyT' }), never)?.id).toBe('select-text');
  });

  it('works on a Cyrillic layout, where those same keys emit й/у/е', () => {
    // The layout changes event.key but never event.code — which is the whole point of the
    // fallback, since Obsidian's own hotkeys match the character.
    expect(fallbackCommandForKey(key({ code: 'KeyQ', key: 'й' }), never)?.tool).toBe('pen');
    expect(fallbackCommandForKey(key({ code: 'KeyE', key: 'у' }), never)?.tool).toBe('eraser');
    expect(fallbackCommandForKey(key({ code: 'KeyT', key: 'е' }), never)?.tool).toBe('text');
  });

  it('never matches on the character: a Cyrillic е on another physical key is not the text tool', () => {
    expect(fallbackCommandForKey(key({ code: 'KeyU', key: 'е' }), never)).toBeNull();
  });

  it('ignores every other key, including the highlighter\'s W', () => {
    for (const code of ['KeyA', 'KeyW', 'Digit1', 'Space', 'Escape', '']) {
      expect(fallbackCommandForKey(key({ code }), never)).toBeNull();
    }
  });

  it('bails on ctrl / meta / alt so app shortcuts keep working', () => {
    expect(fallbackCommandForKey(key({ ctrlKey: true }), never)).toBeNull();
    expect(fallbackCommandForKey(key({ metaKey: true }), never)).toBeNull();
    expect(fallbackCommandForKey(key({ altKey: true }), never)).toBeNull();
  });

  it('bails on auto-repeat', () => {
    expect(fallbackCommandForKey(key({ repeat: true }), never)).toBeNull();
  });

  it('bails when another handler already consumed the event', () => {
    expect(fallbackCommandForKey(key({ defaultPrevented: true }), never)).toBeNull();
  });

  it('shift alone still selects (no modifier gate on shift)', () => {
    expect(fallbackCommandForKey(key({ code: 'KeyT', shiftKey: true }), never)?.tool).toBe('text');
  });

  it('stands down for a command the user has rebound — Obsidian handles that key', () => {
    const rebound = (id: string) => id === 'select-eraser';
    expect(fallbackCommandForKey(key({ code: 'KeyE' }), rebound)).toBeNull();
    // The other commands are untouched: deference is per command, not global.
    expect(fallbackCommandForKey(key({ code: 'KeyQ' }), rebound)?.id).toBe('select-pen');
  });
});

describe('isCommandRebound', () => {
  it('is false when the user has never touched the command\'s hotkeys', () => {
    expect(isCommandRebound(undefined, 'blackboard-text:select-pen')).toBe(false);
    expect(isCommandRebound({}, 'blackboard-text:select-pen')).toBe(false);
  });

  it('is true once Obsidian records custom keys for it', () => {
    const custom = { 'blackboard-text:select-pen': [{ modifiers: ['Mod'], key: 'P' }] };
    expect(isCommandRebound(custom, 'blackboard-text:select-pen')).toBe(true);
  });

  it('is true for an EMPTY custom list — that is how a removed hotkey is stored', () => {
    expect(isCommandRebound({ 'blackboard-text:select-text': [] }, 'blackboard-text:select-text')).toBe(true);
  });

  it('is keyed by the fully-qualified id, not the plugin-local one', () => {
    const custom = { 'blackboard-text:select-pen': [] };
    expect(isCommandRebound(custom, 'select-pen')).toBe(false);
  });
});
