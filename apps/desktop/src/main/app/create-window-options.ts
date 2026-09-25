import { join } from 'node:path';

import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * Опции главного окна (TASK-007 §5, §14): 1440×900, минимум 1024×700, заголовок —
 * имя продукта (§16, скринридер-базис; «Health Log» — не переводимый контент, §17).
 *
 * Флаги изоляции — обязательны с первого запуска (арх. 08 §4): рендерер недоверен,
 * не имеет доступа к Node. Чистая функция без запуска Electron — автотест изоляции
 * читает собранный webPreferences (§19, §20.3).
 *
 * preload — пустой contextBridge-мост (namespace `hl`, §11); наполнение — TASK-008.
 */
export function createWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Health Log',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // dist/main/app/* → dist/main/preload.js (компиляция tsconfig.main.json).
      preload: join(__dirname, '../preload.js'),
    },
  };
}
