import { MarkdownView, Notice, type App, type Editor } from 'obsidian';
import { isolateHistory } from '@codemirror/commands';
import { findEmbedLinks, type EmbedAliasEdit, type EmbedLinkMatch } from './embed-size';

/** Optional CM6 internals: no caret fallback for destructive source edits. */
export interface NoteCM {
  dispatch?(transaction: { changes: { from: number; to: number; insert: string }; annotations: unknown[]; selection?: { anchor: number } }): void;
  posAtDOM?(node: Node, offset?: number): number;
  posAtCoords?(point: { x: number; y: number }, precise?: boolean): number | null;
  coordsAtPos?(pos: number, side?: number): { top: number; bottom: number; left: number; right: number } | null;
  lineBlockAt?(pos: number): { from: number; to: number; top: number; bottom: number };
  scrollDOM?: HTMLElement;
  documentTop?: number;
  requestMeasure?(): void;
}
export function noteCM(editor: Editor): NoteCM | undefined { return (editor as Editor & { cm?: NoteCM }).cm; }

export function hostMarkdownView(app: App, el: HTMLElement): MarkdownView | null {
  if (el.closest('.canvas-node')) return null;
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active?.contentEl.contains(el)) return active;
  let found: MarkdownView | null = null;
  app.workspace.iterateAllLeaves(leaf => {
    if (!found && leaf.view instanceof MarkdownView && leaf.view.contentEl.contains(el)) found = leaf.view;
  });
  return found;
}

export function editableNote(view: MarkdownView | null): view is MarkdownView {
  return !!view?.file && view.getMode() === 'source' && typeof noteCM(view.editor)?.dispatch === 'function';
}

/** Resolve by CM source position, or COMPLETE DOM order with resolved paths.
 * A partial virtualised DOM must never silently select the first duplicate.
 */
export function resolveEmbedLink(app: App, view: MarkdownView, el: HTMLElement, path: string, source: string): EmbedLinkMatch | null {
  const matches = findEmbedLinks(source).filter(m => app.metadataCache.getFirstLinkpathDest(m.linkpath, view.file?.path ?? '')?.path === path);
  const host = el.closest<HTMLElement>('.internal-embed') ?? el;
  const cm = view.editor && noteCM(view.editor);
  if (cm?.posAtDOM) {
    try {
      const position = cm.posAtDOM(host, 0);
      const onLine = matches.filter(m => {
        const start = source.lastIndexOf('\n', m.start - 1) + 1;
        const end = source.indexOf('\n', m.end);
        return position >= start && position <= (end < 0 ? source.length : end);
      });
      if (onLine.length === 1) return onLine[0];
    } catch { /* widgets may have no DOM position; require complete order below */ }
  }
  const siblings = Array.from(view.contentEl.querySelectorAll<HTMLElement>('.internal-embed')).filter(node =>
    !node.closest('.canvas-node') && app.metadataCache.getFirstLinkpathDest(node.getAttribute('src') ?? '', view.file?.path ?? '')?.path === path);
  const index = siblings.indexOf(host);
  return index >= 0 && siblings.length === matches.length ? matches[index] : null;
}

export function commitNoteEdit(view: MarkdownView, original: string, edit: Pick<EmbedAliasEdit, 'start' | 'end' | 'text'>, boardStart?: number): boolean {
  if (!editableNote(view) || view.editor.getValue() !== original) {
    new Notice('Blackboard: the note changed or is not editable. No changes made.');
    return false;
  }
  const cm = noteCM(view.editor);
  cm?.dispatch?.({ changes: { from: edit.start, to: edit.end, insert: edit.text }, annotations: [isolateHistory.of('full')], ...(boardStart === undefined ? {} : { selection: { anchor: boardStart } }) });
  cm?.requestMeasure?.();
  return true;
}
