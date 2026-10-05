import { FILE_EXTENSION } from '../domain/entities';

export interface EmbedSize { width: string | null; height: string | null; }

export type EmbedLayout = 'left' | 'right' | 'center';
export interface EmbedAlias {
  layout: EmbedLayout | null;
  size: EmbedSize | null;
  /** Unrecognised tokens, including whitespace, survive every rewrite. */
  unknownTokens: string[];
  ambiguous: boolean;
}

export function parseEmbedAlias(alias: string | null | undefined): EmbedAlias {
  const result: EmbedAlias = { layout: null, size: null, unknownTokens: [], ambiguous: false };
  if (!alias) return result;
  for (const token of alias.split('|')) {
    const trimmed = token.trim();
    if (trimmed === 'left' || trimmed === 'right' || trimmed === 'center') {
      if (result.layout !== null) result.ambiguous = true;
      result.layout = trimmed;
    } else {
      const size = parseEmbedSize(trimmed);
      if (size) {
        if (result.size !== null) result.ambiguous = true;
        result.size = size;
      } else result.unknownTokens.push(token);
    }
  }
  return result;
}

export function formatEmbedAlias(alias: Pick<EmbedAlias, 'layout' | 'size'> & { unknownTokens?: string[] }): string {
  const tokens: string[] = [];
  if (alias.layout && alias.layout !== 'center') tokens.push(alias.layout);
  if (alias.size?.width) {
    tokens.push(alias.size.width.replace(/px$/, '') + (alias.size.height ? 'x' + alias.size.height.replace(/px$/, '') : ''));
  }
  tokens.push(...(alias.unknownTokens ?? []));
  return tokens.join('|');
}

/** DOM may expose the full alias in alt, but only its size in width. */
export function aliasFromAttributes(alt: string | null, width: string | null): EmbedAlias {
  if (alt?.includes('|')) return parseEmbedAlias(alt);
  if (width?.includes('|')) return parseEmbedAlias(width);
  const a = parseEmbedAlias(alt);
  const w = parseEmbedAlias(width);
  return { ...a, size: w.size ?? a.size, layout: a.layout ?? w.layout };
}

/**
 * Parse Obsidian's embed size alias (the text after `|` in `![[file|...]]`):
 *   "640x480" -> {width:"640px", height:"480px"}
 *   "300"     -> {width:"300px", height:null}
 *   "100%"    -> {width:"100%",  height:null}
 *   "100%x400"-> {width:"100%",  height:"400px"}
 * Returns null when there's no usable size.
 */
/**
 * Fit a drawing's saved size into the available note width, preserving aspect ratio.
 * Used for no-alias Markdown embeds so they render at the drawing's natural size,
 * scaled down (never up) to fit the note. Returns null for a degenerate saved size.
 */
export function fitSavedEmbedSize(
  savedW: number,
  savedH: number,
  availableWidth: number,
): { width: number; height: number } | null {
  if (savedW <= 0 || savedH <= 0) return null;
  if (availableWidth > 0 && savedW > availableWidth) {
    const scale = availableWidth / savedW;
    return { width: Math.floor(savedW * scale), height: Math.floor(savedH * scale) };
  }
  return { width: savedW, height: savedH };
}

export function parseEmbedSize(alias: string | null | undefined): EmbedSize | null {
  if (!alias) return null;
  const m = alias.trim().match(/^(\d+%?)(?:x(\d+))?$/);
  if (!m) return null;
  const wNum = parseInt(m[1], 10);
  if (wNum === 0) return null;                       // a zero width would collapse the embed
  const w = m[1].endsWith('%') ? m[1] : `${m[1]}px`;
  const h = m[2] && parseInt(m[2], 10) > 0 ? `${m[2]}px` : null;
  return { width: w, height: h };
}

/** One `![[drawing.blackboard|alias]]` wikilink embed found in a note's source. */
export interface EmbedLinkMatch {
  /** Offset of the `!` in the source. */
  start: number;
  /** Offset just past the closing `]]`. */
  end: number;
  /** The link target as written (may be a partial path, may carry a heading/block ref). */
  linkpath: string;
  /** Everything after the first `|`, or null when the embed has no alias at all. */
  alias: string | null;
}

/**
 * Ranges of the source that are code and must never be rewritten: fenced blocks
 * (``` / ~~~, any fence length, closed or unterminated) and inline code spans.
 * A `![[x.blackboard]]` inside them is documentation, not an embed.
 */
function codeRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = source.split('\n');
  let offset = 0;
  let fenceStart = -1;
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const char = m[1][0];
      const len = m[1].length;
      if (fenceStart < 0) {
        fenceStart = offset;
        fenceChar = char;
        fenceLen = len;
      } else if (char === fenceChar && len >= fenceLen) {
        ranges.push([fenceStart, offset + line.length]);
        fenceStart = -1;
      }
    }
    offset += line.length + 1; // + the '\n' that split() removed
  }
  if (fenceStart >= 0) ranges.push([fenceStart, source.length]);

  // Inline code spans, outside the fenced ranges found above.
  const inFence = (i: number) => ranges.some(([s, e]) => i >= s && i < e);
  const span = /(`+)(?:[^`]|(?!\1)`)*\1/g;
  let hit: RegExpExecArray | null;
  while ((hit = span.exec(source)) !== null) {
    if (!inFence(hit.index)) ranges.push([hit.index, hit.index + hit[0].length]);
  }
  return ranges;
}

/**
 * Every drawing embed in a note's source, in document order, skipping code.
 * The link target is matched conservatively (no `[`, `]`, `|` or newline) so an alias
 * that itself mentions `.blackboard` cannot extend the captured path.
 */
export function findEmbedLinks(source: string, extension = FILE_EXTENSION): EmbedLinkMatch[] {
  const ranges = codeRanges(source);
  const isCode = (i: number) => ranges.some(([s, e]) => i >= s && i < e);
  const re = new RegExp(String.raw`!\[\[([^[\]|\n]+\.${extension})(\|[^\]\n]*)?\]\]`, 'gi');
  const found: EmbedLinkMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (isCode(m.index)) continue;
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      linkpath: m[1],
      alias: m[2] === undefined ? null : m[2].slice(1),
    });
  }
  return found;
}

/** The replacement text for an embed whose size alias becomes `WxH`. */
export function embedLinkWithSize(link: EmbedLinkMatch, width: number, height: number): string {
  const alias = parseEmbedAlias(link.alias);
  alias.size = { width: `${Math.round(width)}px`, height: `${Math.round(height)}px` };
  return linkWithAlias(link, alias);
}

function linkWithAlias(link: EmbedLinkMatch, alias: EmbedAlias): string {
  const formatted = formatEmbedAlias(alias);
  // An empty unknown token is still an alias, and must retain its pipe.
  return `![[${link.linkpath}${formatted || alias.unknownTokens.length ? '|' + formatted : ''}]]`;
}

export function planEmbedLayoutEdit(source: string, isTarget: (path: string) => boolean, layout: EmbedLayout, occurrence = 0): EmbedAliasEdit | null {
  const link = findEmbedLinks(source).filter(m => isTarget(m.linkpath))[occurrence];
  if (!link) return null;
  const alias = parseEmbedAlias(link.alias);
  if (alias.ambiguous || (alias.layout ?? 'center') === layout) return null;
  alias.layout = layout;
  const text = linkWithAlias(link, alias);
  return { start: link.start, end: link.end, text, source: source.slice(0, link.start) + text + source.slice(link.end) };
}

export interface EmbedAliasEdit {
  start: number;
  end: number;
  /** The full `![[path|WxH]]` that replaces source[start..end]. */
  text: string;
  /** The whole note with the edit applied (for the non-editor write path). */
  source: string;
}

/**
 * Locate exactly one embed of the target drawing and produce the edit that sets its size
 * alias to `WxH`. Never touches a second embed, and never touches code.
 *
 * `isTarget` resolves a written linkpath to the drawing being resized (link resolution is
 * Obsidian's job, so it stays out of here). `occurrence` selects among duplicates of the
 * same drawing in one note; out-of-range or ambiguous callers must refuse.
 * Returns null when there is nothing to do — no match, or the alias is already `WxH`.
 */
export function planEmbedSizeEdit(
  source: string,
  isTarget: (linkpath: string) => boolean,
  width: number,
  height: number,
  occurrence = 0,
): EmbedAliasEdit | null {
  const matches = findEmbedLinks(source).filter((m) => isTarget(m.linkpath));
  const link = matches[occurrence];
  if (!link || parseEmbedAlias(link.alias).ambiguous || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const text = embedLinkWithSize(link, width, height);
  if (text === source.slice(link.start, link.end)) return null;
  return {
    start: link.start,
    end: link.end,
    text,
    source: source.slice(0, link.start) + text + source.slice(link.end),
  };
}
