import { describe, it, expect } from 'vitest';
import { getSvgPathFromStroke, getStrokeBounds, exportSvg } from '../src/application/export-service';
import type { Stroke, Point, Background } from '../src/domain/entities';

function makeStroke(points: Point[], color = '#ffffff', tool: 'pen' | 'highlighter' = 'pen'): Stroke {
  return {
    id: `stroke-${Date.now()}`,
    tool,
    color,
    size: 2,
    opacity: 1,
    points,
    hasPressure: true,
    timestamp: Date.now(),
  };
}

function makeBackground(overrides: Partial<Background> = {}): Background {
  return {
    type: 'blank',
    color: '#1a1a2e',
    grid: false,
    gridSize: 20,
    ...overrides,
  };
}

describe('getSvgPathFromStroke', () => {
  it('returns empty string for less than 2 points', () => {
    const result = getSvgPathFromStroke([[0, 0]]);

    expect(result).toBe('');
  });

  it('returns string starting with M', () => {
    const points = [[0, 0], [10, 10], [20, 20], [30, 30]];
    const result = getSvgPathFromStroke(points);

    expect(result.startsWith('M')).toBe(true);
  });

  it('returns string ending with Z', () => {
    const points = [[0, 0], [10, 10], [20, 20], [30, 30]];
    const result = getSvgPathFromStroke(points);

    expect(result.endsWith('Z')).toBe(true);
  });
});

describe('getStrokeBounds', () => {
  it('returns zero dimensions for empty array', () => {
    const result = getStrokeBounds([]);

    expect(result).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('calculates min x from stroke points', () => {
    const stroke = makeStroke([[5, 10, 0.5], [15, 20, 0.5], [25, 30, 0.5]]);
    const result = getStrokeBounds([stroke]);

    expect(result.x).toBe(5);
  });

  it('calculates max x from stroke points', () => {
    const stroke = makeStroke([[5, 10, 0.5], [15, 20, 0.5], [25, 30, 0.5]]);
    const result = getStrokeBounds([stroke]);

    expect(result.x + result.width).toBe(25);
  });

  it('calculates width from point spread', () => {
    const stroke = makeStroke([[10, 0, 0.5], [30, 0, 0.5]]);
    const result = getStrokeBounds([stroke]);

    expect(result.width).toBe(20);
  });

  it('calculates height from point spread', () => {
    const stroke = makeStroke([[0, 10, 0.5], [0, 50, 0.5]]);
    const result = getStrokeBounds([stroke]);

    expect(result.height).toBe(40);
  });
});

describe('exportSvg', () => {
  const samplePoints: Point[] = [[10, 10, 0.5], [20, 20, 0.5], [30, 30, 0.5]];

  it('returns string containing svg tag', () => {
    const result = exportSvg([makeStroke(samplePoints)], makeBackground());

    expect(result).toContain('<svg');
  });

  it('returns string containing xmlns attribute', () => {
    const result = exportSvg([makeStroke(samplePoints)], makeBackground());

    expect(result).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('contains viewBox attribute', () => {
    const result = exportSvg([makeStroke(samplePoints)], makeBackground());

    expect(result).toContain('viewBox=');
  });

  it('contains path element for each stroke', () => {
    const strokes = [
      makeStroke(samplePoints, '#ff0000'),
      makeStroke(samplePoints, '#00ff00'),
    ];
    const result = exportSvg(strokes, makeBackground());

    expect((result.match(/<path /g) || []).length).toBe(2);
  });

  it('contains fill attribute matching stroke color', () => {
    const result = exportSvg([makeStroke(samplePoints, '#ff0000')], makeBackground());

    expect(result).toContain('fill="#ff0000"');
  });

  it('has transparent background (no background rect)', () => {
    const result = exportSvg([makeStroke(samplePoints)], makeBackground());

    expect(result).not.toMatch(/<rect[^>]*fill="[^"]*"[^>]*>/);
  });

  it('contains grid pattern when grid enabled', () => {
    const bg = makeBackground({ grid: true });
    const result = exportSvg([makeStroke(samplePoints)], bg);

    expect(result).toContain('<pattern');
  });

  it('does not contain grid when grid disabled', () => {
    const bg = makeBackground({ grid: false });
    const result = exportSvg([makeStroke(samplePoints)], bg);

    expect(result).not.toContain('<pattern');
  });

  it('exportSvg with empty strokes array produces string containing svg tag', () => {
    const result = exportSvg([], makeBackground());

    expect(result).toContain('<svg');
  });

  it('exportSvg highlighter stroke has opacity attribute matching 0.3', () => {
    const stroke = makeStroke(samplePoints, '#ffff00', 'highlighter');
    stroke.opacity = 0.3;

    const result = exportSvg([stroke], makeBackground());

    expect(result).toContain('opacity="0.3"');
  });
});

import {
  SVG_TEXT_FONT_FAMILY,
  escapeXml,
  getExportBounds,
  getTextBounds,
  textItemToSvg,
} from '../src/application/export-service';
import type { TextItem } from '../src/domain/text-item';
import { TEXT_LINE_HEIGHT, textBaselineOffset } from '../src/domain/text-item';

const label = (over: Partial<TextItem> = {}): TextItem => ({
  id: 't1', x: 10, y: 20, text: 'hello', fontSize: 20, color: '#ff0000', ...over,
});

const samplePointsForText: Point[] = [[10, 10, 0.5], [20, 20, 0.5], [30, 30, 0.5]];

describe('escapeXml', () => {
  it('escapes the five characters that can break an XML document', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('escapes ampersands first, so nothing is double-escaped', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text (including non-ASCII) alone', () => {
    expect(escapeXml('привет — ok')).toBe('привет — ok');
  });
});

describe('text in SVG export', () => {
  it('emits a <text> element with the label\'s position, size and colour', () => {
    const svg = textItemToSvg(label());
    expect(svg).toContain(`x="10"`);
    expect(svg).toContain(`y="${label().y + textBaselineOffset(20, 0)}"`);
    expect(svg).toContain('font-size="20"');
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain(SVG_TEXT_FONT_FAMILY);
    expect(svg).toContain('>hello</text>');
  });

  it('anchors by the BASELINE, below the label\'s top-left anchor', () => {
    const y = Number(/ y="([\d.]+)"/.exec(textItemToSvg(label()))![1]);
    expect(y).toBeGreaterThan(20);
    expect(y).toBeLessThan(20 + 20 * TEXT_LINE_HEIGHT);
  });

  it('splits a multi-line label into left-aligned tspans one line-height apart', () => {
    const svg = textItemToSvg(label({ text: 'one\ntwo' }));
    expect(svg).toContain(`<tspan x="10" dy="0">one</tspan>`);
    expect(svg).toContain(`<tspan x="10" dy="${20 * TEXT_LINE_HEIGHT}">two</tspan>`);
  });

  it('XML-escapes the content, so a label can never inject markup', () => {
    const svg = textItemToSvg(label({ text: '</text><script>alert("x")</script>' }));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('escapes attribute values too (a hostile colour cannot escape its quotes)', () => {
    expect(textItemToSvg(label({ color: '" onload="evil()' }))).not.toContain('onload="evil()');
  });

  it('skips an empty label rather than emitting an empty element', () => {
    expect(textItemToSvg(label({ text: '' }))).toBe('');
  });

  it('renders labels AFTER the stroke paths, so they sit on top', () => {
    const svg = exportSvg([makeStroke(samplePointsForText)], makeBackground(), [label()]);
    expect(svg.indexOf('<text ')).toBeGreaterThan(svg.lastIndexOf('<path '));
  });

  it('a drawing with no text exports byte-identically to before', () => {
    const strokes = [makeStroke(samplePointsForText)];
    expect(exportSvg(strokes, makeBackground(), [])).toBe(exportSvg(strokes, makeBackground()));
  });

  it('a drawing of only labels still exports them', () => {
    const svg = exportSvg([], makeBackground(), [label()]);
    expect(svg).toContain('<text ');
    expect(svg).not.toContain('<path ');
  });
});

describe('export bounds include text', () => {
  it('getTextBounds spans the estimated boxes of every label', () => {
    const bounds = getTextBounds([label({ x: 0, y: 0, text: 'a' }), label({ id: 't2', x: 100, y: 50 })])!;
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    expect(bounds.x + bounds.width).toBeGreaterThan(100);
    expect(bounds.y + bounds.height).toBeGreaterThan(50);
  });

  it('getTextBounds ignores empty labels and returns null when there is nothing', () => {
    expect(getTextBounds([])).toBeNull();
    expect(getTextBounds([label({ text: '' })])).toBeNull();
  });

  it('with no text the bounds are exactly the stroke bounds', () => {
    const strokes = [makeStroke(samplePointsForText)];
    expect(getExportBounds(strokes, [])).toEqual(getStrokeBounds(strokes));
  });

  it('a label far outside the strokes widens the bounds so it is not clipped', () => {
    const strokes = [makeStroke([[0, 0, 0.5], [10, 10, 0.5]])];
    const bounds = getExportBounds(strokes, [label({ x: 500, y: 400 })]);
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    expect(bounds.x + bounds.width).toBeGreaterThan(500);
    expect(bounds.y + bounds.height).toBeGreaterThan(400);
  });

  it('a label ABOVE and LEFT of the strokes moves the origin', () => {
    const strokes = [makeStroke([[0, 0, 0.5], [10, 10, 0.5]])];
    const bounds = getExportBounds(strokes, [label({ x: -50, y: -30 })]);
    expect(bounds.x).toBe(-50);
    expect(bounds.y).toBe(-30);
  });

  it('the exported viewBox actually contains every label', () => {
    const svg = exportSvg([makeStroke([[0, 0, 0.5], [5, 5, 0.5]])], makeBackground(), [label({ x: 400, y: 300 })]);
    const [vx, vy, vw, vh] = /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);
    expect(vx).toBeLessThanOrEqual(400);
    expect(vy).toBeLessThanOrEqual(300);
    expect(vx + vw).toBeGreaterThan(400);
    expect(vy + vh).toBeGreaterThan(300);
  });
});
