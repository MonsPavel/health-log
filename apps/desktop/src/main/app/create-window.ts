import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, shell } from 'electron';

import { createWindowOptions } from './create-window-options.js';

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

  // §13: DevTools — только в dev (индикатор dev-режима — наличие ELECTRON_RENDERER_URL).
  if (devServerUrl !== undefined) {
    window.webContents.openDevTools();
  }

  // §13 / арх. 08 §4: навигация окна запрещена; в dev разрешён только сам dev-сервер.
  window.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl !== undefined && url.startsWith(devServerUrl)) {
      return;
    }
    event.preventDefault();
  });

  // §13 / арх. 08 §4: window.open запрещён; внешние ссылки — системный браузер.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl === undefined) {
    // §13: prod — собранные файлы, путь относительно каталога этого модуля
    // (ESM-эквивалент __dirname; dist/main/app/* → ../../dist-renderer/index.html).
    const here = dirname(fileURLToPath(import.meta.url));
    void window.loadFile(join(here, '../../dist-renderer/index.html'));
  } else {
    void window.loadURL(devServerUrl);
  }

  return window;
}
