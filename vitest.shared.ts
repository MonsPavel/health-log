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
 */
const workspaceAliases = {
  '@hl/kernel': fileURLToPath(new URL('./packages/kernel/src/index.ts', import.meta.url)),
  '@hl/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
};

/** Общие настройки каждого тестового проекта монорепо (§5, §13). */
export const sharedTestConfig: ProjectTestConfig = {
  environment: 'node',
  setupFiles,
  // Примечание: passWithNoTests («0 тестов — не ошибка», §20.1) объявлен на root-уровне
  // vitest.config.ts — глобальную проверку «No test files found» проектные настройки не покрывают.
};

/** Опции проекта поверх общих настроек (TASK-009): окружение рендерер-тестов. */
export interface TestProjectOptions {
  /** TASK-009: jsdom для React-хуков (Testing Library); по умолчанию node (§13). */
  readonly environment?: 'node' | 'jsdom';
}

/** Фабрика тестового проекта: имя (для `vitest --project`) и include-паттерны поверх общих настроек. */
export function testProject(
  name: string,
  include: string[],
  options: TestProjectOptions = {},
): UserWorkspaceConfig {
  return {
    resolve: { alias: workspaceAliases },
    test: { ...sharedTestConfig, name, include, environment: options.environment ?? 'node' },
  };
}
