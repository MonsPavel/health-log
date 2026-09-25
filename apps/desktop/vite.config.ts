import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * TASK-007 §5: Vite-сборка рендерера — root src-renderer, outDir dist-renderer.
 *
 * - base: './' — prod загружается через file:// (loadFile), относительные пути ассетов
 *   обязательны (§13);
 * - host 127.0.0.1 + port 5183 + strictPort — детерминированная точка входа для скрипта
 *   dev (wait-on ждёт именно её, ELECTRON_RENDERER_URL указывает на 127.0.0.1, а не
 *   localhost — исключает расхождение IPv4/IPv6; конфликт порта = громкое падение,
 *   а не тихая загрузка чужого dev-сервера);
 * - HMR — штатный dev-сервер Vite (§20, шаг 1);
 * - tailwindcss — TASK-013: плагин Tailwind v4, вход @import 'tailwindcss' в
 *   app/theme/theme.css (§6);
 * - Electron-Vite-шаблон — референс конфигурации, не форк (§4).
 */
export default defineConfig({
  root: 'src-renderer',
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist-renderer',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5183,
    strictPort: true,
  },
});
