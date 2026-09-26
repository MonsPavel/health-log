/**
 * Локальные типы better-sqlite3-multiple-ciphers@13.0.3 (§6; мажор зафиксирован
 * в package.json — §22): пакет поставляет index.d.ts, но exports-map v13.0.3 не
 * содержит условия types (исправлено апстримом в 13.0.4) — NodeNext-резолв даёт
 * TS7016. Шим переиспользует @types/better-sqlite3 (форк — надмножество API
 * better-sqlite3; собственные типы форка — те же DT-определения). Подключается
 * тройным слэшем из sqlite.ts — оба tsconfig-проекта получают типы без правок
 * конфигураций (прецедент — pino-roll.d.ts, TASK-010).
 *
 * TODO(TASK-105+): удалить шим при обновлении пресета до ≥13.0.4.
 */
declare module 'better-sqlite3-multiple-ciphers' {
  // export= — семантика реального модуля (CJS, module.exports = Database): форма
  // `import x = require()` несёт и ЗНАЧЕНИЕ, и типы; type-only вариант роняет
  // value-import в sqlite.ts под verbatimModuleSyntax (TS1361).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  import BetterSqlite3 = require('better-sqlite3');

  export = BetterSqlite3;
}
