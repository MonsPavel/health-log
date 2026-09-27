/**
 * TASK-052 §5/§19: golden-фикстуры — генератор детерминированных периодов + 5
 * ручных эталонов (NFR-10: воспроизводимая аналитика). Наборы §19:
 *  (a) classic30  — классический 30 дней × 4 записи (утро 07:00/08:00, вечер 19:00/20:00);
 *  (b) onlyMorning — только утренние, 5 дней (evening/other/delta undefined — §13);
 *  (c) gap14       — разрыв 14 дней посреди (7 дней + пропуск + 3 дня + одна дневная);
 *  (d) threeRecords— 3 записи за 2 дня (мало данных: оба insufficient true, §19);
 *  (e) criticals   — критические значения внутри (high и low по TASK-020).
 *
 * Эталоны (expected) выписаны ВРУЧНУЮ из определений §7/§13 и перепроверены вторым
 * способом — независимым скриптом пересчёта (§22); текстовые случаи формул
 * (SD n=1/n=2, округление) закреплены юнит-тестами stats-math. Пояс всех точек —
 * UTC+03:00 (без переходов) — настенное время воспроизводится точно. Пульс части —
 * только по записям ЧАСТИ с измеренным пульсом (§13: «не измерен» не тянет среднее).
 *
 * Флаг critical проставлен вручную по таблице TASK-020 §13 (180/120 high,
 * 90/60 low, границы включительно) — так боевую точку готовит адаптер порта.
 */
import { Instant, type Instant } from '@hl/kernel';

import type { PeriodStatistics, PartStats, ValueStats } from '../period-statistics.js';
import type { MeasurementPoint } from '../ports/measurement-points.js';

/** Пояс всех фикстур (фиксированный, без DST — настенное время воспроизводимо). */
export const FIXTURE_TZ_ISO = '+03:00';
const FIXTURE_TZ_OFFSET_MIN = 180;

/** Точка периода из настенного времени (детерминизм NFR-10; offset хранится в точке). */
export function point(
  dayIso: string,
  wallTime: string,
  sys: number,
  dia: number,
  pulse: number | undefined = undefined,
  critical: 'high' | 'low' | undefined = undefined,
): MeasurementPoint {
  return {
    sys,
    dia,
    pulse,
    takenAt: Instant.fromIso(`${dayIso}T${wallTime}:00.000${FIXTURE_TZ_ISO}`),
    critical,
  };
}

/** Настенный момент фикстуры — для эталонных полей-времён (lastMeasurementUtcMs). */
export function fixtureInstant(dayIso: string, wallTime: string): Instant {
  return Instant.fromIso(`${dayIso}T${wallTime}:00.000${FIXTURE_TZ_ISO}`);
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Следующий календарный день 'YYYY-MM-DD' (фикстуры живут в 2026 — год не високосный). */
function nextDay(dayIso: string): string {
  const [y, m, d] = dayIso.split('-').map(Number) as [number, number, number];
  const dim = MONTH_DAYS[m - 1] as number;
  if (d < dim) {
    return `${dayIso.slice(0, 8)}${String(d + 1).padStart(2, '0')}`;
  }
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-01`;
}

/** Слот дня генератора: настенное время и фиксированные значения (детерминизм, NFR-10). */
export interface DailySlot {
  readonly wallTime: string;
  readonly sys: number;
  readonly dia: number;
  readonly pulse: number | undefined;
  readonly critical: 'high' | 'low' | undefined;
}

/**
 * Генератор детерминированного периода (§5): `days` подряд идущих настенных дней
 * с `startDayIso`, каждый день — одни и те же слоты с одними и теми же значениями.
 * Порядок выдачи: по дням, внутри дня — по слотам.
 */
export function generateDailyPeriod(
  startDayIso: string,
  days: number,
  slots: readonly DailySlot[],
): MeasurementPoint[] {
  const points: MeasurementPoint[] = [];
  let day = startDayIso;
  for (let i = 0; i < days; i += 1) {
    for (const slot of slots) {
      points.push(point(day, slot.wallTime, slot.sys, slot.dia, slot.pulse, slot.critical));
    }
    day = nextDay(day);
  }
  return points;
}

// --- компактные конструкторы эталонных структур (§7) -----------------------------

const vs = (
  avg: number | undefined,
  min: number | undefined,
  max: number | undefined,
  sd: number | undefined,
): ValueStats => ({ avg, min, max, sd });

const part = (
  count: number,
  sys: ValueStats,
  dia: ValueStats,
  pulse: ValueStats | undefined,
): PartStats => ({ count, sys, dia, pulse });

// --- (a) классический 30 дней × 4 записи -----------------------------------------

/**
 * Слоты (a): sys 120/121 утром, 122/123 вечером; dia 80/81 утром, 82/80 вечером;
 * pulse 60..63. Эталоны: среднее утра 120.5 (sd 0.5), вечера 122.5 (sd 0.5);
 * общий sys 121.5 (sd 1.1: Σdev²=150, /119), dia 80.75→80.8 (sd 0.8: Σ=82.5/119),
 * pulse 61.5 (sd 1.1); delta = 2 / 0.5; 30 дней подряд → streak 30.
 */
const CLASSIC_SLOTS: readonly DailySlot[] = [
  { wallTime: '07:00', sys: 120, dia: 80, pulse: 60, critical: undefined },
  { wallTime: '08:00', sys: 121, dia: 81, pulse: 61, critical: undefined },
  { wallTime: '19:00', sys: 122, dia: 82, pulse: 62, critical: undefined },
  { wallTime: '20:00', sys: 123, dia: 80, pulse: 63, critical: undefined },
];

// --- (b) только утренние ----------------------------------------------------------

/** sys/dia — арифметическая прогрессия с шагом 2 (sd 3.2: Σdev²=40/4), pulse 58/64/68. */
function onlyMorningPoints(): MeasurementPoint[] {
  return [
    point('2026-03-02', '07:30', 118, 76, 58),
    point('2026-03-03', '07:30', 120, 78, undefined),
    point('2026-03-04', '07:30', 122, 80, 64),
    point('2026-03-05', '07:30', 124, 82, undefined),
    point('2026-03-06', '07:30', 126, 84, 68),
  ];
}

// --- (c) разрыв 14 дней посреди ----------------------------------------------------

/** 7 дней по (121/81/65) в 08:00 + 3 дня по (129/84/70) в 20:00 + одна дневная 12:00. */
function gap14Points(): MeasurementPoint[] {
  const points: MeasurementPoint[] = [];
  let day = '2026-03-01';
  for (let i = 0; i < 7; i += 1) {
    points.push(point(day, '08:00', 121, 81, 65));
    day = nextDay(day);
  }
  day = '2026-03-22'; // пропуск 2026-03-08..2026-03-21 — ровно 14 дней
  for (let i = 0; i < 3; i += 1) {
    points.push(point(day, '20:00', 129, 84, 70));
    day = nextDay(day);
  }
  points.push(point('2026-03-24', '12:00', 125, 83, undefined));
  return points;
}

// --- (d) 3 записи — мало данных -----------------------------------------------------

function threeRecordsPoints(): MeasurementPoint[] {
  return [
    point('2026-03-02', '07:00', 120, 80, 60),
    point('2026-03-02', '20:00', 130, 85, 70),
    point('2026-03-03', '07:00', 125, 82, 60),
  ];
}

// --- (e) критические значения -------------------------------------------------------

/** 185/110 → high (sys≥180); 88/58 → low; 200/120 → high (dia на границе, §13 TASK-020);
 *  90/60 → low (обе на границах включительно). */
function criticalsPoints(): MeasurementPoint[] {
  return [
    point('2026-04-01', '08:00', 125, 82, 70),
    point('2026-04-02', '07:30', 185, 110, 90, 'high'),
    point('2026-04-03', '08:00', 88, 58, 55, 'low'),
    point('2026-04-04', '19:30', 200, 120, undefined, 'high'),
    point('2026-04-05', '08:00', 90, 60, undefined, 'low'),
  ];
}

// --- реестр эталонов ----------------------------------------------------------------

/** Golden-фикстура §19: имя, детерминированные точки, полный ручной эталон §7. */
export interface GoldenFixture {
  readonly name: string;
  readonly points: () => MeasurementPoint[];
  readonly expected: PeriodStatistics;
}

/** Пять эталонных наборов §19 (AC §20 п. 1: все поля §7, включая undefined-ветки). */
export const GOLDEN_FIXTURES: readonly GoldenFixture[] = [
  {
    name: 'classic30 — 30 дней × 4 записи (утро+вечер)',
    points: () => generateDailyPeriod('2026-03-01', 30, CLASSIC_SLOTS),
    expected: {
      count: 120,
      sys: vs(121.5, 120, 123, 1.1),
      dia: vs(80.8, 80, 82, 0.8),
      pulse: vs(61.5, 60, 63, 1.1),
      morning: part(60, vs(120.5, 120, 121, 0.5), vs(80.5, 80, 81, 0.5), vs(60.5, 60, 61, 0.5)),
      evening: part(60, vs(122.5, 122, 123, 0.5), vs(81, 80, 82, 1), vs(62.5, 62, 63, 0.5)),
      other: undefined,
      delta: { sys: 2, dia: 0.5 },
      critical: { high: false, low: false },
      daysWithMeasurements: 30,
      longestStreakDays: 30,
      lastMeasurementUtcMs: fixtureInstant('2026-03-30', '20:00').utcMs,
      insufficientData: { tooFewMeasurements: false, tooFewDays: false },
    },
  },
  {
    name: 'onlyMorning — только утренние (evening/other/delta undefined)',
    points: onlyMorningPoints,
    expected: {
      count: 5,
      sys: vs(122, 118, 126, 3.2),
      dia: vs(80, 76, 84, 3.2),
      pulse: vs(63.3, 58, 68, 5),
      morning: part(5, vs(122, 118, 126, 3.2), vs(80, 76, 84, 3.2), vs(63.3, 58, 68, 5)),
      evening: undefined,
      other: undefined,
      delta: undefined,
      critical: { high: false, low: false },
      daysWithMeasurements: 5,
      longestStreakDays: 5,
      lastMeasurementUtcMs: fixtureInstant('2026-03-06', '07:30').utcMs,
      insufficientData: { tooFewMeasurements: true, tooFewDays: false },
    },
  },
  {
    name: 'gap14 — разрыв 14 дней посреди (streak 7, дней 10)',
    points: gap14Points,
    expected: {
      count: 11,
      sys: vs(123.5, 121, 129, 3.7),
      dia: vs(82, 81, 84, 1.4),
      pulse: vs(66.5, 65, 70, 2.4),
      morning: part(7, vs(121, 121, 121, 0), vs(81, 81, 81, 0), vs(65, 65, 65, 0)),
      evening: part(3, vs(129, 129, 129, 0), vs(84, 84, 84, 0), vs(70, 70, 70, 0)),
      other: part(1, vs(125, 125, 125, undefined), vs(83, 83, 83, undefined), undefined),
      delta: { sys: 8, dia: 3 },
      critical: { high: false, low: false },
      daysWithMeasurements: 10,
      longestStreakDays: 7,
      lastMeasurementUtcMs: fixtureInstant('2026-03-24', '20:00').utcMs,
      insufficientData: { tooFewMeasurements: false, tooFewDays: false },
    },
  },
  {
    name: 'threeRecords — 3 записи за 2 дня (мало данных: оба флага)',
    points: threeRecordsPoints,
    expected: {
      count: 3,
      sys: vs(125, 120, 130, 5),
      dia: vs(82.3, 80, 85, 2.5),
      pulse: vs(63.3, 60, 70, 5.8),
      morning: part(2, vs(122.5, 120, 125, 3.5), vs(81, 80, 82, 1.4), vs(60, 60, 60, 0)),
      evening: part(1, vs(130, 130, 130, undefined), vs(85, 85, 85, undefined), vs(70, 70, 70, undefined)),
      other: undefined,
      delta: { sys: 7.5, dia: 4 },
      critical: { high: false, low: false },
      daysWithMeasurements: 2,
      longestStreakDays: 2,
      lastMeasurementUtcMs: fixtureInstant('2026-03-03', '07:00').utcMs,
      insufficientData: { tooFewMeasurements: true, tooFewDays: true },
    },
  },
  {
    name: 'criticals — критические значения внутри (high и low)',
    points: criticalsPoints,
    expected: {
      count: 5,
      sys: vs(137.6, 88, 200, 52.5),
      dia: vs(86, 58, 120, 28.3),
      pulse: vs(71.7, 55, 90, 17.6),
      morning: part(4, vs(122, 88, 185, 45.3), vs(77.5, 58, 110, 24.2), vs(71.7, 55, 90, 17.6)),
      evening: part(1, vs(200, 200, 200, undefined), vs(120, 120, 120, undefined), undefined),
      other: undefined,
      delta: { sys: 78, dia: 42.5 },
      critical: { high: true, low: true },
      daysWithMeasurements: 5,
      longestStreakDays: 5,
      lastMeasurementUtcMs: fixtureInstant('2026-04-05', '08:00').utcMs,
      insufficientData: { tooFewMeasurements: true, tooFewDays: false },
    },
  },
];
