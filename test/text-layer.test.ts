import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TextLayer } from '../src/presentation/text-layer';
import { memoryTextDocument, type TextDocument } from '../src/application/text-document';
import type { TextItem } from '../src/domain/text-item';
import { StrokeManager } from '../src/domain/stroke-manager';
import { DocumentStore } from '../src/application/document-store';
import { handleTextDocument } from '../src/application/text-document';
import type { BlackboardFile } from '../src/domain/entities';
import type { IDrawingRepository } from '../src/domain/ports';

const item = (over: Partial<TextItem> = {}): TextItem => ({
  id: 'a1', x: 10, y: 20, text: 'hello', fontSize: 20, color: '#ffffff', ...over,
});

/**
 * The layer's text document, with every write recorded — the layer's only persistence path,
 * so `writes` is exactly "how many times did this reach the shared document".
 */
function recordingDocument(initial: TextItem[] = []) {
  const inner = memoryTextDocument(initial);
  const writes: TextItem[][] = [];
  const doc: TextDocument & { writes: TextItem[][] } = {
    writes,
    getItems: () => inner.getItems(),
    setItems: (items) => { writes.push(items.map((i) => ({ ...i }))); inner.setItems(items); },
  };
  return doc;
}

/** Minimal stand-in for the engine surface the layer projects through. */
function fakeEngine(view = { scale: 1, offsetX: 0, offsetY: 0 }) {
  const listeners = new Set<() => void>();
  return {
    view,
    listeners,
    // Text edits join the engine's ONE undo stack, so the fake needs a real one.
    strokeManager: new StrokeManager(),
    getViewTransform: () => ({ ...view }),
    onViewChange: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    screenToDrawing: (x: number, y: number) => [
      (x - view.offsetX) / view.scale,
      (y - view.offsetY) / view.scale,
    ] as [number, number],
    toolManager: { activeColor: '#00ff00', textColor: '#00ff00', textFontSize: 20 },
  };
}

function mount(items: TextItem[] = []) {
  const doc = recordingDocument(items);
  const container = document.createElement('div');
  container.className = 'blackboard-drawing-container';
  document.body.appendChild(container);
  const engine = fakeEngine();
  const layer = new TextLayer(engine as never, container, () => doc);
  return { layer, container, doc, engine };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('TextLayer rendering', () => {
  it('creates its overlay inside the drawing container', () => {
    const { container } = mount();
    expect(container.querySelector('.blackboard-text-layer')).not.toBeNull();
  });

  it('renders one .blackboard-text-item per label from the sidecar', async () => {
    const { layer, container } = mount([item(), item({ id: 'b2', text: 'second' })]);
    layer.sync();
    const nodes = container.querySelectorAll('.blackboard-text-item');
    expect(nodes).toHaveLength(2);
    expect(Array.from(nodes, (n) => n.textContent)).toEqual(['hello', 'second']);
  });

  it('projects a label through the view transform', async () => {
    const { layer, container, engine } = mount([item()]);
    engine.view.scale = 2;
    engine.view.offsetX = 100;
    engine.view.offsetY = -30;
    layer.sync();
    const node = container.querySelector<HTMLElement>('.blackboard-text-item')!;
    expect(node.style.left).toBe('120px');   // 10 * 2 + 100
    expect(node.style.top).toBe('10px');     // 20 * 2 - 30
    expect(node.style.fontSize).toBe('40px'); // 20 * 2
  });

  it('re-projects when the engine announces a view change', async () => {
    const { layer, container, engine } = mount([item()]);
    layer.sync();
    engine.view.offsetX = 250;
    for (const cb of engine.listeners) cb();
    await vi.advanceTimersByTimeAsync(20);
    expect(container.querySelector<HTMLElement>('.blackboard-text-item')!.style.left).toBe('260px');
  });

  it('text mode toggles the class the stylesheet keys interactivity off', () => {
    const { layer, container } = mount();
    const overlay = container.querySelector('.blackboard-text-layer')!;
    layer.setTextMode(true);
    expect(overlay.classList.contains('is-text-mode')).toBe(true);
    layer.setTextMode(false);
    expect(overlay.classList.contains('is-text-mode')).toBe(false);
  });
});

describe('TextLayer editing', () => {
  it('creating a label opens an editor and hides the label node until commit', async () => {
    const { layer, container } = mount();
    layer.createAt(50, 60);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('textarea.blackboard-text-editor')).not.toBeNull();
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(0);
  });

  it('places a new label at the drawing-space position of the click', async () => {
    const { layer, container, engine, doc } = mount();
    engine.view.scale = 2;
    engine.view.offsetX = 10;
    layer.createAt(210, 40);
    await vi.advanceTimersByTimeAsync(0);
    const editor = container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!;
    editor.value = 'placed';
    layer.commitEditor();
    await vi.advanceTimersByTimeAsync(20);
    const written = doc.getItems();
    expect(written[0].x).toBe(100); // (210 - 10) / 2
    expect(written[0].y).toBe(20);
  });

  it('a new label takes the active drawing colour', async () => {
    const { layer, container, doc } = mount();
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'x';
    layer.commitEditor();
    await vi.advanceTimersByTimeAsync(20);
    expect(doc.getItems()[0].color).toBe('#00ff00');
  });

  it('committing persists the text and renders it as a label', async () => {
    const { layer, container, doc } = mount();
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'committed';
    layer.commitEditor();
    expect(container.querySelector('.blackboard-text-editor')).toBeNull();
    expect(container.querySelector('.blackboard-text-item')!.textContent).toBe('committed');
    await vi.advanceTimersByTimeAsync(20);
    expect(doc.getItems().map((i) => i.text)).toContain('committed');
  });

  it('committing an empty NEW label leaves nothing behind and writes nothing', async () => {
    const { layer, container, doc } = mount();
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    layer.commitEditor();
    await vi.advanceTimersByTimeAsync(20);
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(0);
    expect(doc.writes).toHaveLength(0);
  });

  it('cancelling a NEW label removes it entirely', async () => {
    const { layer, container, doc } = mount();
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'typed then escaped';
    layer.cancelEditor();
    await vi.advanceTimersByTimeAsync(20);
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(0);
    expect(doc.writes).toHaveLength(0);
  });

  it('cancelling an EXISTING label restores its original text', async () => {
    const { layer, container, doc } = mount([item()]);
    layer.sync();
    const existing = layer.itemForElement(container.querySelector('.blackboard-text-item'))!;
    layer.edit(existing);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'edited away';
    layer.cancelEditor();
    await vi.advanceTimersByTimeAsync(20);
    expect(container.querySelector('.blackboard-text-item')!.textContent).toBe('hello');
    expect(doc.writes).toHaveLength(0);
  });

  it('editing an EXISTING label and committing persists the new text', async () => {
    const { layer, container, doc } = mount([item()]);
    layer.sync();
    layer.edit(layer.itemForElement(container.querySelector('.blackboard-text-item'))!);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'rewritten';
    layer.commitEditor();
    await vi.advanceTimersByTimeAsync(20);
    expect(doc.getItems().map((i) => i.text)).toContain('rewritten');
    expect(container.querySelector('.blackboard-text-item')!.textContent).toBe('rewritten');
  });

  it('escape inside the editor cancels through the keydown handler', async () => {
    const { layer, container } = mount([item()]);
    layer.sync();
    layer.edit(layer.itemForElement(container.querySelector('.blackboard-text-item'))!);
    await vi.advanceTimersByTimeAsync(0);
    const editor = container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!;
    editor.value = 'abandoned';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(container.querySelector('.blackboard-text-editor')).toBeNull();
    expect(container.querySelector('.blackboard-text-item')!.textContent).toBe('hello');
  });

  it('the editor does not leak its keystrokes to the document (tool shortcuts stay dead)', async () => {
    const { layer, container } = mount([item()]);
    layer.sync();
    layer.edit(layer.itemForElement(container.querySelector('.blackboard-text-item'))!);
    await vi.advanceTimersByTimeAsync(0);
    const seen: string[] = [];
    document.addEventListener('keydown', (e) => seen.push(e.key));
    container.querySelector('.blackboard-text-editor')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    expect(seen).toEqual([]);
  });

  it('a label deleted from the model is removed from the DOM', async () => {
    const { layer, container, doc } = mount([item(), item({ id: 'b2', text: 'gone' })]);
    layer.sync();
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(2);
    // A sibling surface edited the shared document; this layer adopts it on the next sync.
    doc.setItems([item()]);
    layer.sync();
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(1);
  });

  it('destroy commits an open editor rather than discarding what was typed', async () => {
    const { layer, container, doc } = mount();
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'unmounted mid-edit';
    layer.destroy();
    await vi.advanceTimersByTimeAsync(20);
    expect(doc.getItems().map((i) => i.text)).toContain('unmounted mid-edit');
  });

  it('destroy removes the overlay and unsubscribes from the engine', () => {
    const { layer, container, engine } = mount();
    layer.destroy();
    expect(container.querySelector('.blackboard-text-layer')).toBeNull();
    expect(engine.listeners.size).toBe(0);
  });

  it('load() while an editor is open never clobbers what is being typed', async () => {
    const { layer, container } = mount([item()]);
    layer.sync();
    layer.edit(layer.itemForElement(container.querySelector('.blackboard-text-item'))!);
    await vi.advanceTimersByTimeAsync(0);
    const editor = container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!;
    editor.value = 'in progress';
    layer.sync();
    expect(container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value).toBe('in progress');
  });
});

/** A pointer event with client coordinates, as jsdom's PointerEvent ignores them. */
function pointer(type: string, x: number, y: number, pointerId = 1): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true }) as unknown as PointerEvent;
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

async function withLabel(text = 'hello') {
  const ctx = mount([item({ text })]);
  ctx.layer.sync();
  const node = ctx.container.querySelector<HTMLElement>('.blackboard-text-item')!;
  return { ...ctx, node, target: ctx.layer.itemForElement(node)! };
}

describe('TextLayer selection', () => {
  it('nothing is selected until a label is', async () => {
    const { layer, node } = await withLabel();
    expect(layer.selectedItem).toBeNull();
    expect(node.classList.contains('is-selected')).toBe(false);
  });

  it('selecting marks the label with a class the stylesheet keys off', async () => {
    const { layer, container, target } = await withLabel();
    layer.select(target.id);
    expect(layer.selectedItem?.id).toBe(target.id);
    expect(container.querySelector('.blackboard-text-item')!.classList.contains('is-selected')).toBe(true);
  });

  it('selecting null clears it again', async () => {
    const { layer, container, target } = await withLabel();
    layer.select(target.id);
    layer.select(null);
    expect(layer.selectedItem).toBeNull();
    expect(container.querySelector('.blackboard-text-item')!.classList.contains('is-selected')).toBe(false);
  });

  it('leaving the text tool drops the selection (Delete must not act later)', async () => {
    const { layer, target } = await withLabel();
    layer.setTextMode(true);
    layer.select(target.id);
    layer.setTextMode(false);
    expect(layer.selectedItem).toBeNull();
  });
});

describe('TextLayer delete', () => {
  it('removes the selected label, rewrites the sidecar, and is one undo step', async () => {
    const { layer, container, target, doc, engine } = await withLabel();
    layer.select(target.id);

    expect(layer.deleteSelected()).toBe(true);

    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(doc.getItems()).toEqual([]);

    engine.strokeManager.undo();
    expect(container.querySelector('.blackboard-text-item')!.textContent).toBe('hello');
    await vi.advanceTimersByTimeAsync(20);
    expect(doc.getItems()[0].id).toBe(target.id);
  });

  it('does nothing with no selection', async () => {
    const { layer, container } = await withLabel();
    expect(layer.deleteSelected()).toBe(false);
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(1);
  });

  it('is refused while the editor is open — there Backspace is a character', async () => {
    const { layer, container, target } = await withLabel();
    layer.select(target.id);
    layer.edit(target);
    await vi.advanceTimersByTimeAsync(0);

    expect(layer.deleteSelected()).toBe(false);
    expect(container.querySelector('.blackboard-text-editor')).not.toBeNull();
  });
});

describe('TextLayer move', () => {
  it('a press that never moves opens the editor instead of moving the label', async () => {
    const { layer, container, target, node } = await withLabel();
    layer.setTextMode(true);
    layer.beginDrag(target, pointer('pointerdown', 50, 50));
    node.dispatchEvent(pointer('pointermove', 51, 51)); // below the 4px threshold
    node.dispatchEvent(pointer('pointerup', 51, 51));

    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('.blackboard-text-editor')).not.toBeNull();
    expect(layer.itemForElement(node)?.x ?? 10).toBe(10);
  });

  it('a drag past the threshold moves the label and never opens the editor', async () => {
    const { layer, container, target, node, doc } = await withLabel();
    layer.setTextMode(true);
    expect(doc.writes).toHaveLength(0);
    layer.beginDrag(target, pointer('pointerdown', 50, 50));
    node.dispatchEvent(pointer('pointermove', 90, 70));
    node.dispatchEvent(pointer('pointerup', 90, 70));

    await vi.advanceTimersByTimeAsync(20);
    expect(container.querySelector('.blackboard-text-editor')).toBeNull();
    const written = doc.getItems()[0];
    expect([written.x, written.y]).toEqual([50, 40]); // moved by (+40, +20) from (10, 20)
  });

  it('a whole drag is ONE undo step, whatever it took to get there', async () => {
    const { layer, target, node, engine } = await withLabel();
    layer.setTextMode(true);
    layer.beginDrag(target, pointer('pointerdown', 50, 50));
    for (const x of [60, 70, 80, 90]) node.dispatchEvent(pointer('pointermove', x, 50));
    node.dispatchEvent(pointer('pointerup', 90, 50));

    engine.strokeManager.undo();

    expect(layer.itemForElement(node)!.x).toBe(10);
    expect(engine.strokeManager.canUndo()).toBe(false);
  });

  it('a cancelled drag commits nothing and releases the capture', async () => {
    const { layer, target, node, engine } = await withLabel();
    layer.setTextMode(true);
    layer.beginDrag(target, pointer('pointerdown', 50, 50));
    expect(node.hasPointerCapture(1)).toBe(true);
    node.dispatchEvent(pointer('pointermove', 90, 50));

    node.dispatchEvent(pointer('pointercancel', 90, 50));

    expect(node.hasPointerCapture(1)).toBe(false);
    expect(layer.itemForElement(node)!.x).toBe(10);
    expect(engine.strokeManager.canUndo()).toBe(false);
  });

  it('losing the capture ends the drag the same way as a cancel', async () => {
    const { layer, target, node, engine } = await withLabel();
    layer.setTextMode(true);
    layer.beginDrag(target, pointer('pointerdown', 50, 50));
    node.dispatchEvent(pointer('pointermove', 90, 50));
    node.dispatchEvent(pointer('lostpointercapture', 90, 50));

    expect(layer.isDragging()).toBe(false);
    expect(engine.strokeManager.canUndo()).toBe(false);
  });

  it('ignores moves from a different pointer (a second finger cannot steer the drag)', async () => {
    const { layer, target, node } = await withLabel();
    layer.setTextMode(true);
    layer.beginDrag(target, pointer('pointerdown', 50, 50, 1));

    node.dispatchEvent(pointer('pointermove', 300, 300, 2));

    expect(layer.isDragging()).toBe(false);
  });

  it('the drag delta is measured in DRAWING space, so zoom does not exaggerate it', async () => {
    const ctx = mount([item()]);
    ctx.engine.view.scale = 2;
    ctx.layer.sync();
    const node = ctx.container.querySelector<HTMLElement>('.blackboard-text-item')!;
    const target = ctx.layer.itemForElement(node)!;
    ctx.layer.setTextMode(true);

    ctx.layer.beginDrag(target, pointer('pointerdown', 100, 100));
    node.dispatchEvent(pointer('pointermove', 140, 100));
    node.dispatchEvent(pointer('pointerup', 140, 100));

    // 40 screen px at 2x zoom is 20 drawing units.
    expect(ctx.layer.itemForElement(node)!.x).toBe(30);
  });
});

describe('TextLayer undo/redo joins the engine timeline', () => {
  it('creating a label is undoable, and redo restores it with the same id', async () => {
    const { layer, container, doc, engine } = mount();
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'note';
    layer.commitEditor();
    const id = layer.itemForElement(container.querySelector('.blackboard-text-item'))!.id;
    await vi.advanceTimersByTimeAsync(20);

    engine.strokeManager.undo();
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(doc.getItems()).toEqual([]);

    engine.strokeManager.redo();
    expect(layer.itemForElement(container.querySelector('.blackboard-text-item'))!.id).toBe(id);
    await vi.advanceTimersByTimeAsync(20);
    expect(doc.getItems()[0].id).toBe(id);
  });

  it('editing a label is undoable back to its previous text', async () => {
    const { layer, container, target, engine } = await withLabel();
    layer.edit(target);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'rewritten';
    layer.commitEditor();

    engine.strokeManager.undo();

    expect(container.querySelector('.blackboard-text-item')!.textContent).toBe('hello');
  });

  it('committing an unchanged edit records nothing (no empty undo step)', async () => {
    const { layer, container, target, engine } = await withLabel();
    layer.edit(target);
    await vi.advanceTimersByTimeAsync(0);
    layer.commitEditor();

    expect(engine.strokeManager.canUndo()).toBe(false);
    expect(container.querySelector('.blackboard-text-item')!.textContent).toBe('hello');
  });

  it('an abandoned new label records nothing', async () => {
    const { layer, engine } = mount();
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    layer.commitEditor();

    expect(engine.strokeManager.canUndo()).toBe(false);
  });

  it('label edits and strokes reverse in the order they happened', async () => {
    const { layer, container, engine } = mount();
    const strokeManager = engine.strokeManager;
    strokeManager.addStroke({
      id: 's1', tool: 'pen', color: '#fff', size: 2, opacity: 1,
      points: [[0, 0, 0.5]], hasPressure: false, timestamp: 0,
    } as never);
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'label';
    layer.commitEditor();

    strokeManager.undo();
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(0);
    expect(strokeManager.strokes).toHaveLength(1);

    strokeManager.undo();
    expect(strokeManager.strokes).toHaveLength(0);
  });

  it('a new label takes the TEXT tool\'s colour and font size, not the pen\'s', async () => {
    const { layer, container, doc, engine } = mount();
    engine.toolManager.textColor = '#ff00ff';
    engine.toolManager.textFontSize = 40;
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'big';
    layer.commitEditor();
    await vi.advanceTimersByTimeAsync(20);

    const written = doc.getItems()[0];
    expect(written.color).toBe('#ff00ff');
    expect(written.fontSize).toBe(40);
  });

  it('an existing label keeps its own stored colour and size when edited', async () => {
    const ctx = mount([item({ color: '#123456', fontSize: 12 })]);
    ctx.layer.sync();
    ctx.engine.toolManager.textColor = '#ff00ff';
    ctx.engine.toolManager.textFontSize = 40;
    const target = ctx.layer.itemForElement(ctx.container.querySelector('.blackboard-text-item'))!;
    ctx.layer.edit(target);
    await vi.advanceTimersByTimeAsync(0);
    ctx.container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = 'still small';
    ctx.layer.commitEditor();
    await vi.advanceTimersByTimeAsync(20);

    const written = ctx.doc.getItems()[0];
    expect(written.color).toBe('#123456');
    expect(written.fontSize).toBe(12);
  });
});

describe('TextLayer itemAt — geometric hit test', () => {
  it('finds the label whose box contains the point', async () => {
    const { layer } = await withLabel();
    expect(layer.itemAt(12, 22)?.text).toBe('hello');
    expect(layer.itemAt(-40, -40)).toBeNull();
  });

  it('maps through the view transform before testing', async () => {
    const ctx = mount([item()]);
    ctx.engine.view.scale = 2;
    ctx.engine.view.offsetX = 100;
    ctx.layer.sync();
    // Drawing (10,20) sits at screen (120, 40) under this transform.
    expect(ctx.layer.itemAt(122, 42)?.text).toBe('hello');
    expect(ctx.layer.itemAt(10, 20)).toBeNull();
  });
});

describe('TextLayer erasing', () => {
  /** jsdom lays nothing out, so a label falls back to the font-size estimate: ~55x25 at 20px. */
  const wide = () => item({ id: 'w1', x: 0, y: 0, text: 'hello' });
  const far = () => item({ id: 'f1', x: 500, y: 500, text: 'far away' });

  it('a label under the eraser is removed and written through the document', () => {
    const { layer, container, doc } = mount([wide()]);
    layer.sync();

    layer.beginErase();
    expect(layer.eraseAt(5, 5, 15)).toBe(true);
    layer.endErase();

    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(0);
    expect(doc.getItems()).toEqual([]);
  });

  it('a label outside the eraser path survives', () => {
    const { layer, container, doc } = mount([wide(), far()]);
    layer.sync();

    layer.beginErase();
    layer.eraseAt(5, 5, 15);
    layer.endErase();

    expect(doc.getItems().map((i) => i.id)).toEqual(['f1']);
    expect(container.querySelectorAll('.blackboard-text-item')).toHaveLength(1);
  });

  it('a whole gesture is ONE undo step, however many labels it swept and however many samples', () => {
    const { layer, engine, doc } = mount([wide(), item({ id: 'w2', x: 0, y: 40, text: 'second' })]);
    layer.sync();

    layer.beginErase();
    for (let y = 0; y <= 60; y += 2) layer.eraseAt(5, y, 15);
    expect(layer.endErase()).toBe(true);

    expect(doc.getItems()).toEqual([]);
    engine.strokeManager.undo();
    expect(doc.getItems().map((i) => i.id)).toEqual(['w1', 'w2']);
    expect(engine.strokeManager.canUndo()).toBe(false);
  });

  it('undo restores each label at the index it was erased from', () => {
    const items = [wide(), item({ id: 'w2', x: 0, y: 40, text: 'b' }), item({ id: 'w3', x: 0, y: 80, text: 'c' })];
    const { layer, engine, doc } = mount(items);
    layer.sync();

    layer.beginErase();
    layer.eraseAt(5, 45, 15); // the middle one
    layer.endErase();
    expect(doc.getItems().map((i) => i.id)).toEqual(['w1', 'w3']);

    engine.strokeManager.undo();
    expect(doc.getItems().map((i) => i.id)).toEqual(['w1', 'w2', 'w3']);
  });

  it('redo re-erases the whole gesture', () => {
    const { layer, engine, doc } = mount([wide()]);
    layer.sync();
    layer.beginErase();
    layer.eraseAt(5, 5, 15);
    layer.endErase();

    engine.strokeManager.undo();
    engine.strokeManager.redo();

    expect(doc.getItems()).toEqual([]);
  });

  it('a gesture that hit nothing records no undo step at all', () => {
    const { layer, engine } = mount([far()]);
    layer.sync();

    layer.beginErase();
    layer.eraseAt(5, 5, 15);

    expect(layer.endErase()).toBe(false);
    expect(engine.strokeManager.canUndo()).toBe(false);
  });

  it('erasing outside a gesture does nothing (no stray deletions from a pointermove)', () => {
    const { layer, doc } = mount([wide()]);
    layer.sync();

    expect(layer.eraseAt(5, 5, 15)).toBe(false);
    expect(doc.getItems()).toHaveLength(1);
  });

  it('the same label is never erased (or recorded) twice within one gesture', () => {
    const { layer, doc, engine } = mount([wide()]);
    layer.sync();

    layer.beginErase();
    expect(layer.eraseAt(5, 5, 15)).toBe(true);
    expect(layer.eraseAt(5, 5, 15)).toBe(false);
    layer.endErase();

    engine.strokeManager.undo();
    expect(doc.getItems()).toHaveLength(1);
  });

  it('measures ONCE per gesture: a pointermove sample re-measures nothing', () => {
    const { layer, engine } = mount([wide(), far()]);
    layer.sync();
    const measured = vi.spyOn(engine, 'getViewTransform');

    layer.beginErase();
    measured.mockClear();
    for (let i = 0; i < 200; i++) layer.eraseAt(300 + i, 300, 15);
    layer.endErase();

    expect(measured).not.toHaveBeenCalled();
  });

  it('the miss path allocates nothing per sample', () => {
    const { layer } = mount([far()]);
    layer.sync();
    layer.beginErase();

    // Every way this code could allocate on the hot path, counted. Array literals cannot be
    // intercepted, so this is backed by the implementation keeping its boxes in flat arrays
    // built once in beginErase.
    let allocations = 0;
    const count = <T extends (...args: never[]) => unknown>(fn: T): T =>
      (function (this: unknown, ...args: never[]) { allocations++; return fn.apply(this, args); }) as unknown as T;
    const targets: Array<[object, string]> = [
      [Array.prototype, 'map'], [Array.prototype, 'filter'], [Array.prototype, 'slice'],
      [Array.prototype, 'concat'], [Array.prototype, 'push'], [Object, 'assign'], [Array, 'from'],
    ];
    // Originals are collected BEFORE anything is patched, or the bookkeeping counts itself.
    const patched = targets.map(([obj, key]) => [obj, key, (obj as Record<string, unknown>)[key]] as const);
    for (const [obj, key, original] of patched) {
      (obj as Record<string, unknown>)[key] = count(original as (...args: never[]) => unknown);
    }
    try {
      for (let i = 0; i < 500; i++) layer.eraseAt(i, 12, 15);
    } finally {
      for (const [obj, key, original] of patched) (obj as Record<string, unknown>)[key] = original;
    }

    expect(allocations).toBe(0);
    layer.endErase();
  });

  it('erasing the selected label clears the selection', () => {
    const { layer } = mount([wide()]);
    layer.sync();
    layer.select('w1');

    layer.beginErase();
    layer.eraseAt(5, 5, 15);
    layer.endErase();

    expect(layer.selectedItem).toBeNull();
  });

  it('erased labels interleave with strokes on the one undo timeline, in order', () => {
    const { layer, engine, doc } = mount([wide()]);
    layer.sync();
    const strokes = engine.strokeManager;
    strokes.addStroke({
      id: 's1', tool: 'pen', color: '#fff', size: 2, opacity: 1,
      points: [[0, 0, 0.5]], hasPressure: false, timestamp: 0,
    } as never);

    layer.beginErase();
    layer.eraseAt(5, 5, 15);
    layer.endErase();

    strokes.undo();                       // the erase gesture, most recent
    expect(doc.getItems()).toHaveLength(1);
    expect(strokes.strokes).toHaveLength(1);

    strokes.undo();                       // then the stroke
    expect(strokes.strokes).toHaveLength(0);
  });
});

describe('text through the shared document — the wave-1 undo timeline, unchanged', () => {
  function sharedMount() {
    const saved: BlackboardFile[] = [];
    const repo = {
      load: vi.fn(async () => ({
        file: { version: 3, width: 800, height: 600, strokes: [], background: { color: 'transparent' } } as BlackboardFile,
        warnings: [], readonly: false,
      })),
      save: vi.fn(async (_p: string, f: BlackboardFile) => { saved.push(f); }),
      writeRaw: vi.fn(), create: vi.fn(), exists: vi.fn(() => true),
      ensureFolder: vi.fn(), delete: vi.fn(), rename: vi.fn(),
    } as unknown as IDrawingRepository;
    const store = new DocumentStore({ saveDelayMs: 0 });
    const container = document.createElement('div');
    container.className = 'blackboard-drawing-container';
    document.body.appendChild(container);
    const engine = fakeEngine();
    return { repo, store, container, engine, saved };
  }

  async function build() {
    const ctx = sharedMount();
    const handle = await ctx.store.acquire('D.blackboard', ctx.repo);
    const layer = new TextLayer(ctx.engine as never, ctx.container, () => handleTextDocument(handle));
    return { ...ctx, handle, layer };
  }

  const type = async (layer: TextLayer, container: HTMLElement, text: string) => {
    layer.createAt(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector<HTMLTextAreaElement>('.blackboard-text-editor')!.value = text;
    layer.commitEditor();
  };

  const addStroke = (engine: { strokeManager: StrokeManager }, id: string) => {
    engine.strokeManager.addStroke({
      id, tool: 'pen', color: '#fff', size: 2, opacity: 1,
      points: [[0, 0, 0.5]], hasPressure: false, timestamp: 0,
    } as never);
  };

  it('a label committed by the layer lands in the shared document', async () => {
    const { layer, container, handle } = await build();
    await type(layer, container, 'in the file');
    expect(handle.getTextItems().map((i) => i.text)).toEqual(['in the file']);
  });

  it('text and strokes reverse in the exact order they happened', async () => {
    const { layer, container, engine, handle } = await build();
    const strokes = engine.strokeManager;

    addStroke(engine, 's1');
    await type(layer, container, 'first label');
    addStroke(engine, 's2');
    await type(layer, container, 'second label');
    const id = handle.getTextItems()[1].id;
    layer.select(id);
    layer.deleteSelected();
    addStroke(engine, 's3');

    const order: string[] = [];
    const snapshot = () => `${String(strokes.strokes.length)}/${handle.getTextItems().map((i) => i.text).join(',')}`;

    for (let i = 0; i < 6; i++) { strokes.undo(); order.push(snapshot()); }

    expect(order).toEqual([
      '2/first label',                 // s3
      '2/first label,second label',    // the delete
      '2/first label',                 // second label's creation
      '1/first label',                 // s2
      '1/',                            // first label's creation
      '0/',                            // s1
    ]);
    expect(strokes.canUndo()).toBe(false);
  });

  it('redo replays the same interleaving forwards', async () => {
    const { layer, container, engine, handle } = await build();
    addStroke(engine, 's1');
    await type(layer, container, 'label');
    addStroke(engine, 's2');

    const strokes = engine.strokeManager;
    strokes.undo(); strokes.undo(); strokes.undo();
    expect(strokes.strokes).toHaveLength(0);
    expect(handle.getTextItems()).toEqual([]);

    strokes.redo(); strokes.redo(); strokes.redo();
    expect(strokes.strokes.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(handle.getTextItems().map((i) => i.text)).toEqual(['label']);
  });

  it('every label edit goes through the document\'s ONE debounced save', async () => {
    const { layer, container, repo } = await build();
    await type(layer, container, 'saved with the strokes');
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.save).mock.calls[0][1].text?.items[0].text).toBe('saved with the strokes');
  });

  it('a sibling surface sees the label after a sync', async () => {
    const { layer, container, store, repo, engine } = await build();
    const sibling = document.createElement('div');
    sibling.className = 'blackboard-drawing-container';
    document.body.appendChild(sibling);
    const siblingHandle = await store.acquire('D.blackboard', repo);
    const siblingLayer = new TextLayer(fakeEngine() as never, sibling, () => handleTextDocument(siblingHandle));
    siblingHandle.subscribe(() => siblingLayer.sync());

    await type(layer, container, 'typed on the first surface');

    expect(sibling.querySelector('.blackboard-text-item')!.textContent).toBe('typed on the first surface');
    expect(engine.strokeManager.canUndo()).toBe(true);
  });
});
