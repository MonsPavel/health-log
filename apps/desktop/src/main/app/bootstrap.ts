import { join } from 'node:path';

import { app, dialog } from 'electron';

import { SystemClock } from '@hl/kernel';

import { createWindow, focusExistingWindow } from './create-window.js';
import { installGlobalErrorHandlers } from './global-errors.js';
import { createSecondInstanceHandler, ensureSingleInstance } from './single-instance.js';
import { buildContainer, type Container } from '../container.js';
import { installChannelBridge } from '../ipc/register-channel.js';
import { createLogger, initFileLogging } from '../shared/logger/logger.js';

/**
 * Инициализация логирования (TASK-010 §9): bootstrap → whenReady → getPath('logs') →
 * createLogger('app'). getPath('logs') при первом обращении сам создаёт каталог по
 * умолчанию (Windows: userData/logs — §5); pino-roll дополнительно получает mkdir.
 * До whenReady вызовы createLogger уходят in-memory буфер и сбрасываются в файл здесь
 * (ранние ошибки старта не теряются). Провал инициализации не роняет приложение —
 * лог остаётся буферизованным, ошибка видна в консоли.
 */
function initAppLogging(): void {
  initFileLogging({
    file: join(app.getPath('logs'), 'hl.log'),
    dev: !app.isPackaged,
    logLevel: process.env['LOG_LEVEL'],
  })
    .then(() => {
      // §13: операция и её исход — без пользовательских данных
      createLogger('app').info('app started', {
        electron: process.versions.electron,
        node: process.versions.node,
        dev: !app.isPackaged,
      });
    })
    .catch((cause: unknown) => {
      console.error('файловый лог недоступен — записи остаются в буфере памяти', cause);
    });
}

/**
 * Безопасный диалог краша main (TASK-011 §9/§22): dialog API работает без окна —
 * краш до создания окна допустим. Текст — константа из global-errors (§14: только
 * code, без message исключения).
 */
function showCrashDialog(text: string): Promise<unknown> {
  return dialog
    .showMessageBox({ type: 'error', title: 'Health Log', buttons: ['OK'], message: text })
    .then(() => undefined);
}

/**
 * TASK-011 §5: глобальные хендлеры uncaughtException/unhandledRejection ставятся на
 * импорте модуля, ДО whenReady — краши старта тоже обязаны быть видны (§2). Логгер
 * до initFileLogging буферизуется (TASK-010 §9) — ранние записи не теряются.
 */
installGlobalErrorHandlers({ logger: createLogger('app'), showDialog: showCrashDialog });

/**
 * TASK-012 §5/§9: single-instance lock ДО whenReady. Лок не получен (второй запуск) →
 * обёртка уже вызвала молчаливый app.quit() (без диалога — фокус получит существующее
 * окно); whenReady не регистрируется — окно не создаётся (§20 п. 2). Получен — по
 * second-instance: info-лог (§9/§18) + восстановление окна restore/show/focus (§10).
 * EC-24 (арх. 07): защита SQLCipher-файла от двух экземпляров — до появления БД.
 */
const gotSingleInstanceLock = ensureSingleInstance(
  createSecondInstanceHandler({ logger: createLogger('app'), focusWindow: focusExistingWindow }),
  app,
);

if (gotSingleInstanceLock) {
  /**
   * Точка входа main-процесса (TASK-007 §9): whenReady → сборка контейнера (TASK-027)
   * → транспортный мост IPC (TASK-008) → createWindow. Контейнер — единственная точка
   * сборки графа зависимостей и регистрации IPC-хендлеров (§5/§11 TASK-027).
   */

  /** Собранный контейнер; если сборка не состоялась — закрывать нечего (§13). */
  let container: Container | undefined;

  // TASK-027 §8: graceful shutdown — WAL-чекпоинт (TRUNCATE) и закрытие БД на выходе:
  // чистое отсутствие -wal/-shm после выхода (NFR-2-гигиена). Сборка не состоялась —
  // close не вызывается (контейнер не создан); повторный will-quit — no-op в close.
  app.on('will-quit', () => {
    container?.close();
  });

  void app.whenReady().then(async () => {
    initAppLogging();
    // TASK-027 §5/§13: реальные зависимости (пути, боевой vault, SystemClock).
    // Init-ошибка (VAULT/*, STORAGE/*) пробрасывается выше → глобальный хендлер
    // TASK-011 (диалог + код, §9 TASK-027).
    container = await buildContainer({
      userDataPath: app.getPath('userData'),
      clock: new SystemClock(),
    });
    // TASK-008 §5: мост `hl:invoke` ставится один раз до создания окна; каналы
    // зарегистрированы в реестре контейнера (TASK-027 §11).
    installChannelBridge(container.channels);
    createWindow();
  });
}

// §9: Windows-целевая платформа — «все окна закрыты» = выход приложения;
// macOS-семантика (приложение живо без окон) в MVP не нужна.
app.on('window-all-closed', () => {
  app.quit();
});
