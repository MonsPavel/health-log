/**
 * TASK-102 §5/§11/§14: zod-схемы TEST-ONLY каналов крэш-теста потери питания
 * (NFR-3): `__test/insert-batch` (вставка батча записей ОДНОЙ транзакцией + bump
 * data_version за каждую запись, §8/§9) и `__test/db-state` (снимок состояния БД
 * после перезапуска: count/dataVersion/schemaVersion — проверяемые свойства §8).
 *
 * TEST-ONLY (§11/§14): каналы регистрируются ТОЛЬКО при env HL_TEST_HOOKS=1 и
 * только в не-packaged запуске (двойной гард testHooksEnabled, main) и работают
 * только с tmp-userData крэш-прогона. Схемы живут в контракте единственно ради
 * формы: каркас TASK-008 валидирует payload zod-схемой реестра, а реестр
 * типизирован ChannelName. Без флага каналы не зарегистрированы и неотличимы от
 * неизвестных (APP/INTERNAL каркаса). Имена — с общим `__test/*` префиксом
 * (§4: унификация семейства test-hook поверх __bench/seed TASK-062).
 *
 * Формы (§9): insert-batch request {count ≥ 1} — размер батча (прогон — 50;
 * крупные батчи нужны демонстрации чувствительности §20-3 — авто-коммит ловится
 * только если килл успевает внутрь батча); response {committedTotal ≥ 0} —
 * подтверждённый total строк в bp_measurement после транзакции (это значение
 * скрипт трекает как ack — оракул инварианта «подтверждённое = целое», §2/§8).
 * db-state request {} → response {count, dataVersion, schemaVersion} — три
 * факта чтения БД. Все объекты .strict() (§14).
 */
import { z } from 'zod';

/**
 * Границы count (§9): минимум 1 — вызов без записей не имеет смысла (в отличие
 * от пустого сида bench); максимум — запас поверх демо-батчей чувствительности
 * §20-3 (5000), защита от случайной генерации миллионных объёмов в tmp-БД.
 */
export const TEST_INSERT_BATCH_COUNT_MAX = 200_000;

/** Запрос `__test/insert-batch`: сколько записей вставить одной транзакцией (§11). */
export const TEST_INSERT_BATCH_REQUEST_SCHEMA = z
  .object({ count: z.number().int().min(1).max(TEST_INSERT_BATCH_COUNT_MAX) })
  .strict();

/** Ответ `__test/insert-batch`: подтверждённый total строк после транзакции (ack). */
export const TEST_INSERT_BATCH_RESPONSE_SCHEMA = z
  .object({ committedTotal: z.number().int().min(0) })
  .strict();

/** Запрос `__test/db-state` — {} (снимок состояния, параметров нет). */
export const TEST_DB_STATE_REQUEST_SCHEMA = z.object({}).strict();

/**
 * Ответ `__test/db-state` (§8 — проверяемые свойства): count — строк в
 * bp_measurement; dataVersion — meta.data_version (каждая вставка = +1, §8);
 * schemaVersion — meta.schema_version. Все значения ≥ 0 (отсутствие строк meta
 * — честный 0, прецедент readSchemaVersionForLog контейнера).
 */
export const TEST_DB_STATE_RESPONSE_SCHEMA = z
  .object({
    count: z.number().int().min(0),
    dataVersion: z.number().int().min(0),
    schemaVersion: z.number().int().min(0),
  })
  .strict();

/** Запрос __test/insert-batch (§11). */
export type TestInsertBatchRequest = z.infer<typeof TEST_INSERT_BATCH_REQUEST_SCHEMA>;

/** Ответ __test/insert-batch — подтверждённый total (§11). */
export type TestInsertBatchResponse = z.infer<typeof TEST_INSERT_BATCH_RESPONSE_SCHEMA>;

/** Запрос __test/db-state (§11). */
export type TestDbStateRequest = z.infer<typeof TEST_DB_STATE_REQUEST_SCHEMA>;

/** Ответ __test/db-state — снимок {count, dataVersion, schemaVersion} (§8/§11). */
export type TestDbStateResponse = z.infer<typeof TEST_DB_STATE_RESPONSE_SCHEMA>;
