import { describe, it, expect } from 'vitest';
import { parseEmbedSize, fitSavedEmbedSize, findEmbedLinks, planEmbedSizeEdit } from '../src/presentation/embed-size';

describe('fitSavedEmbedSize', () => {
  it('keeps the saved size when it fits the available width', () => {
    expect(fitSavedEmbedSize(320, 240, 700)).toEqual({ width: 320, height: 240 });
  });
  it('scales down proportionally when wider than the note', () => {
    // 800 wide into 400 available -> half scale, aspect preserved
    expect(fitSavedEmbedSize(800, 600, 400)).toEqual({ width: 400, height: 300 });
  });
  it('never upscales beyond the saved size', () => {
    expect(fitSavedEmbedSize(200, 100, 2000)).toEqual({ width: 200, height: 100 });
  });
  it('returns null for a degenerate saved size', () => {
    expect(fitSavedEmbedSize(0, 0, 500)).toBeNull();
  });
});


describe('parseEmbedSize', () => {
  it('parses WxH', () => {
    expect(parseEmbedSize('640x480')).toEqual({ width: '640px', height: '480px' });
  });
  it('parses width-only', () => {
    expect(parseEmbedSize('300')).toEqual({ width: '300px', height: null });
  });
  it('parses percent width', () => {
    expect(parseEmbedSize('100%')).toEqual({ width: '100%', height: null });
  });
  it('parses percentxheight', () => {
    expect(parseEmbedSize('100%x400')).toEqual({ width: '100%', height: '400px' });
  });
  it('returns null for empty/garbage', () => {
    expect(parseEmbedSize('')).toBeNull();
    expect(parseEmbedSize('abc')).toBeNull();
  });
  it('returns null for null/undefined input', () => {
    expect(parseEmbedSize(null)).toBeNull();
    expect(parseEmbedSize(undefined)).toBeNull();
  });
  it('returns null for a zero width', () => {
    expect(parseEmbedSize('0')).toBeNull();
    expect(parseEmbedSize('0x0')).toBeNull();
  });
  it('drops a zero height but keeps the width', () => {
    expect(parseEmbedSize('640x0')).toEqual({ width: '640px', height: null });
  });
});

describe('findEmbedLinks / planEmbedSizeEdit', () => {
  const all = () => true;
  const plan = (source: string, w = 640, h = 480, occurrence = 0) =>
    planEmbedSizeEdit(source, all, w, h, occurrence);

  it('finds an embed with no alias', () => {
    const links = findEmbedLinks('text\n![[Drawing.blackboard]]\nmore');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ linkpath: 'Drawing.blackboard', alias: null });
  });

  it('adds an alias to an embed that has none', () => {
    const edit = plan('a\n![[Drawing.blackboard]]\nb');
    expect(edit!.source).toBe('a\n![[Drawing.blackboard|640x480]]\nb');
    expect(edit!.text).toBe('![[Drawing.blackboard|640x480]]');
  });

  it('replaces a width-only alias', () => {
    expect(plan('![[Drawing.blackboard|300]]')!.source).toBe('![[Drawing.blackboard|640x480]]');
    expect(findEmbedLinks('![[Drawing.blackboard|300]]')[0].alias).toBe('300');
  });

  it('replaces a WxH alias', () => {
    expect(plan('![[Drawing.blackboard|100x200]]')!.source).toBe('![[Drawing.blackboard|640x480]]');
  });

  it('replaces a percentage alias', () => {
    expect(plan('![[Drawing.blackboard|100%]]')!.source).toBe('![[Drawing.blackboard|640x480]]');
  });

  it('keeps the link target exactly as written, including subfolders', () => {
    expect(plan('![[Notes/Sub folder/My Drawing.blackboard|10x10]]')!.source)
      .toBe('![[Notes/Sub folder/My Drawing.blackboard|640x480]]');
  });

  it('rounds fractional sizes', () => {
    expect(plan('![[a.blackboard]]', 640.6, 479.4)!.source).toBe('![[a.blackboard|641x479]]');
  });

  it('returns null when the alias is already the requested size', () => {
    expect(plan('![[Drawing.blackboard|640x480]]')).toBeNull();
  });

  it('returns null when the note contains no embed of the target', () => {
    expect(plan('nothing here')).toBeNull();
    expect(planEmbedSizeEdit('![[Other.blackboard]]', (p) => p === 'Mine.blackboard', 10, 10)).toBeNull();
  });

  it('ignores non-blackboard embeds and plain links', () => {
    expect(findEmbedLinks('![[image.png|300]] [[Drawing.blackboard]] ![[note.md]]')).toHaveLength(0);
  });

  it('rewrites only the requested occurrence when a note embeds the drawing twice', () => {
    const source = 'one ![[D.blackboard|10x10]]\ntwo ![[D.blackboard|20x20]]\n';
    expect(findEmbedLinks(source)).toHaveLength(2);
    expect(plan(source, 640, 480, 0)!.source).toBe('one ![[D.blackboard|640x480]]\ntwo ![[D.blackboard|20x20]]\n');
    expect(plan(source, 640, 480, 1)!.source).toBe('one ![[D.blackboard|10x10]]\ntwo ![[D.blackboard|640x480]]\n');
  });

  it('falls back to the first occurrence when the index is out of range', () => {
    const source = '![[D.blackboard]] ![[D.blackboard]]';
    expect(plan(source, 640, 480, 9)!.source).toBe('![[D.blackboard|640x480]] ![[D.blackboard]]');
  });

  it('never rewrites an embed inside a fenced code block', () => {
    const source = 'before\n```md\n![[D.blackboard|1x1]]\n```\nafter\n';
    expect(findEmbedLinks(source)).toHaveLength(0);
    expect(plan(source)).toBeNull();
  });

  it('rewrites the real embed while skipping an identical one inside a fence', () => {
    const source = '```\n![[D.blackboard|1x1]]\n```\n![[D.blackboard|2x2]]\n';
    expect(plan(source)!.source).toBe('```\n![[D.blackboard|1x1]]\n```\n![[D.blackboard|640x480]]\n');
  });

  it('handles tilde fences, long fences and an unterminated fence', () => {
    expect(findEmbedLinks('~~~\n![[D.blackboard]]\n~~~\n')).toHaveLength(0);
    expect(findEmbedLinks('````\n```\n![[D.blackboard]]\n```\n````\n')).toHaveLength(0);
    expect(findEmbedLinks('```\n![[D.blackboard]]\n')).toHaveLength(0);
  });

  it('never rewrites an embed inside an inline code span', () => {
    expect(findEmbedLinks('write `![[D.blackboard|1x1]]` to embed')).toHaveLength(0);
  });

  it('is case-insensitive about the extension', () => {
    expect(plan('![[D.BLACKBOARD]]')!.source).toBe('![[D.BLACKBOARD|640x480]]');
  });

  it('reports offsets that address exactly the embed text', () => {
    const source = 'xx ![[D.blackboard|1x1]] yy';
    const edit = plan(source)!;
    expect(source.slice(edit.start, edit.end)).toBe('![[D.blackboard|1x1]]');
    expect(edit.source).toBe('xx ![[D.blackboard|640x480]] yy');
  });

  it('does not let an alias mentioning .blackboard extend the captured path', () => {
    expect(findEmbedLinks('![[D.blackboard|see other.blackboard]]')[0])
      .toMatchObject({ linkpath: 'D.blackboard', alias: 'see other.blackboard' });
  });
});
