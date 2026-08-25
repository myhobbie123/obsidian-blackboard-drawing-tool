import { getStroke } from 'perfect-freehand';
import type { Stroke, Background } from '../domain/entities';
import type { TextItem } from '../domain/text-item';
import { estimateTextItemBox, textBaselineOffset, TEXT_LINE_HEIGHT } from '../domain/text-item';

export interface ExportBounds { x: number; y: number; width: number; height: number }

/**
 * Font stack for exported labels. On screen a label uses Obsidian's `var(--font-text)`, which
 * an SVG opened outside Obsidian cannot resolve, so the export names a concrete stack ending
 * in `sans-serif`. Deliberately quote-free: every family here is a valid unquoted CSS
 * identifier sequence, so the attribute needs no nested quoting.
 */
export const SVG_TEXT_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

/**
 * XML text/attribute escaping. `&` first (or it would double-escape the others); `"` because
 * the same helper writes attribute values, where an unescaped quote would end the attribute
 * — a label containing `" onload="` must not be able to inject anything into the exported
 * document.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function getSvgPathFromStroke(points: number[][]): string {
  if (points.length < 2) return '';

  const first = points[0];
  let d = `M${first[0].toFixed(2)},${first[1].toFixed(2)}`;

  for (let i = 1; i < points.length - 1; i++) {
    const cp = points[i];
    const next = points[i + 1];
    const midX = (cp[0] + next[0]) / 2;
    const midY = (cp[1] + next[1]) / 2;
    d += ` Q${cp[0].toFixed(2)},${cp[1].toFixed(2)} ${midX.toFixed(2)},${midY.toFixed(2)}`;
  }

  const last = points[points.length - 1];
  d += ` Q${last[0].toFixed(2)},${last[1].toFixed(2)} ${first[0].toFixed(2)},${first[1].toFixed(2)}Z`;

  return d;
}

export function getStrokeBounds(strokes: Stroke[]): ExportBounds {
  if (strokes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (point[0] < minX) minX = point[0];
      if (point[1] < minY) minY = point[1];
      if (point[0] > maxX) maxX = point[0];
      if (point[1] > maxY) maxY = point[1];
    }
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Bounding box of the labels, in drawing units, or null when there are none. Sizes come from
 * `estimateTextItemBox` — the export has no DOM to measure against, and the estimate is
 * deliberately generous, so the box errs towards padding rather than clipping.
 */
export function getTextBounds(items: TextItem[]): ExportBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;

  for (const item of items) {
    if (item.text === '') continue;
    const box = estimateTextItemBox(item);
    found = true;
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.x + box.width > maxX) maxX = item.x + box.width;
    if (item.y + box.height > maxY) maxY = item.y + box.height;
  }

  if (!found) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The box the export has to cover. Text has to be included or labels near the edge are cut
 * off by the viewBox; with no labels the result is exactly `getStrokeBounds`, so a text-free
 * drawing exports byte-for-byte what it did before.
 */
export function getExportBounds(strokes: Stroke[], items: TextItem[] = []): ExportBounds {
  const text = getTextBounds(items);
  if (!text) return getStrokeBounds(strokes);
  if (strokes.length === 0) return text;

  const s = getStrokeBounds(strokes);
  const minX = Math.min(s.x, text.x);
  const minY = Math.min(s.y, text.y);
  const maxX = Math.max(s.x + s.width, text.x + text.width);
  const maxY = Math.max(s.y + s.height, text.y + text.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * One label as an SVG `<text>`. A label is anchored by its TOP-LEFT everywhere in the plugin
 * but `<text>` is anchored by its BASELINE, so the y is offset by `textBaselineOffset`;
 * further lines are `<tspan>`s one line-height apart, re-anchored at x so they left-align the
 * way the wrapped DOM label does. `xml:space="preserve"` keeps leading/trailing spaces the
 * user typed (the DOM label renders `pre-wrap`).
 */
export function textItemToSvg(item: TextItem): string {
  if (item.text === '') return '';
  const lines = item.text.split('\n');
  const x = item.x;
  const y = item.y + textBaselineOffset(item.fontSize, 0);
  const attrs =
    `x="${x}" y="${y}"` +
    ` font-family="${escapeXml(SVG_TEXT_FONT_FAMILY)}"` +
    ` font-size="${item.fontSize}"` +
    ` fill="${escapeXml(item.color)}"` +
    ' xml:space="preserve"';
  if (lines.length === 1) return `<text ${attrs}>${escapeXml(lines[0])}</text>`;
  const spans = lines.map((line, i) =>
    `<tspan x="${x}" dy="${i === 0 ? 0 : item.fontSize * TEXT_LINE_HEIGHT}">${escapeXml(line)}</tspan>`,
  ).join('');
  return `<text ${attrs}>${spans}</text>`;
}

/**
 * Serialize a drawing as SVG in drawing-space coordinates. Labels are emitted AFTER the
 * stroke paths, so they paint on top — the same z-order the on-screen text layer has, sitting
 * in its own DOM layer above both canvases.
 */
export function exportSvg(strokes: Stroke[], background: Background, textItems: TextItem[] = []): string {
  const bounds = getExportBounds(strokes, textItems);
  const padding = 20;
  const vx = bounds.x - padding;
  const vy = bounds.y - padding;
  const vw = bounds.width + padding * 2;
  const vh = bounds.height + padding * 2;

  let defs = '';
  let gridRect = '';

  if (background.grid) {
    const gs = background.gridSize;
    defs = `<defs><pattern id="grid" width="${gs}" height="${gs}" patternUnits="userSpaceOnUse"><path d="M ${gs} 0 L 0 0 0 ${gs}" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="0.5"/></pattern></defs>`;
    gridRect = `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="url(#grid)"/>`;
  }

  const paths = strokes.map((stroke) => {
    const outlinePoints = getStroke(stroke.points, {
      size: stroke.size,
      thinning: 0.5,
      simulatePressure: !stroke.hasPressure,
    });
    const d = getSvgPathFromStroke(outlinePoints);
    return `<path d="${d}" fill="${stroke.color}" opacity="${stroke.opacity}"/>`;
  });

  const texts = textItems.map(textItemToSvg).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}">${defs}${gridRect}${paths.join('')}${texts}</svg>`;
}
