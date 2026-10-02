/**
 * TASK-102 §5/§9/§11/§14: TEST-ONLY test-хуки крэш-теста потери питания (NFR-3)
 * — main-сторона каналов `__test/insert-batch` и `__test/db-state`. Три части:
 *  1. Гард `testHooksEnabled` (§11/§14): каналы регистрируются ТОЛЬКО при env
 *     HL_TEST_HOOKS=1 и ТОЛЬКО в не-packaged запуске (двойная защита — в packaged
 *     env игнорируется). Паттерн benchChannelsEnabled TASK-062; общий флаг
 *     семейства test-hook (§4: HL_BENCH/HL_FAKE_LLM/HL_TEST_MODEL_FILE остаются
 *     как есть — унификация именами `__test/*`, не переименованием env).
 *     Без флага регистрация пропускается — вызов канала неотличим от вызова
 *     неизвестного канала (APP/INTERNAL каркаса) — §20 AC4.
 *  2. Хендлер `createTestInsertBatchHandler` (§8/§9): вставка count записей ОДНОЙ
 *     db.transaction (атомарность батча — основа инварианта «count == ack ИЛИ
 *     ack + размер батча»: недо-батч при килле откатывается ЦЕЛИКОМ, §8), bump
 *     data_version за КАЖДУЮ запись (формула dv == 1 + count, §8), ответ
 *     {committedTotal} — ПОДТВЕРЖДЁННЫЙ COUNT(*) ПОСЛЕ транзакции (его скрипт
 *     трекает как ack — оракул «подтверждённое = целое», §2). id —
 *     crypto.randomUUID (глобальная уникальность между батчами/перезапусками:
 *     хендлер пересоздаётся каждым стартом приложения, счётчик не переживёт
 *     килл). Профиль — seed-profile-0001 миграции v1 (FK), значения в границах
 *     CHECK v1 (TASK-025 §8), моменты строго возрастают от якоря первого батча.
 *  3. Хендлер `createTestDbStateHandler` (§8/§11): снимок {count, dataVersion,
 *     schemaVersion} — факты чтения bp_measurement/meta; отсутствие строк meta
 *     и мусор в них — честные нули (форма ответа — контракт, прецедент
 *     readSchemaVersionForLog контейнера).
 *
 * БЕЗОПАСНОСТЬ (§14): каналы пишут/читают только БД переданного tmp-userData
 * (HL_TEST_USER_DATA крэш-прогона); боевые данные недостижимы — флаг действует
 * только в не-packaged запуске скрипта поверх собственной tmp-директории.
 *
 * СИНСИТИВНОСТЬ-ДЕМО (§20-3): минимальная dev-правка «отключить транзакцию» —
 * заменить вызов insertAll() (ниже, помечен) на прямое исполнение тела цикла:
 * каждая вставка+bump станут авто-коммитами → килл внутри батча оставит
 * частичный батч (ack < count < ack+batch) → крэш-тест ОБЯЗАН дать FAIL.
 *
 * Файл живёт рядом с хендлерами каналов (ipc/handlers — прецедент bench-seed.ts):
 * регистрация выполняется bootstrap-ом ДО installChannelBridge.
 */
import { randomUUID } from 'node:crypto';

import {
  TEST_INSERT_BATCH_RESPONSE_SCHEMA,
  TEST_DB_STATE_RESPONSE_SCHEMA,
  type TestDbStateRequest,
  type TestDbStateResponse,
  type TestInsertBatchRequest,
  type TestInsertBatchResponse,
} from '@hl/contracts';

/** Имя env-флага test-хуков (§5/§6: HL_TEST_HOOKS=1; единственный источник строки). */
export const HL_TEST_HOOKS_ENV = 'HL_TEST_HOOKS';

/**
 * Гард регистрации test-каналов (§11/§14). isPackaged — параметр (тест-эмуляция
 * packaged-режима §14; bootstrap подставляет app.isPackaged).
 */
export function testHooksEnabled(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): boolean {
  return env[HL_TEST_HOOKS_ENV] === '1' && !isPackaged;
}

/** Профиль-владелец синтетики (seed миграции v1; FK bp_measurement.profile_id). */
const SEED_PROFILE_ID = 'seed-profile-0001';

/**
 * Минимальная поверхность better-sqlite3 для хендлеров (§19: fake-БД в юнит-тестах;
 * боевая — EncryptedDatabase контейнера через прокси, структурно совместима).
 * Контракт db.transaction — better-sqlite3: ВОЗВРАЩАЕТ транзакционную функцию
 * (BEGIN…COMMIT, сбой → ROLLBACK); исполнение — её вызов (прецедент bench-seed.ts).
 */
export interface TestHooksDatabase {
  transaction(fn: () => unknown): () => unknown;
  prepare(sql: string): {
    run(params?: Record<string, unknown>): unknown;
    get(...params: unknown[]): unknown;
  };
}

/** INSERT v1 без изменений (TASK-025 §8; named params — прецедент репозитория TASK-026). */
const INSERT_SQL = `
  INSERT INTO bp_measurement (
    id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse,
    irregular_pulse, arm, note, source, created_at_utc, updated_at_utc
  ) VALUES (
    @id, @profile_id, @taken_at_utc, @tz_offset_minutes, @sys, @dia, @pulse,
    @irregular_pulse, @arm, @note, @source, @created_at_utc, @updated_at_utc
  )
`;

/**
 * Bump data_version за КАЖДУЮ запись (§8: «каждая запись = +1» — формула
 * dv == 1 + count; колонка TEXT — CAST туда и обратно, прецедент репозитория).
 */
const BUMP_VERSION_SQL =
  "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'data_version'";

/** Подтверждённый total (§2/§11): COUNT по всей таблице — ack-оракул скрипта. */
const COUNT_ALL_SQL = 'SELECT COUNT(*) AS total FROM bp_measurement';

/** Значения синтетики — середины CHECK-границ v1 (смысл данных для крэш-теста не важен). */
const SYNTHETIC_SYS = 120;
const SYNTHETIC_DIA = 80;
const SYNTHETIC_PULSE = 70;

/** Смещение зоны синтетики (EC-06): константа +180, прецедент bench-seed.ts. */
const TZ_OFFSET_MIN = 180;

/**
 * Фабрика хендлера `__test/insert-batch {count}` (§9): батч — одна транзакция
 * (insert + bump на каждую запись), ответ — COUNT(*) после фиксации. Statements
 * готовятся один раз (§15 better-sqlite3), якорь моментов — первый вызов.
 */
export function createTestInsertBatchHandler(
  db: TestHooksDatabase,
): (payload: TestInsertBatchRequest) => TestInsertBatchResponse {
  const insertStmt = db.prepare(INSERT_SQL);
  const bumpStmt = db.prepare(BUMP_VERSION_SQL);
  const countStmt = db.prepare(COUNT_ALL_SQL);
  let sequence = 0;
  let anchorUtcMs: number | undefined;
  return (payload) => {
    anchorUtcMs ??= Date.now();
    // better-sqlite3: db.transaction(fn) ВОЗВРАЩАЕТ транзакционную функцию —
    // исполнение (BEGIN…COMMIT, сбой → ROLLBACK) — её ВЫЗОВ (прецедент bench-seed).
    const insertAll = db.transaction(() => {
      for (let i = 0; i < payload.count; i += 1) {
        // §20-3 (точка минимальной dev-правки «авто-коммит»): вынести тело цикла
        // из-под insertAll — каждая вставка+bump станут отдельными транзакциями.
        const takenAtUtc = (anchorUtcMs as number) + sequence;
        sequence += 1;
        insertStmt.run({
          id: randomUUID(),
          profile_id: SEED_PROFILE_ID,
          taken_at_utc: takenAtUtc,
          tz_offset_minutes: TZ_OFFSET_MIN,
          sys: SYNTHETIC_SYS,
          dia: SYNTHETIC_DIA,
          pulse: SYNTHETIC_PULSE,
          irregular_pulse: 0,
          arm: 'left',
          note: null,
          source: 'manual',
          created_at_utc: takenAtUtc,
          updated_at_utc: takenAtUtc,
        });
        bumpStmt.run();
      }
    });
    insertAll();
    // Ответ валидируется схемой контракта (гвоздь формы §9): committedTotal —
    // ПОДТВЕРЖДЁННЫЙ total (после COMMIT), ack-оракул инварианта §2/§8.
    const row = countStmt.get() as { total: number | bigint };
    return TEST_INSERT_BATCH_RESPONSE_SCHEMA.parse({ committedTotal: Number(row.total) });
  };
}

/** Читает неотрицательное целое из строки meta; отсутствие/мусор — 0 (§11-форма). */
function metaValueToNonNegativeInt(row: { value: string } | undefined): number {
  const value = row?.value;
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0;
}

/**
 * Фабрика хендлера `__test/db-state {}` (§8/§11): снимок состояния БД после
 * перезапуска — {count, dataVersion, schemaVersion}. Statements готовятся один
 * раз; отсутствие строк meta — честные нули (свежая/повреждённая БД).
 */
export function createTestDbStateHandler(
  db: TestHooksDatabase,
): (payload: TestDbStateRequest) => TestDbStateResponse {
  const countStmt = db.prepare(COUNT_ALL_SQL);
  const dataVersionStmt = db.prepare("SELECT value FROM meta WHERE key = 'data_version'");
  const schemaVersionStmt = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'");
  return () => {
    const countRow = countStmt.get() as { total: number | bigint };
    return TEST_DB_STATE_RESPONSE_SCHEMA.parse({
      count: Number(countRow.total),
      dataVersion: metaValueToNonNegativeInt(dataVersionStmt.get() as { value: string } | undefined),
      schemaVersion: metaValueToNonNegativeInt(
        schemaVersionStmt.get() as { value: string } | undefined,
      ),
    });
  };
}
