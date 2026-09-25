import { join } from 'node:path';

import { app } from 'electron';

import { CHANNEL_SCHEMAS } from '@hl/contracts';
import { SystemClock } from '@hl/kernel';

import { createWindow } from './create-window.js';
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
  installChannelBridge();
  createWindow();
});

// §9: Windows-целевая платформа — «все окна закрыты» = выход приложения;
// macOS-семантика (приложение живо без окон) в MVP не нужна.
app.on('window-all-closed', () => {
  app.quit();
});
