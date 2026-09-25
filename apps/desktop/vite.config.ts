import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * TASK-007 §5: Vite-сборка рендерера — root src-renderer, outDir dist-renderer.
 *
 * - base: './' — prod загружается через file:// (loadFile), относительные пути ассетов
 *   обязательны (§13);
 * - port 5173 + strictPort — фиксированный порт для скрипта dev (wait-on ждёт именно его, §5);
 * - HMR — штатный dev-сервер Vite (§20, шаг 1);
 * - Electron-Vite-шаблон — референс конфигурации, не форк (§4).
 */
export default defineConfig({
  root: 'src-renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist-renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
