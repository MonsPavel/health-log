/**
 * TASK-047 §5/§8: миграция v3 — хранилище настроек `app_setting (key TEXT PK,
 * value_json TEXT NOT NULL, updated_at_utc INTEGER NOT NULL)`. KV-таблица общего
 * назначения модуля settings-profile (арх. 04 §3): настройки — единый документ
 * `prefs` под ключом 'prefs' (§5 PreferencesService — атомарные чтения), ключи
 * дальше растят задачи 051/075/087/089 (реестр миграций §4: v3 = app_setting).
 *
 * Seed §8 — ПУСТО: источник правды значений по умолчанию — DEFAULT_PREFS в коде
 * PreferencesService (zod-дефолты делают восстановление из старой копии безопасным,
 * §22). Нумерация миграций — по хронологии разработки (§4): v1 = схема (TASK-025),
 * v2 = FTS (TASK-045), v3 = app_setting (эта задача).
 *
 * ИНВАРИАНТ НЕИЗМЕНЯЕМОСТИ v1/v2 (§22 TASK-025) соблюдён: схема расширяется НОВОЙ
 * миграцией, существующие таблицы не трогаются.
 *
 * Безопасность (§14): настройки — внутри шифрованной БД (не localStorage) — попадают
 * в резервные копии и мигрируют между машинами (FR-6.4-семантика, §3).
 */
import type { Migration } from '../migration-runner.js';

/**
 * DDL v3 (§5/§8, сверка с арх. 04 §3). Выполняется одним exec внутри транзакции
 * runner'а (DDL в SQLite транзакционен, TASK-024 §13). Индексы не нужны: PK по key
 * покрывает единственный профиль доступа «чтение/запись документа по ключу» (§15).
 */
const V3_APP_SETTING_DDL_SQL = `
  CREATE TABLE app_setting (
    key            TEXT PRIMARY KEY,
    value_json     TEXT NOT NULL,
    updated_at_utc INTEGER NOT NULL    -- epoch ms; writes через SettingsStore (Clock)
  );
`;

/** Миграция v3 (§2): чистая функция над Database — никаких чтений ФС/сети (§7 TASK-024). */
export const V3_APP_SETTING: Migration = {
  version: 3,
  up: (db) => {
    db.exec(V3_APP_SETTING_DDL_SQL);
  },
};
