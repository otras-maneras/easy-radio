import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
await build({ entryPoints: ['public/app.ts'], bundle: true, minify: true, sourcemap: true, outfile: 'dist/public/app.js', target: 'es2022' });
for (const file of ['index.html', 'styles.css']) await copyFile(`public/${file}`, `dist/public/${file}`);
