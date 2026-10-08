import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

await rm(dist, { recursive: true, force: true });

const build = spawnSync(process.execPath, [vite, 'build', '--configLoader', 'native'], {
  cwd: root,
  stdio: 'inherit',
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

await mkdir(dist, { recursive: true });
await Promise.all([
  cp(join(root, 'presentation', 'index.html'), join(dist, 'index.html')),
  cp(join(root, 'presentation', 'pitch.css'), join(dist, 'pitch.css')),
  cp(join(root, 'presentation', 'assets'), join(dist, 'assets'), { recursive: true }),
  cp(join(root, 'public', 'manus-routes.json'), join(dist, 'manus-routes.json')),
]);
