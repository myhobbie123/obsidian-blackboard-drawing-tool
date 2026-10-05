import { findEmbedLinks } from './embed-size';

export interface NoteBlock { start: number; end: number; kind: 'text' | 'heading' | 'embed' | 'list' | 'quote' | 'code' | 'table' | 'frontmatter' | 'unsafe'; }
interface Line { start: number; end: number; text: string; }
const blank = (line: Line) => /^\s*$/.test(line.text);
const list = (text: string) => /^ {0,3}(?:[-+*]|\d+[.)])\s/.test(text);
const heading = (text: string) => /^ {0,3}#{1,6}\s/.test(text);
const embed = (text: string) => /^ {0,3}!\[\[[^\n]+\]\]\s*$/.test(text);
const indent = (text: string) => /^(?: {4}|\t)/.test(text);

/** Conservative Markdown block map. Unsupported constructs stay opaque, never split. */
export function noteBlocks(source: string): NoteBlock[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const raw of source.split('\n')) {
    lines.push({ start: offset, end: offset + raw.replace(/\r$/, '').length, text: raw.replace(/\r$/, '') });
    offset += raw.length + 1;
  }
  const blocks: NoteBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (blank(lines[i])) { i++; continue; }
    const first = i;
    const text = lines[i].text;
    let kind: NoteBlock['kind'] = 'text';
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (i === 0 && text.replace(/^\uFEFF/, '') === '---') {
      kind = 'frontmatter';
      i++;
      while (i < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[i].text)) i++;
      if (i < lines.length) i++;
    } else if (fence) {
      kind = 'code';
      i++;
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !close.test(lines[i].text)) i++;
      if (i < lines.length) i++;
      else kind = 'unsafe';
    } else if (list(text) || /^ {0,3}>/.test(text) || indent(text)) {
      kind = list(text) ? 'list' : indent(text) ? 'code' : 'quote';
      i++;
      // Include lazy continuation and blank-separated nested content. An unindented
      // line after a blank starts a new top-level block; ambiguous continuations refuse.
      while (i < lines.length) {
        if (blank(lines[i])) {
          let next = i + 1;
          while (next < lines.length && blank(lines[next])) next++;
          if (next >= lines.length || !(/^[ \t]+\S/.test(lines[next].text) || list(lines[next].text) || /^ {0,3}>/.test(lines[next].text))) break;
          i = next;
        } else if (heading(lines[i].text) || /^ {0,3}(`{3,}|~{3,})/.test(lines[i].text)) break;
        else i++;
      }
    } else if (heading(text) || embed(text)) {
      kind = heading(text) ? 'heading' : 'embed';
      i++;
    } else {
      if (/^ {0,3}(?:<|\[\^|\[.+\]:)/.test(text)) kind = 'unsafe';
      i++;
      while (i < lines.length && !blank(lines[i]) && !heading(lines[i].text) && !embed(lines[i].text) && !list(lines[i].text) && !/^ {0,3}(?:>|`{3,}|~{3,})/.test(lines[i].text)) i++;
      if (lines.slice(first, i).some(l => l.text.includes('|'))) kind = 'table';
      if (lines.slice(first, i).some(l => /^ {0,3}(?:===+|---+)\s*$/.test(l.text))) kind = 'heading';
    }
    blocks.push({ start: lines[first].start, end: lines[i - 1].end, kind });
  }
  return blocks;
}

export function movableBlock(source: string, fromOccurrence: number, blocks = noteBlocks(source)): number {
  const link = findEmbedLinks(source)[fromOccurrence];
  if (!link) return -1;
  return blocks.findIndex(b => b.kind === 'embed' && b.start <= link.start && b.end >= link.end && source.slice(b.start, b.end).trim() === source.slice(link.start, link.end));
}

export interface EmbedMoveEdit { source: string; start: number; end: number; text: string; boardStart: number; }

/** targetBlockIndex is a gap BEFORE an original block (blocks.length means EOF).
 * Only separators at the old/new board locations change; every other byte survives.
 */
export function planEmbedMove(source: string, fromOccurrence: number, targetBlockIndex: number): EmbedMoveEdit | null {
  if (/\r(?!\n)/.test(source) || (/\r\n/.test(source) && /(?<!\r)\n/.test(source))) return null;
  const blocks = noteBlocks(source);
  const from = movableBlock(source, fromOccurrence, blocks);
  if (from < 0 || !Number.isInteger(targetBlockIndex) || targetBlockIndex < 0 || targetBlockIndex > blocks.length || targetBlockIndex === from || targetBlockIndex === from + 1) return null;
  if (targetBlockIndex === 0 && blocks[0]?.kind === 'frontmatter') return null;
  // Unclosed/opaque Markdown can change interpretation after insertion. Refuse.
  if (blocks.some(b => b.kind === 'unsafe')) return null;
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const board = source.slice(blocks[from].start, blocks[from].end);
  const order = blocks.map((b, index) => ({ ...b, index })).filter(b => b.index !== from);
  const destination = targetBlockIndex > from ? targetBlockIndex - 1 : targetBlockIndex;
  order.splice(destination, 0, { ...blocks[from], index: from });
  let result = source.slice(0, blocks[0].start);
  let boardStart = 0;
  for (let index = 0; index < order.length; index++) {
    const current = order[index];
    if (index) {
      const previous = order[index - 1];
      result += previous.index !== from && current.index !== from && previous.index + 1 === current.index
        ? source.slice(previous.end, current.start) : nl + nl;
    }
    if (current.index === from) boardStart = result.length;
    result += current.index === from ? board : source.slice(current.start, current.end);
  }
  result += source.slice(blocks[blocks.length - 1].end);
  if (result === source) return null;
  // One contiguous replacement is one Editor.transaction change, even across blocks.
  let start = 0;
  while (start < source.length && start < result.length && source[start] === result[start]) start++;
  let end = source.length;
  let resultEnd = result.length;
  while (end > start && resultEnd > start && source[end - 1] === result[resultEnd - 1]) { end--; resultEnd--; }
  return { source: result, start, end, text: result.slice(start, resultEnd), boardStart };
}

/** Pointer targets within protected blocks are refused, even if close to an edge. */
export function moveTargetAt(source: string, offset: number, after: boolean): number | null {
  const blocks = noteBlocks(source);
  if (offset < 0 || offset > source.length) return null;
  const index = blocks.findIndex(b => offset >= b.start && offset <= b.end);
  if (index >= 0) {
    if (!['text', 'heading'].includes(blocks[index].kind)) return null;
    return index + (after ? 1 : 0);
  }
  const next = blocks.findIndex(b => b.start > offset);
  const target = next < 0 ? blocks.length : next;
  return target === 0 && blocks[0]?.kind === 'frontmatter' ? null : target;
}
