import type { DrawingEngine } from '../infrastructure/canvas-renderer';
import type { TextDocument } from '../application/text-document';
import type { ToolManager } from '../domain/tool-manager';
import type { ToolName } from '../domain/entities';
import type { SurfaceManager } from './surface-manager';
import { TextLayer } from './text-layer';
import {
  decidePointerDown,
  isBlackboardChrome,
  isDeleteSelectionKey,
  isTypingTarget,
} from './text-mode';
import { fallbackCommandForKey } from './tool-commands';

/**
 * How the controller reaches Obsidian's command system. The physical-key fallback does not
 * act on the tool directly — it runs the very same command the Hotkeys pane runs, so there is
 * exactly one code path from "user asked for the eraser" to "the eraser is selected".
 */
export interface HotkeyBridge {
  /** Run one of our tool commands by its plugin-local id. */
  run(commandId: string): void;
  /** Whether the user has given this command a hotkey of their own (Obsidian then owns it). */
  isRebound(commandId: string): boolean;
}

/**
 * Owns the text tool across every mounted drawing surface: which surfaces have a text layer,
 * the click-outside rule, label selection, and the physical-key fallback for the tool
 * commands.
 *
 * Text mode is no longer controller-local state: `text` is a real `ToolManager` tool, and the
 * controller derives its mode from the shared tool selection (subscribing to it, so picking
 * another tool anywhere — toolbar, command, hotkey — leaves text mode by itself).
 */
export class TextController {
  private layers = new Set<TextLayer>();
  private lastActive: TextLayer | null = null;
  /**
   * The shortcuts are armed only once the user has actually touched Blackboard, so a bare
   * "e" in a note never switches tools. Disarmed by focus moving outside Blackboard chrome
   * and by Escape.
   */
  private armed = false;
  private boundDocs = new WeakSet<Document>();
  private abort = new AbortController();
  private onStateChange: (() => void) | null = null;
  private hotkeys: HotkeyBridge | null = null;
  private unsubscribeTool: () => void;

  constructor(
    private toolManager: ToolManager,
    private surfaceManager: SurfaceManager,
  ) {
    // The tool selection is the single source of truth for text mode; mirror it rather than
    // shadowing it with a second flag that has to be kept in step at every call site.
    this.unsubscribeTool = toolManager.onChange(() => this.syncFromTool());
  }

  /** Called whenever the toolbar's T button may need re-rendering. */
  setStateListener(cb: (() => void) | null): void {
    this.onStateChange = cb;
  }

  /** Wire the controller to Obsidian's commands (see `HotkeyBridge`). */
  setHotkeyBridge(bridge: HotkeyBridge | null): void {
    this.hotkeys = bridge;
  }

  /**
   * Give a surface a text layer over its shared document's text. Returns the layer plus the
   * detach function the surface calls on unmount. Also binds this surface's document, which is how a pop-out window gets its
   * listeners without anything having to enumerate windows.
   */
  attach(engine: DrawingEngine, container: HTMLElement, document: () => TextDocument | null): { layer: TextLayer; detach: () => void } {
    // A label edit changes what undo/redo would do, so the toolbar is re-synced exactly as
    // it is when a stroke ends.
    const layer = new TextLayer(engine, container, document, () => this.surfaceManager.refresh());
    this.layers.add(layer);
    this.lastActive = layer;
    this.bindDocument(container.ownerDocument);
    layer.setTextMode(this.isTextMode() && this.current() === layer);
    layer.sync();
    this.notify();
    return {
      layer,
      detach: () => {
        this.layers.delete(layer);
        if (this.lastActive === layer) this.lastActive = null;
        layer.destroy();
        this.notify();
      },
    };
  }

  /** The layer the toolbar and the shortcuts act on. */
  current(): TextLayer | null {
    if (this.lastActive && this.layers.has(this.lastActive)) return this.lastActive;
    if (this.layers.size === 1) return this.layers.values().next().value ?? null;
    return null;
  }

  isTextMode(): boolean {
    return this.toolManager.activeTool === 'text' && this.current() !== null;
  }

  /** True when there is a surface for the T button to act on. */
  hasSurface(): boolean {
    return this.current() !== null;
  }

  toggleTextMode(): void {
    this.setTextMode(!this.isTextMode());
  }

  setTextMode(on: boolean): void {
    if (on && !this.current()) return;
    // Leaving text mode always lands on the pen, so the surface is immediately drawable.
    this.toolManager.setTool(on ? 'text' : 'pen');
    this.surfaceManager.refresh();
    this.notify();
  }

  /** Select a tool. `text` needs a surface; the drawing tools always leave text mode. */
  selectTool(tool: ToolName): void {
    if (tool === 'text') {
      this.setTextMode(true);
      return;
    }
    this.toolManager.setTool(tool);
    this.surfaceManager.refresh();
  }

  /** Register this controller's listeners on a document exactly once. */
  bindDocument(doc: Document): void {
    if (this.boundDocs.has(doc)) return;
    this.boundDocs.add(doc);
    const signal = this.abort.signal;
    doc.addEventListener('pointerdown', this.onPointerDown, { capture: true, signal });
    doc.addEventListener('dblclick', this.onDoubleClick, { capture: true, signal });
    doc.addEventListener('focusin', this.onFocusIn, { capture: true, signal });
    doc.addEventListener('keydown', this.onKeyDown, { capture: true, signal });
  }

  destroy(): void {
    for (const layer of this.layers) layer.destroy();
    this.layers.clear();
    this.lastActive = null;
    this.unsubscribeTool();
    this.abort.abort();
    this.onStateChange = null;
    this.hotkeys = null;
  }

  private notify(): void {
    this.onStateChange?.();
  }

  /** Push the shared tool selection down onto every layer. */
  private syncFromTool(): void {
    const on = this.isTextMode();
    const active = this.current();
    for (const layer of this.layers) layer.setTextMode(on && layer === active);
    this.notify();
  }

  private layerForElement(el: Element | null): TextLayer | null {
    const container = el?.closest<HTMLElement>('.blackboard-drawing-container');
    if (!container) return null;
    for (const layer of this.layers) {
      if (layer.container === container) return layer;
    }
    return null;
  }

  private openEditorLayer(): TextLayer | null {
    for (const layer of this.layers) {
      if (layer.hasOpenEditor()) return layer;
    }
    return null;
  }

  private readonly onPointerDown = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    if ((event as PointerEvent).altKey && target?.closest('.blackboard-embed') && !target.closest('.canvas-node')) return;
    // Interacting with any Blackboard chrome arms the shortcuts.
    this.armed = isBlackboardChrome(target);
    if (!target) return;

    const layer = this.layerForElement(target);
    if (layer) this.lastActive = layer;

    const editorLayer = this.openEditorLayer();
    const action = decidePointerDown({
      inEditor: target.closest('.blackboard-text-editor') !== null,
      editorOpen: editorLayer !== null,
      inDrawingContainer: target.closest('.blackboard-drawing-container') !== null,
      onTextItem: target.closest('.blackboard-text-item') !== null,
      textMode: this.isTextMode() && layer !== null && layer === this.current(),
    });

    switch (action) {
      case 'shield-editor':
      case 'shield-item':
        event.stopPropagation();
        return;
      case 'select-text-item': {
        // Shield it from the drawing surface, select it, and arm a move. The gesture only
        // becomes a move past the threshold; otherwise the release opens the editor.
        event.stopPropagation();
        const pointer = event as PointerEvent;
        const item = layer?.itemForElement(target);
        if (layer && item) layer.beginDrag(item, pointer);
        return;
      }
      case 'commit':
        editorLayer?.commitEditor();
        return;
      case 'commit-and-consume':
        editorLayer?.commitEditor();
        this.setTextMode(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      case 'create-text': {
        if (!layer) return;
        event.preventDefault();
        event.stopPropagation();
        const pointer = event as PointerEvent;
        // A press inside an existing label's box grabs that label rather than stacking a
        // new one on top of it, even when the press missed the label's own DOM node.
        const hit = layer.itemAt(pointer.clientX, pointer.clientY);
        if (hit) { layer.beginDrag(hit, pointer); return; }
        layer.createAt(pointer.clientX, pointer.clientY);
        return;
      }
      default:
        return;
    }
  };

  private readonly onDoubleClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.blackboard-text-item')) return;
    const layer = this.layerForElement(target);
    const item = layer?.itemForElement(target);
    if (!layer || !item) return;
    this.lastActive = layer;
    event.preventDefault();
    event.stopPropagation();
    layer.edit(item);
  };

  private readonly onFocusIn = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (!isBlackboardChrome(target)) this.armed = false;
  };

  private readonly onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    if (e.key === 'Escape') {
      this.armed = false;
      // The open editor handles its own Escape (restore-and-close); don't also exit the mode.
      if (this.openEditorLayer()) return;
      // Escape steps out: first the selection, then the mode.
      const layer = this.current();
      if (layer?.selectedItem) { layer.select(null); return; }
      if (this.isTextMode()) this.setTextMode(false);
      return;
    }

    if (isTypingTarget(e.target, e.target instanceof Element ? null : this.activeElement(e))) return;

    // Delete/Backspace removes the selected label. Never while the editor is open (checked
    // above through isTypingTarget, and again here for a selection held by another layer).
    if (isDeleteSelectionKey(e) && this.isTextMode() && !this.openEditorLayer()) {
      const layer = this.current();
      if (layer?.deleteSelected()) {
        e.preventDefault();
        e.stopPropagation();
        this.surfaceManager.refresh();
      }
      return;
    }

    // Physical-key fallback for the tool commands. Obsidian matches hotkeys on the CHARACTER,
    // so its own binding is dead on a Cyrillic layout; matching the physical key here keeps
    // the shortcuts under the same fingers on every layout. It defers to Obsidian for any
    // command the user has rebound, and never fires without a bridge to run the command.
    if (!this.hotkeys) return;
    const command = fallbackCommandForKey(e, (id) => this.hotkeys?.isRebound(id) ?? false);
    if (!command) return;
    if (!this.armed && !isBlackboardChrome(e.target)) return;
    e.preventDefault();
    // stopPropagation, never stopImmediatePropagation: other listeners on this same document
    // (including Obsidian's own) are entitled to run.
    e.stopPropagation();
    this.hotkeys.run(command.id);
  };

  private activeElement(e: Event): Element | null {
    const doc = (e.currentTarget as Document | null) ?? null;
    return doc?.activeElement ?? null;
  }
}
