import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyEmbedLayout } from '../src/presentation/embed-layout';
import { parseEmbedAlias } from '../src/presentation/embed-size';

describe('offline wrap prototype and shipped fallback', () => {
  it('applies the experimental float in an isolated CM-shaped DOM', () => {
    const fixture = readFileSync('test/fixtures/live-preview-float.html', 'utf8');
    const host = document.createElement('div'); host.innerHTML = fixture; document.body.appendChild(host);
    const board = host.querySelector<HTMLElement>('.blackboard-embed')!;
    expect(window.getComputedStyle(board).float).toBe('left');
    // JSDOM has no geometry engine. These assertions prove CSS application only.
    expect(host.querySelector('.cm-line')?.getAttribute('contenteditable')).toBeNull();
    host.remove();
  });
  it('ships floats in Reading view and centered badges in Live Preview', () => {
    const style = document.createElement('style'); style.textContent = readFileSync('styles.css', 'utf8');
    document.head.appendChild(style);
    const reading = document.body.createDiv({ cls: 'markdown-preview-view' });
    const preview = document.body.createDiv({ cls: 'markdown-source-view' });
    const a = reading.createDiv({ cls: 'blackboard-embed' });
    const b = preview.createDiv({ cls: 'blackboard-embed' });
    applyEmbedLayout(a, parseEmbedAlias('right|300'));
    applyEmbedLayout(b, parseEmbedAlias('right|300'));
    expect(window.getComputedStyle(a).float).toBe('right');
    expect(window.getComputedStyle(b).float).toBe('none');
    expect(b.classList.contains('bb-wrap-preview')).toBe(true);
    reading.classList.add('bb-narrow-note');
    expect(window.getComputedStyle(a).float).toBe('none');
    style.remove(); reading.remove(); preview.remove();
  });
});
