import { describe, expect, it } from 'vitest';
import { dropLines, dropSlotAt, inspectDropSource, planEmbedDrop } from '../src/presentation/embed-drop';
import { findEmbedLinks } from '../src/presentation/embed-size';

const board = '![[x.blackboard|right|300]]';
const other = '![[other.blackboard|left]]';
function drop(source: string, line: number, after = false, occurrence = 0) {
  const l = dropLines(source)[line - 1];
  const slot = dropSlotAt(source, l.from, after);
  return slot ? planEmbedDrop(source, occurrence, slot) : null;
}
describe('line drop planning', () => {
  it.each([
    [`- First ${board}\n- Next\n- Last`, 2, `- First\n  ${board}\n- Next\n- Last`],
    [`- Parent ${board}\n  - Child\n  - Next child\n- Last`, 3, `- Parent\n  - Child\n    ${board}\n  - Next child\n- Last`],
    [`1. First ${board}\n2. Next\n3. Last`, 2, `1. First\n   ${board}\n2. Next\n3. Last`],
    [`9. First ${board}\n10. Next\n11. Last`, 3, `9. First\n10. Next\n    ${board}\n11. Last`],
    [`- First ${board}\n  continuation\n  more\n- Last`, 3, `- First\n  continuation\n  ${board}\n  more\n- Last`],
    [`First ${board}\nSecond\nThird`, 3, `First\nSecond\n\n${board}\n\nThird`],
    [`First ${board}\nSecond`, 1, `${board}\n\nFirst\nSecond`],
    [`---\ntitle: Test\n---\nFirst ${board}\nSecond`, 4, `---\ntitle: Test\n---\n\n${board}\n\nFirst\nSecond`],
    [`First ${board}\nSecond\n`, 3, `First\nSecond\n\n${board}\n`],
  ])('preserves prose and places at line %s', (source, line, expected) => {
    const edit = drop(source as string, line as number)!;
    expect(edit?.source).toBe(expected);
    expect((source as string).slice(0, edit.start) + edit.text + (source as string).slice(edit.end)).toBe(expected);
    expect(findEmbedLinks(edit.source).map(l => l.linkpath).sort()).toEqual(findEmbedLinks(source as string).map(l => l.linkpath).sort());
    expect(edit.source.slice(edit.boardStart, edit.boardStart + board.length)).toBe(board);
  });
  it('drops after the final line and respects CRLF and no final newline', () => {
    expect(drop(`First ${board}\nSecond`, 2, true)?.source).toBe(`First\nSecond\n\n${board}`);
    expect(drop(`- First ${board}\r\n- Next`, 2, true)?.source).toBe(`- First\r\n- Next\r\n  ${board}`);
  });
  it('retains punctuation and the other glued embed, selected by occurrence', () => {
    const source = `- First.${board}${other}\n- Next`;
    expect(drop(source, 2)?.source).toBe(`- First.${other}\n  ${board}\n- Next`);
    expect(drop(source, 2, false, 1)?.source).toBe(`- First.${board}\n  ${other}\n- Next`);
  });
  it('removes exactly one separated space, trims the source line and removes empty items', () => {
    expect(drop(`- First ${board} next\n- Last`, 2)?.source).toBe(`- First next\n  ${board}\n- Last`);
    expect(drop(`- ${board}\n- Next\n- Last`, 3)?.source).toBe(`- Next\n  ${board}\n- Last`);
    expect(drop(`- First ${board}  \n- Last`, 2)?.source).toBe(`- First\n  ${board}\n- Last`);
    expect(drop(`${board}\n\n\nFirst\n\n\nLast`, 6)?.source).toBe(`First\n\n${board}\n\nLast`);
  });
  it('refuses removing an empty parent with children rather than orphaning them', () => {
    expect(drop(`- ${board}\n  - Child\n- Last`, 3)).toBeNull();
  });
  it('supports a board on an indented continuation line, not mistaken for code', () => {
    expect(drop(`- First\n  ${board}\n- Next\n- Last`, 4)?.source).toBe(`- First\n- Next\n  ${board}\n- Last`);
  });
  it('returns to parent content indentation after a nested list continuation dedents', () => {
    const source = `- Parent ${board}\n  - Child\n  Parent continuation\n- Next`;
    expect(drop(source, 4)?.source).toBe(`- Parent\n  - Child\n  Parent continuation\n  ${board}\n- Next`);
  });
  it('expands tabs only for classification and protects indented pseudo-list/code gaps', () => {
    const source = `${board}\n\n    - code\n\n    more\n\nEnd`;
    expect(dropSlotAt(source, source.indexOf('- code'), true)).toBeNull();
    expect(drop(source, 4)).toBeNull();
    expect(dropSlotAt(`${board}\n\n\t~~~\n\tcode\n\t~~~`, board.length + 3, true)).toBeNull();
  });
  it.each([
    ['---\nkey: value\n---', 'key'],
    ['```md\ncode\n```', 'code'],
    ['~~~\ncode\n~~~', 'code'],
    ['    code\n    middle\n    more', 'middle'],
    ['- Item\n  ```md\n  code\n  ```', 'code'],
    ['- Item\n      code\n      middle\n      more', 'middle'],
    ['| Header |\n| --- |\n| cell |\n| more |', 'cell'],
    ['- Item\n  | Header |\n  | --- |\n  | cell |\n  | more |', 'cell'],
    ['$$\nmath\n$$', 'math'],
    ['- Item\n  $$\n  math\n  $$', 'math'],
  ])('refuses protected pointer line: %s', (zone, word) => {
    const source = zone.startsWith('---') ? `${zone}\n\n${board}\n\nEnd` : `${board}\n\n${zone}\n\nEnd`;
    expect(dropSlotAt(source, source.indexOf(word), false)).toBeNull();
    expect(dropSlotAt(source, source.indexOf(word), true)).toBeNull();
  });
  it('can cross whole math/code/table zones and drop outside them', () => {
    const source = `${board}\n\n$$\nmath\n$$\n\nEnd`;
    expect(drop(source, 7, true)?.source).toBe(`$$\nmath\n$$\n\nEnd\n\n${board}`);
    expect(inspectDropSource(`$$\n${board}\n$$`, 0)).toEqual({ reason: 'unsafe' });
  });
  it('allows the outer boundaries of protected blocks, including adjacent fences', () => {
    const source = `${board}\n\n~~~\ncode\n~~~\n~~~\nmore\n~~~\n\nEnd`;
    expect(dropSlotAt(source, source.indexOf('~~~'), false)).not.toBeNull();
    const nextFence = dropLines(source)[5].from;
    expect(dropSlotAt(source, nextFence, false)).not.toBeNull();
    expect(dropSlotAt(source, source.lastIndexOf('~~~'), true)).not.toBeNull();
    const properties = `---\ntitle: Test\n---\n${board}`;
    expect(dropSlotAt(properties, 0, false)).toBeNull();
    expect(dropSlotAt(properties, properties.lastIndexOf('---'), true)?.offset).toBe(properties.indexOf(board));
  });
  it('does not write at its original slot or adjacent blank gaps', () => {
    const source = `First\n\n${board}\n\nLast`;
    for (const line of [2, 3, 4, 5]) expect(drop(source, line)).toBeNull();
    expect(drop(source, 3, true)).toBeNull();
    expect(drop(source, 1)?.source).toBe(`${board}\n\nFirst\n\nLast`);
    expect(drop(`- ${board}\n- Next`, 1)).toBeNull();
    expect(drop(`- ${board}\n- Next`, 1, true)).toBeNull();
    expect(drop(`- ${board}\n  - Child\n- Next`, 1, true)).toBeNull();
  });
  it('refuses mixed line endings and unresolved duplicates', () => {
    expect(drop(`First ${board}\r\nNext\nLast`, 3)).toBeNull();
    expect(drop(`First ${board}\nLast`, 2, false, -1)).toBeNull();
  });
});
