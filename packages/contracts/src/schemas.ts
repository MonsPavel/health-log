/**
 * TASK-008 §5: реестр zod-схем прикладных каналов — единственное место знания о
 * формах payload (арх. 05 §1). Схемы strict по умолчанию (§14: prototype-pollution);
 * типы выводятся из схем (z.infer) — никакой ручной синхронизации (§23).
 */
import { z } from 'zod';

import { BENCH_SEED_REQUEST_SCHEMA, BENCH_SEED_RESPONSE_SCHEMA } from './bench.js';
import type { ChannelName } from './channels.js';
import {
  BACKUP_CREATE_REQUEST_SCHEMA,
  BACKUP_CREATE_RESPONSE_SCHEMA,
  BACKUP_RESTORE_REQUEST_SCHEMA,
  BACKUP_RESTORE_RESPONSE_SCHEMA,
  DATA_WIPE_REQUEST_SCHEMA,
  DATA_WIPE_RESPONSE_SCHEMA,
} from './data-care/schemas.js';
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
import {
  REPORT_EXPORT_REQUEST_SCHEMA,
  REPORT_EXPORT_RESPONSE_SCHEMA,
  REPORT_PDF_REQUEST_SCHEMA,
  REPORT_PDF_RESPONSE_SCHEMA,
  REVEAL_PATH_REQUEST_SCHEMA,
} from './report/schemas.js';
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
   * TASK-068 §5/§11: «открыть папку» после сохранения отчёта/экспорта —
   * {path} → null (fire-and-forget, §9). Путь — тот, что вернул наш же save-диалог
   * (UX-удобство на своей машине, решение §11 — без санитизации).
   */
  'app/reveal-path': {
    request: REVEAL_PATH_REQUEST_SCHEMA,
    response: z.null(),
  },
  /**
   * TASK-070 §6/§11: создание копии (Data Care) — {mode:'ask', passphrase} |
   * {mode:'auto', targetName?} → {file: basename, sizeBytes, manifest}.
   * Канал-контракт и формат манифеста — здесь; регистрация хендлера и диалоги —
   * TASK-073 (§6 РЕШЕНИЕ). Пароль копии ≠ пароль приложения (§14).
   */
  'backup/create': {
    request: BACKUP_CREATE_REQUEST_SCHEMA,
    response: BACKUP_CREATE_RESPONSE_SCHEMA,
  },
  /**
   * TASK-071 §6/§11: восстановление из копии (Data Care) — двухфазный канал:
   * фаза 1 {file, passphrase, confirmed: false} → {plan} (предупреждения — UI
   * показывает до подтверждения); фаза 2 {…, confirmed: true} → {restarting: true}
   * (замена БД + отложенный relaunch, §9). Регистрация хендлера — TASK-073.
   */
  'backup/restore': {
    request: BACKUP_RESTORE_REQUEST_SCHEMA,
    response: BACKUP_RESTORE_RESPONSE_SCHEMA,
  },
  /**
   * TASK-072 §5/§11: полное удаление данных (Data Care) — двухфазный канал по
   * `phase`: {phase:'plan'} → {plan: WipePlan} (basename+категория — пути от
   * renderer не принимаются и наружу не идут, §7/§14); {phase:'execute'} →
   * {restarting: true} (unlink по плану + отложенный relaunch, §9). Ошибки —
   * WIPE/FAILED (частичный сбой: remainingCount в params). Регистрация хендлера
   * и команда renderer'у на очистку localStorage — TASK-073.
   */
  'data/wipe': {
    request: DATA_WIPE_REQUEST_SCHEMA,
    response: DATA_WIPE_RESPONSE_SCHEMA,
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
   * TASK-065 §5/§11: экспорт CSV/JSON (US-27) — {profileId} → {path} | {canceled: true}.
   * Путь файла выбирает save-диалог main (§14: renderer путь не присылает); отмена —
   * не ошибка (§7). Оба канала — одна пара схем (запрос одинаков, §5 «аналогично»).
   */
  'report/export-csv': {
    request: REPORT_EXPORT_REQUEST_SCHEMA,
    response: REPORT_EXPORT_RESPONSE_SCHEMA,
  },
  'report/export-json': {
    request: REPORT_EXPORT_REQUEST_SCHEMA,
    response: REPORT_EXPORT_RESPONSE_SCHEMA,
  },
  /**
   * TASK-068 §5/§11: сборка+сохранение PDF-отчёта (UC-05) — {profileId, period,
   * includeAiSection, aiText?} → {path} | {canceled: true} (та же union-схема, §23).
   * Пустой период → REPORT/EMPTY_PERIOD (main-валидация, §9); путь — save-диалог main.
   */
  'report/pdf': {
    request: REPORT_PDF_REQUEST_SCHEMA,
    response: REPORT_PDF_RESPONSE_SCHEMA,
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
