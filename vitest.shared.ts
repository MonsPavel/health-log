/**
 * TASK-004: общие настройки тестовых проектов Vitest.
 *
 * Конвенции (§19): colocated tests `*.test.ts` рядом с кодом; интеграционные помечаются
 * `*.int.test.ts` — они попадают в общий include, а выборочно запускаются фильтром по имени
 * (например, `pnpm exec vitest run *.int.test.ts`); fixture-каталоги `__fixtures__/` — рядом.
 *
 * Окружение — node (юниты чистых слоёв, интеграционные с tmp-файлами). jsdom-проект
 * рендерера добавляется в TASK-013 отдельным проектом, а не здесь.
 */
import { fileURLToPath } from 'node:url';

import type { UserWorkspaceConfig } from 'vitest/config';

/** Настройки test-блока проекта Vitest. */
type ProjectTestConfig = NonNullable<UserWorkspaceConfig['test']>;

/** Абсолютный путь setup-хука: проекты резолвят setupFiles от своего root — фиксируем от корня монорепо. */
const setupFiles = [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))];

/**
 * TASK-008: алиасы workspace-пакетов на исходники — тесты main-процесса desktop
 * (register-channel и далее) импортируют @hl/kernel и @hl/contracts по имени, и
 * без алиаса vitest резолвил бы их через dist (сборка перед pnpm test). Тесты
 * герметичны от порядка сборки: pnpm test работает на свежем checkout.
 * TASK-051: @hl/scales-data — данные шкалы (потребитель ScaleService) — тем же
 * способом, на исходники (без предварительной сборки пакета).
 */
const workspaceAliases = {
  '@hl/kernel': fileURLToPath(new URL('./packages/kernel/src/index.ts', import.meta.url)),
  '@hl/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
  '@hl/scales-data': fileURLToPath(new URL('./packages/scales-data/src/index.ts', import.meta.url)),
};

/** Общие настройки каждого тестового проекта монорепо (§5, §13). */
export const sharedTestConfig: ProjectTestConfig = {
  environment: 'node',
  setupFiles,
  /**
   * Урок прогонов 3/5 живой приёмки TASK-105 §20: дефолтный testTimeout 5 с
   * калиброван под dev-машину — на windows-runner под полной загрузкой пулов
   * тяжёлые int-тесты (полная сборка контейнера + tmp-БД) изредка не укладываются,
   * причём каждый прогон трясёт разных (run 3: router/container-ландмарк —
   * починено asyncUtilTimeout/CI-бюджетом; run 5: ai-summary (3b), search
   * VALIDATION — оба «Test timed out in 5000ms»). На CI порог 20 с — детект
   * зависаний сохранён; локальный быстрый фейл остаётся 5 с. Явные бюджеты
   * §15 не затронуты: они ассертятся performance.now() (container.int.test,
   * pdf.render ≤30 с) и не зависят от testTimeout.
   */
  testTimeout: process.env.CI === 'true' ? 20_000 : 5_000,
  // Примечание: passWithNoTests («0 тестов — не ошибка», §20.1) объявлен на root-уровне
  // vitest.config.ts — глобальную проверку «No test files found» проектные настройки не покрывают.
};

/** Опции проекта поверх общих настроек (TASK-009): окружение рендерер-тестов. */
export interface TestProjectOptions {
  /** TASK-009: jsdom для React-хуков (Testing Library); по умолчанию node (§13). */
  readonly environment?: 'node' | 'jsdom';
  /**
   * TASK-085 (гейт pnpm test): последовательное исполнение файлов проекта —
   * для тяжёлых проектов, чьи wall-clock ассерты иначе не выполняются под
   * CPU-конкуренцией пулов ДРУГИХ проектов (проектные конфиги НЕ наследуют
   * pool-опции root — эксперимент: root maxWorkers:1 → 122 воркера
   * desktop-main; кап в shared тоже недостаточен — пулы у проектов свои):
   * desktop-main — pdf.render 5k ≤30 с (TASK-067 §9 = SRS 05 §15; ~22 с на
   * простаивающей машине, workerpool pdf — отдельный процесс), desktop-renderer —
   * 79 jsdom-окружений (~96 с суммарно) будят первые findBy-монтирования
   * (таймаут 1 с). Ассерты и таймауты тестов при этом не менялись.
   */
  readonly fileParallelism?: boolean;
  /**
   * TASK-105 §20 (урок прогона 3 живой приёмки): дополнительные setup-файлы
   * проекта поверх общего vitest.setup.ts — например, калибровка asyncUtilTimeout
   * Testing Library для jsdom-проекта рендерера (дефолтная 1 с findBy не
   * выдерживает первые монтирования под полной загрузкой windows-runner'а).
   */
  readonly extraSetupFiles?: readonly string[];
}

/** Фабрика тестового проекта: имя (для `vitest --project`) и include-паттерны поверх общих настроек. */
export function testProject(
  name: string,
  include: string[],
  options: TestProjectOptions = {},
): UserWorkspaceConfig {
  return {
    resolve: { alias: workspaceAliases },
    test: {
      ...sharedTestConfig,
      name,
      include,
      environment: options.environment ?? 'node',
      ...(options.extraSetupFiles === undefined
        ? {}
        : { setupFiles: [...setupFiles, ...options.extraSetupFiles] }),
      ...(options.fileParallelism === undefined
        ? {}
        : { fileParallelism: options.fileParallelism }),
    },
  };
}
