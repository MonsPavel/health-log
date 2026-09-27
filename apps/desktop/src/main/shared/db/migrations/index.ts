/**
 * Реестр миграций (TASK-024 §5): единый список, передаётся MigrationRunner'у на
 * старте приложения. Пополается задачами 025+ — каждая добавляет запись
 * `{ version, up }` СЛЕДУЮЩЕЙ версией; version строго инкрементируется, назад не
 * откатывается (forward-only, арх. 04 §5; down-миграции — TD-2).
 *
 * Правила ревью для каждой миграции (§7/§22):
 *  - комментарий «что и зачем» + ссылка на TASK;
 *  - миграция — чистая функция над Database: никаких чтений ФС/сети;
 *  - миграции только структурные (DDL) — без переноса больших объёмов данных
 *    (долгая миграция блокирует старт, §22; для данных — отдельный механизм, §23).
 */
import { V1_INITIAL_SCHEMA } from './v1-initial-schema.js';
import { V2_FTS_NOTES } from './v2-fts.js';
import { V3_APP_SETTING } from './v3-app-setting.js';
import { V4_SCALES_EVENTS } from './v4-scales-events.js';
import type { Migration } from '../migration-runner.js';

/** Все миграции проекта по возрастанию version. v1 — TASK-025; v2 — TASK-045; v3 — TASK-047; v4 — TASK-051. */
export const MIGRATIONS: readonly Migration[] = [
  V1_INITIAL_SCHEMA,
  V2_FTS_NOTES,
  V3_APP_SETTING,
  V4_SCALES_EVENTS,
];
