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

export function applyEmbedLayout(el: HTMLElement, alias: EmbedAlias, experimental = false, openSetting: () => void = () => {}, measure: () => void = () => {}): void {
  if (el.closest('.canvas-node')) return;
  const layout = alias.ambiguous ? 'center' : alias.layout ?? 'center';
  const changed = el.dataset.bbLayout !== layout || el.classList.contains('bb-wrap-experimental') !== (experimental && layout !== 'center' && !!el.closest('.markdown-source-view, .cm-editor'));
  for (const value of ['left', 'right', 'center']) el.classList.toggle('bb-layout-' + value, layout === value);
  el.dataset.bbLayout = layout;
  const editing = !!el.closest('.markdown-source-view, .cm-editor');
  const fallback = layout !== 'center' && editing && !experimental;
  el.classList.toggle('bb-wrap-preview', fallback);
  el.classList.toggle('bb-wrap-experimental', layout !== 'center' && editing && experimental);
  let badge = el.querySelector<HTMLButtonElement>(':scope > .bb-wrap-badge');
  if (fallback) {
    badge ??= el.createEl('button', { cls: 'bb-wrap-badge' });
    badge.type = 'button';
    const text = `wrap: ${layout} — shown in Reading view`;
    if (badge.textContent !== text) badge.textContent = text;
    badge.setAttribute('aria-label', badge.textContent + '. Open experimental wrap setting');
    badge.onclick = e => { e.preventDefault(); e.stopPropagation(); openSetting(); };
    badge.onpointerdown = e => e.stopPropagation();
  } else badge?.remove();
  if (layout !== 'center' && (el.closest('.markdown-preview-view') || (editing && experimental))) {
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
  if (editing && changed) measure();
}

export function watchEmbedLayout(el: HTMLElement, measure: () => void = () => {}): () => void {
  const root = el.closest<HTMLElement>('.markdown-preview-view, .markdown-source-view');
  if (!root) return () => {};
  let pending: number | null = null;
  const win = el.ownerDocument.defaultView ?? window;
  const resize = () => {
    root.classList.toggle('bb-narrow-note', root.clientWidth < 500);
    if (el.classList.contains('bb-wrap-experimental') && pending === null) {
      pending = win.requestAnimationFrame(() => { pending = null; measure(); });
    }
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(root);
  observer.observe(el);
  return () => {
    observer.disconnect();
    if (pending !== null) win.cancelAnimationFrame(pending);
    applyEmbedLayout(el, parseEmbedAlias(null));
    for (const value of ['left', 'right', 'center']) el.classList.remove('bb-layout-' + value);
    el.classList.remove('bb-wrap-preview');
    el.classList.remove('bb-wrap-experimental');
    delete el.dataset.bbLayout;
    if (!Array.from(root.querySelectorAll('.blackboard-embed[data-bb-mounted="true"]')).some(node => node !== el)) root.classList.remove('bb-narrow-note');
  };
}
