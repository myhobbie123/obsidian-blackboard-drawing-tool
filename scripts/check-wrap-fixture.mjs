// Offline renderer: isolated profile, local file only, external DNS blocked.
// Requires an already-installed Chrome; no browser/package downloads.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = process.env.CHROME_PATH ?? join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe');
if (!existsSync(chrome)) throw new Error('Set CHROME_PATH to an installed Chromium browser. No downloads are performed.');
const output = resolve('release/wrap-fixture');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, 'profile-'));
const flags = [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--disable-extensions', '--disable-domain-reliability', '--disable-breakpad',
  '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-features=MediaRouter,OptimizationHints',
  '--window-size=900,800', `--user-data-dir=${profile}`, '--dump-dom',
  `--screenshot=${join(output, 'reading-float-list.png')}`,
  pathToFileURL(resolve('test/fixtures/reading-float-list.html')).href,
];
const result = spawnSync(chrome, flags, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Chromium exited ${result.status}`);
const data = /data-wrap-check="([^"]+)"/.exec(result.stdout)?.[1];
if (!data) throw new Error('No geometry result from the local fixture');
const geometry = JSON.parse(data.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
writeFileSync(join(output, 'geometry.json'), JSON.stringify(geometry, null, 2) + '\n');
for (const check of geometry.checks) {
  if (check.float !== check.direction || !check.nextListFlowRoot || !check.beside || !check.gutterClear || !check.headingClear) {
    throw new Error(`Float/list geometry failed: ${JSON.stringify(check)}`);
  }
}
if (!geometry.narrowCenters) throw new Error('Narrow-note fallback did not center boards');
console.log('PASS offline Chromium: left/right float, following ul/ol, marker gutters, heading clearing, narrow-note fallback');

const previewFlags = flags.slice(0, -3).concat([
  '--dump-dom', `--screenshot=${join(output, 'live-preview-float.png')}`,
  pathToFileURL(resolve('test/fixtures/live-preview-float.html')).href,
]);
const preview = spawnSync(chrome, previewFlags, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
if (preview.error) throw preview.error;
if (preview.status !== 0) throw new Error(`Chromium preview exited ${preview.status}`);
const previewData = /data-wrap-check="([^"]+)"/.exec(preview.stdout)?.[1];
if (!previewData) throw new Error('No geometry result from the local experimental preview fixture');
const previewGeometry = JSON.parse(previewData.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
writeFileSync(join(output, 'preview-geometry.json'), JSON.stringify(previewGeometry, null, 2) + '\n');
if (!previewGeometry.experimentalFloat || !previewGeometry.widgetContents || !previewGeometry.textBeside) {
  throw new Error(`Experimental float CSS failed: ${JSON.stringify(previewGeometry)}`);
}
console.log('PASS offline Chromium: experimental CM-shaped widget uses shipped float CSS and adjacent text flows beside it (no CM6 runtime)');
