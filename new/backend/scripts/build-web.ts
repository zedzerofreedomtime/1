import fs from 'fs';
import path from 'path';
import { build } from 'esbuild';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const webRoot = path.join(root, 'frontend');
const outDir = path.join(webRoot, 'dist');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });

await build({
  entryPoints: [path.join(webRoot, 'src', 'main.tsx')],
  outfile: path.join(outDir, 'assets', 'app.js'),
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'browser',
  target: ['chrome110'],
  jsx: 'automatic',
  loader: { '.tsx': 'tsx' },
});

fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html>
<html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#08111d"><title>ClipBot Flow</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>\n`);
console.log(`Built web app: ${outDir}`);
