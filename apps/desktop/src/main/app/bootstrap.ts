import { join } from 'node:path';

import { app, dialog } from 'electron';

import { CHANNEL_SCHEMAS } from '@hl/contracts';
import { SystemClock } from '@hl/kernel';

import { createWindow } from './create-window.js';
import { createLogClientErrorHandler, installGlobalErrorHandlers } from './global-errors.js';
import { createPingHandler } from '../ipc/handlers/ping.js';
import { installChannelBridge, registerChannel } from '../ipc/register-channel.js';
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
 * Точка входа main-процесса (TASK-007 §9): whenReady → каналы IPC (TASK-008 §5) →
 * createWindow. Регистрация каналов — только через registerChannel каркаса (§9),
 * транспортный мост `hl:invoke` ставится один раз до создания окна.
 *
 * Single-instance lock: точка расширения зарезервирована здесь (§9) — фактическая
 * логика (app.requestSingleInstanceLock, quit второй копии, обработка second-instance)
 * включается в TASK-012, вызов размещается в этом файле.
 * TODO(TASK-012): app.requestSingleInstanceLock() — здесь.
 */
void app.whenReady().then(() => {
  initAppLogging();
  registerChannel('app/ping', CHANNEL_SCHEMAS['app/ping'], createPingHandler(new SystemClock()));
  // TASK-011 §9: клиентский отчёт об ошибке — fire-and-forget, response null.
  registerChannel(
    'app/log-client-error',
    CHANNEL_SCHEMAS['app/log-client-error'],
    createLogClientErrorHandler(createLogger('app')),
  );
  installChannelBridge();
  createWindow();
});

// §9: Windows-целевая платформа — «все окна закрыты» = выход приложения;
// macOS-семантика (приложение живо без окон) в MVP не нужна.
app.on('window-all-closed', () => {
  app.quit();
});
