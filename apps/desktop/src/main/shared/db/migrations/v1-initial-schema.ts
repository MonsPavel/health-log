/**
 * TASK-025 §5/§8: миграция v1 — начальная схема хранилища: таблица `profile`
 * (с одним seeded-профилем) и `bp_measurement` (CHECK-ограничения + индекс),
 * инициализация `meta.data_version = '1'`. DDL-источник — арх. 04 §3; приёмка §20:
 * поимённое совпадение таблиц/колонок/индекса (сверяет тест v1.int.test.ts).
 *
 * ИНВАРИАНТ НЕИЗМЕНЯЕМОСТИ (§22): v1 после релиза НЕ правится. Любое изменение
 * схемы (rename/расширения, §23) — только новая миграция v2+, добавляемая в
 * migrations/index.ts; правка v1 ломает совместимость уже созданных копий БД
 * (арх. 04 §5 — restore из снапшота старой версии на схеме v1).
 *
 * Решения, задокументированные спекой:
 *  - seed-профиль `seed-profile-0001` / «Основной» — RU-строка в данных; EN-локализация
 *    пост-MVP — переименование пользователем (§16–17). created_at_utc = Date.now() В
 *    МОМЕНТ ЗАПУСКА МИГРАЦИИ: Date.now() здесь допустим, потому что миграция
 *    выполняется ОДНОКРАТНО (guard schema_version у runner'а, TASK-024) — в отличие
 *    от домена, где время всегда через Clock-инъекцию;
 *  - CHECK-числа (50–300 / 20–200 / 20–300) дублируют BP_LIMITS из
 *    modules/measurement/domain/constants.ts (TASK-016) — защита от багов вне домена
 *    (прямой SQL, будущий импорт, §3); правка границ — синхронно в обоих местах;
 *  - `note` БЕЗ CHECK длины: ≤500 проверяет домен (NOTE_MAX_LENGTH, TASK-017), БД
 *    доверяет домену; альтернатива CHECK(length(note)<=500) отвергнута (§13);
 *  - `profile_id` с первого дня (при одном seeded-профиле) — дешёвая страховка
 *    пост-MVP мультипрофилей (FR-11) без миграции данных (§3).
 *
 * Безопасность (§14): таблицы внутри шифрованной БД (TASK-022) — ничего дополнительно.
 */
import type { Migration } from '../migration-runner.js';

/**
 * DDL v1 (§8, сверка с арх. 04 §3). Выполняется одним exec внутри транзакции
 * runner'а (DDL в SQLite транзакционен — сбой откатывает весь пакет, TASK-024 §13).
 * FTS (bp_measurement_fts) и остальные таблицы арх. 04 §3 — НЕ здесь (§5: TASK-045
 * и фазы своих задач).
 */
const V1_DDL_SQL = `
  CREATE TABLE profile (
    id             TEXT PRIMARY KEY,               -- uuid v7
    name           TEXT NOT NULL,
    created_at_utc INTEGER NOT NULL
  );

  CREATE TABLE bp_measurement (
    id                TEXT PRIMARY KEY,            -- uuid v7 (сортируем по времени создания)
    profile_id        TEXT NOT NULL REFERENCES profile(id),
    taken_at_utc      INTEGER NOT NULL,            -- epoch ms
    tz_offset_minutes INTEGER NOT NULL,            -- смещение в момент измерения (EC-06/07)
    sys               INTEGER NOT NULL CHECK (sys BETWEEN 50 AND 300),   -- синхронно с domain/constants.ts (BP_LIMITS, TASK-016)
    dia               INTEGER NOT NULL CHECK (dia BETWEEN 20 AND 200),   -- синхронно с domain/constants.ts (BP_LIMITS, TASK-016)
    pulse             INTEGER CHECK (pulse IS NULL OR pulse BETWEEN 20 AND 300), -- синхронно с domain/constants.ts (BP_LIMITS, TASK-016)
    irregular_pulse   INTEGER NOT NULL DEFAULT 0 CHECK (irregular_pulse IN (0, 1)), -- флаг аритмии тонометра
    arm               TEXT NOT NULL CHECK (arm IN ('left', 'right')),
    note              TEXT,                        -- ≤500 симв.; БЕЗ CHECK длины — проверяет домен (NOTE_MAX_LENGTH, TASK-017; решение §13)
    source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
    created_at_utc    INTEGER NOT NULL,
    updated_at_utc    INTEGER NOT NULL
  );

  -- Главный запрос listByPeriod и агрегаты статистики (§15): без индекса 50k записей —
  -- полноэкранный скан
  CREATE INDEX idx_bp_profile_time ON bp_measurement (profile_id, taken_at_utc);
`;

/**
 * Миграция v1 (§2): DDL обеих таблиц + индекс + seed одного профиля +
 * `meta.data_version = '1'`. Ключ `data_version` runner не трогает (TASK-024 §8) —
 * его инициирует только эта миграция; повторного INSERT не будет: runner применяет
 * миграцию ровно один раз (guard schema_version).
 */
export const V1_INITIAL_SCHEMA: Migration = {
  version: 1,
  up: (db) => {
    db.exec(V1_DDL_SQL);
    // Seed единственного профиля (§8): created_at_utc — время запуска миграции.
    db.prepare('INSERT INTO profile (id, name, created_at_utc) VALUES (?, ?, ?)').run(
      'seed-profile-0001',
      'Основной',
      Date.now(),
    );
    // data_version — счётчик изменений данных (арх. 04 §4): стартовое значение '1'.
    db.prepare("INSERT INTO meta (key, value) VALUES ('data_version', '1')").run();
  },
};
