/**
 * TASK-035 §5: конфигурация Playwright для E2E-слоя (арх. 10 §1).
 *
 * Запуск — dev-сборка main (не packaged — быстрое обнаружение, §4): `pnpm test:e2e`
 * сначала собирает main+renderer (§22: сценарий требует предварительной сборки),
 * затем Playwright стартует Electron через _electron.launch с tmp-userData
 * (helpers/launch.ts + критический путь critical-path.spec.ts).
 *
 * workers 1 — Electron-глобальное состояние (single-instance lock, %APPDATA%/Electron),
 * детерминизм важнее скорости (§5/§15). retries 0 — flake-политика §19: падение =
 * расследование, а не retry-маскировка. Трейсы на падения — будущая работа §23.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  /** Только сценарии (.spec.ts): юнит-тесты helpers (*.test.ts) — слой Vitest
   *  (проект desktop-e2e корневого конфига), Playwright их не запускает. */
  testMatch: '**/*.spec.ts',
  /** §5: 30 с на тест (два запуска приложения в сценарии персистентности). */
  timeout: 30_000,
  /** §5/§15: Electron-глобальное состояние — параллельность запрещена. */
  workers: 1,
  fullyParallel: false,
  /** §19: ретраи только на инфраструктурные таймауты запуска — их нет по умолчанию. */
  retries: 0,
  /** §5: единственный проект E2E-слоя. */
  projects: [{ name: 'e2e-electron' }],
});
