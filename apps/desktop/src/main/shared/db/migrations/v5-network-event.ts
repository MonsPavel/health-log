/**
 * TASK-075 §5/§8: миграция v5 — журнал сети EgressGateway:
 *  - `network_event (id TEXT PK, kind TEXT NOT NULL, endpoint TEXT NOT NULL,
 *    status TEXT NOT NULL, bytes INTEGER NULL, at_utc INTEGER NOT NULL)` +
 *    индекс (kind, at_utc) — DDL дословно арх. 04 §3; аудит AC-4.1 (BG-2 «нулевого
 *    сетевого следа») — проверка одного компонента, журнал честен и про отказы
 *    (§9: blocked-записи тоже в журнале).
 *
 * Статусы — значения домена TASK-075 ('running'/'ok'/'failed'/'blocked'), без CHECK:
 * схема не знает о домене гейтвея (прецедент app_event.kind v4); валидация — в
 * EgressGateway. bytes NULL — blocked-запись или ответ без content-length.
 *
 * События журнала — ТОЛЬКО метаданные (kind/endpoint/status/bytes/at): URL не
 * содержит PHI — эндпоинты CDN моделей/сервера обновлений (§7, правило фиксируется
 * gateway-тестами: в журнал не пишут тела запросов/ответов).
 *
 * Нумерация (§4, лиджер обновлён §5): v2 FTS (045), v3 app_setting (047), v4
 * scales+events (051), v5 network_event — эта задача; v6 ai_summary и v7 chat —
 * будущие задачи P5.
 *
 * Ретеншен 90 дней — TASK-103 (ротация), здесь только индекс (kind, at_utc) —
 * единственный профиль доступа «выборка по kind в порядке времени» (§5/§8).
 *
 * ИНВАРИАНТ НЕИЗМЕНЯЕМОСТИ v1–v4 (§22 TASK-025) соблюдён: схема расширяется
 * НОВОЙ миграцией, существующие таблицы не трогаются.
 *
 * Безопасность (§14): таблица — внутри шифрованной БД; запись — только через
 * EgressGateway (единственная точка сети приложения, D11).
 */
import type { Migration } from '../migration-runner.js';

/**
 * DDL v5 (§5/§8, сверка с арх. 04 §3). Выполняется одним exec внутри транзакции
 * runner'а (DDL в SQLite транзакционен, TASK-024 §13).
 */
const V5_NETWORK_EVENT_DDL_SQL = `
  CREATE TABLE network_event (
    id       TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    status   TEXT NOT NULL,
    bytes    INTEGER NULL,        -- NULL: blocked-запись либо ответ без content-length
    at_utc   INTEGER NOT NULL     -- epoch ms; момент СТАРТА записи (обновляется по завершении)
  );

  CREATE INDEX network_event_kind_at_idx ON network_event (kind, at_utc);
`;

/** Миграция v5 (§2): чистая функция над Database — никаких чтений ФС/сети (§7 TASK-024). */
export const V5_NETWORK_EVENT: Migration = {
  version: 5,
  up: (db) => {
    db.exec(V5_NETWORK_EVENT_DDL_SQL);
  },
};
