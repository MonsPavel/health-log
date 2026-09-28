// Сборка спайка: bundle приложения с библиотекой + baseline (только react/react-dom).
// Размер gzip считается zlib-ом на максимальной степени сжатия.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
};

await build({ ...common, entryPoints: ['src/main.tsx'], outfile: 'dist/bundle.js' });
await build({ ...common, entryPoints: ['src/baseline.tsx'], outfile: 'dist/baseline.js' });

for (const name of ['bundle.js', 'baseline.js']) {
  const raw = readFileSync(`dist/${name}`);
  const gz = gzipSync(raw, { level: 9 });
  writeFileSync(`dist/${name}.gz.bytes`, String(gz.length));
  console.log(`${name}: ${raw.length} B raw, ${gz.length} B gzip`);
}
