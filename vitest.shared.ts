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

/** Общие настройки каждого тестового проекта монорепо (§5, §13). */
export const sharedTestConfig: ProjectTestConfig = {
  environment: 'node',
  setupFiles,
  // §20.1: 0 тестов — не ошибка: проект без подходящих файлов пропускается, а не роняет прогон.
  passWithNoTests: true,
};

/** Фабрика тестового проекта: имя (для `vitest --project`) и include-паттерны поверх общих настроек. */
export function testProject(name: string, include: string[]): UserWorkspaceConfig {
  return { test: { ...sharedTestConfig, name, include } };
}
