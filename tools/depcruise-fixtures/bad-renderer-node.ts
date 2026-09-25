/**
 * Фикстура TASK-005 §19: нарушение правила renderer-not-node — импорт Node-билдена
 * из зоны renderer (арх. 08 §4: renderer — недоверенная зона без Node-доступа).
 *
 * Не является частью приложения: в основном прогоне `pnpm depcruise` исключается
 * через .dependency-cruiser-ignore и проверяется только скриптом
 * `pnpm run test:depcruise-rules` (§24: ожидаются нарушения с этим именем правила).
 */
import fs from 'node:fs';

export const rendererViolation = fs;
