import { describe, expect, it } from 'vitest';
import { findEmbedLinks } from '../src/presentation/embed-size';
import { noteBlocks, movableBlock, planEmbedMove, moveTargetAt } from '../src/presentation/embed-move';

const board = '![[x.blackboard|right|300]]';
describe('planEmbedMove', () => {
  it('moves to top and bottom, including no trailing newline', () => {
    const source = `first\n\n${board}\n\nlast`;
    expect(planEmbedMove(source, 0, 0)?.source).toBe(`${board}\n\nfirst\n\nlast`);
    expect(planEmbedMove(source, 0, 3)?.source).toBe(`first\n\nlast\n\n${board}`);
  });
  it('moves one adjacent top-level block and isolates the board paragraph', () => {
    const source = `first\n${board}\n# Heading\nlast\n`;
    expect(planEmbedMove(source, 0, 3)?.source).toBe(`first\n\n# Heading\n\n${board}\n\nlast\n`);
  });
  it('cleans board separators without normalising unrelated spacing', () => {
    const source = `first\n\n\n${board}\n\n\nsecond\n\n\nlast\n`;
    expect(planEmbedMove(source, 0, 4)?.source).toBe(`first\n\nsecond\n\n\nlast\n\n${board}\n`);
  });
  it('keeps CRLF, leading blank lines and final newline policy', () => {
    const source = `\r\nfirst\r\n\r\n${board}\r\n\r\nlast\r\n`;
    expect(planEmbedMove(source, 0, 3)?.source).toBe(`\r\nfirst\r\n\r\nlast\r\n\r\n${board}\r\n`);
    expect(planEmbedMove(`first\r\n${board}\nlast`, 0, 0)).toBeNull();
  });
  it('keeps frontmatter first and refuses its interior', () => {
    const source = `---\ntitle: Note\n---\n\nfirst\n\n${board}`;
    expect(planEmbedMove(source, 0, 0)).toBeNull();
    expect(planEmbedMove(source, 0, 1)?.source).toBe(`---\ntitle: Note\n---\n\n${board}\n\nfirst`);
    expect(moveTargetAt(source, source.indexOf('title'), false)).toBeNull();
  });
  it.each([
    '```md\nexample\n```', '~~~\nexample\n~~~', '    indented\n    code',
    '| A | B |\n| --- | --- |\n| a | b |', '- item\n  continuation\n\n    nested',
    '> [!note]\n> callout body',
  ])('crosses a whole protected block without changing its bytes: %s', protectedBlock => {
    const source = `${board}\n\n${protectedBlock}\n\nlast`;
    const blocks = noteBlocks(source);
    expect(blocks).toHaveLength(3);
    expect(moveTargetAt(source, source.indexOf(protectedBlock) + 2, false)).toBeNull();
    expect(planEmbedMove(source, 0, 2)?.source).toBe(`${protectedBlock}\n\n${board}\n\nlast`);
  });
  it.each([
    `    ${board}`, `---\nkey: ${board}\n---`,
    `\x60\x60\x60\n${board}\n\x60\x60\x60`,
  ])('refuses code/frontmatter boards: %s', source => {
    expect(planEmbedMove(source, 0, noteBlocks(source).length)).toBeNull();
    expect(movableBlock(source, 0)).toBe(-1);
  });
  it('selects duplicates by source occurrence and never loses or duplicates links', () => {
    const source = `${board}\n\nfirst\n\n${board}\n\nlast`;
    const result = planEmbedMove(source, 1, 0)!;
    expect(result.source).toBe(`${board}\n\n${board}\n\nfirst\n\nlast`);
    expect(findEmbedLinks(result.source)).toHaveLength(2);
    expect(result.source.slice(result.boardStart, result.boardStart + board.length)).toBe(board);
    expect(source.slice(0, result.start) + result.text + source.slice(result.end)).toBe(result.source);
  });
  it('refuses targets inside another embed, invalid indices, and drops on self', () => {
    const source = `first\n\n${board}\n\n![[other.blackboard]]`;
    expect(moveTargetAt(source, source.indexOf('other'), false)).toBeNull();
    for (const target of [-1, 1, 2, 4, 1.5]) expect(planEmbedMove(source, 0, target)).toBeNull();
    expect(planEmbedMove(source, 9, 0)).toBeNull();
  });
  it('treats blank gaps as boundaries and preserves other embeds', () => {
    const source = `${board}\n\n![[image.png]]\n\nlast`;
    expect(moveTargetAt(source, board.length + 1, false)).toBe(1);
    expect(planEmbedMove(source, 0, 2)?.source).toBe(`![[image.png]]\n\n${board}\n\nlast`);
  });
  it('refuses unsupported opaque Markdown rather than guessing', () => {
    expect(planEmbedMove(`${board}\n\n<div>\ntext\n</div>`, 0, 2)).toBeNull();
    expect(planEmbedMove(`${board}\n\n\x60\x60\x60\nunterminated`, 0, 2)).toBeNull();
    expect(planEmbedMove(`${board}\n\n$$\nequation\n$$`, 0, 2)).toBeNull();
    expect(planEmbedMove(`<!--\n\n${board}\n\n-->`, 0, 0)).toBeNull();
  });
});
