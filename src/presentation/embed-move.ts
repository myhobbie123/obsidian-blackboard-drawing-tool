import { codeRanges, findEmbedLinks, findEmbedTokens, parseEmbedAlias, planEmbedLayoutEdit, type EmbedLayout, type EmbedLinkMatch } from './embed-size';

export interface NoteBlock { start: number; end: number; kind: 'text' | 'heading' | 'embed' | 'list' | 'quote' | 'code' | 'table' | 'frontmatter' | 'unsafe'; }
interface Line { start: number; end: number; text: string; }
const blank = (line: Line) => /^\s*$/.test(line.text);
const list = (text: string) => /^ {0,3}(?:[-+*]|\d+[.)])\s/.test(text);
const heading = (text: string) => /^ {0,3}#{1,6}\s/.test(text);
const embed = (text: string) => /^ {0,3}!\[\[[^\n]+\]\]\s*$/.test(text);
const indent = (text: string) => /^(?: {4}|\t)/.test(text);
const tableDelimiter = (text: string) => text.includes('|') && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(text.trim());

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
      const listIndent = kind === 'list' ? /^ {0,3}(?:[-+*]|\d+[.)])\s+/.exec(text)![0].length : 0;
      i++;
      // Include lazy continuation and blank-separated nested content. An unindented
      // line after a blank starts a new top-level block; ambiguous continuations refuse.
      while (i < lines.length) {
        if (blank(lines[i])) {
          let next = i + 1;
          while (next < lines.length && blank(lines[next])) next++;
          if (next >= lines.length || !(kind === 'list'
            ? /^[ \t]+\S/.test(lines[next].text) || list(lines[next].text)
            : kind === 'quote' ? /^ {0,3}>/.test(lines[next].text) : indent(lines[next].text))) break;
          i = next;
        } else if ((heading(lines[i].text) || /^ {0,3}(`{3,}|~{3,})/.test(lines[i].text)) && (kind !== 'list' || /^ */.exec(lines[i].text)![0].length < listIndent)) break;
        else if (kind === 'list' && /^ {0,3}>/.test(lines[i].text) && /^ */.exec(lines[i].text)![0].length < listIndent) break;
        else if (kind === 'quote' && list(lines[i].text)) break;
        else i++;
      }
    } else if (heading(text) || embed(text)) {
      kind = heading(text) ? 'heading' : 'embed';
      i++;
    } else {
      if (/^ {0,3}(?:<|\[\^|\[.+\]:)/.test(text)) kind = 'unsafe';
      i++;
      while (i < lines.length && !blank(lines[i]) && !heading(lines[i].text) && !embed(lines[i].text) && !list(lines[i].text) && !/^ {0,3}(?:>|`{3,}|~{3,})/.test(lines[i].text)) i++;
      // Pipes in aliases or prose are not tables. A table needs its delimiter row.
      if (lines.slice(first, i).some(l => tableDelimiter(l.text))) kind = 'table';
      if (lines.slice(first, i).some(l => /^ {0,3}(?:===+|---+)\s*$/.test(l.text))) kind = 'heading';
    }
    blocks.push({ start: lines[first].start, end: lines[i - 1].end, kind });
  }
  return blocks;
}

export function movableBlock(source: string, fromOccurrence: number, blocks = noteBlocks(source)): number {
  const info = inspectEmbedMove(source, fromOccurrence, blocks);
  return 'reason' in info ? -1 : info.blockIndex;
}

export type MoveRefusal = 'ambiguous' | 'code' | 'frontmatter' | 'table' | 'link' | 'line-endings' | 'unsafe' | 'alias';
export const MOVE_MESSAGES: Record<MoveRefusal, string> = {
  ambiguous: 'Choose this board in Live Preview, or put the source cursor inside its embed token. If identical boards remain ambiguous, separate them manually first.',
  code: 'This board is inside code. Move it out of the code block or backticks manually.',
  frontmatter: 'This board is inside note properties. Move it below the closing properties delimiter manually.',
  table: 'This board is inside a table. Move its embed token outside the table manually.',
  link: 'This board is inside a link or wiki link. Move its embed token outside the enclosing link manually.',
  'line-endings': 'This note mixes line endings. Save it with consistent line endings before moving the board.',
  unsafe: 'This note contains an unfinished or unsupported Markdown block. Close code fences and move the board outside HTML, comments or math blocks manually.',
  alias: 'This board has conflicting layout or size tokens. Keep just one layout and one size in its embed alias first.',
};

interface MoveSource { link: EmbedLinkMatch; blockIndex: number; standalone: boolean; }

/** Detect code nested inside list/quote containers, whose fences can be indented. */
function nestedCode(source: string, block: NoteBlock, start: number): boolean {
  let offset = block.start;
  let fence: { char: string; length: number } | null = null;
  let contentIndent = 0;
  for (const raw of source.slice(block.start, block.end).split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/^(?: {0,3}> ?)+/, '');
    const marker = /^(\s*)(?:[-+*]|\d+[.)])\s+/.exec(line);
    if (marker) contentIndent = marker[0].length;
    const body = marker ? line.slice(marker[0].length) : line.slice(Math.min(contentIndent, /^ */.exec(line)![0].length));
    const hit = /^ {0,3}(`{3,}|~{3,})/.exec(body);
    const onLine = start >= offset && start <= offset + raw.length;
    if (onLine && (fence || /^(?: {4}|\t)/.test(body))) return true;
    if (hit) {
      if (!fence) fence = { char: hit[1][0], length: hit[1].length };
      else if (hit[1][0] === fence.char && hit[1].length >= fence.length && /^\s*$/.test(body.slice(hit[0].length))) fence = null;
      if (onLine) return true;
    }
    offset += raw.length + 1;
  }
  return false;
}

/** A token within an enclosing []/[[ ]] is syntax, not a movable embed. */
function enclosedLink(source: string, start: number): boolean {
  let depth = 0;
  let destination = 0;
  const code = codeRanges(source);
  for (let i = 0; i < start; i++) {
    const range = code.find(([s, e]) => i >= s && i < e);
    if (range) { i = range[1] - 1; continue; }
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '(' && (source[i - 1] === ']' || destination)) destination++;
    if (source[i] === ')' && destination) destination--;
    if (source[i] === '[') depth++;
    if (source[i] === ']') depth = Math.max(0, depth - 1);
  }
  return depth > 0 || destination > 0 || /\\(?:\\\\)*$/.test(source.slice(0, start));
}

function nestedTable(source: string, block: NoteBlock, start: number): boolean {
  const lines = source.slice(block.start, block.end).split('\n');
  let selected = 0;
  let offset = block.start;
  for (let i = 0; i < lines.length; i++) {
    if (start >= offset && start <= offset + lines[i].length) selected = i;
    offset += lines[i].length + 1;
  }
  const text = lines.map(line => line.replace(/^(?: {0,3}> ?)+/, '').replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '').trim());
  for (let i = 1; i < text.length; i++) {
    if (!tableDelimiter(text[i]) || !text[i - 1].includes('|')) continue;
    let end = i;
    while (end + 1 < text.length && text[end + 1].includes('|') && text[end + 1] !== '') end++;
    if (selected >= i - 1 && selected <= end) return true;
  }
  return false;
}

export function inspectEmbedMove(source: string, occurrence: number, blocks = noteBlocks(source)): MoveSource | { reason: MoveRefusal } {
  if (!Number.isInteger(occurrence) || occurrence < 0) return { reason: 'ambiguous' };
  const link = findEmbedLinks(source)[occurrence];
  if (!link) {
    const raw = findEmbedTokens(source)[occurrence];
    return { reason: raw && codeRanges(source).some(([s, e]) => raw.start >= s && raw.start < e) ? 'code' : 'ambiguous' };
  }
  const blockIndex = blocks.findIndex(b => b.start <= link.start && b.end >= link.end);
  const block = blocks[blockIndex];
  if (!block) return { reason: 'ambiguous' };
  if (block.kind === 'frontmatter') return { reason: 'frontmatter' };
  if (block.kind === 'code' || nestedCode(source, block, link.start)) return { reason: 'code' };
  if (nestedTable(source, block, link.start)) return { reason: 'table' };
  if (enclosedLink(source, link.start)) return { reason: 'link' };
  if (/\r(?!\n)/.test(source) || (/\r\n/.test(source) && /(?<!\r)\n/.test(source))) return { reason: 'line-endings' };
  if (source.includes('<!--') || /^ {0,3}\$\$/m.test(source) || blocks.some(b => b.kind === 'unsafe')) return { reason: 'unsafe' };
  return { link, blockIndex, standalone: block.kind === 'embed' && source.slice(block.start, block.end).trim() === source.slice(link.start, link.end) };
}

/** Source commands can explain code tokens even though normal embed discovery skips code. */
export function embedRefusalAtCursor(source: string, cursor: number): MoveRefusal {
  const tokens = findEmbedTokens(source);
  const exact = tokens.filter(m => cursor >= m.start && cursor < m.end);
  const onLine = tokens.filter(m => {
    const start = source.lastIndexOf('\n', m.start - 1) + 1;
    const end = source.indexOf('\n', m.end);
    return cursor >= start && cursor <= (end < 0 ? source.length : end);
  });
  const token = exact[0] ?? (onLine.length === 1 ? onLine[0] : null);
  if (!token) return 'ambiguous';
  if (codeRanges(source).some(([s, e]) => token.start >= s && token.start < e)) return 'code';
  const info = inspectEmbedMove(source, findEmbedLinks(source).findIndex(m => m.start === token.start));
  return 'reason' in info ? info.reason : 'ambiguous';
}

export interface EmbedMoveEdit { source: string; start: number; end: number; text: string; boardStart: number; }

function replacement(source: string, result: string, boardStart: number): EmbedMoveEdit | null {
  if (result === source) return null;
  let start = 0;
  while (start < source.length && start < result.length && source[start] === result[start]) start++;
  let end = source.length;
  let resultEnd = result.length;
  while (end > start && resultEnd > start && source[end - 1] === result[resultEnd - 1]) { end--; resultEnd--; }
  return { source: result, start, end, text: result.slice(start, resultEnd), boardStart };
}

/** targetBlockIndex is a gap BEFORE an original block (blocks.length means EOF).
 * Only separators at the old/new board locations change; every other byte survives.
 */
export function planEmbedMove(source: string, fromOccurrence: number, targetBlockIndex: number): EmbedMoveEdit | null {
  const blocks = noteBlocks(source);
  const info = inspectEmbedMove(source, fromOccurrence, blocks);
  if ('reason' in info) return null;
  const from = info.blockIndex;
  if (!Number.isInteger(targetBlockIndex) || targetBlockIndex < 0 || targetBlockIndex > blocks.length || (info.standalone && (targetBlockIndex === from || targetBlockIndex === from + 1))) return null;
  if (targetBlockIndex === 0 && blocks[0]?.kind === 'frontmatter') return null;
  // Unclosed/opaque Markdown can change interpretation after insertion. Refuse.
  if (blocks.some(b => b.kind === 'unsafe')) return null;
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const board = source.slice(info.link.start, info.link.end);
  let removeStart = info.link.start;
  let removeEnd = info.link.end;
  // Remove exactly one adjacent ASCII space, preferring the preceding separator.
  if (source[removeStart - 1] === ' ') removeStart--;
  else if (source[removeEnd] === ' ') removeEnd++;
  const order = blocks.map((b, index) => ({ ...b, index, board: false })).filter(b => !info.standalone || b.index !== from);
  const destination = info.standalone && targetBlockIndex > from ? targetBlockIndex - 1 : targetBlockIndex;
  order.splice(destination, 0, { ...blocks[from], index: -1, board: true });
  let result = source.slice(0, blocks[0].start);
  let boardStart = 0;
  for (let index = 0; index < order.length; index++) {
    const current = order[index];
    if (index) {
      const previous = order[index - 1];
      result += !previous.board && !current.board && previous.index + 1 === current.index
        ? source.slice(previous.end, current.start) : nl + nl;
    }
    if (current.board) boardStart = result.length;
    result += current.board ? board : current.index === from
      ? source.slice(current.start, removeStart) + source.slice(removeEnd, current.end)
      : source.slice(current.start, current.end);
  }
  result += source.slice(blocks[blocks.length - 1].end);
  return replacement(source, result, boardStart);
}

/** Inline first press extracts above/below the WHOLE containing top-level block. */
export function planEmbedStep(source: string, occurrence: number, direction: -1 | 1): EmbedMoveEdit | null {
  const info = inspectEmbedMove(source, occurrence);
  if ('reason' in info) return null;
  return planEmbedMove(source, occurrence, info.blockIndex + (info.standalone ? (direction < 0 ? -1 : 2) : (direction < 0 ? 0 : 1)));
}

export function planEmbedOwnLine(source: string, occurrence: number, before = false): EmbedMoveEdit | null {
  const info = inspectEmbedMove(source, occurrence);
  if ('reason' in info || info.standalone) return null;
  return planEmbedMove(source, occurrence, info.blockIndex + (before ? 0 : 1));
}

/** Extraction and alias rewrite form one replacement, hence one isolated undo. */
export function planEmbedWrap(source: string, occurrence: number, layout: EmbedLayout): EmbedMoveEdit | null {
  const info = inspectEmbedMove(source, occurrence);
  if ('reason' in info || parseEmbedAlias(info.link.alias).ambiguous) return null;
  const move = layout !== 'center' ? planEmbedOwnLine(source, occurrence, true) : null;
  const intermediate = move?.source ?? source;
  const boardStart = move?.boardStart ?? info.link.start;
  const selected = findEmbedLinks(intermediate).filter(m => m.linkpath === info.link.linkpath);
  const alias = planEmbedLayoutEdit(intermediate, p => p === info.link.linkpath, layout, selected.findIndex(m => m.start === boardStart));
  return replacement(source, alias?.source ?? intermediate, boardStart);
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
