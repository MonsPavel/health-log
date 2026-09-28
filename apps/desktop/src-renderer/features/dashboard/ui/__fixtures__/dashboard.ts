/**
 * TASK-057 §19: фикстуры компонентных тестов экрана «Динамика» — детерминированные
 * (без Date.now), с id записей (переход к правке §12), части суток всех трёх видов
 * (§13). Шкала — ESC/ESH 2018 с порогами high_normal 130/85 и hypertension1 140/90.
 */
import type { ActiveScale, DayPoint, RawPoint } from '@hl/contracts';

/** Фикстура активной шкалы (§20.1: подпись «ESC/ESH 2018» из sourceLabel данных). */
export const SCALE_FIXTURE: ActiveScale = {
  code: 'esc-esh-2018',
  version: '1.0.0',
  sourceLabel: 'ESC/ESH 2018',
  categories: [
    {
      code: 'optimal',
      label: 'Оптимальное',
      sysRange: { min: null, max: 119 },
      diaRange: { min: null, max: 79 },
    },
    {
      code: 'normal',
      label: 'Нормальное',
      sysRange: { min: 120, max: 129 },
      diaRange: { min: 80, max: 84 },
    },
    {
      code: 'high_normal',
      label: 'Высокое нормальное',
      sysRange: { min: 130, max: 139 },
      diaRange: { min: 85, max: 89 },
    },
    {
      code: 'hypertension1',
      label: 'АГ 1 степени',
      sysRange: { min: 140, max: 159 },
      diaRange: { min: 90, max: 99 },
    },
    {
      code: 'hypertension2',
      label: 'АГ 2 степени',
      sysRange: { min: 160, max: 179 },
      diaRange: { min: 100, max: 109 },
    },
    {
      code: 'hypertension3',
      label: 'АГ 3 степени',
      sysRange: { min: 180, max: null },
      diaRange: { min: 110, max: null },
    },
  ],
  homeBPNote: '…',
  specialGroupsNote: '…',
};

/** Настенная дата дня №0 фикстуры (30 дней — сентябрь 2026). */
const DAY_0_UTC_MS = Date.UTC(2026, 8, 1, 0, 0);

/** Точка фикстуры дня slotIndex (утро/вечер/other по расписанию ниже). */
export function fixturePoint(dayIndex: number, slot: 0 | 1 | 2): RawPoint {
  const slots = [
    {
      wallHour: 7,
      part: 'morning',
      sys: 120 + (dayIndex % 5),
      dia: 78 + (dayIndex % 4),
      pulse: 62 + (dayIndex % 3),
    },
    {
      wallHour: 20,
      part: 'evening',
      sys: 128 + (dayIndex % 6),
      dia: 84 + (dayIndex % 5),
      pulse: 70 + (dayIndex % 4),
    },
    { wallHour: 13, part: 'other', sys: 124, dia: 82, pulse: undefined },
  ] as const;
  const slotDef = slots[slot];
  return {
    utcMs: DAY_0_UTC_MS + dayIndex * 86_400_000 + slotDef.wallHour * 3_600_000,
    tzOffsetMin: 180,
    sys: slotDef.sys,
    dia: slotDef.dia,
    ...(slotDef.pulse !== undefined ? { pulse: slotDef.pulse } : {}),
    part: slotDef.part,
    id: `rec-${dayIndex}-${slot}`,
  };
}

/** 30 дней × 3 точки (утро/вечер/other) — 90 точек, §20.1 «фикстура 30 дней». */
export const TREND_30_DAYS: readonly RawPoint[] = Array.from({ length: 30 }, (_, day) => [
  fixturePoint(day, 0),
  fixturePoint(day, 1),
  fixturePoint(day, 2),
]).flat();

/** Одна точка (§13 пограничный: одна точка — маркер без линии). */
export const TREND_SINGLE_POINT: readonly RawPoint[] = [fixturePoint(0, 0)];

/** Дневные агрегаты (daily-режим, §20.5): три дня с коридорами. */
export const TREND_DAYS: readonly DayPoint[] = [
  {
    wallDate: '2026-03-01',
    sysAvg: 122,
    sysMin: 118,
    sysMax: 128,
    diaAvg: 79,
    diaMin: 76,
    diaMax: 82,
    morningSysAvg: 120,
    eveningSysAvg: 128,
    count: 3,
  },
  {
    wallDate: '2026-03-02',
    sysAvg: 124.5,
    sysMin: 120,
    sysMax: 130,
    diaAvg: 81,
    diaMin: 78,
    diaMax: 85,
    morningSysAvg: 121,
    count: 2,
  },
  {
    wallDate: '2026-03-03',
    sysAvg: 121,
    sysMin: 121,
    sysMax: 121,
    diaAvg: 80,
    diaMin: 80,
    diaMax: 80,
    count: 1,
  },
];
