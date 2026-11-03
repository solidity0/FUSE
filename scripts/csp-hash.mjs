// Re-pins index.html's inline <script> in its Content-Security-Policy. The browser refuses to
// run that script unless its sha256 matches, so run this after every edit to it:
//   npm run csp            (rewrites the hash)
//   npm run csp -- --check (exits 1 if the hash is stale — for CI / pre-commit)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = new URL('../index.html', import.meta.url);
const html = readFileSync(file, 'utf8');

const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (inline.length !== 1) throw new Error(`expected exactly one inline <script>, found ${inline.length}`);
// Browsers hash the script text after normalising line endings to \n.
const body = inline[0][1].replace(/\r\n?/g, '\n');
const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

const cspRe = /script-src '(sha256-[^']*)'/;
const current = html.match(cspRe);
if (!current) throw new Error("no script-src 'sha256-…' found in the CSP meta tag");

if (`'${current[1]}'` === hash) {
  console.log('CSP script hash is up to date:', hash);
} else if (process.argv.includes('--check')) {
  console.error(`CSP script hash is stale — run "npm run csp".\n  in file: '${current[1]}'\n  actual:  ${hash}`);
  process.exit(1);
} else {
  writeFileSync(file, html.replace(cspRe, `script-src ${hash}`));
  console.log('CSP script hash updated:', hash);
}
