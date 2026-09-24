/**
 * TASK-004: Vitest — единый тест-рантайм всех пакетов монорепо.
 *
 * Vitest 5: проекты объявляются в root-конфиге через `test.projects`; файл
 * vitest.workspace.ts удалён начиная с Vitest 4 — конфигурация следует документации
 * установленной мажорной версии (§22, мажор зафиксирован в lockfile).
 *
 * Покрытие (§5, §18): provider v8, merged-отчёт по всему workspace (text в консоль +
 * lcov в coverage/, только локальный артефакт). Пороги покрытия — TODO(TASK-052):
 * 90% (NFR-10) включаются, когда есть что мерить — домен аналитики; до тех пор
 * coverage — отчёт без гейта.
 */
import { defineConfig } from 'vitest/config';

import { testProject } from './vitest.shared.js';

export default defineConfig({
  test: {
    // §20.1: 0 тестов — не ошибка. Уровень root важен: решение «No test files found»
    // принимается по root-конфигу (проектный passWithNoTests его не покрывает).
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'apps/desktop/src/main/**'],
      // thresholds: TODO(TASK-052) — порог 90% (NFR-10) для домена аналитики.
    },
    projects: [
      testProject('kernel', ['packages/kernel/src/**/*.test.ts']),
      testProject('contracts', ['packages/contracts/src/**/*.test.ts']),
      testProject('scales-data', ['packages/scales-data/src/**/*.test.ts']),
      testProject('desktop-main', ['apps/desktop/src/main/**/*.test.ts']),
      // desktop-renderer включается в TASK-013 (jsdom + web-пресет) — заготовка:
      // testProject('desktop-renderer', ['apps/desktop/src-renderer/**/*.test.ts']),
    ],
  },
});
