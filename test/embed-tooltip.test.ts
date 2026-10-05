import { describe, expect, it } from 'vitest';
import { tooltipPosition, attachPaneTooltip } from '../src/presentation/embed-tooltip';

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect;
describe('pane tooltip geometry', () => {
  it('places the left-edge grip tooltip to its right and below, inside its pane', () => {
    expect(tooltipPosition(rect(0, 30, 32, 62), rect(0, 0, 500, 600), 160, 30, 1200, 800)).toEqual({ left: 36, top: 66, maxWidth: 492 });
  });
  it('clamps both axes at the right/bottom pane and viewport boundaries', () => {
    const pos = tooltipPosition(rect(580, 480, 612, 512), rect(200, 50, 700, 650), 180, 50, 640, 550);
    expect(pos.left).toBe(456); expect(pos.top).toBe(496);
    expect(pos.left + 180).toBeLessThanOrEqual(636); expect(pos.top + 50).toBeLessThanOrEqual(546);
  });
  it('limits long tooltips to a narrow pane', () => {
    expect(tooltipPosition(rect(20, 10, 52, 42), rect(20, 0, 140, 300), 400, 60, 1200, 800)).toEqual({ left: 24, top: 46, maxWidth: 112 });
  });
  it('cleans up focused tooltips on blur, abort and teardown', () => {
    const pane = document.body.createDiv(), button = pane.createEl('button');
    button.setAttribute('aria-label', 'Drag to move board');
    pane.getBoundingClientRect = () => rect(0, 0, 600, 600);
    const abort = new AbortController(); const stop = attachPaneTooltip(button, () => pane, abort.signal);
    button.dispatchEvent(new FocusEvent('focus')); expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Drag to move board');
    button.dispatchEvent(new FocusEvent('blur')); expect(document.querySelector('[role="tooltip"]')).toBeNull();
    button.dispatchEvent(new FocusEvent('focus')); abort.abort(); expect(document.querySelector('[role="tooltip"]')).toBeNull();
    stop(); pane.remove();
  });
});
