import { readFileSync } from 'node:fs';

const source = readFileSync('main.js', 'utf8');
const checks = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['requestUrl(', /\brequestUrl\s*\(/],
  ['WebSocket', /WebSocket/],
  ['eval(', /\beval\s*\(/],
  ['new Function', /\bnew\s+Function\b/],
  ['localhost', /localhost/i],
  ['personal paths', /(?:[A-Z]:[/\\]+(?:Users|AI|ObsidianVaults|Recovery_Backups)|Tania|\/Users\/|\/home\/)/i],
  ['dev-only drag harness', /playwright|chromium\.launch|cm-drag|legacy-controls|ChangeSet|StateField|Decoration\.set/],
];
let failed = false;
for (const [name, pattern] of checks) {
  const found = pattern.test(source);
  console.log(`${found ? 'FAIL' : 'PASS'} ${name}`);
  failed ||= found;
}
process.exitCode = failed ? 1 : 0;
