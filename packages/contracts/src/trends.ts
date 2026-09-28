/**
 * TASK-056 §5/§11: zod-схемы канала `trend/series` — серии точек для графика динамики
 * (арх. 05 §3, FR-3.5). Два режима ответа решает read model (§2: «переключение
 * "сырые ↔ дни" — поведение read model, а не забота UI»): raw — до порога включительно,
 * daily — агрегация «день = среднее + диапазон» при превышении порога.
 *
 * ПОРОГ В КОНТРАКТЕ (§2/§5): RAW_POINTS_LIMIT = 500 — константа контекста аналитики,
 * живёт здесь (одна, §22: правка после замеров TASK-057 дешёвая); read model её
 * импортирует, дубликатов нет.
 *
 * ПЕРИОД ПЕРЕИСПОЛЬЗОВАН (§23 TASK-054): схема периода — та же STATS_PERIOD_PARAM_SCHEMA,
 * копии для trend не создавать (пресеты TASK-044, custom TASK-046).
 *
 * Формы точек (§5): RawPoint — плоская проекция точки порта аналитики (utcMs +
 * tzOffsetMin вместо вложенного Instant — провод без вложенности; part — правило
 * дня TASK-052; critical — политика TASK-020, прокинута read model'ом). DayPoint —
 * агрегат НАСТЕННОГО дня (семантика дней TASK-046): avg округлён правилом отображения
 * 052 (1 знак, stats-math.summarize), min/max целые; morningSysAvg/eveningSysAvg —
 * раздельные средние утра/вечера (§4: различение утро/вечер сохраняется в агрегате),
 * только при наличии таких записей в дне (§13).
 *
 * Все объекты .strict() (§14); типы выводятся из схем (z.infer, §23). Форма ответа —
 * плоская по §5: {mode, points?|days?}, ветка определяется mode.
 */
import { z } from 'zod';

import { STATS_PERIOD_PARAM_SCHEMA } from './stats/schemas.js';

/** Порог raw-режима (§5/§13): ≤500 точек в периоде → raw, больше → daily. */
export const RAW_POINTS_LIMIT = 500;

/** §14: профиль-владелец — та же гигиена длины, что у measurement/stats (≤64). */
const PROFILE_ID_MAX_LENGTH = 64;

/** §5/§11: запрос trend/series — {profileId, period}; период — схема TASK-054 (§23). */
export const TREND_REQUEST_SCHEMA = z
  .object({
    profileId: z.string().min(1).max(PROFILE_ID_MAX_LENGTH),
    period: STATS_PERIOD_PARAM_SCHEMA,
  })
  .strict();

/** Часть суток точки (§5: правило дня TASK-052, константы общие — domain/day-part). */
const TREND_PART_SCHEMA = z.enum(['morning', 'evening', 'other']);

/** Флаг критичности точки (политика TASK-020, server-computed — §7): high/low. */
const TREND_CRITICAL_SCHEMA = z.enum(['high', 'low']);

/**
 * Сырая точка графика (§5): момент — пара (utcMs, tzOffsetMin) как хранится (EC-06),
 * значения как измерены, part — частью суток, critical — флагом политики. pulse и
 * critical опциональны: «не измерен»/«не критично» — поле отсутствует в JSON (§7).
 *
 * id записи (TASK-057 §12, ДОПОЛНЕНИЕ КОНТРАКТА — аддитивно): переход к правке из
 * тултипа графика открывает запись (TASK-038 edit-режим) — точка несёт её id
 * (uuid v7 агрегата, доставляет адаптер порта TASK-054). Опционально: daily-режим
 * правки не имеет (агрегат, §12), а точки без id (ручные фикстуры тестов) остаются
 * валидными — в продакшене id есть всегда.
 */
export const TREND_RAW_POINT_SCHEMA = z
  .object({
    utcMs: z.number().int(),
    tzOffsetMin: z.number().int(),
    sys: z.number().int(),
    dia: z.number().int(),
    pulse: z.number().int().optional(),
    part: TREND_PART_SCHEMA,
    critical: TREND_CRITICAL_SCHEMA.optional(),
    id: z.string().optional(),
  })
  .strict();

/**
 * Агрегат настенного дня (§5/§13): avg (округлён до 1 знака — правило отображения
 * 052) + min/max (целые) по обоим каналам; morningSysAvg/eveningSysAvg — средние
 * sys утра/вечера раздельно, только при наличии таких записей в дне (§13); count —
 * записей в дне (≥1: день существует, пока в нём есть точки).
 */
export const TREND_DAY_POINT_SCHEMA = z
  .object({
    wallDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sysAvg: z.number(),
    sysMin: z.number().int(),
    sysMax: z.number().int(),
    diaAvg: z.number(),
    diaMin: z.number().int(),
    diaMax: z.number().int(),
    morningSysAvg: z.number().optional(),
    eveningSysAvg: z.number().optional(),
    count: z.number().int().min(1),
  })
  .strict();

/**
 * §5/§11: ответ trend/series — {mode, points?|days?}: raw — массив сырых точек
 * (пустой период → {mode:'raw', points:[]}, §11), daily — массив дневных агрегатов,
 * сортированный по wallDate asc (§13). Ветка определяется mode (§5).
 */
export const TREND_RESPONSE_SCHEMA = z
  .object({
    mode: z.enum(['raw', 'daily']),
    points: z.array(TREND_RAW_POINT_SCHEMA).optional(),
    days: z.array(TREND_DAY_POINT_SCHEMA).optional(),
  })
  .strict();

/** Запрос trend/series (§11): {profileId, period}. */
export type TrendRequest = z.infer<typeof TREND_REQUEST_SCHEMA>;

/** Сырая точка графика (§5). */
export type RawPoint = z.infer<typeof TREND_RAW_POINT_SCHEMA>;

/** Агрегат настенного дня (§5/§13). */
export type DayPoint = z.infer<typeof TREND_DAY_POINT_SCHEMA>;

/** Ответ trend/series (§5): {mode: 'raw'|'daily', points?|days?}. */
export type TrendResponse = z.infer<typeof TREND_RESPONSE_SCHEMA>;
