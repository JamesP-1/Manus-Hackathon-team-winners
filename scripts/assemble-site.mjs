// Assemble the public site: the pitch page at "/" and the navigator app at "/app/".
// Run after `vite build --base /app/ --outDir dist/app` (see "build:site" in package.json).
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pitch = join(root, 'presentation');

if (!existsSync(join(dist, 'app', 'index.html'))) {
  console.error('dist/app/index.html is missing: run the Vite build with --base /app/ --outDir dist/app first.');
  process.exit(1);
}

mkdirSync(dist, { recursive: true });
cpSync(join(pitch, 'pitch.css'), join(dist, 'pitch.css'));
cpSync(join(pitch, 'assets'), join(dist, 'assets'), { recursive: true });

// The pitch page links to the dev server locally; on the assembled site the app lives at /app/.
const html = readFileSync(join(pitch, 'index.html'), 'utf8').replace(/href="http:\/\/localhost:5173\/?"/g, 'href="/app/"');
writeFileSync(join(dist, 'index.html'), html);

console.log('Site assembled: dist/index.html (pitch) + dist/app/ (navigator).');
