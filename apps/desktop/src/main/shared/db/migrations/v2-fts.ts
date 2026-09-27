/**
 * TASK-045 §5/§8: миграция v2 — FTS-поиск по заметкам. FTS5-виртуальная таблица
 * bp_measurement_fts на ВНЕШНЕМ содержимом (content='bp_measurement',
 * content_rowid='rowid' — арх. 04 §6): индекс без дублирования текста; синхронизация
 * — 3 триггера AFTER INSERT/UPDATE/DELETE на bp_measurement (каноническая схема
 * external-content FTS5, §8: insert → добавить строку; delete → 'delete'-команда со
 * СТАРЫМИ значениями; update → 'delete' старой + вставка новой). DDL-источник —
 * арх. 04 §6.
 *
 * ИНВАРИАНТ НЕИЗМЕНЯЕМОСТИ v1 (§22 TASK-025) соблюдён: схема расширяется НОВОЙ
 * миграцией, bp_measurement не меняется — триггеры только читают old/new.
 *
 * ОГРАНИЧЕНИЕ (TD-IMP-3, §4): FTS5 unicode61 без русской морфологии — токены точные;
 * подстроки/словоформы даёт LIKE-fallback адаптера поиска (§13), не индекс.
 *
 * Backfill (§5/§8): INSERT … SELECT копирует заметки существующих записей в индекс —
 * апгрейд существующей БД v1→v2 видит старые заметки. Идемпотентность backfill'а и
 * repair-механика (§8): команда 'rebuild' (rebuildFtsIndex ниже) пересобирает индекс
 * из content-таблицы с нуля — ею же чинится рассинхрон.
 *
 * NULL-заметки безопасны: FTS5 не токенизирует NULL (нет ни вставки, ни удаления).
 *
 * Риск §22 закрыт пробной загрузкой перед задачей: FTS5 скомпилирован в пресете
 * better-sqlite3-multiple-ciphers@13.0.3 (CREATE VIRTUAL TABLE … fts5 проходит,
 * MATCH работает, кириллица токенизируется unicode61) — LIKE-only fallback (§22)
 * НЕ нужен.
 */
import type { Migration } from '../migration-runner.js';

/**
 * DDL v2 (§8, сверка с арх. 04 §6): внешнее содержимое — bp_measurement, ключ
 * rowid (TEXT PRIMARY KEY v1 не отменяет неявный rowid таблицы). Выполняется одним
 * exec внутри транзакции runner'а (DDL в SQLite транзакционен, TASK-024 §13).
 */
const V2_FTS_DDL_SQL = `
  CREATE VIRTUAL TABLE bp_measurement_fts USING fts5(
    note,
    content='bp_measurement',
    content_rowid='rowid'
  );

  CREATE TRIGGER bp_measurement_fts_ai AFTER INSERT ON bp_measurement BEGIN
    INSERT INTO bp_measurement_fts(rowid, note) VALUES (new.rowid, new.note);
  END;

  CREATE TRIGGER bp_measurement_fts_ad AFTER DELETE ON bp_measurement BEGIN
    INSERT INTO bp_measurement_fts(bp_measurement_fts, rowid, note)
      VALUES ('delete', old.rowid, old.note);
  END;

  CREATE TRIGGER bp_measurement_fts_au AFTER UPDATE ON bp_measurement BEGIN
    INSERT INTO bp_measurement_fts(bp_measurement_fts, rowid, note)
      VALUES ('delete', old.rowid, old.note);
    INSERT INTO bp_measurement_fts(rowid, note) VALUES (new.rowid, new.note);
  END;
`;

/**
 * Backfill (§5/§8): индексирование заметок, существовавших до v2. Тот же INSERT
 * выполняет и repair-команда 'rebuild' — этот SELECT идемпотентен по построению
 * (миграция применяется runner'ом ровно один раз).
 */
const V2_FTS_BACKFILL_SQL =
  'INSERT INTO bp_measurement_fts(rowid, note) SELECT rowid, note FROM bp_measurement';

/**
 * Миграция v2 (§2): FTS-таблица + триггеры + backfill. Чистая функция над Database —
 * никаких чтений ФС/сети (§7 TASK-024).
 */
export const V2_FTS_NOTES: Migration = {
  version: 2,
  up: (db) => {
    db.exec(V2_FTS_DDL_SQL);
    db.exec(V2_FTS_BACKFILL_SQL);
  },
};

/**
 * Repair (§8): пересборка FTS-индекса из content-таблицы ('rebuild'). Идемпотентна —
 * индекс строится с нуля; используется при рассинхроне (будущая работа: вызов при
 * старте/диагностике). Отдельная функция — чтобы SQL 'rebuild' не дублировался.
 */
export function rebuildFtsIndex(db: Parameters<Migration['up']>[0]): void {
  db.prepare("INSERT INTO bp_measurement_fts(bp_measurement_fts) VALUES('rebuild')").run();
}
