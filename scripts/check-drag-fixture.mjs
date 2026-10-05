// Real CM6 layout + trusted mouse events. Local files and installed Chromium only.
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const output = resolve('release/drag-fixture');
mkdirSync(output, { recursive: true });
// Reproduce the previous production drag, not a rewritten approximation. Obsidian
// UI factories are the only mocked dependency; CM geometry/capture are real.
const legacyControls = execFileSync('git', ['show', '56ccbc6:src/presentation/embed-controls.ts'], { encoding: 'utf8' });
writeFileSync(join(output, 'legacy-controls.ts'), legacyControls.replaceAll("'./", "'../../src/presentation/"));
await build({ entryPoints: ['test/fixtures/cm-drag.ts'], bundle: true, format: 'iife', outfile: join(output, 'cm-drag.js') });
await build({ entryPoints: ['test/fixtures/cm-legacy-drag.ts'], bundle: true, format: 'iife', outfile: join(output, 'cm-legacy-drag.js'), alias: { obsidian: resolve('test/fixtures/legacy-host.ts'), '@codemirror/commands': resolve('test/__mocks__/cm-commands.ts') } });
const chrome = process.env.CHROME_PATH ?? join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe');
if (!existsSync(chrome)) throw new Error('Set CHROME_PATH to installed Chromium. No downloads.');
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-domain-reliability', '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-features=MediaRouter,OptimizationHints'] });
const results = [], errors = [], logs = [];
const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, offline: true });
await context.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'debug') logs.push(message.text()); });
const board = '![[x.blackboard|right|300]]';
const other = '![[other.blackboard|left]]';
const longList = `- First ${board}\n- Second\n  - Child A\n    - Grandchild A\n    - Grandchild B\n  - Child B\n- Third.${other}\n` + Array.from({ length: 100 }, (_, i) => `- More ${i}\n  - Nested ${i}`).join('\n');
const ready = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function mount(source) { await page.evaluate(s => window.harness.mount(s), source); await ready(); }
async function grab(alt = false) {
  const rect = await page.locator(alt ? '.blackboard-drawing-container' : '.bb-move-grip').first().boundingBox();
  assert(rect, 'visible board grip');
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(point.x, point.y);
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.down();
  return point;
}
async function target(line, after = false, end = false) {
  const point = await page.evaluate(p => window.harness.point(...p), [line, after, end]);
  await page.mouse.move(point.x, point.y, { steps: 6 }); await ready();
  return point;
}
async function overlays(line) {
  assert(await page.locator('.bb-drag-ghost:not([hidden])').count(), 'ghost visible');
  assert.equal(await page.locator('.bb-drop-indicator:not([hidden])').getAttribute('data-line'), String(line), 'exact caret slot');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).cursor), 'grabbing');
  assert.equal(await page.locator('.bb-drag-ghost:not([hidden])').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
}
async function finish(name, source, expected, undo = true) {
  await page.mouse.up(); await ready();
  assert.equal(await page.evaluate(() => window.harness.source()), expected, name + ' Markdown');
  assert.equal(await page.evaluate(() => window.harness.writes()), expected === source ? 0 : 1, name + ' transaction count');
  assert.equal(await page.locator('.bb-drag-ghost:not([hidden])').count(), 0, 'ghost cleaned');
  assert.equal(await page.evaluate(() => document.body.classList.contains('bb-dragging')), false);
  if (undo && expected !== source) {
    assert.equal(await page.evaluate(() => window.harness.undo()), true);
    assert.equal(await page.evaluate(() => window.harness.source()), source, 'one undo restores every byte');
    assert.equal(await page.evaluate(() => window.harness.undo()), false, 'no second board undo entry');
  }
  results.push({ name, result: 'PASS' });
}
try {
  await page.goto(pathToFileURL(resolve('test/fixtures/cm-drag.html')).href);
  await mount(longList); await grab(); await target(2); await overlays(2);
  const first = longList.replace(` ${board}`, '');
  await page.screenshot({ path: join(output, 'list-drag.png') });
  await finish('between bullet items + one undo', longList, first.replace('- Second', `  ${board}\n- Second`));
  await mount(longList); await grab(); await target(5); await overlays(5);
  await finish('between deeply nested items', longList, first.replace('    - Grandchild B', `      ${board}\n    - Grandchild B`));
  const atTop = `- First ${board}\n- Next`;
  await mount(atTop); await grab(); await target(1); await overlays(1);
  await finish('before first note line', atTop, `${board}\n\n- First\n- Next`);
  const numbered = `9. First ${board}\n10. Next\n11. Last`;
  await mount(numbered); await grab(); await target(3); await overlays(3);
  await finish('numbered list continuation', numbered, `9. First\n10. Next\n    ${board}\n11. Last`);
  const wrapped = `First ${board}\n` + 'A long paragraph line with spaces and words. '.repeat(12) + '\nNext physical line';
  await mount(wrapped); await grab(); await target(2, true, true); await overlays(3);
  await finish('lower half of final visual row', wrapped, wrapped.replace(` ${board}`, '').replace('\nNext physical line', `\n\n${board}\n\nNext physical line`));
  const paragraph = `First ${board}\nSecond paragraph line\nThird paragraph line`;
  await mount(paragraph); await grab(); await target(3); await overlays(3);
  await finish('between paragraph lines', paragraph, `First\nSecond paragraph line\n\n${board}\n\nThird paragraph line`);
  const top = `---\ntitle: Local test\n---\nFirst line\n\nText ${board}\n\nEnd`;
  await mount(top); await grab(); await target(4); await overlays(4);
  await finish('top after frontmatter', top, `---\ntitle: Local test\n---\n\n${board}\n\nFirst line\n\nText\n\nEnd`);
  const end = `First ${board}\nLast line`;
  await mount(end); await grab(); await target(2, true, true); await overlays(3);
  await finish('end without trailing newline', end, `First\nLast line\n\n${board}`);
  for (const [name, zone, line] of [
    ['fenced code', '~~~\ncode\n~~~', 4], ['indented code', '    code\n    more', 4],
    ['table', '| Header |\n| --- |\n| cell |', 5], ['math', '$$\nmath\n$$', 4],
  ]) {
    const source = `Text ${board}\n\n${zone}\n\nEnd`;
    await mount(source); await grab(); await target(line);
    assert.equal(await page.locator('.bb-drop-indicator:not([hidden])').count(), 0, name + ' indicator refused');
    assert(await page.locator('.bb-drag-ghost:not([hidden])').count());
    await finish('protected ' + name, source, source);
    assert((await page.evaluate(() => window.harness.notices())).at(-1).includes('outside'));
  }
  const beforeCode = `Text ${board}\n\n~~~\ncode\n~~~\n\nEnd`;
  await mount(beforeCode); await grab(); await target(3); await overlays(3);
  await finish('outer boundary before protected code', beforeCode, `Text\n\n${board}\n\n~~~\ncode\n~~~\n\nEnd`);
  await mount(top); await grab(); await target(2);
  assert.equal(await page.locator('.bb-drop-indicator:not([hidden])').count(), 0);
  await finish('protected frontmatter', top, top);
  await mount(longList); await grab(); await target(2); await overlays(2);
  await page.evaluate(() => document.body.releasePointerCapture(1));
  const lostPoint = await page.evaluate(() => window.harness.point(2, false));
  await page.mouse.move(lostPoint.x + 1, lostPoint.y); await ready();
  assert.equal(await page.locator('.bb-drag-ghost:not([hidden])').count(), 0);
  await finish('native capture loss cancels', longList, longList);
  const protectedSource = `| Header |\n| --- |\n| ${board} |`;
  await mount(protectedSource); await grab(); await target(2);
  await finish('protected source refused before capture', protectedSource, protectedSource);
  assert((await page.evaluate(() => window.harness.notices())).at(-1).includes('outside the table'));
  await mount(longList); await grab(); await target(2); await page.keyboard.press('Escape');
  await finish('Escape cancels', longList, longList);
  const own = `First\n\n${board}\n\nLast`;
  await mount(own); await grab(); await target(3, true, true); await overlays(4);
  await finish('own slot no write', own, own);
  await mount(end); await grab(true); await target(2, true, true); await page.keyboard.up('Alt');
  assert.equal(await page.evaluate(() => window.harness.strokes()), 0, 'Alt grab starts no stroke');
  await finish('Alt grab on drawing surface', end, `First\nLast line\n\n${board}`);
  await mount(longList); const start = await grab();
  await page.mouse.move(start.x + 3, start.y); await ready();
  assert.equal(await page.locator('.bb-drag-ghost:not([hidden])').count(), 0);
  await page.mouse.move(start.x + 4, start.y); await ready();
  assert(await page.locator('.bb-drag-ghost:not([hidden])').count());
  await page.keyboard.press('Escape'); await finish('4px threshold', longList, longList);
  await mount(longList); const offset = await grab();
  await page.mouse.move(offset.x + 30, offset.y + 25); await ready();
  const ghost = await page.locator('.bb-drag-ghost:not([hidden])').boundingBox();
  const original = await page.locator('.mock-board').first().boundingBox();
  assert(Math.abs(ghost.x - original.x - 30) < 2 && Math.abs(ghost.y - original.y - 25) < 2, 'grab offset preserved');
  await page.keyboard.press('Escape'); await finish('ghost follows with grab offset', longList, longList);
  await mount(longList); await grab();
  const pane = await page.locator('.cm-scroller').boundingBox();
  await page.mouse.move(pane.x + 200, pane.y + pane.height - 5);
  await page.waitForFunction(() => window.harness.scrollTop() > 250);
  await page.evaluate(() => window.harness.scroll(180)); await ready();
  assert.equal(await page.locator('.mock-board').count(), 0, 'source widgets have been virtualised out');
  await target(180); await overlays(180);
  await finish('auto-scroll and source widget virtualisation', longList, first.replace('- More 86', `    ${board}\n- More 86`));
  await mount(end); await grab(); await target(2);
  await page.evaluate(() => window.harness.mutate('\nExternal edit')); await ready();
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.harness.writes()), 0);
  assert.equal(await page.evaluate(() => window.harness.source()), end + '\nExternal edit');
  results.push({ name: 'concurrent note edit refuses without loss', result: 'PASS' });
  assert(logs.some(s => s.includes('pointerdown accepted')) && logs.some(s => s.includes('capture set')) && logs.some(s => s.includes('capture lost')) && logs.some(s => s.includes('pointerdown refused')) && logs.some(s => s.includes('first move')) && logs.some(s => s.includes('slot')) && logs.some(s => s.includes('moved')), 'debug phases recorded');
  await mount(end); await page.evaluate(() => window.harness.debug(false)); const beforeLogs = logs.length;
  await grab(); await target(2, true, true); await finish('debug off emits nothing', end, `First\nLast line\n\n${board}`);
  assert.equal(logs.length, beforeLogs);

  // Previous release controller, real capture and geometry, same list-only note.
  await page.goto(pathToFileURL(resolve('test/fixtures/cm-legacy-drag.html')).href); await ready();
  await page.evaluate(s => window.legacy.mount(s), longList); await ready();
  const oldGrip = await page.locator('.bb-move-grip').first().boundingBox();
  await page.mouse.move(oldGrip.x + 10, oldGrip.y + 10); await page.mouse.down();
  const oldTarget = await page.evaluate(() => window.legacy.point(2));
  await page.mouse.move(oldTarget.x, oldTarget.y, { steps: 8 }); await ready();
  const evidence = await page.evaluate(() => window.legacy.evidence());
  assert.equal(evidence.target, null); assert.equal(evidence.indicatorHidden, true); assert.equal(evidence.captureLostBeforeRelease, false);
  assert(evidence.hasCoords && Number.isFinite(evidence.documentTop) && evidence.captured);
  await page.mouse.up(); await ready();
  assert.equal(await page.evaluate(() => window.legacy.source()), longList);
  results.push({ name: '1.4.1 actual controller reproduces list refusal', result: 'PASS', evidence });
  assert.deepEqual(errors, [], 'no browser runtime errors');
  writeFileSync(join(output, 'results.json'), JSON.stringify({ results, errors, logs }, null, 2) + '\n');
  console.log(`PASS offline Chromium / real CM6: ${results.length} cases; trusted pointer input, exact Markdown, transaction counts and inverse-ChangeSet undo.`);
} finally {
  writeFileSync(join(output, 'results.json'), JSON.stringify({ results, errors, logs }, null, 2) + '\n');
  await browser.close();
}
