/**
 * TASK-062 §9/§11/§14: zod-схемы test-only канала `__bench/seed` — сидинг
 * синтетики perf-bench графика (генерация на main-стороне, одна транзакция;
 * IPC-цикл add по записям — 10k × IPC слишком медленно, §8).
 *
 * TEST-ONLY (§11/§14): канал регистрируется ТОЛЬКО при env HL_BENCH=1 и только
 * в не-packaged запуске (двойной гард benchChannelsEnabled, main) и пишет только
 * в tmp-userData bench-прогона. Схемы живут в контракте единственно ради формы:
 * каркас TASK-008 валидирует payload zod-схемой реестра, а реестр типизирован
 * ChannelName. Без флага канал не зарегистрирован — вызов получает APP/INTERNAL
 * («неизвестный IPC-канал»), как и любой незарегистрированный канал.
 *
 * Формы (§9): request {count} — сколько записей сгенерировать (генератор — общая
 * функция main с юнит-тестами: детерминизм seed, форма день/вечер); response
 * {inserted} — факт вставки (равен count при успехе; отдельное поле — честный
 * отчёт канала, а не предположение скрипта). Все объекты .strict() (§14).
 */
import { z } from 'zod';

/**
 * Границы count (§9): 0 — валиден (пустой сид легален, ответ {inserted: 0});
 * максимум — запас поверх bench-профиля 10k (будущие профили нагрузки, §23),
 * защита от случайной генерации миллионных объёмов в tmp-БД.
 */
export const BENCH_SEED_COUNT_MAX = 200_000;

/** Запрос `__bench/seed`: сколько синтетических записей вставить (§9). */
export const BENCH_SEED_REQUEST_SCHEMA = z
  .object({ count: z.number().int().min(0).max(BENCH_SEED_COUNT_MAX) })
  .strict();

/** Ответ `__bench/seed`: сколько записей фактически вставлено (одной транзакцией). */
export const BENCH_SEED_RESPONSE_SCHEMA = z.object({ inserted: z.number().int().min(0) }).strict();

/** Запрос __bench/seed (§9). */
export type BenchSeedRequest = z.infer<typeof BENCH_SEED_REQUEST_SCHEMA>;

/** Ответ __bench/seed (§9). */
export type BenchSeedResponse = z.infer<typeof BENCH_SEED_RESPONSE_SCHEMA>;
