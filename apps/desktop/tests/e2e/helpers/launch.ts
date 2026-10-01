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

import { _electron, type ElectronApplication, type Page } from '@playwright/test';

/** Корень пакета @hl/desktop (tests/e2e/helpers/* → три уровня вверх → apps/desktop). */
const APP_ROOT = join(fileURLToPath(new URL('../../..', import.meta.url)));

/** Точка входа main-процесса — продукт `tsc -b tsconfig.main.json` (§22). */
const MAIN_ENTRY = join(APP_ROOT, 'dist', 'main', 'app', 'bootstrap.js');

/** Опции launchApp (§5: `{userData}` — единственная точка вариации). */
export interface LaunchAppOptions {
  /** Каталог tmp-userData (fixture mkdtemp) для изоляции данных прогона. */
  readonly userData: string;
  /**
   * TASK-062 §6/§10: bench-режим — запуск с env HL_BENCH=1: main регистрирует
   * test-only канал `__bench/seed` (гард benchChannelsEnabled §14), preload
   * экспонирует performance-хуки `window.hl.__bench`. Без флага — обычный e2e
   * запуск, bench-поверхность отсутствует (проверяется негатив-тестом §20 AC4).
   */
  readonly bench?: boolean;
  /**
   * TASK-078 §5/§20 (AC3): fake-LLM режим — запуск с env HL_FAKE_LLM=1:
   * bootstrap передаёт в контейнер useFakeLlm (гард fakeLlmEnabled — только
   * не-packaged, §14), движок — FakeLlmEngine: детерминированные ответы с
   * префиксом [FAKE] без модели и процессов (e2e-сценарии ИИ-экранов 088/090,
   * §3: без 2–3 ГБ модели в CI).
   */
  readonly fakeLlm?: boolean;
  /**
   * TASK-090 §19/§20: задержка fake-движка между «словами», мс (env
   * HL_FAKE_LLM_DELAY_MS; гард main — только вместе с fakeLlm и не-packaged,
   * §14). Детерминированное окно занятости движка для e2e-эмуляции BUSY.
   */
  readonly fakeLlmDelayMs?: number;
  /**
   * TASK-081 §22/§20 (AC6): TEST-ONLY путь файла «модели» — запуск с env
   * HL_TEST_MODEL_FILE: bootstrap передаёт путь в контейнер (гард
   * testModelFileEnabled — только не-packaged, §14), ai/models/download ставит
   * файл мимо сети (§22: dev-модель с PLACEHOLDER-URL манифеста 079 сетевой
   * путь 080 не проходит). Без опции — обычный запуск.
   */
  readonly testModelFile?: string;
}

/** TASK-062 §10: зеркало результата measureChannel preload.cts (§5 шаг 3). */
export interface BenchChannelMeasure {
  /** Длительность round-trip канала из рендерера, мс (performance.now). */
  readonly ms: number;
  /** Факт ok-конверта (отказ канала делает прогон невалидным). */
  readonly ok: boolean;
}

/** TASK-062 §10: зеркало результата measureRender preload.cts (§5 шаг 4). */
export interface BenchRenderMeasure {
  /** «данные получены → paint завершён» (performance.measure), мс. */
  readonly ms: number;
  /** true — график уже был в DOM (кэш): прогон нечестен, повторить на свежей странице. */
  readonly missed: boolean;
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
 * create-window: без него открылись бы dev-сервер и DevTools). bench:true —
 * добавляется HL_BENCH=1 (§6 TASK-062), fakeLlm:true — HL_FAKE_LLM=1 (§5
 * TASK-078), testModelFile — HL_TEST_MODEL_FILE (§22 TASK-081; поверхности —
 * см. LaunchAppOptions).
 */
export async function launchApp(options: LaunchAppOptions): Promise<ElectronApplication> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['HL_TEST_USER_DATA'] = options.userData;
  if (options.bench === true) {
    env['HL_BENCH'] = '1';
  }
  if (options.fakeLlm === true) {
    env['HL_FAKE_LLM'] = '1';
  }
  if (options.fakeLlmDelayMs !== undefined) {
    env['HL_FAKE_LLM_DELAY_MS'] = String(options.fakeLlmDelayMs);
  }
  if (options.testModelFile !== undefined) {
    env['HL_TEST_MODEL_FILE'] = options.testModelFile;
  }
  delete env['ELECTRON_RENDERER_URL'];

  return _electron.launch({ args: [MAIN_ENTRY], cwd: APP_ROOT, env });
}

/**
 * TASK-062 §6/§10: замер A — время ответа канала из РЕНДЕРЕРА (§5 шаг 3, РЕШЕНИЕ:
 * performance.now() вокруг invoke). Сам замер выполняет window.hl.__bench
 * (isolated-мир preload, §10); хелпер — типизированная обёртка evaluate.
 */
export async function benchMeasureChannel(
  page: Page,
  channel: string,
  payload: unknown,
): Promise<BenchChannelMeasure> {
  return page.evaluate(
    async ({ benchChannel, benchPayload }) => {
      const bridge = (globalThis as BenchHost).hl?.__bench;
      if (bridge === undefined) {
        throw new Error('window.hl.__bench недоступен — приложение запущено без HL_BENCH=1?');
      }
      return bridge.measureChannel(benchChannel, benchPayload);
    },
    { benchChannel: channel, benchPayload: payload },
  );
}

/**
 * TASK-062 §6/§10: замер B — «данные получены → paint завершён» вокруг монтирования
 * РЕАЛЬНОГО графика приложения (§5 шаг 4). hash — маршрут перехода (HashRouter),
 * вызывающий гарантирует, что график ещё не смонтирован (missed-детекция в хуке).
 */
export async function benchMeasureRender(page: Page, hash: string): Promise<BenchRenderMeasure> {
  return page.evaluate((benchHash) => {
    const bridge = (globalThis as BenchHost).hl?.__bench;
    if (bridge === undefined) {
      throw new Error('window.hl.__bench недоступен — приложение запущено без HL_BENCH=1?');
    }
    return bridge.measureRender(benchHash);
  }, hash);
}

/** Локальная форма window.hl.__bench внутри evaluate (страница — не TS-DOM контекст). */
interface BenchBridgeShape {
  measureChannel(channel: string, payload: unknown): Promise<BenchChannelMeasure>;
  measureRender(hash: string): Promise<BenchRenderMeasure>;
}
type BenchHost = { hl?: { __bench?: BenchBridgeShape } } & Record<string, unknown>;

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
