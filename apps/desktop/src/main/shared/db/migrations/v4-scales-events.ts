/**
 * TASK-051 §5/§8: миграция v4 — справочные шкалы и локальный журнал аналитики:
 *  - `reference_scale (id TEXT PK, code TEXT NOT NULL, version TEXT NOT NULL,
 *    source_label TEXT NOT NULL, data_json TEXT NOT NULL, activated_at_utc
 *    INTEGER NULL, UNIQUE(code, version))` — версионируемые данные шкал
 *    (арх. 04 §3; данные пакета @hl/scales-data TASK-050 активирует ScaleService);
 *  - `app_event (id TEXT PK, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
 *    at_utc INTEGER NOT NULL)` + индекс (kind, at_utc) — локальный журнал
 *    аналитики (арх. 09 §9). Консолидация в ОДНОЙ миграции — осознанное решение
 *    §4: у app_event нет собственного потребителя до P6 (TASK-103), выделенная
 *    «миграция ради таблицы» плодила бы техническую версию; потребитель обязан
 *    проверить наличие таблицы (§22, пункт в заметках TASK-103).
 *
 * UNIQUE(code, version) (§8) — защита от дублей при повторной активации.
 * activated_at_utc NULL: активность записи определяется по max activated_at_utc
 * на code (§13, правило фиксируется сервисом); история версий хранится с
 * проставленным моментом активации, обнуление не производится.
 *
 * Нумерация (§4, лиджер): v2 FTS (045), v3 app_setting (047), v4 — эта задача.
 *
 * ИНВАРИАНТ НЕИЗМЕНЯЕМОСТИ v1/v2/v3 (§22 TASK-025) соблюдён: схема расширяется
 * НОВОЙ миграцией, существующие таблицы не трогаются.
 *
 * Безопасность (§14): данные из комплекта приложения (пакет TASK-050, без
 * пользовательского ввода); таблицы — внутри шифрованной БД.
 */
import type { Migration } from '../migration-runner.js';

/**
 * DDL v4 (§5/§8, сверка с арх. 04 §3 и арх. 09 §9). Выполняется одним exec внутри
 * транзакции runner'а (DDL в SQLite транзакционен, TASK-024 §13). Индекс — единственный
 * профиль доступа app_event «выборка по kind в порядке времени» (§5).
 */
const V4_SCALES_EVENTS_DDL_SQL = `
  CREATE TABLE reference_scale (
    id               TEXT PRIMARY KEY,
    code             TEXT NOT NULL,
    version          TEXT NOT NULL,
    source_label     TEXT NOT NULL,
    data_json        TEXT NOT NULL,     -- файл данных шкалы (форма ScaleData пакета @hl/scales-data)
    activated_at_utc INTEGER NULL,      -- epoch ms; NULL — запись ожидает активации
    UNIQUE (code, version)              -- §8: защита от дублей при повторной активации
  );

  CREATE TABLE app_event (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    at_utc       INTEGER NOT NULL      -- epoch ms; writes через Clock (потребитель P6)
  );

  CREATE INDEX app_event_kind_at_idx ON app_event (kind, at_utc);
`;

/** Миграция v4 (§2): чистая функция над Database — никаких чтений ФС/сети (§7 TASK-024). */
export const V4_SCALES_EVENTS: Migration = {
  version: 4,
  up: (db) => {
    db.exec(V4_SCALES_EVENTS_DDL_SQL);
  },
};
