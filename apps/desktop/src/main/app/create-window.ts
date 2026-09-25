import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, shell } from 'electron';

import { createWindowOptions } from './create-window-options.js';
import { buildCspPolicy } from './csp.js';
import { isExternalHttpUrl, isNavigationAllowed } from './navigation-guards.js';

/**
 * Открытые окна: ссылки удерживают их от сборщика мусора, пока окно не закрыто
 * (BrowserWindow, на который нет ссылок, закрывается GC).
 */
const openWindows = new Set<BrowserWindow>();

/**
 * Главное окно (TASK-007): опции и флаги изоляции — createWindowOptions() (§5, §19);
 * dev — loadURL с ELECTRON_RENDERER_URL, иначе loadFile из dist-renderer (§13);
 * навигация и window.open отключены, DevTools — только в dev (§13, арх. 08 §4).
 */
export function createWindow(): BrowserWindow {
  const window = new BrowserWindow(createWindowOptions());
  openWindows.add(window);
  window.on('closed', () => {
    openWindows.delete(window);
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];

  // §6/§14, арх. 08 §4: CSP-заголовок на каждый ответ окна — default-src 'self';
  // в dev «+ разрешение vite-хоста» (origin + inline-preamble react-refresh + ws://
  // для HMR; послабление только в dev — §22). Решение §6: заголовок в
  // onHeadersReceived, а не meta-тег (проверка приёмки §20 — Network → headers).
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildCspPolicy(devServerUrl)],
      },
    });
  });

  // §13: DevTools — только в dev (индикатор dev-режима — наличие ELECTRON_RENDERER_URL).
  if (devServerUrl !== undefined) {
    window.webContents.openDevTools();
  }

  // §13 / арх. 08 §4: навигация окна запрещена; в dev разрешён только origin
  // dev-сервера — сравнение origin, не префикса (ревью task/TASK-007: префикс
  // пропускал http://127.0.0.1:5183.evil.test/ и userinfo-обход 5183@evil.test).
  window.webContents.on('will-navigate', (event, url) => {
    if (!isNavigationAllowed(url, devServerUrl)) {
      event.preventDefault();
    }
  });

  // §13 / арх. 08 §4: window.open запрещён; наружу (системный браузер) уходят только
  // http/https-URL — протокол из недоверенного рендерера валидируется (file:,
  // ms-msdt:, search-ms: и прочие протоколы ОС наружу не передаются).
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (devServerUrl === undefined) {
    // §13: prod — собранные файлы, путь относительно каталога этого модуля
    // (ESM-эквивалент __dirname; dist/main/app/* → ../../../dist-renderer/index.html).
    const here = dirname(fileURLToPath(import.meta.url));
    void window.loadFile(join(here, '../../../dist-renderer/index.html'));
  } else {
    void window.loadURL(devServerUrl);
  }

  return window;
}

/**
 * Окно-подобный минимум для восстановления фокуса (§19: fake-окно в тестах);
 * BrowserWindow структурно совместим.
 */
export interface FocusableWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Последнее созданное открытое окно (Set хранит порядок вставки; в MVP окно одно). */
function lastOpenWindow(): FocusableWindow | undefined {
  return [...openWindows].at(-1);
}

/**
 * Восстановление существующего окна при повторном запуске (TASK-012 §5/§10): свёрнутое
 * — restore; затем show (возвращает из скрытого состояния — «закрытое» окно §20, трея
 * в MVP нет) и focus. Окон нет — no-op: на Windows «все окна закрыты» уже уводит
 * приложение в quit (window-all-closed, bootstrap). Вызывается обработчиком
 * second-instance (single-instance.ts).
 */
export function focusExistingWindow(
  window: FocusableWindow | undefined = lastOpenWindow(),
): void {
  if (window === undefined) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}
