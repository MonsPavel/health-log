// TASK-056 §19: контракт-тесты zod-схем канала `trend/series` — zod на границе
// доверия (арх. 08 §4), strict-объекты (§14). Матрица:
//  - порог RAW_POINTS_LIMIT = 500 — константа контракта (§2/§5: «порог и форма —
//    в контракте»; правка дешёвая — константа одна, §22);
//  - период — ТА ЖЕ схема, что у stats/period (переиспользование ОБЯЗАТЕЛЬНО,
//    §23 TASK-054: копии периода для trend не создавать);
//  - request {profileId, period} — strict, profileId непустой (§14);
//  - RawPoint {utcMs, tzOffsetMin, sys, dia, pulse?, part, critical?, irregular?} —
//    плоская форма Instant + флаги; undefined-части отсутствуют в JSON (§7);
//    irregular — TASK-058 §7 (EC-10, аддитивно);
//  - DayPoint {wallDate, avg/min/max sys+dia, morningSysAvg?, eveningSysAvg?,
//    pulseAvg?, pulseCount?, count} (§5/§13: день с одной записью — avg=min=max;
//    pulseAvg/pulseCount — TASK-058 §5: среднее пульса дня только при наличии
//    записей с пульсом);
//  - константы PULSE_REF_LOW/HIGH = 60/100 — опорный коридор пульса, справка,
//    не классификация (TASK-058 §5: константы в @hl/contracts рядом с trend-типами);
//  - response {mode, points?|days?} — пустой период {mode:'raw', points:[]} (§11).
import { describe, expect, it } from 'vitest';

import { CHANNEL_SCHEMAS } from './schemas.js';
import { STATS_PERIOD_PARAM_SCHEMA } from './stats/schemas.js';
import {
  TREND_DAY_POINT_SCHEMA,
  TREND_RAW_POINT_SCHEMA,
  TREND_REQUEST_SCHEMA,
  TREND_RESPONSE_SCHEMA,
  PULSE_REF_HIGH,
  PULSE_REF_LOW,
  RAW_POINTS_LIMIT,
  type DayPoint,
  type RawPoint,
  type TrendResponse,
} from './trends.js';

describe('RAW_POINTS_LIMIT — порог raw/daily в контракте (§2/§5/§13)', () => {
  it('равен 500: ровно 500 → raw, 501 → daily (§13)', () => {
    expect(RAW_POINTS_LIMIT).toBe(500);
  });
});

describe('PULSE_REF_LOW/HIGH — опорный коридор пульса (TASK-058 §5: справка, не классификация)', () => {
  it('значения 60 и 100 уд/мин; коридор корректен (low < high)', () => {
    expect(PULSE_REF_LOW).toBe(60);
    expect(PULSE_REF_HIGH).toBe(100);
    expect(PULSE_REF_LOW).toBeLessThan(PULSE_REF_HIGH);
  });
});

describe('TREND_REQUEST_SCHEMA — запрос trend/series (§11: {profileId, period})', () => {
  it('принимает {profileId, period: пресет} и {profileId, period: custom}', () => {
    expect(TREND_REQUEST_SCHEMA.safeParse({ profileId: 'profile-1', period: 'all' }).success).toBe(
      true,
    );
    expect(
      TREND_REQUEST_SCHEMA.safeParse({
        profileId: 'profile-1',
        period: { fromUtcMs: 0, toUtcMs: 1 },
      }).success,
    ).toBe(true);
  });

  it('отклоняет пустой profileId, запрос без периода и без профиля (§14)', () => {
    expect(TREND_REQUEST_SCHEMA.safeParse({ profileId: '', period: 'all' }).success).toBe(false);
    expect(TREND_REQUEST_SCHEMA.safeParse({ profileId: 'p' }).success).toBe(false);
    expect(TREND_REQUEST_SCHEMA.safeParse({ period: 'all' }).success).toBe(false);
  });

  it('strict: отклоняет неизвестные поля (§14)', () => {
    expect(
      TREND_REQUEST_SCHEMA.safeParse({ profileId: 'p', period: 'all', arm: 'left' }).success,
    ).toBe(false);
  });

  it('период — ТА ЖЕ схема, что у stats/period (§23 054: переиспользование, копии не создавать)', () => {
    expect(TREND_REQUEST_SCHEMA.shape.period).toBe(STATS_PERIOD_PARAM_SCHEMA);
  });
});

describe('TREND_RAW_POINT_SCHEMA — сырая точка графика (§5)', () => {
  // TASK-057 §12 (ДОПОЛНЕНИЕ КОНТРАКТА, аддитивно): переход к правке из тултипа
  // графика — точка несёт id записи; режим daily правки не имеет (агрегат, §12).
  it('(057 §12) id записи: строка присутствует в точке с id; без id поле отсутствует (аддитивно)', () => {
    const withId = {
      utcMs: 0,
      tzOffsetMin: 180,
      sys: 120,
      dia: 80,
      part: 'morning',
      id: '0198abcd-7f12-7abc-9def-0123456789ab',
    };
    expect(TREND_RAW_POINT_SCHEMA.safeParse(withId).success).toBe(true);
    const withoutId = { utcMs: 0, tzOffsetMin: 180, sys: 120, dia: 80, part: 'morning' };
    expect(TREND_RAW_POINT_SCHEMA.safeParse(withoutId).success).toBe(true);
  });

  it('(057 §12) strict по-прежнему: id неверного типа отклоняется', () => {
    expect(
      TREND_RAW_POINT_SCHEMA.safeParse({
        utcMs: 0,
        tzOffsetMin: 0,
        sys: 120,
        dia: 80,
        part: 'other',
        id: 42,
      }).success,
    ).toBe(false);
  });

  it('принимает полную точку: pulse и critical присутствуют (сквозной флаг TASK-020)', () => {
    const point = {
      utcMs: 1_774_891_200_000,
      tzOffsetMin: 180,
      sys: 190,
      dia: 125,
      pulse: 70,
      part: 'evening',
      critical: 'high',
    };
    expect(TREND_RAW_POINT_SCHEMA.safeParse(point).success).toBe(true);
  });

  it('принимает точку без pulse и critical — undefined-части отсутствуют в JSON, не null (§7)', () => {
    const point = { utcMs: 0, tzOffsetMin: -300, sys: 120, dia: 80, part: 'morning' };
    expect(TREND_RAW_POINT_SCHEMA.safeParse(point).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...point, pulse: null }).success).toBe(false);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...point, critical: null }).success).toBe(false);
  });

  it('part ограничен правилом дня TASK-052: morning/evening/other', () => {
    const base = { utcMs: 0, tzOffsetMin: 0, sys: 120, dia: 80 };
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, part: 'morning' }).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, part: 'evening' }).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, part: 'other' }).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, part: 'noon' }).success).toBe(false);
  });

  it('critical ограничен политикой TASK-020: high/low (§7)', () => {
    const base = { utcMs: 0, tzOffsetMin: 0, sys: 120, dia: 80, part: 'other' };
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, critical: 'high' }).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, critical: 'low' }).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, critical: 'medium' }).success).toBe(false);
  });

  // TASK-058 §7 (ДОПОЛНЕНИЕ КОНТРАКТА, аддитивно): EC-10 — запись с флагом
  // «неровный пульс» маркируется на графике; нет флага — поле отсутствует в JSON.
  it('(058 §7) irregular: true принимается; без флага поле отсутствует; не-boolean и null отклоняются', () => {
    const base = { utcMs: 0, tzOffsetMin: 0, sys: 120, dia: 80, pulse: 75, part: 'other' };
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, irregular: true }).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse(base).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, irregular: false }).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, irregular: 'yes' }).success).toBe(false);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, irregular: null }).success).toBe(false);
  });

  // TASK-059 §5 (ДОПОЛНЕНИЕ КОНТРАКТА, аддитивно): таблица-альтернатива графику
  // строится из ТОГО ЖЕ TrendResponse (§4: «ноль параллельных вычислений») —
  // колонка «Рука» требует arm в сырой точке; прецедент irregular TASK-058.
  it('(059 §5) arm: left/right принимается; без руки поле отсутствует; прочие значения отклоняются', () => {
    const base = { utcMs: 0, tzOffsetMin: 0, sys: 120, dia: 80, part: 'other' };
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, arm: 'left' }).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, arm: 'right' }).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse(base).success).toBe(true);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, arm: 'both' }).success).toBe(false);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, arm: null }).success).toBe(false);
  });

  it('значения целые: дробные sys/pulse/utcMs отклоняются', () => {
    const base = { utcMs: 0, tzOffsetMin: 0, dia: 80, part: 'other' };
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, sys: 120.5 }).success).toBe(false);
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, sys: 120, pulse: 60.5 }).success).toBe(
      false,
    );
    expect(TREND_RAW_POINT_SCHEMA.safeParse({ ...base, sys: 120, utcMs: 0.5 }).success).toBe(false);
  });

  it('strict: неизвестные поля отклоняются (§14)', () => {
    expect(
      TREND_RAW_POINT_SCHEMA.safeParse({
        utcMs: 0,
        tzOffsetMin: 0,
        sys: 120,
        dia: 80,
        part: 'other',
        note: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('TREND_DAY_POINT_SCHEMA — агрегат настенного дня (§5/§13)', () => {
  it('принимает полный агрегат: avg/min/max обоих каналов + morning/evening средние + count', () => {
    const day = {
      wallDate: '2026-03-02',
      sysAvg: 124,
      sysMin: 120,
      sysMax: 130,
      diaAvg: 82.3,
      diaMin: 80,
      diaMax: 85,
      morningSysAvg: 121,
      eveningSysAvg: 130,
      count: 3,
    };
    expect(TREND_DAY_POINT_SCHEMA.safeParse(day).success).toBe(true);
  });

  it('принимает день без morning/evening средних (нет утренних/вечерних — поля отсутствуют, §13)', () => {
    const day = {
      wallDate: '2026-03-03',
      sysAvg: 125,
      sysMin: 125,
      sysMax: 125,
      diaAvg: 82,
      diaMin: 82,
      diaMax: 82,
      count: 1,
    };
    expect(TREND_DAY_POINT_SCHEMA.safeParse(day).success).toBe(true);
  });

  it('wallDate — ISO-строка YYYY-MM-DD (§17: локализует UI), count ≥ 1 (день существует — есть точки)', () => {
    const base = {
      sysAvg: 120,
      sysMin: 120,
      sysMax: 120,
      diaAvg: 80,
      diaMin: 80,
      diaMax: 80,
      count: 1,
    };
    expect(TREND_DAY_POINT_SCHEMA.safeParse({ wallDate: '2026-03-02', ...base }).success).toBe(
      true,
    );
    expect(TREND_DAY_POINT_SCHEMA.safeParse({ wallDate: '2026-3-2', ...base }).success).toBe(false);
    expect(
      TREND_DAY_POINT_SCHEMA.safeParse({ wallDate: '2026-03-02T00:00', ...base }).success,
    ).toBe(false);
    expect(
      TREND_DAY_POINT_SCHEMA.safeParse({ wallDate: '2026-03-02', ...base, count: 0 }).success,
    ).toBe(false);
  });

  // TASK-058 §5: среднее пульса дня + число записей с пульсом — ветка daily
  // графика ЧСС («avg+коридор»); нет записей с пульсом — поля отсутствуют (§7).
  it('(058 §5) pulseAvg/pulseCount принимаются; без пульса в дне — поля отсутствуют; pulseCount ≥ 1', () => {
    const base = {
      wallDate: '2026-03-02',
      sysAvg: 120,
      sysMin: 120,
      sysMax: 120,
      diaAvg: 80,
      diaMin: 80,
      diaMax: 80,
      count: 2,
    };
    expect(
      TREND_DAY_POINT_SCHEMA.safeParse({ ...base, pulseAvg: 64.7, pulseCount: 1 }).success,
    ).toBe(true);
    expect(TREND_DAY_POINT_SCHEMA.safeParse(base).success).toBe(true);
    expect(TREND_DAY_POINT_SCHEMA.safeParse({ ...base, pulseCount: 0 }).success).toBe(false);
    expect(TREND_DAY_POINT_SCHEMA.safeParse({ ...base, pulseAvg: '60' }).success).toBe(false);
  });

  it('strict: неизвестные поля отклоняются (§14)', () => {
    expect(
      TREND_DAY_POINT_SCHEMA.safeParse({
        wallDate: '2026-03-02',
        sysAvg: 120,
        sysMin: 120,
        sysMax: 120,
        diaAvg: 80,
        diaMin: 80,
        diaMax: 80,
        count: 1,
        median: 60,
      }).success,
    ).toBe(false);
  });
});

describe('TREND_RESPONSE_SCHEMA — ответ trend/series (§5: {mode, points?|days?})', () => {
  const RAW_POINT: RawPoint = {
    utcMs: 0,
    tzOffsetMin: 180,
    sys: 120,
    dia: 80,
    part: 'morning',
  };
  const DAY_POINT: DayPoint = {
    wallDate: '2026-03-02',
    sysAvg: 120,
    sysMin: 120,
    sysMax: 120,
    diaAvg: 80,
    diaMin: 80,
    diaMax: 80,
    count: 1,
  };

  it('принимает raw-режим с точками; пустой период — {mode:"raw", points:[]} (§11)', () => {
    expect(TREND_RESPONSE_SCHEMA.safeParse({ mode: 'raw', points: [] }).success).toBe(true);
    expect(TREND_RESPONSE_SCHEMA.safeParse({ mode: 'raw', points: [RAW_POINT] }).success).toBe(
      true,
    );
  });

  it('принимает daily-режим с днями (§5: порог превышен → агрегация)', () => {
    expect(TREND_RESPONSE_SCHEMA.safeParse({ mode: 'daily', days: [DAY_POINT] }).success).toBe(
      true,
    );
  });

  it('mode ограничен raw/daily; strict: неизвестные поля отклоняются (§14)', () => {
    expect(TREND_RESPONSE_SCHEMA.safeParse({ mode: 'hourly', points: [] }).success).toBe(false);
    // Форма §5 плоская (points?/days? опциональны): взаимоисключительность веток —
    // поведение read model (§2), схема карает только НЕИЗВЕСТНЫЕ поля (§14).
    expect(TREND_RESPONSE_SCHEMA.safeParse({ mode: 'raw', points: [], cached: true }).success).toBe(
      false,
    );
  });

  it('типы выводятся из схем (§23): TrendResponse = z.infer', () => {
    const parsed: TrendResponse = TREND_RESPONSE_SCHEMA.parse({ mode: 'raw', points: [] });
    expect(parsed.mode).toBe('raw');
  });
});

describe('реестр каналов — trend/series подключён (§5)', () => {
  it('CHANNEL_SCHEMAS["trend/series"] несёт пары схем тренда (контракт + хендлер, §5)', () => {
    expect(CHANNEL_SCHEMAS['trend/series']?.request).toBe(TREND_REQUEST_SCHEMA);
    expect(CHANNEL_SCHEMAS['trend/series']?.response).toBe(TREND_RESPONSE_SCHEMA);
  });
});
