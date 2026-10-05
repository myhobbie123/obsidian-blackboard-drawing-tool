/** Clamp a below/right tooltip to both the pane and the visible viewport. */
export function tooltipPosition(anchor: DOMRect, pane: DOMRect, width: number, height: number, viewportWidth: number, viewportHeight: number): { left: number; top: number; maxWidth: number } {
  const leftEdge = Math.max(4, pane.left + 4);
  const rightEdge = Math.min(viewportWidth - 4, pane.right - 4);
  const topEdge = Math.max(4, pane.top + 4);
  const bottomEdge = Math.min(viewportHeight - 4, pane.bottom - 4);
  const maxWidth = Math.max(1, rightEdge - leftEdge);
  const left = Math.max(leftEdge, Math.min(anchor.right + 4, rightEdge - Math.min(width, maxWidth)));
  const top = Math.max(topEdge, Math.min(anchor.bottom + 4, bottomEdge - height));
  return { left, top, maxWidth };
}

export function attachPaneTooltip(button: HTMLElement, pane: () => HTMLElement, signal: AbortSignal): () => void {
  const doc = button.ownerDocument;
  const win = doc.defaultView ?? window;
  let tooltip: HTMLElement | null = null;
  const hide = () => { tooltip?.remove(); tooltip = null; button.removeAttribute('aria-describedby'); };
  const show = () => {
    hide();
    tooltip = doc.body.createDiv({ cls: 'bb-pane-tooltip' });
    tooltip.textContent = button.getAttribute('aria-label');
    tooltip.id = 'bb-tooltip-' + Math.random().toString(36).slice(2);
    tooltip.setAttribute('role', 'tooltip');
    button.setAttribute('aria-describedby', tooltip.id);
    const rect = pane().getBoundingClientRect();
    tooltip.style.maxWidth = `${Math.max(1, Math.min(win.innerWidth, rect.right) - Math.max(0, rect.left) - 8)}px`;
    tooltip.style.maxHeight = `${Math.max(1, Math.min(win.innerHeight, rect.bottom) - Math.max(0, rect.top) - 8)}px`;
    const box = tooltip.getBoundingClientRect();
    const position = tooltipPosition(button.getBoundingClientRect(), rect, box.width, box.height, win.innerWidth, win.innerHeight);
    tooltip.style.left = `${position.left}px`;
    tooltip.style.top = `${position.top}px`;
    tooltip.style.maxWidth = `${position.maxWidth}px`;
  };
  button.addEventListener('pointerenter', show, { signal });
  button.addEventListener('focus', show, { signal });
  button.addEventListener('pointerleave', hide, { signal });
  button.addEventListener('blur', hide, { signal });
  button.addEventListener('pointerdown', hide, { signal });
  doc.addEventListener('scroll', hide, { capture: true, signal });
  doc.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); }, { signal });
  win.addEventListener('resize', hide, { signal });
  signal.addEventListener('abort', hide, { once: true });
  return hide;
}
