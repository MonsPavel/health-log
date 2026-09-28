/**
 * TASK-008 §5: реестр zod-схем прикладных каналов — единственное место знания о
 * формах payload (арх. 05 §1). Схемы strict по умолчанию (§14: prototype-pollution);
 * типы выводятся из схем (z.infer) — никакой ручной синхронизации (§23).
 */
import { z } from 'zod';

import { BENCH_SEED_REQUEST_SCHEMA, BENCH_SEED_RESPONSE_SCHEMA } from './bench.js';
import type { ChannelName } from './channels.js';
import {
  MEASUREMENT_ADD_REQUEST_SCHEMA,
  MEASUREMENT_ADD_RESPONSE_SCHEMA,
  MEASUREMENT_DELETE_REQUEST_SCHEMA,
  MEASUREMENT_DELETE_RESPONSE_SCHEMA,
  MEASUREMENT_LIST_REQUEST_SCHEMA,
  MEASUREMENT_LIST_RESPONSE_SCHEMA,
  MEASUREMENT_UPDATE_REQUEST_SCHEMA,
  MEASUREMENT_UPDATE_RESPONSE_SCHEMA,
} from './measurement/schemas.js';
import { NOTES_SEARCH_REQUEST_SCHEMA, NOTES_SEARCH_RESPONSE_SCHEMA } from './notes/schemas.js';
import {
  PREFS_GET_REQUEST_SCHEMA,
  PREFS_GET_RESPONSE_SCHEMA,
  PREFS_SET_REQUEST_SCHEMA,
  PREFS_SET_RESPONSE_SCHEMA,
} from './prefs/schemas.js';
import { SCALES_ACTIVE_REQUEST_SCHEMA, SCALES_ACTIVE_RESPONSE_SCHEMA } from './scales.js';
import { STATS_REQUEST_SCHEMA, STATS_RESPONSE_SCHEMA } from './stats/schemas.js';
import { TREND_REQUEST_SCHEMA, TREND_RESPONSE_SCHEMA } from './trends.js';

/** Пара схем канала: запрос валидируется в main до handler, ответ — контракт хендлера. */
export interface ChannelSchemas<TRequest = unknown, TResponse = unknown> {
  readonly request: z.ZodType<TRequest>;
  readonly response: z.ZodType<TResponse>;
}

/**
 * Реестр каналов: `Record<ChannelName, ChannelSchemas>` (§5). Новый канал = запись
 * здесь + строка в union ChannelName; компилятор не даст забыть ни одну из сторон.
 */
export const CHANNEL_SCHEMAS = {
  /**
   * TASK-062 §9/§11: TEST-ONLY сидинг синтетики bench — {count} → {inserted}
   * (одна транзакция на main). Регистрируется только при env HL_BENCH=1 и не в
   * packaged (двойной гард main §14); без флага — «неизвестный канал» каркаса.
   */
  '__bench/seed': {
    request: BENCH_SEED_REQUEST_SCHEMA,
    response: BENCH_SEED_RESPONSE_SCHEMA,
  },
  'app/ping': {
    request: z.object({}).strict(),
    response: z.object({ pong: z.literal(true), ts: z.number() }).strict(),
  },
  /**
   * TASK-011 §7/§11: клиентский отчёт об ошибке из ErrorBoundary. Стек и текст
   * исключения наружу не уходят (§14) — только messageKey каталога и digest
   * (хеш message+первой строки стека, ≤64) для дедупликации в логах (§18).
   * Ответ null: канал fire-and-forget (§9).
   */
  'app/log-client-error': {
    request: z
      .object({
        code: z.literal('APP/RENDERER'),
        messageKey: z.string().max(200),
        digest: z.string().max(64),
      })
      .strict(),
    response: z.null(),
  },
  /**
   * TASK-028 §5/§11: журнал измерений — CRUD и список (арх. 05 §3, FR-1/FR-2).
   * Хендлеры подключают use cases TASK-029 (add), TASK-037 (update/delete), TASK-033
   * (list); флаги эвристик и критичность — в ответе add.
   */
  'measurements/add': {
    request: MEASUREMENT_ADD_REQUEST_SCHEMA,
    response: MEASUREMENT_ADD_RESPONSE_SCHEMA,
  },
  'measurements/list': {
    request: MEASUREMENT_LIST_REQUEST_SCHEMA,
    response: MEASUREMENT_LIST_RESPONSE_SCHEMA,
  },
  'measurements/update': {
    request: MEASUREMENT_UPDATE_REQUEST_SCHEMA,
    response: MEASUREMENT_UPDATE_RESPONSE_SCHEMA,
  },
  'measurements/delete': {
    request: MEASUREMENT_DELETE_REQUEST_SCHEMA,
    response: MEASUREMENT_DELETE_RESPONSE_SCHEMA,
  },
  /**
   * TASK-045 §5/§11: FTS-поиск заметок (арх. 05 §3, FR-2.2). Хендлер — use case
   * SearchNotes (TASK-045 §5/§9): мусорный/пустой запрос — пустой результат, не ошибка.
   */
  'notes/search': {
    request: NOTES_SEARCH_REQUEST_SCHEMA,
    response: NOTES_SEARCH_RESPONSE_SCHEMA,
  },
  /**
   * TASK-047 §5/§11: настройки — prefs/get (полный документ) и prefs/set
   * {patch} → обновлённый полный. Patch — strip-режим (неизвестные ключи
   * отбрасываются zod, неверный тип — VALIDATION/FAILED); merge — в сервисе.
   */
  'prefs/get': {
    request: PREFS_GET_REQUEST_SCHEMA,
    response: PREFS_GET_RESPONSE_SCHEMA,
  },
  'prefs/set': {
    request: PREFS_SET_REQUEST_SCHEMA,
    response: PREFS_SET_RESPONSE_SCHEMA,
  },
  /**
   * TASK-051 §5/§11: активная справочная шкала — {} → полная форма ActiveScale
   * (code, version, sourceLabel, категории, обе заметки). Статический между
   * запусками (данные — из комплекта, §14): кэш рендерера staleTime Infinity.
   */
  'scales/active': {
    request: SCALES_ACTIVE_REQUEST_SCHEMA,
    response: SCALES_ACTIVE_RESPONSE_SCHEMA,
  },
  /**
   * TASK-054 §5/§11: статистика периода поверх read models 052/053 —
   * {profileId, period} → {stats: PeriodStatisticsDto, scale: {code, version,
   * sourceLabel}}. Пустой период — полная структура с нулями/undefined, не ошибка
   * (§11); при insufficientData категория в данных отсутствует (EC-09). Период —
   * та же схема, что пойдёт в trend/series (§23: переиспользование обязательно).
   */
  'stats/period': {
    request: STATS_REQUEST_SCHEMA,
    response: STATS_RESPONSE_SCHEMA,
  },
  /**
   * TASK-056 §5/§11: серии точек для графика динамики — {profileId, period} →
   * {mode, points?|days?}: raw до порога RAW_POINTS_LIMIT (500) включительно, daily —
   * агрегация «день = среднее + диапазон» при превышении (порог и форма — в контракте,
   * §2). Пустой период — {mode:'raw', points:[]}, не ошибка (§11). Период — та же
   * схема, что у stats/period (§23 054: переиспользование обязательно).
   */
  'trend/series': {
    request: TREND_REQUEST_SCHEMA,
    response: TREND_RESPONSE_SCHEMA,
  },
} satisfies Record<ChannelName, ChannelSchemas>;
