import { app } from 'electron';

import { CHANNEL_SCHEMAS } from '@hl/contracts';
import { SystemClock } from '@hl/kernel';

import { createWindow } from './create-window.js';
import { createPingHandler } from '../ipc/handlers/ping.js';
import { installChannelBridge, registerChannel } from '../ipc/register-channel.js';

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
  registerChannel('app/ping', CHANNEL_SCHEMAS['app/ping'], createPingHandler(new SystemClock()));
  installChannelBridge();
  createWindow();
});

// §9: Windows-целевая платформа — «все окна закрыты» = выход приложения;
// macOS-семантика (приложение живо без окон) в MVP не нужна.
app.on('window-all-closed', () => {
  app.quit();
});
