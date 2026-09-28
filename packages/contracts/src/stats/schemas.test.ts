// TASK-054 §19: контракт-тесты zod-схем канала `stats/period` — zod на границе
// доверия (арх. 08 §4), strict-объекты (§14). Матрица:
//  - period — пресеты 7d/30d/90d/all ИЛИ custom {fromUtcMs, toUtcMs} (§5; семантики
//    TASK-044/046; переиспользование схемы TASK-056 — §23);
//  - request {profileId, period} — strict, profileId непустой (§14);
//  - response {stats: PeriodStatisticsDto, scale} — плоская форма read model 052:
//    undefined-части отсутствуют (не null-простыня — §7), classification с категорией
//    и обязательными заметками (053), пустой период валиден (§11).
import { describe, expect, it } from 'vitest';

import { BP_RANGE_SCHEMA, SCALE_CATEGORY_SCHEMA, SCALE_VERSION_SCHEMA } from '../scales.js';
import {
  PERIOD_STATISTICS_DTO_SCHEMA,
  STATS_PERIOD_PARAM_SCHEMA,
  STATS_REQUEST_SCHEMA,
  STATS_RESPONSE_SCHEMA,
} from './schemas.js';

/** Полная категория (зеркало данных пакета) — для проверки classification в DTO. */
const CATEGORY = {
  code: 'normal',
  label: 'Нормальное давление',
  sysRange: { min: 120, max: 129 },
  diaRange: { min: 80, max: 84 },
};

describe('STATS_PERIOD_PARAM_SCHEMA — период канала (§5: пресеты + custom, §23: переиспользование 056)', () => {
  it('принимает пресеты 7d/30d/90d/all (TASK-044)', () => {
    for (const preset of ['7d', '30d', '90d', 'all'] as const) {
      expect(STATS_PERIOD_PARAM_SCHEMA.safeParse(preset).success).toBe(true);
    }
  });

  it('принимает custom {fromUtcMs, toUtcMs} — целые (TASK-046: границы включительно)', () => {
    expect(STATS_PERIOD_PARAM_SCHEMA.safeParse({ fromUtcMs: 0, toUtcMs: 86_400_000 }).success).toBe(
      true,
    );
    expect(STATS_PERIOD_PARAM_SCHEMA.safeParse({ fromUtcMs: -1, toUtcMs: 0 }).success).toBe(true);
  });

  it('отклоняет неизвестный пресет и неполный custom', () => {
    expect(STATS_PERIOD_PARAM_SCHEMA.safeParse('15d').success).toBe(false);
    expect(STATS_PERIOD_PARAM_SCHEMA.safeParse('all ').success).toBe(false);
    expect(STATS_PERIOD_PARAM_SCHEMA.safeParse({ fromUtcMs: 0 }).success).toBe(false);
    expect(STATS_PERIOD_PARAM_SCHEMA.safeParse({ toUtcMs: 0 }).success).toBe(false);
  });

  it('отклоняет дробные границы custom и лишние поля (strict, §14)', () => {
    expect(STATS_PERIOD_PARAM_SCHEMA.safeParse({ fromUtcMs: 0.5, toUtcMs: 1 }).success).toBe(false);
    expect(
      STATS_PERIOD_PARAM_SCHEMA.safeParse({ fromUtcMs: 0, toUtcMs: 1, extra: 'x' }).success,
    ).toBe(false);
  });

  it('отклоняет не-строки и не-объекты', () => {
    expect(STATS_PERIOD_PARAM_SCHEMA.safeParse(30).success).toBe(false);
    expect(STATS_PERIOD_PARAM_SCHEMA.safeParse(null).success).toBe(false);
  });
});

describe('STATS_REQUEST_SCHEMA — запрос stats/period (§5/§14: profileId в схеме)', () => {
  it('принимает {profileId, period: пресет} и {profileId, period: custom}', () => {
    expect(STATS_REQUEST_SCHEMA.safeParse({ profileId: 'profile-1', period: '30d' }).success).toBe(
      true,
    );
    expect(
      STATS_REQUEST_SCHEMA.safeParse({
        profileId: 'profile-1',
        period: { fromUtcMs: 0, toUtcMs: 1 },
      }).success,
    ).toBe(true);
  });

  it('отклоняет пустой profileId и период без профиля (§14: принудительный скоуп)', () => {
    expect(STATS_REQUEST_SCHEMA.safeParse({ profileId: '', period: '30d' }).success).toBe(false);
    expect(STATS_REQUEST_SCHEMA.safeParse({ period: '30d' }).success).toBe(false);
  });

  it('strict: отклоняет неизвестные поля (§14)', () => {
    expect(
      STATS_REQUEST_SCHEMA.safeParse({ profileId: 'p', period: 'all', arm: 'left' }).success,
    ).toBe(false);
  });
});

describe('PERIOD_STATISTICS_DTO_SCHEMA — плоская форма read model 052 (§5/§7)', () => {
  it('принимает полный DTO: агрегаты, части суток, delta, критические, регулярность, classification', () => {
    const dto = {
      count: 120,
      sys: { avg: 121.5, min: 120, max: 123, sd: 1.1 },
      dia: { avg: 80.8, min: 80, max: 82, sd: 0.8 },
      pulse: { avg: 61.5, min: 60, max: 63, sd: 1.1 },
      morning: {
        count: 60,
        sys: { avg: 120.5, min: 120, max: 121, sd: 0.5 },
        dia: { avg: 80.5, min: 80, max: 81, sd: 0.5 },
        pulse: { avg: 60.5, min: 60, max: 61, sd: 0.5 },
      },
      evening: {
        count: 60,
        sys: { avg: 122.5, min: 122, max: 123, sd: 0.5 },
        dia: { avg: 81, min: 80, max: 82, sd: 1 },
        pulse: { avg: 62.5, min: 62, max: 63, sd: 0.5 },
      },
      delta: { sys: 2, dia: 0.5 },
      critical: { high: false, low: false },
      daysWithMeasurements: 30,
      longestStreakDays: 30,
      lastMeasurementUtcMs: 1_774_891_200_000,
      insufficientData: { tooFewMeasurements: false, tooFewDays: false },
      classification: {
        category: CATEGORY,
        notes: [
          { kind: 'homeBP', text: 'порог дома' },
          { kind: 'specialGroups', text: 'особые группы' },
        ],
      },
    };
    expect(PERIOD_STATISTICS_DTO_SCHEMA.safeParse(dto).success).toBe(true);
  });

  it('принимает пустой период: undefined-части отсутствуют в JSON, а не null (§7/§11)', () => {
    const empty = {
      count: 0,
      sys: {},
      dia: {},
      critical: { high: false, low: false },
      daysWithMeasurements: 0,
      longestStreakDays: 0,
      insufficientData: { tooFewMeasurements: true, tooFewDays: true },
      classification: { notes: [{ kind: 'insufficientData', text: 'Данных пока мало.' }] },
    };
    expect(PERIOD_STATISTICS_DTO_SCHEMA.safeParse(empty).success).toBe(true);
  });

  it('отклоняет null-простыню: avg null не проходит (undefined отсутствует, §7)', () => {
    expect(
      PERIOD_STATISTICS_DTO_SCHEMA.safeParse({
        count: 0,
        sys: { avg: null },
        dia: {},
        critical: { high: false, low: false },
        daysWithMeasurements: 0,
        longestStreakDays: 0,
        insufficientData: { tooFewMeasurements: true, tooFewDays: true },
      }).success,
    ).toBe(false);
  });

  it('отклоняет NaN-формы: дробный count и булевы флаги не того типа', () => {
    expect(
      PERIOD_STATISTICS_DTO_SCHEMA.safeParse({
        count: 1.5,
        sys: {},
        dia: {},
        critical: { high: false, low: false },
        daysWithMeasurements: 0,
        longestStreakDays: 0,
        insufficientData: { tooFewMeasurements: true, tooFewDays: true },
      }).success,
    ).toBe(false);
    expect(
      PERIOD_STATISTICS_DTO_SCHEMA.safeParse({
        count: 1,
        sys: {},
        dia: {},
        critical: { high: 'yes', low: false },
        daysWithMeasurements: 0,
        longestStreakDays: 0,
        insufficientData: { tooFewMeasurements: true, tooFewDays: true },
      }).success,
    ).toBe(false);
  });

  it('strict: отклоняет неизвестные поля (§14)', () => {
    expect(
      PERIOD_STATISTICS_DTO_SCHEMA.safeParse({
        count: 1,
        sys: {},
        dia: {},
        critical: { high: false, low: false },
        daysWithMeasurements: 1,
        longestStreakDays: 1,
        insufficientData: { tooFewMeasurements: false, tooFewDays: false },
        scaleCategories: [],
      }).success,
    ).toBe(false);
  });

  it('classification: kind ограничен заметками 053 (homeBP/specialGroups/insufficientData)', () => {
    expect(
      PERIOD_STATISTICS_DTO_SCHEMA.safeParse({
        count: 1,
        sys: {},
        dia: {},
        critical: { high: false, low: false },
        daysWithMeasurements: 1,
        longestStreakDays: 1,
        insufficientData: { tooFewMeasurements: false, tooFewDays: false },
        classification: { notes: [{ kind: 'other', text: 'x' }] },
      }).success,
    ).toBe(false);
  });
});

describe('STATS_RESPONSE_SCHEMA — ответ stats/period (§5: {stats, scale})', () => {
  const STATS = {
    count: 0,
    sys: {},
    dia: {},
    critical: { high: false, low: false },
    daysWithMeasurements: 0,
    longestStreakDays: 0,
    insufficientData: { tooFewMeasurements: true, tooFewDays: true },
  };

  it('принимает {stats, scale: {code, version, sourceLabel}}', () => {
    expect(
      STATS_RESPONSE_SCHEMA.safeParse({
        stats: STATS,
        scale: { code: 'bp_office_esc2018', version: '1.0.0', sourceLabel: 'ESC 2018' },
      }).success,
    ).toBe(true);
  });

  it('отклоняет ответ без scale и scale без sourceLabel (§5: источник/версия обязательны)', () => {
    expect(STATS_RESPONSE_SCHEMA.safeParse({ stats: STATS }).success).toBe(false);
    expect(
      STATS_RESPONSE_SCHEMA.safeParse({
        stats: STATS,
        scale: { code: 'bp_office_esc2018', version: '1.0.0' },
      }).success,
    ).toBe(false);
  });

  it('version — семвер (переиспользование SCALE_VERSION_SCHEMA, §7 051)', () => {
    expect(SCALE_VERSION_SCHEMA.safeParse('1.0').success).toBe(false);
    expect(
      STATS_RESPONSE_SCHEMA.safeParse({
        stats: STATS,
        scale: { code: 'c', version: '1.0', sourceLabel: 's' },
      }).success,
    ).toBe(false);
  });

  it('strict: неизвестные поля в ответе отклоняются (§14)', () => {
    expect(
      STATS_RESPONSE_SCHEMA.safeParse({
        stats: STATS,
        scale: { code: 'c', version: '1.0.0', sourceLabel: 's' },
        cached: true,
      }).success,
    ).toBe(false);
  });
});

describe('переиспользование схем шкалы (§22: без дрейфа зеркал)', () => {
  it('категория в classification — та же схема, что у scales/active (SCALE_CATEGORY_SCHEMA)', () => {
    expect(SCALE_CATEGORY_SCHEMA.safeParse(CATEGORY).success).toBe(true);
    expect(BP_RANGE_SCHEMA.safeParse(CATEGORY.sysRange).success).toBe(true);
  });
});
