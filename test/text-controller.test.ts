import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TextController } from '../src/presentation/text-controller';
import { memoryTextDocument } from '../src/application/text-document';
import { ToolManager } from '../src/domain/tool-manager';
import { SurfaceManager } from '../src/presentation/surface-manager';
import { GlobalToolbar } from '../src/presentation/global-toolbar';
import { DEFAULT_PLUGIN_SETTINGS, DEFAULT_TOOL_STATE } from '../src/domain/entities';
import { StrokeManager } from '../src/domain/stroke-manager';
import { TOOL_COMMANDS } from '../src/presentation/tool-commands';

function fakeEngine() {
  const listeners = new Set<() => void>();
  return {
    getViewTransform: () => ({ scale: 1, offsetX: 0, offsetY: 0 }),
    onViewChange: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    screenToDrawing: (x: number, y: number) => [x, y] as [number, number],
    strokeManager: new StrokeManager(),
    toolManager: { activeColor: '#ffffff', textColor: '#ffffff', textFontSize: 20 },
  };
}

function setup() {
  const document_ = memoryTextDocument();
  const toolManager = new ToolManager({ ...DEFAULT_TOOL_STATE });
  const surfaceManager = new SurfaceManager();
  const controller = new TextController(toolManager, surfaceManager);
  // Stand-in for Obsidian's command system: the physical-key fallback runs commands, never
  // the tool directly, so the tests exercise the same path the Hotkeys pane does.
  const ran: string[] = [];
  const rebound = new Set<string>();
  controller.setHotkeyBridge({
    run: (id) => {
      ran.push(id);
      const command = TOOL_COMMANDS.find((c) => c.id === id);
      if (command) controller.selectTool(command.tool);
    },
    isRebound: (id) => rebound.has(id),
  });
  controller.bindDocument(document);

  const container = document.createElement('div');
  container.className = 'blackboard-drawing-container';
  document.body.appendChild(container);
  const attached = controller.attach(fakeEngine() as never, container, () => document_);

  return { controller, toolManager, surfaceManager, container, attached, textDocument: document_, ran, rebound };
}

function keydown(target: EventTarget, code: string, extra: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(event);
  return event;
}

function pointerdown(target: EventTarget, x = 10, y = 20) {
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
  return event;
}

let live: ReturnType<typeof setup> | null = null;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  live?.controller.destroy();
  live = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('TextController shortcuts', () => {
  it('Q selects the pen and E the eraser once Blackboard has been touched', () => {
    live = setup();
    pointerdown(live.container); // arms the shortcuts
    keydown(live.container, 'KeyE');
    expect(live.toolManager.activeTool).toBe('eraser');
    keydown(live.container, 'KeyQ');
    expect(live.toolManager.activeTool).toBe('pen');
  });

  it('T enters text mode and leaves the drawing tool alone', () => {
    live = setup();
    pointerdown(live.container);
    keydown(live.container, 'KeyT');
    expect(live.controller.isTextMode()).toBe(true);
  });

  it('a drawing-tool shortcut leaves text mode', () => {
    live = setup();
    pointerdown(live.container);
    keydown(live.container, 'KeyT');
    keydown(live.container, 'KeyE');
    expect(live.controller.isTextMode()).toBe(false);
    expect(live.toolManager.activeTool).toBe('eraser');
  });

  it('is not armed before any Blackboard interaction: a key on unrelated chrome does nothing', () => {
    live = setup();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    keydown(outside, 'KeyE');
    expect(live.toolManager.activeTool).toBe('pen');
  });

  it('a keystroke in an editor is never swallowed, even while armed', () => {
    live = setup();
    pointerdown(live.container);
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    document.body.appendChild(editor);
    const event = keydown(editor, 'KeyE');
    expect(event.defaultPrevented).toBe(false);
    expect(live.toolManager.activeTool).toBe('pen');
  });

  it('a keystroke in an input/textarea/select is never swallowed', () => {
    live = setup();
    pointerdown(live.container);
    for (const tag of ['input', 'textarea', 'select']) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      const event = keydown(el, 'KeyT');
      expect(event.defaultPrevented).toBe(false);
    }
    expect(live.controller.isTextMode()).toBe(false);
  });

  it('modifier combinations are left to the app', () => {
    live = setup();
    pointerdown(live.container);
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const event = keydown(live.container, 'KeyE', mod);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(live.toolManager.activeTool).toBe('pen');
  });

  it('focus moving outside Blackboard disarms the shortcuts', () => {
    live = setup();
    pointerdown(live.container);
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    keydown(outside, 'KeyE');
    expect(live.toolManager.activeTool).toBe('pen');
  });

  it('escape leaves text mode and disarms', () => {
    live = setup();
    pointerdown(live.container);
    keydown(live.container, 'KeyT');
    expect(live.controller.isTextMode()).toBe(true);
    keydown(live.container, 'Escape', { key: 'Escape' });
    expect(live.controller.isTextMode()).toBe(false);
  });

  it('consumes with stopPropagation, never stopImmediatePropagation', () => {
    live = setup();
    pointerdown(live.container);
    const sibling = vi.fn();
    // A second listener on the SAME node in the same phase still runs.
    document.addEventListener('keydown', sibling, true);
    keydown(live.container, 'KeyE');
    document.removeEventListener('keydown', sibling, true);
    expect(sibling).toHaveBeenCalled();
  });

  it('T is inert while no surface is mounted', () => {
    live = setup();
    live.attached.detach();
    pointerdown(document.body);
    keydown(document.body, 'KeyT');
    expect(live.controller.isTextMode()).toBe(false);
  });
});

describe('TextController click-outside', () => {
  it('a click on the surface in text mode creates a label and consumes the event', async () => {
    live = setup();
    live.controller.setTextMode(true);
    const event = pointerdown(live.container);
    expect(event.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(live.container.querySelector('.blackboard-text-editor')).not.toBeNull();
  });

  it('a click elsewhere while editing commits WITHOUT consuming the event', async () => {
    live = setup();
    live.controller.setTextMode(true);
    pointerdown(live.container);
    await vi.advanceTimersByTimeAsync(0);
    live.container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'note';

    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    const event = pointerdown(elsewhere);

    expect(event.defaultPrevented).toBe(false);
    expect(live.container.querySelector('.blackboard-text-editor')).toBeNull();
    expect(live.container.querySelector('.blackboard-text-item')!.textContent).toBe('note');
    // Text mode stays on: the user did not click a drawing.
    expect(live.controller.isTextMode()).toBe(true);
  });

  it('a click back on the surface while editing commits, consumes, and drops to the pen', async () => {
    live = setup();
    live.controller.setTextMode(true);
    pointerdown(live.container);
    await vi.advanceTimersByTimeAsync(0);
    live.container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'done';

    const event = pointerdown(live.container);

    expect(event.defaultPrevented).toBe(true);
    expect(live.controller.isTextMode()).toBe(false);
    expect(live.toolManager.activeTool).toBe('pen');
  });
});

describe('the toolbar T button', () => {
  function toolbar(controller: TextController) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    return new GlobalToolbar(host, new SurfaceManager(), undefined, undefined, { ...DEFAULT_PLUGIN_SETTINGS }, {
      isActive: () => controller.isTextMode(),
      toggle: () => controller.toggleTextMode(),
    });
  }

  it('is built as a real toolbar child, next to the drawing tools', () => {
    live = setup();
    const bar = toolbar(live.controller);
    const btn = document.querySelector<HTMLButtonElement>('[data-bb-text-tool]')!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('T');
    expect(btn.classList.contains('blackboard-gt-btn')).toBe(true);
    // Sits with the other tool buttons (right after the last of them), so it reads as one.
    const tools = Array.from(btn.parentElement!.children);
    const lastIconTool = tools.map((c, i) => ((c as HTMLElement).dataset.tool && c !== btn ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    expect(tools.indexOf(btn)).toBe(lastIconTool + 1);
    bar.destroy();
  });

  it('is not built at all when no text hook is supplied (upstream parity)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const bar = new GlobalToolbar(host, new SurfaceManager(), undefined, undefined, { ...DEFAULT_PLUGIN_SETTINGS });
    expect(host.querySelector('[data-bb-text-tool]')).toBeNull();
    bar.destroy();
  });

  it('toggles text mode and reflects it as .active', () => {
    live = setup();
    const bar = toolbar(live.controller);
    const btn = document.querySelector<HTMLButtonElement>('[data-bb-text-tool]')!;
    btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(live.controller.isTextMode()).toBe(true);
    expect(btn.classList.contains('active')).toBe(true);
    btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(live.controller.isTextMode()).toBe(false);
    expect(btn.classList.contains('active')).toBe(false);
    bar.destroy();
  });

  it('is disabled while there is no live drawing surface', () => {
    live = setup();
    const manager = new SurfaceManager();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const controller = live.controller;
    const bar = new GlobalToolbar(host, manager, undefined, undefined, { ...DEFAULT_PLUGIN_SETTINGS }, {
      isActive: () => controller.isTextMode(),
      toggle: () => controller.toggleTextMode(),
    });
    const btn = host.querySelector<HTMLButtonElement>('[data-bb-text-tool]')!;

    // No surface: the host-only pill state disables every surface control.
    bar.setHost(document.createElement('div'));
    expect(btn.disabled).toBe(true);

    // A disabled button must not act even if something dispatches on it.
    btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(controller.isTextMode()).toBe(false);
    bar.destroy();
  });
});

describe('TextController — the shortcuts run commands', () => {
  it('a physical-key shortcut RUNS the command, it never touches the tool directly', () => {
    live = setup();
    pointerdown(live.container);
    keydown(live.container, 'KeyE');
    keydown(live.container, 'KeyT');
    expect(live.ran).toEqual(['select-eraser', 'select-text']);
  });

  it('defers to Obsidian for a command the user has rebound (the key is not swallowed)', () => {
    live = setup();
    live.rebound.add('select-eraser');
    pointerdown(live.container);

    const event = keydown(live.container, 'KeyE');

    expect(event.defaultPrevented).toBe(false);
    expect(live.ran).toEqual([]);
    expect(live.toolManager.activeTool).toBe('pen');
  });

  it('deference is per command: an untouched shortcut still works', () => {
    live = setup();
    live.rebound.add('select-eraser');
    pointerdown(live.container);
    keydown(live.container, 'KeyQ');
    expect(live.ran).toEqual(['select-pen']);
  });

  it('does nothing at all without a command bridge (no second way to select a tool)', () => {
    live = setup();
    live.controller.setHotkeyBridge(null);
    pointerdown(live.container);

    const event = keydown(live.container, 'KeyE');

    expect(event.defaultPrevented).toBe(false);
    expect(live.toolManager.activeTool).toBe('pen');
  });

  it('auto-repeat never fires a command', () => {
    live = setup();
    pointerdown(live.container);
    keydown(live.container, 'KeyE', { repeat: true });
    expect(live.ran).toEqual([]);
  });

  it('the physical W is NOT claimed — the highlighter has no fallback key', () => {
    live = setup();
    pointerdown(live.container);
    const event = keydown(live.container, 'KeyW');
    expect(event.defaultPrevented).toBe(false);
    expect(live.ran).toEqual([]);
  });
});

describe('TextController — text mode follows the shared tool selection', () => {
  it('selecting text through the ToolManager turns the mode on', () => {
    live = setup();
    live.toolManager.setTool('text');
    expect(live.controller.isTextMode()).toBe(true);
    expect(live.container.querySelector('.blackboard-text-layer')!.classList.contains('is-text-mode'))
      .toBe(true);
  });

  it('selecting a drawing tool anywhere leaves text mode by itself', () => {
    live = setup();
    live.controller.setTextMode(true);
    live.toolManager.setTool('highlighter');
    expect(live.controller.isTextMode()).toBe(false);
    expect(live.container.querySelector('.blackboard-text-layer')!.classList.contains('is-text-mode'))
      .toBe(false);
  });

  it('leaving text mode lands on the pen, so the surface is immediately drawable', () => {
    live = setup();
    live.controller.setTextMode(true);
    live.controller.setTextMode(false);
    expect(live.toolManager.activeTool).toBe('pen');
  });

  it('text mode is off while no surface is mounted, even with text selected', () => {
    live = setup();
    live.controller.setTextMode(true);
    live.attached.detach();
    expect(live.controller.isTextMode()).toBe(false);
  });
});

describe('TextController — selecting, moving and deleting labels', () => {
  /** Create one committed label and return its DOM node. */
  async function withLabel(text = 'note') {
    const ctx = setup();
    live = ctx;
    ctx.controller.setTextMode(true);
    pointerdown(ctx.container);
    await vi.advanceTimersByTimeAsync(0);
    ctx.container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = text;
    ctx.attached.layer.commitEditor();
    const node = ctx.container.querySelector<HTMLElement>('.blackboard-text-item')!;
    return { ...ctx, node };
  }

  it('a press on a label selects it and shields it from the drawing surface', async () => {
    const { attached, node } = await withLabel();
    const onSurface = vi.fn();
    node.closest('.blackboard-drawing-container')!.addEventListener('pointerdown', onSurface);

    pointerdown(node);

    expect(attached.layer.selectedItem?.text).toBe('note');
    expect(node.classList.contains('is-selected')).toBe(true);
    expect(onSurface).not.toHaveBeenCalled();
  });

  it('Delete removes the selected label and consumes the key', async () => {
    const { container, node } = await withLabel();
    pointerdown(node);

    const event = keydown(container, 'Delete', { key: 'Delete' });

    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(0);
  });

  it('Backspace does the same', async () => {
    const { container, node } = await withLabel();
    pointerdown(node);
    keydown(container, 'Backspace', { key: 'Backspace' });
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(0);
  });

  it('Delete is inert while the editor is open, and inert with nothing selected', async () => {
    const { container, attached } = await withLabel();
    // A freshly committed label IS the selection; clear it to test the empty case.
    attached.layer.select(null);
    keydown(container, 'Delete', { key: 'Delete' });
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(1);

    attached.layer.edit(attached.layer.itemForElement(container.querySelector('.blackboard-text-item'))!);
    await vi.advanceTimersByTimeAsync(0);
    const editor = container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!;
    keydown(editor, 'Backspace', { key: 'Backspace' });

    expect(container.querySelector('.blackboard-text-editor')).not.toBeNull();
  });

  it('Delete does nothing while a drawing tool is active (the selection is gone by then)', async () => {
    const { container, node } = await withLabel();
    pointerdown(node);
    live!.toolManager.setTool('pen');

    keydown(container, 'Delete', { key: 'Delete' });

    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(1);
  });

  it('an undo after a delete brings the label back', async () => {
    const { container, node, attached } = await withLabel();
    pointerdown(node);
    keydown(container, 'Delete', { key: 'Delete' });

    (attached.layer as unknown as { engine: { strokeManager: { undo(): void } } });
    live!.controller.current();
    // Undo through the same stack the toolbar's undo button uses.
    const strokeManager = (attached.layer as any).engine.strokeManager;
    strokeManager.undo();

    expect(container.querySelector('.blackboard-text-item')!.textContent).toBe('note');
  });

  it('Escape steps out: first the selection, then text mode', async () => {
    const { container, node, controller, attached } = await withLabel();
    pointerdown(node);
    expect(attached.layer.selectedItem).not.toBeNull();

    keydown(container, 'Escape', { key: 'Escape' });
    expect(attached.layer.selectedItem).toBeNull();
    expect(controller.isTextMode()).toBe(true);

    keydown(container, 'Escape', { key: 'Escape' });
    expect(controller.isTextMode()).toBe(false);
  });

  it('a label edit refreshes the toolbar, so undo lights up at once', async () => {
    const ctx = setup();
    live = ctx;
    const refreshed = vi.fn();
    ctx.surfaceManager.onChange(refreshed);
    ctx.controller.setTextMode(true);
    refreshed.mockClear();

    pointerdown(ctx.container);
    await vi.advanceTimersByTimeAsync(0);
    ctx.container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'x';
    ctx.attached.layer.commitEditor();

    expect(refreshed).toHaveBeenCalled();
  });

  it('a press on a label never creates a second label on top of it', async () => {
    const { container, node } = await withLabel();
    pointerdown(node);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(1);
  });
});
