/**
 * TASK-054 §5/§11: zod-схемы канала `stats/period` — статистика периода поверх
 * read models 052/053 (арх. 05 §3, FR-3/FR-4). Период — вход канала, всё остальное
 * — производное: пресеты 7d/30d/90d/all — семантики TASK-044 (from = now − N*24ч,
 * «всё» = без границ), custom {fromUtcMs, toUtcMs} — семантики TASK-046 (обе границы
 * включительно; конвертация настенных дат в utcMs — забота рендерера, канал принимает
 * готовые границы). Схема периода переиспользуется TASK-056 (trend/series, §23) —
 * ПЕРЕИСПОЛЬЗОВАНИЕ ОБЯЗАТЕЛЬНО, копии периода для trend не создавать.
 *
 * Ответ {stats, scale}: stats — плоская форма read model PeriodStatistics (052)
 * с classification (053) — форма фиксируется каналом ОДИН РАЗ для трёх потребителей
 * (дашборд 061, отчёт 068, ИИ-контекст 083, §3). Flat-маппинг §7: undefined-части
 * отсутствуют в JSON (не null-простыня) — optional-поля схем; округления — уже в
 * read model, схемой не дублируются. Scale в ответе (а не отдельный канал) —
 * классификация без второй загрузки (§4): {code, version, sourceLabel} — enough
 * для потребителей, полная форма шкалы — канал scales/active (TASK-051).
 *
 * Все объекты .strict() (§14: IPC-гигиена TASK-008); типы выводятся из схем
 * (z.infer — types.ts, §23). profileId в схеме запроса (§14: принудительный скоуп).
 */
import { z } from 'zod';

import { SCALE_CATEGORY_SCHEMA, SCALE_VERSION_SCHEMA } from '../scales.js';

/** §14: профиль-владелец — та же гигиена длины, что у measurement (≤64, не uuid-regex). */
const PROFILE_ID_MAX_LENGTH = 64;

/**
 * Период канала (§5): пресет или готовые utcMs-границы. Пресеты считает main от
 * Clock (§9: from = now − N*24ч, to = ∞ — TASK-044); custom проходит как есть —
 * семантика включительно на стороне порта TASK-021. Схема ПЕРЕИСПОЛЬЗУЕТСЯ TASK-056 (§23).
 */
export const STATS_PERIOD_PARAM_SCHEMA = z.union([
  z.enum(['7d', '30d', '90d', 'all']),
  z
    .object({ fromUtcMs: z.number().int(), toUtcMs: z.number().int() })
    .strict(),
]);

/** Агрегаты одного канала значений (052 §7): avg/min/max/sd, undefined-части отсутствуют. */
export const STATS_VALUE_STATS_SCHEMA = z
  .object({
    avg: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    sd: z.number().optional(),
  })
  .strict();

/** Часть суток (052 §7): своя выборка и свой пульс; без измерений части поле отсутствует. */
export const STATS_PART_STATS_SCHEMA = z
  .object({
    count: z.number().int(),
    sys: STATS_VALUE_STATS_SCHEMA,
    dia: STATS_VALUE_STATS_SCHEMA,
    pulse: STATS_VALUE_STATS_SCHEMA.optional(),
  })
  .strict();

/** Примечание классификации 053 (FR-4.2): род + текст ИЗ ДАННЫХ шкалы (§14 R-1). */
export const STATS_CLASSIFICATION_NOTE_SCHEMA = z
  .object({
    kind: z.enum(['homeBP', 'specialGroups', 'insufficientData']),
    text: z.string().min(1),
  })
  .strict();

/**
 * Классификация средних (053): категория «худшая из двух» (опциональна — при
 * insufficientData её НЕТ, EC-09: «мало данных» не превращается в вердикт) + обязательные
 * заметки. Категория — та же схема, что у scales/active (§22: без дрейфа зеркал).
 */
export const STATS_CLASSIFICATION_SCHEMA = z
  .object({
    category: SCALE_CATEGORY_SCHEMA.optional(),
    notes: z.array(STATS_CLASSIFICATION_NOTE_SCHEMA),
  })
  .strict();

/**
 * PeriodStatisticsDto (§5/§7): плоская форма структуры read model 052, включая
 * classification 053. Опциональные части (pulse, morning/evening/other, delta,
 * lastMeasurementUtcMs, classification) в JSON отсутствуют при undefined — не null.
 */
export const PERIOD_STATISTICS_DTO_SCHEMA = z
  .object({
    count: z.number().int(),
    sys: STATS_VALUE_STATS_SCHEMA,
    dia: STATS_VALUE_STATS_SCHEMA,
    pulse: STATS_VALUE_STATS_SCHEMA.optional(),
    morning: STATS_PART_STATS_SCHEMA.optional(),
    evening: STATS_PART_STATS_SCHEMA.optional(),
    other: STATS_PART_STATS_SCHEMA.optional(),
    delta: z
      .object({ sys: z.number(), dia: z.number() })
      .strict()
      .optional(),
    critical: z.object({ high: z.boolean(), low: z.boolean() }).strict(),
    daysWithMeasurements: z.number().int(),
    longestStreakDays: z.number().int(),
    lastMeasurementUtcMs: z.number().int().optional(),
    insufficientData: z
      .object({ tooFewMeasurements: z.boolean(), tooFewDays: z.boolean() })
      .strict(),
    classification: STATS_CLASSIFICATION_SCHEMA.optional(),
  })
  .strict();

/** §5/§11: запрос stats/period — {profileId, period}. */
export const STATS_REQUEST_SCHEMA = z
  .object({
    profileId: z.string().min(1).max(PROFILE_ID_MAX_LENGTH),
    period: STATS_PERIOD_PARAM_SCHEMA,
  })
  .strict();

/** Справка об активной шкале в ответе (§4): классификация без второй загрузки. */
export const STATS_SCALE_INFO_SCHEMA = z
  .object({
    code: z.string().min(1),
    version: SCALE_VERSION_SCHEMA,
    sourceLabel: z.string().min(1),
  })
  .strict();

/** §5/§11: ответ stats/period — {stats, scale}. Пустой период — полная структура с нулями (§11), не ошибка. */
export const STATS_RESPONSE_SCHEMA = z
  .object({ stats: PERIOD_STATISTICS_DTO_SCHEMA, scale: STATS_SCALE_INFO_SCHEMA })
  .strict();
