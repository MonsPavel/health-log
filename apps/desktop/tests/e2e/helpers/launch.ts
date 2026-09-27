/**
 * TASK-035 §5: helper запуска приложения для E2E — Playwright `_electron.launch`
 * (официальный способ, §4) собранного main-entry (dist/main/app/bootstrap.js)
 * с env HL_TEST_USER_DATA=<tmp>. Bootstrap (TASK-035) подставляет её в контейнер:
 * зашифрованная БД и vault.key живут в tmp-userData fixture, реальные данные
 * пользователя не затронуты (§20 п. 3).
 *
 * Двойной запуск в одном прогоне (§22): закрытие — graceful `app.quit()` из
 * firstInstance (will-quit → container.close(): WAL-чекпоинт, §8 TASK-027) с
 * ожиданием exit-события процесса; second launch не упрётся в single-instance lock.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron, type ElectronApplication } from '@playwright/test';

/** Корень пакета @hl/desktop (tests/e2e/helpers/* → три уровня вверх → apps/desktop). */
const APP_ROOT = join(fileURLToPath(new URL('../../..', import.meta.url)));

/** Точка входа main-процесса — продукт `tsc -b tsconfig.main.json` (§22). */
const MAIN_ENTRY = join(APP_ROOT, 'dist', 'main', 'app', 'bootstrap.js');

/** Опции launchApp (§5: `{userData}` — единственная точка вариации). */
export interface LaunchAppOptions {
  /** Каталог tmp-userData (fixture mkdtemp) для изоляции данных прогона. */
  readonly userData: string;
}

/**
 * Каталог main-логов приложения при e2e-запуске (эмпирика TASK-035): raw-file entry
 * (`electron dist/main/app/bootstrap.js`) — имя приложения «Electron», логи pino-roll
 * пишутся в %APPDATA%/Electron/logs (hl.1.log — активный), НЕ в tmp-userData. Файл
 * общий для всех прогонов и перезаписывается — дамп diagnostics при падении забирает
 * его ДО следующего запуска (§19: падение = расследование).
 */
export function mainProcessLogsDir(): string {
  return join(process.env['APPDATA'] ?? '', 'Electron', 'logs');
}

/**
 * Запускает приложение с изолированным userData. env копируется из process.env
 * (_electron.launch заменяет окружение целиком), HL_TEST_USER_DATA добавляется,
 * ELECTRON_RENDERER_URL удаляется — окно грузит собранный dist-renderer (§13
 * create-window: без него открылись бы dev-сервер и DevTools).
 */
export async function launchApp(options: LaunchAppOptions): Promise<ElectronApplication> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['HL_TEST_USER_DATA'] = options.userData;
  delete env['ELECTRON_RENDERER_URL'];

  return _electron.launch({ args: [MAIN_ENTRY], cwd: APP_ROOT, env });
}

/**
 * Graceful закрытие (§22): подписка на exit ДО app.quit() — событие не пропустить;
 * уже завершённый процесс — no-op (повторный вызов из fixture-страховки безвреден).
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const process = app.process();
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    process.once('exit', () => resolve());
  });
  await app.evaluate(({ app: electronApp }) => {
    electronApp.quit();
  });
  await exited;
}
