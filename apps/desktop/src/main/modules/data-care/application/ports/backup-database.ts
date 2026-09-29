/**
 * TASK-070 §5: порт доступа use case'а копии к открытой БД — минимальная структурная
 * поверхность (прецедент BpMeasurementRepository TASK-021: application не импортирует
 * адаптеры/shared; реальное соединение EncryptedDatabase удовлетворяет структурно).
 *
 * Поверхность — ровно то, что нужно снапшоту (§5):
 *  - exec — VACUUM INTO (консистентный снимок WAL-БД без остановки записи, §4);
 *  - prepare().get() — чтение meta.schema_version и COUNT(*) измерений (§5/§15).
 */
export interface BackupStatement {
  /** Однострочный SELECT (meta/счётчики); значение приводит вызыватель. */
  get(): unknown;
}

export interface BackupDatabase {
  /** Выполнение SQL без результата (VACUUM INTO 'путь'). */
  exec(sql: string): void;
  /** Подготовка запроса (meta.schema_version, COUNT). */
  prepare(sql: string): BackupStatement;
}
