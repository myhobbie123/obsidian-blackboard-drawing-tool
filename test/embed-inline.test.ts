import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findEmbedLinks } from '../src/presentation/embed-size';
import { inspectEmbedMove, embedRefusalAtCursor, MOVE_MESSAGES, noteBlocks, planEmbedMove, planEmbedOwnLine, planEmbedStep, planEmbedWrap } from '../src/presentation/embed-move';

const board = '![[x.blackboard|right|300x200]]';
const other = '![[y.blackboard|left]]';
function checkEdit(source: string, edit: ReturnType<typeof planEmbedMove>) {
  expect(edit).not.toBeNull();
  expect(source.slice(0, edit!.start) + edit!.text + source.slice(edit!.end)).toBe(edit!.source);
  expect(edit!.source.slice(edit!.boardStart, edit!.boardStart + 3)).toBe('![[');
  expect(findEmbedLinks(edit!.source).map(m => m.linkpath).sort()).toEqual(findEmbedLinks(source).map(m => m.linkpath).sort());
  return edit!.source;
}

describe('inline extraction and first-press semantics', () => {
  it.each([
    [`- Item ${board}\n- Next`, '- Item\n- Next'],
    [`- Parent\n  - Nested ${board}\n    - Deep child\n- Next`, '- Parent\n  - Nested\n    - Deep child\n- Next'],
    [`1. Parent\n   1. Nested ${board}\n2. Next`, '1. Parent\n   1. Nested\n2. Next'],
    [`before ${board} after`, 'before after'],
    [`before ${board}  after`, 'before  after'],
    [`before  ${board}`, 'before '],
    [`${board} after`, 'after'],
    [`before.${board}`, 'before.'],
    [`> Quote ${board}\n> continuation`, '> Quote\n> continuation'],
    [`> [!note] Callout\n> Text.${board}\n> continued`, '> [!note] Callout\n> Text.\n> continued'],
    [`- Item\n  > Nested quote ${board}`, '- Item\n  > Nested quote'],
  ])('extracts just the token from %s', (source, remainder) => {
    expect(checkEdit(source, planEmbedOwnLine(source, 0))).toBe(`${remainder}\n\n${board}`);
    expect(checkEdit(source, planEmbedOwnLine(source, 0, true))).toBe(`${board}\n\n${remainder}`);
  });
  it('preserves a CRLF list and final newline, including glued punctuation', () => {
    const source = `- One.${board}\r\n  - Two\r\n\r\nlast\r\n`;
    expect(checkEdit(source, planEmbedOwnLine(source, 0))).toBe(`- One.\r\n  - Two\r\n\r\n${board}\r\n\r\nlast\r\n`);
  });
  it.each([0, 1])('extracts glued embed %i without touching the other token', occurrence => {
    const source = `- Text.${board}${other}`;
    const chosen = occurrence === 0 ? board : other;
    const untouched = occurrence === 0 ? other : board;
    expect(checkEdit(source, planEmbedOwnLine(source, occurrence))).toBe(`- Text.${untouched}\n\n${chosen}`);
  });
  it.each([0, 1])('selects glued duplicates by occurrence %i', occurrence => {
    const source = `- Text.${board}${board}`;
    expect(checkEdit(source, planEmbedOwnLine(source, occurrence))).toBe(`- Text.${board}\n\n${board}`);
  });
  it('first press extracts at the whole list boundary; later presses cross one block', () => {
    const source = `first\n\n- Item ${board}\n- Next\n\nlast`;
    expect(planEmbedStep(source, 0, -1)?.source).toBe(`first\n\n${board}\n\n- Item\n- Next\n\nlast`);
    const down = planEmbedStep(source, 0, 1)!;
    expect(down.source).toBe(`first\n\n- Item\n- Next\n\n${board}\n\nlast`);
    expect(planEmbedStep(down.source, 0, 1)?.source).toBe(`first\n\n- Item\n- Next\n\nlast\n\n${board}`);
    expect(planEmbedOwnLine(down.source, 0)).toBeNull();
  });
  it('permits both original block edges as drag targets for an inline source', () => {
    const source = `text ${board}`;
    expect(planEmbedMove(source, 0, 0)?.source).toBe(`${board}\n\ntext`);
    expect(planEmbedMove(source, 0, 1)?.source).toBe(`text\n\n${board}`);
  });
  it('moves each board from the anonymized owner fixture and preserves all other characters', () => {
    const source = readFileSync('test/fixtures/inline-boards.md', 'utf8');
    for (let occurrence = 0; occurrence < 3; occurrence++) {
      const link = findEmbedLinks(source)[occurrence];
      const token = source.slice(link.start, link.end);
      const removeStart = source[link.start - 1] === ' ' ? link.start - 1 : link.start;
      const remainder = source.slice(0, removeStart) + source.slice(link.end);
      const edit = planEmbedOwnLine(source, occurrence)!;
      expect(checkEdit(source, edit)).toBe(`${remainder.trimEnd()}\n\n${token}\n`);
    }
  });
  it('does not treat alias pipes as a table or combine a list and separate callout', () => {
    const source = `- Item ${board}\n\n> [!note]\n> Other`;
    expect(noteBlocks(source).map(b => b.kind)).toEqual(['list', 'quote']);
    expect(planEmbedOwnLine(source, 0)?.source).toBe(`- Item\n\n${board}\n\n> [!note]\n> Other`);
  });
});

describe('protected source reasons and combined wrap', () => {
  it.each([
    [`---\nkey: ${board}\n---`, 'frontmatter'],
    [`\x60\x60\x60md\n${board}\n\x60\x60\x60`, 'code'],
    [`before \x60${board}\x60 after`, 'code'],
    [`    ${board}`, 'code'],
    [`> \x60\x60\x60\n> ${board}\n> \x60\x60\x60`, 'code'],
    [`- Item\n  \x60\x60\x60\n  ${board}\n  \x60\x60\x60`, 'code'],
    [`- Item\n      ${board}`, 'code'],
    [`>     ${board}`, 'code'],
    [`| Board |\n| --- |\n| ${board} |`, 'table'],
    [`- Item\n  | Board |\n  | --- |\n  | ${board} |`, 'table'],
    [`> | Board |\n> | --- |\n> | ${board} |`, 'table'],
    [`[${board}](url)`, 'link'],
    [`[[outer|${board}]]`, 'link'],
    [`[label](url${board})`, 'link'],
    [`before\\${board}`, 'link'],
    [`before\r\n${board}\nlast`, 'line-endings'],
    [`${board}\n\n<div>\ntext\n</div>`, 'unsafe'],
    [`<!-- ${board} -->`, 'unsafe'],
  ])('refuses %s with message id %s', (source, reason) => {
    expect(inspectEmbedMove(source, 0)).toEqual({ reason });
    expect(planEmbedOwnLine(source, 0)).toBeNull();
    expect(planEmbedMove(source, 0, noteBlocks(source).length)).toBeNull();
    expect(planEmbedWrap(source, 0, 'left')).toBeNull();
    expect(MOVE_MESSAGES[reason as keyof typeof MOVE_MESSAGES]).toMatch(/manually|Save|Close/);
  });
  it('refuses unresolved occurrences with actionable ambiguity id', () => {
    for (const occurrence of [-1, 5, 1.5]) expect(inspectEmbedMove(board, occurrence)).toEqual({ reason: 'ambiguous' });
    expect(MOVE_MESSAGES.ambiguous).toContain('cursor inside');
  });
  it('explains a source cursor token in code without confusing it with another board', () => {
    const source = `${board}\n\n\x60${other}\x60`;
    expect(embedRefusalAtCursor(source, source.indexOf(other))).toBe('code');
  });
  it('moves inline board before its whole block and rewrites only its alias', () => {
    const source = `- Item.![[x.blackboard|300x200|custom]]${other}\n- Next`;
    const edit = planEmbedWrap(source, 0, 'left');
    expect(checkEdit(source, edit)).toBe(`![[x.blackboard|left|300x200|custom]]\n\n- Item.${other}\n- Next`);
  });
  it('extracts even when the selected wrap token already matches', () => {
    const source = `before ${board} after`;
    expect(planEmbedWrap(source, 0, 'right')?.source).toBe(`${board}\n\nbefore after`);
  });
  it('center edits an inline alias in place without extracting', () => {
    expect(planEmbedWrap(`- Text.${board}${other}`, 0, 'center')?.source).toBe(`- Text.![[x.blackboard|300x200]]${other}`);
  });
  it('keeps properties before an extracted wrapped board', () => {
    const source = `---\ntitle: Note\n---\n\n- Item ${board}`;
    expect(planEmbedWrap(source, 0, 'left')?.source).toBe(`---\ntitle: Note\n---\n\n![[x.blackboard|left|300x200]]\n\n- Item`);
  });
  it('refuses conflicting aliases without partially extracting', () => {
    expect(planEmbedWrap('- Item ![[x.blackboard|right|left|300]]', 0, 'left')).toBeNull();
  });
});
