import { vi } from 'vitest';

// Polyfill ResizeObserver for jsdom
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

if (!HTMLElement.prototype.empty) {
  HTMLElement.prototype.empty = function () {
    this.innerHTML = '';
  };
}

if (!HTMLElement.prototype.addClass) {
  (HTMLElement.prototype as any).addClass = function (cls: string) {
    this.classList.add(cls);
  };
}

if (!HTMLElement.prototype.removeClass) {
  (HTMLElement.prototype as any).removeClass = function (cls: string) {
    this.classList.remove(cls);
  };
}

if (!HTMLElement.prototype.createDiv) {
  (HTMLElement.prototype as any).createDiv = function (opts?: { cls?: string; text?: string }) {
    const div = document.createElement('div');
    if (opts?.cls) div.className = opts.cls;
    if (opts?.text) div.textContent = opts.text;
    this.appendChild(div);
    return div;
  };
}

if (!HTMLElement.prototype.createEl) {
  (HTMLElement.prototype as any).createEl = function (tag: string, opts?: { cls?: string; text?: string }) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    this.appendChild(el);
    return el;
  };
}

// jsdom lacks Obsidian's setCssStyles; mirror its behavior (assign onto inline style).
if (!HTMLElement.prototype.setCssStyles) {
  (HTMLElement.prototype as any).setCssStyles = function (styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
}

// jsdom ships no pointer-capture API, but every drag in the plugin captures the pointer at
// drag start and releases it on up/cancel. A tiny per-element registry makes the real calls
// observable in tests instead of silently swallowed by the callers' try/catch.
if (!HTMLElement.prototype.setPointerCapture) {
  const captured = new WeakMap<HTMLElement, Set<number>>();
  (HTMLElement.prototype as any).setPointerCapture = function (pointerId: number) {
    let ids = captured.get(this);
    if (!ids) { ids = new Set(); captured.set(this, ids); }
    ids.add(pointerId);
  };
  (HTMLElement.prototype as any).hasPointerCapture = function (pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false;
  };
  (HTMLElement.prototype as any).releasePointerCapture = function (pointerId: number) {
    captured.get(this)?.delete(pointerId);
  };
}

if (typeof globalThis.URL.createObjectURL !== 'function') {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
}

if (typeof globalThis.URL.revokeObjectURL !== 'function') {
  globalThis.URL.revokeObjectURL = vi.fn();
}

// Obsidian runtime globals (obsidian.d.ts declares them; the app provides them).
// activeDocument/activeWindow alias the focused window — in jsdom that's the one window.
(globalThis as any).activeDocument = document;
(globalThis as any).activeWindow = window;
if (typeof (globalThis as any).createEl !== 'function') {
  (globalThis as any).createEl = (tag: string, o?: { cls?: string; text?: string }) => {
    const el = document.createElement(tag);
    if (o?.cls) el.className = o.cls;
    if (o?.text) el.textContent = o.text;
    return el;
  };
}
if (typeof (globalThis as any).createDiv !== 'function') {
  (globalThis as any).createDiv = (o?: { cls?: string; text?: string }) =>
    (globalThis as any).createEl('div', o);
}

// jsdom ships no Path2D, but the static renderer caches each stroke's outline as one.
// This stand-in records the path-building calls in order, so tests can assert the exact
// geometry a stroke produces (and that a cached stroke is not rebuilt).
if (typeof (globalThis as any).Path2D === 'undefined') {
  (globalThis as any).Path2D = class Path2D {
    ops: Array<[string, ...number[]]> = [];
    moveTo(x: number, y: number) { this.ops.push(['moveTo', x, y]); }
    lineTo(x: number, y: number) { this.ops.push(['lineTo', x, y]); }
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
      this.ops.push(['quadraticCurveTo', cx, cy, x, y]);
    }
    closePath() { this.ops.push(['closePath']); }
  };
}
