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
      // TASK-050 §6: schema-тест схемы/данных живёт в выделенном каталоге test/
      // (вне tsc-сборки пакета; типы теста проверяет корневой tsconfig.json).
      testProject('scales-data', [
        'packages/scales-data/src/**/*.test.ts',
        'packages/scales-data/test/**/*.test.ts',
      ]),
      testProject('desktop-main', ['apps/desktop/src/main/**/*.test.ts']),
      // desktop-renderer: jsdom-проект включён в TASK-009 — обязательный тест хука
      // useHlEvent (§19/§20/§24: отписка при unmount). Минимальная версия заготовки
      // TASK-013; полноценный web-пресет (css, алиасы рендерера) расширяется там.
      testProject('desktop-renderer', ['apps/desktop/src-renderer/**/*.test.ts'], {
        environment: 'jsdom',
      }),
      // TASK-034 §24: тест скрипта аудита размера packaged-артефактов (scripts .mjs,
      // чистые функции + прогон run() на tmp-dist).
      testProject('desktop-scripts', ['apps/desktop/scripts/**/*.test.mjs']),
      // TASK-036 §19: тест скрипта аудита размера установщика (tools/scripts .mjs,
      // чистые расчёты + прогон run()/CLI на tmp-фикстурах).
      testProject('tools-scripts', ['tools/scripts/**/*.test.mjs']),
      // TASK-035 §19: юнит-тесты helpers E2E-слоя (node-окружение: fs/tmp — те же
      // конвенции colocated-тестов, что и в src/main).
      testProject('desktop-e2e', ['apps/desktop/tests/e2e/**/*.test.ts']),
    ],
  },
});
