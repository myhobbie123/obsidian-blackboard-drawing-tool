import type { ToolName, ToolState } from './entities';
import { DEFAULT_TEXT_COLOR, DEFAULT_TEXT_FONT_SIZE } from './text-item';

export class ToolManager {
  activeTool: ToolName;
  private penColor_: string;
  private penSize: number;
  private highlighterColor_: string;
  private highlighterSize: number;
  private eraserSize: number;
  private textColor_: string;
  private textFontSize_: number;
  /**
   * Anything that mirrors tool state (the text controller's mode, the plugin's settings
   * persistence) subscribes here rather than being pushed to from every call site — the same
   * listener pattern the surface manager and the engine's view transform already use.
   */
  private listeners = new Set<() => void>();

  constructor(defaults?: Partial<ToolState>) {
    this.activeTool = defaults?.activeTool ?? 'pen';
    this.penColor_ = defaults?.penColor ?? '#ffffff';
    this.penSize = defaults?.penSize ?? 4;
    this.highlighterColor_ = defaults?.highlighterColor ?? '#FFFF00';
    this.highlighterSize = defaults?.highlighterSize ?? 20;
    this.eraserSize = defaults?.eraserSize ?? 10;
    this.textColor_ = defaults?.textColor ?? DEFAULT_TEXT_COLOR;
    this.textFontSize_ = defaults?.textFontSize ?? DEFAULT_TEXT_FONT_SIZE;
  }

  /** Subscribe to tool/colour/size changes. Returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  setTool(tool: ToolName): void {
    if (this.activeTool === tool) return;
    this.activeTool = tool;
    this.notify();
  }

  /**
   * Apply per-tool defaults from settings to every tool at once, then select the active tool.
   * Assigns each tool's color/size directly (unlike `setColor`/`setSize`, which only touch the
   * active tool), so highlighter and eraser defaults are honored regardless of `activeTool`.
   */
  setDefaults(defaults: Partial<ToolState>): void {
    if (defaults.penColor !== undefined) this.penColor_ = defaults.penColor;
    if (defaults.penSize !== undefined) this.penSize = defaults.penSize;
    if (defaults.highlighterColor !== undefined) this.highlighterColor_ = defaults.highlighterColor;
    if (defaults.highlighterSize !== undefined) this.highlighterSize = defaults.highlighterSize;
    if (defaults.eraserSize !== undefined) this.eraserSize = defaults.eraserSize;
    if (defaults.textColor !== undefined) this.textColor_ = defaults.textColor;
    if (defaults.textFontSize !== undefined) this.textFontSize_ = defaults.textFontSize;
    if (defaults.activeTool !== undefined) this.activeTool = defaults.activeTool;
    this.notify();
  }

  /**
   * Tools that draw with (and configure) the PEN's colour and width: the pen itself, the four
   * shape tools — a committed shape is a pen stroke — and the select tool, whose colour is
   * what a group recolour applies.
   */
  private usesPenStyle(): boolean {
    return this.activeTool !== 'highlighter' && this.activeTool !== 'eraser' && this.activeTool !== 'text';
  }

  setColor(color: string): void {
    if (this.usesPenStyle()) {
      this.penColor_ = color;
    } else if (this.activeTool === 'highlighter') {
      this.highlighterColor_ = color;
    } else if (this.activeTool === 'text') {
      this.textColor_ = color;
    } else {
      return; // the eraser has no colour
    }
    this.notify();
  }

  /** The active tool's size. For the text tool "size" IS its font size — one control, own scale. */
  setSize(size: number): void {
    if (this.usesPenStyle()) {
      this.penSize = size;
    } else if (this.activeTool === 'highlighter') {
      this.highlighterSize = size;
    } else if (this.activeTool === 'eraser') {
      this.eraserSize = size;
    } else if (this.activeTool === 'text') {
      this.textFontSize_ = size;
    }
    this.notify();
  }

  get activeColor(): string {
    if (this.activeTool === 'highlighter') {
      return this.highlighterColor_;
    }
    if (this.activeTool === 'text') {
      return this.textColor_;
    }
    return this.penColor_;
  }

  /** Pen color regardless of the active tool — lets the toolbar tint the pen glyph. */
  get penColor(): string {
    return this.penColor_;
  }

  /** Highlighter color regardless of the active tool — lets the toolbar tint the highlighter glyph. */
  get highlighterColor(): string {
    return this.highlighterColor_;
  }

  /** Text colour regardless of the active tool — lets the toolbar tint the T glyph. */
  get textColor(): string {
    return this.textColor_;
  }

  /** Font size for newly created labels, regardless of the active tool. */
  get textFontSize(): number {
    return this.textFontSize_;
  }

  get activeSize(): number {
    if (this.activeTool === 'highlighter') {
      return this.highlighterSize;
    }
    if (this.activeTool === 'eraser') {
      return this.eraserSize;
    }
    if (this.activeTool === 'text') {
      return this.textFontSize_;
    }
    return this.penSize;
  }

  get activeOpacity(): number {
    if (this.activeTool === 'highlighter') {
      return 0.3;
    }
    return 1.0;
  }

  getState(): ToolState {
    return {
      activeTool: this.activeTool,
      penColor: this.penColor_,
      penSize: this.penSize,
      highlighterColor: this.highlighterColor_,
      highlighterSize: this.highlighterSize,
      eraserSize: this.eraserSize,
      textColor: this.textColor_,
      textFontSize: this.textFontSize_,
    };
  }
}
