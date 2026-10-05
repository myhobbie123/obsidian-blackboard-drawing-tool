import { inspectEmbedMove, replacement, type EmbedMoveEdit, type MoveRefusal } from './embed-move';

export interface DropLine {
  from: number; to: number; end: number; text: string;
  contentIndent: number | null;
  protected: MoveRefusal | 'math' | null;
  zone?: number;
}
export interface DropSlot { offset: number; line: number; indent: number | null; }
const columns = (s: string) => [...s].reduce((n, c) => c === '\t' ? n + 4 - n % 4 : n + 1, 0);
const expandedIndent = (s: string) => s.replace(/^[ \t]+/, prefix => ' '.repeat(columns(prefix)));
const marker = (s: string) => /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/.exec(s);
const delimiter = (s: string) => s.includes('|') && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(s.trim());

/** Physical Markdown lines, with list-relative code indentation and nested fences. */
export function dropLines(source: string): DropLine[] {
  let offset = 0;
  const lines: DropLine[] = source.split('\n').map(raw => {
    const text = raw.replace(/\r$/, '');
    const line: DropLine = { from: offset, to: offset + text.length, end: Math.min(source.length, offset + raw.length + 1), text, contentIndent: null, protected: null };
    offset += raw.length + 1;
    return line;
  });
  let frontmatter = /^\uFEFF?---\s*$/.test(lines[0].text);
  let zone = 1;
  let fence: { char: string; length: number; zone: number } | null = null;
  let math = false;
  let mathZone = 0;
  let listIndent: number | null = null;
  const items: Array<{ indent: number; content: number }> = [];
  const indentedLines = new Set<number>();
  let previousBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text;
    if (frontmatter) {
      line.protected = 'frontmatter';
      line.zone = 1;
      if (i > 0 && /^(---|\.\.\.)\s*$/.test(text)) frontmatter = false;
      continue;
    }
    const unquoted = expandedIndent(text.replace(/^(?: {0,3}> ?)+/, ''));
    const item = marker(unquoted);
    const leading = columns(/^[ \t]*/.exec(unquoted)![0]);
    const codeItem = !!item && leading >= (listIndent ?? 0) + 4;
    if (!fence && !math && item && !codeItem) {
      while (items.length && items[items.length - 1].indent >= leading) items.pop();
      listIndent = columns(item[0]);
      items.push({ indent: leading, content: listIndent });
    } else if (!fence && !math && text.trim()) {
      if (previousBlank && leading < (items[0]?.content ?? 0) || /^ {0,3}(?:#{1,6}\s|>)/.test(text)) {
        items.length = 0; listIndent = null;
      } else if (!item) {
        while (items.length > 1 && leading < items[items.length - 1].content) items.pop();
        listIndent = items[items.length - 1]?.content ?? null;
      }
    }
    line.contentIndent = listIndent;
    const body = item && !codeItem && !fence ? unquoted.slice(item[0].length) : unquoted.slice(Math.min(listIndent ?? 0, leading));
    const hit = /^ {0,3}(`{3,}|~{3,})/.exec(body);
    if (fence) {
      line.protected = 'code';
      line.zone = fence.zone;
      if (hit && hit[1][0] === fence.char && hit[1].length >= fence.length && /^\s*$/.test(body.slice(hit[0].length))) fence = null;
    } else if (hit) {
      line.protected = 'code'; line.zone = ++zone; fence = { char: hit[1][0], length: hit[1].length, zone };
    } else if (math || /^\s*\$\$/.test(body)) {
      line.protected = 'math';
      if (!math) mathZone = ++zone;
      line.zone = mathZone;
      if (math) { if (/^\s*\$\$\s*$/.test(body)) math = false; }
      else math = !/^\s*\$\$.+\$\$\s*$/.test(body);
    } else if (text.trim() && (codeItem || !item && leading >= (listIndent ?? 0) + 4)) {
      line.protected = 'code'; indentedLines.add(i);
    }
    previousBlank = !text.trim();
  }
  // Blank lines within an indented code run are code too; outside fenced blocks,
  // ordinary blank gaps before/after code remain usable drop boundaries.
  for (const i of indentedLines) {
    let next = i + 1;
    while (next < lines.length && !lines[next].text.trim()) next++;
    if (indentedLines.has(next)) for (let blank = i + 1; blank < next; blank++) lines[blank].protected = 'code';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].protected !== 'code' || lines[i].zone !== undefined) continue;
    const codeZone = ++zone;
    let next = i;
    while (next < lines.length && lines[next].protected === 'code' && lines[next].zone === undefined) lines[next++].zone = codeZone;
  }
  // Table delimiters identify the header and every contiguous body row. Alias pipes
  // alone never make a table. Container prefixes are removed only for classification.
  const tableText = (l: DropLine) => l.text.replace(/^(?: {0,3}> ?)+/, '').replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '').trim();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].protected || !delimiter(tableText(lines[i])) || !tableText(lines[i - 1]).includes('|')) continue;
    lines[i - 1].protected = lines[i].protected = 'table';
    lines[i - 1].zone = lines[i].zone = ++zone;
    let j = i + 1;
    while (j < lines.length && !lines[j].protected && tableText(lines[j]).includes('|') && tableText(lines[j])) {
      lines[j].zone = zone; lines[j++].protected = 'table';
    }
  }
  return lines;
}

export function inspectDropSource(source: string, occurrence: number) {
  const info = inspectEmbedMove(source, occurrence, undefined, true);
  if ('reason' in info) return info;
  const line = dropLines(source).find(l => info.link.start >= l.from && info.link.start <= l.to);
  if (line?.protected) return { reason: line.protected === 'math' ? 'unsafe' as const : line.protected };
  return info;
}

/** Before an opening delimiter/after a closing one is outside its protected zone. */
export function dropSlotAt(source: string, offset: number, after: boolean, lines = dropLines(source)): DropSlot | null {
  if (offset < 0 || offset > source.length) return null;
  const index = lines.findIndex(l => offset >= l.from && offset <= l.to);
  if (index < 0) return null;
  return slotAtBoundary(lines, index + (after ? 1 : 0));
}

function slotAtBoundary(lines: DropLine[], index: number): DropSlot | null {
  const previous = lines[index - 1];
  const next = lines[index];
  // No boundary within a protected region; its outer edges remain legal.
  if (previous?.protected && next?.zone === previous.zone) return null;
  if (index === 0 && next?.protected === 'frontmatter') return null;
  const indent = previous && !previous.text.trim() && next && next.contentIndent === null ? null : previous?.contentIndent ?? null;
  return { offset: next?.from ?? previous?.end ?? 0, line: index + 1, indent };
}

function currentLineSlot(lines: DropLine[], index: number, slot: DropSlot): boolean {
  let low = index, high = index + 1;
  while (low > 0 && !lines[low - 1].text.trim()) low--;
  while (high < lines.length && !lines[high].text.trim()) high++;
  return slot.offset >= lines[low].from && slot.offset <= (lines[high]?.from ?? lines[lines.length - 1].end);
}

export function isCurrentDropSlot(source: string, occurrence: number, slot: DropSlot): boolean {
  const info = inspectDropSource(source, occurrence);
  if ('reason' in info) return false;
  const lines = dropLines(source);
  const index = lines.findIndex(l => info.link.start >= l.from && info.link.start <= l.to);
  const remainder = (source.slice(lines[index].from, info.link.start) + source.slice(info.link.end, lines[index].to)).trim();
  return (!remainder || /^(?:[-+*]|\d+[.)])$/.test(remainder)) && currentLineSlot(lines, index, slot);
}

/** Remove+insert is returned as one minimal replacement for one isolated undo. */
export function planEmbedDrop(source: string, occurrence: number, slot: DropSlot): EmbedMoveEdit | null {
  const info = inspectDropSource(source, occurrence);
  if ('reason' in info) return null;
  const lines = dropLines(source);
  const targetIndex = lines.findIndex(l => l.from === slot.offset);
  const target = slotAtBoundary(lines, targetIndex < 0 && slot.offset === source.length ? lines.length : targetIndex);
  if (!target || slot.offset < 0 || slot.offset > source.length || (targetIndex < 0 && slot.offset !== source.length)) return null;
  const index = lines.findIndex(l => info.link.start >= l.from && info.link.start <= l.to);
  const line = lines[index];
  const board = source.slice(info.link.start, info.link.end);
  let from = info.link.start, to = info.link.end;
  if (source[from - 1] === ' ') from--;
  else if (source[to] === ' ') to++;
  const remainder = (source.slice(line.from, from) + source.slice(to, line.to)).replace(/[ \t]+$/, '');
  const emptyItem = /^[ \t]*(?:[-+*]|\d+[.)])$/.test(remainder);
  const empty = !remainder.trim() || emptyItem;
  // A board already occupying this line or either adjacent blank gap stays untouched.
  if (empty && currentLineSlot(lines, index, slot)) return null;
  if (emptyItem && lines[index + 1]?.text.trim() && columns(/^[ \t]*/.exec(lines[index + 1].text)![0]) > columns(/^[ \t]*/.exec(line.text)![0])) return null;
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  let removeFrom = line.from, removeTo = line.to, removedText = remainder;
  if (empty) {
    removedText = '';
    removeTo = line.end;
    // Collapse only the vacated board's separators, retaining at most one blank line.
    let low = index, high = index + 1;
    while (low > 0 && !lines[low - 1].text.trim()) low--;
    while (high < lines.length && !lines[high].text.trim()) high++;
    if (low < index || high > index + 1) {
      removeFrom = lines[low].from;
      removeTo = lines[high]?.from ?? source.length;
      removedText = low > 0 && high < lines.length ? nl : '';
    } else if (removeTo === source.length && line.end === line.to && index > 0) {
      // Delete the final empty item/board without manufacturing a trailing newline.
      removeFrom = lines[index - 1].to;
    }
  }
  const intermediate = source.slice(0, removeFrom) + removedText + source.slice(removeTo);
  let destination = slot.offset <= removeFrom ? slot.offset : slot.offset >= removeTo ? slot.offset + removedText.length - (removeTo - removeFrom) : removeFrom + removedText.length;
  const restLines = dropLines(intermediate);
  const restIndex = restLines.findIndex(l => l.from === destination);
  const previous = restIndex >= 0 ? restLines[restIndex - 1] : restLines[restLines.length - 1];
  const next = restIndex >= 0 ? restLines[restIndex] : undefined;
  const indentation = previous && !previous.text.trim() && next && next.contentIndent === null ? null : previous?.contentIndent ?? null;
  let prefix = '', suffix = '';
  if (destination > 0 && intermediate[destination - 1] !== '\n') prefix = nl;
  if (indentation === null) {
    const before = intermediate.slice(0, destination);
    if (before && !before.endsWith(nl + nl)) prefix += nl;
    const after = intermediate.slice(destination);
    if (after && !after.startsWith(nl)) suffix += nl;
  }
  // In a list the embed is a continuation of the preceding item, including nested
  // and ordered items. No marker or blank line is introduced.
  const inserted = prefix + ' '.repeat(indentation ?? 0) + board + (destination < intermediate.length ? nl + suffix : '');
  const boardStart = destination + prefix.length + (indentation ?? 0);
  let result = intermediate.slice(0, destination) + inserted + intermediate.slice(destination);
  if (source.endsWith(nl) && !result.endsWith(nl)) result += nl;
  destination = boardStart;
  return replacement(source, result, destination);
}
