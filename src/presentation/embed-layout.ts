import type { App } from 'obsidian';
import { aliasFromAttributes, parseEmbedAlias, type EmbedAlias } from './embed-size';
import { hostMarkdownView, resolveEmbedLink } from './embed-note';

/** Obsidian does not document alt/width tokenisation. Prefer verified note source. */
export async function readRenderedAlias(app: App, el: HTMLElement, path: string): Promise<EmbedAlias> {
  const view = hostMarkdownView(app, el);
  if (view?.file) {
    const source = view.getMode() === 'source' ? view.editor.getValue() : await app.vault.cachedRead(view.file);
    const link = resolveEmbedLink(app, view, el, path, source);
    if (link) return parseEmbedAlias(link.alias);
  }
  return aliasFromAttributes(el.getAttribute('alt'), el.getAttribute('width'));
}

export function applyEmbedLayout(el: HTMLElement, alias: EmbedAlias): void {
  if (el.closest('.canvas-node')) return;
  const layout = alias.ambiguous ? 'center' : alias.layout ?? 'center';
  for (const value of ['left', 'right', 'center']) el.classList.toggle('bb-layout-' + value, layout === value);
  el.dataset.bbLayout = layout;
  // CM6 widgets are block measured. Floats change visual lines without changing
  // CM's line wrapping/height map. Ship the explicit safe fallback in Live Preview.
  el.classList.toggle('bb-wrap-preview', layout !== 'center' && !!el.closest('.markdown-source-view, .cm-editor'));
  if (layout !== 'center' && el.closest('.markdown-preview-view')) {
    el.dataset.bbCenterMarginLeft ??= el.style.marginLeft;
    el.dataset.bbCenterMarginRight ??= el.style.marginRight;
    el.style.removeProperty('margin-left');
    el.style.removeProperty('margin-right');
  } else if (el.dataset.bbCenterMarginLeft !== undefined) {
    el.style.marginLeft = el.dataset.bbCenterMarginLeft;
    el.style.marginRight = el.dataset.bbCenterMarginRight ?? '';
    delete el.dataset.bbCenterMarginLeft;
    delete el.dataset.bbCenterMarginRight;
  }
}

export function watchEmbedLayout(el: HTMLElement): () => void {
  const root = el.closest<HTMLElement>('.markdown-preview-view, .markdown-source-view');
  if (!root) return () => {};
  const resize = () => root.classList.toggle('bb-narrow-note', root.clientWidth < 500);
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(root);
  return () => {
    observer.disconnect();
    applyEmbedLayout(el, parseEmbedAlias(null));
    for (const value of ['left', 'right', 'center']) el.classList.remove('bb-layout-' + value);
    el.classList.remove('bb-wrap-preview');
    delete el.dataset.bbLayout;
    if (!Array.from(root.querySelectorAll('.blackboard-embed[data-bb-mounted="true"]')).some(node => node !== el)) root.classList.remove('bb-narrow-note');
  };
}
