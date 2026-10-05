import { describe, expect, it } from 'vitest';
import { aliasFromAttributes, formatEmbedAlias, parseEmbedAlias, planEmbedLayoutEdit, planEmbedSizeEdit } from '../src/presentation/embed-size';

describe('embed aliases', () => {
  it.each([null, '', '640x480', '300', '100%', '100%x400', 'left', 'right|400x300', '300|left', 'center|100%', 'right| unknown token |400x300|other', 'left||300|'])('round-trips semantics and unknown tokens: %s', alias => {
    const parsed = parseEmbedAlias(alias);
    const roundTrip = parseEmbedAlias(formatEmbedAlias(parsed));
    expect(roundTrip).toEqual({ ...parsed, layout: parsed.layout === 'center' ? null : parsed.layout });
  });
  it('writes canonical order and preserves unknown tokens verbatim', () => {
    expect(formatEmbedAlias(parseEmbedAlias(' stranger |300|right|more '))).toBe('right|300| stranger |more ');
  });
  it('reads full alt, full width, and split attributes', () => {
    expect(aliasFromAttributes('right|400x300', '400').layout).toBe('right');
    expect(aliasFromAttributes('400x300', 'right|400x300').layout).toBe('right');
    expect(aliasFromAttributes('left', '300').size?.width).toBe('300px');
  });
  it('preserves legacy size tokens while changing layout', () => {
    for (const token of ['640x480', '300', '100%', '100%x400']) {
      const source = `![[x.blackboard|${token}]]`;
      expect(planEmbedLayoutEdit(source, () => true, 'left')?.text).toBe(`![[x.blackboard|left|${token}]]`);
    }
  });
  it('removes default layout, preserves unknown tokens and size', () => {
    expect(planEmbedLayoutEdit('![[x.blackboard|right|400x300| hi ]]', () => true, 'center')?.text).toBe('![[x.blackboard|400x300| hi ]]');
    expect(planEmbedLayoutEdit('![[x.blackboard|left]]', () => true, 'center')?.text).toBe('![[x.blackboard]]');
  });
  it('resizing preserves layout and unknown tokens', () => {
    expect(planEmbedSizeEdit('![[x.blackboard|300|right|unknown]]', () => true, 400, 300)?.text).toBe('![[x.blackboard|right|400x300|unknown]]');
  });
  it('edits the requested duplicate only and refuses missing or ambiguous aliases', () => {
    const source = '![[x.blackboard]]\n![[x.blackboard|100%]]';
    expect(planEmbedLayoutEdit(source, () => true, 'right', 1)?.source).toBe('![[x.blackboard]]\n![[x.blackboard|right|100%]]');
    expect(planEmbedLayoutEdit(source, () => true, 'right', 9)).toBeNull();
    expect(planEmbedLayoutEdit('![[x.blackboard|left|right]]', () => true, 'center')).toBeNull();
    expect(planEmbedSizeEdit('![[x.blackboard|300|400]]', () => true, 500, 400)).toBeNull();
    expect(planEmbedLayoutEdit('![[x.blackboard]]', () => true, 'center')).toBeNull();
    expect(planEmbedLayoutEdit('`![[x.blackboard]]`', () => true, 'right')).toBeNull();
  });
});
