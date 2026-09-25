/**
 * Фикстура TASK-005 §19: нарушение правила module-public-api — импорт внутренностей
 * чужого модуля минуя его публичный index.ts (арх. 03 §1/§2: межмодульно — только index).
 *
 * Не является частью приложения: в основном прогоне `pnpm depcruise` исключается
 * через .dependency-cruiser-ignore и проверяется только скриптом
 * `pnpm run test:depcruise-rules` (§24: ожидаются нарушения с этим именем правила).
 */
import { betaInternal } from './fixture-module-beta/internal.js';

export const crossModuleViolation = betaInternal;
