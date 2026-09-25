import { app } from 'electron';

import { createWindow } from './create-window.js';

/**
 * Точка входа main-процесса (TASK-007 §9): whenReady → createWindow.
 *
 * Single-instance lock: точка расширения зарезервирована здесь (§9) — фактическая
 * логика (app.requestSingleInstanceLock, quit второй копии, обработка second-instance)
 * включается в TASK-012, вызов размещается в этом файле.
 * TODO(TASK-012): app.requestSingleInstanceLock() — здесь.
 */
void app.whenReady().then(() => {
  createWindow();
});

// §9: Windows-целевая платформа — «все окна закрыты» = выход приложения;
// macOS-семантика (приложение живо без окон) в MVP не нужна.
app.on('window-all-closed', () => {
  app.quit();
});
