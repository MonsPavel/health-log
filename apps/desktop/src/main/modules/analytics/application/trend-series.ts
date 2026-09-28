/**
 * TASK-056 §5/§9: TrendSeries — read model серий точек для графика динамики (FR-3.5):
 * сырые точки (момент, sys, dia, pulse, part, critical) ДО порога включительно и
 * автоматическая агрегация «день = среднее + диапазон» при превышении. Переключение
 * режимов — поведение read model, а не забота UI (§2): порог RAW_POINTS_LIMIT = 500
 * живёт в контракте (§2/§5, одна константа — §22), здесь он применяется.
 *
 * ЧИСТАЯ СБОРКА НАД ТОЧКАМИ (§9, арх. 05 §5): точек период достаёт порт
 * MeasurementPointsPort (052, боевой — адаптер журнала, без нового SQL), вся
 * математика — домен analytics: part — правило дня TASK-052 (domain/day-part),
 * avg — summarize домена (правило отображения 052: округление до 1 знака; min/max
 * целые), группировка дней — настенная дата момента с ЕГО offset (TASK-046, EC-06).
 * critical — политика TASK-020, поставленная адаптером порта, прокидывается как есть
 * (§7: server-computed, согласовано с TASK-042) — пороги здесь не дублируются.
 *
 * ДЕТЕРМИНИЗМ (§9, NFR-10): сортировка точек по utc asc (график слева-направо),
 * tie-break id asc (uuid v7 — сортируем по времени создания; порт порядок выборки не
 * гарантирует). Ответ daily сортирован по wallDate asc (§13) — ЯВНО: при смешанных
 * offset записей (перелёты, EC-06) utc-порядок входа не обязан совпадать с настенным.
 *
 * ГРАНИЦЫ ПОРОГА (§13): ровно 500 точек в периоде → raw, 501 → daily; порог считается
 * по точкам ПЕРИОДА (§7). Пустой период → {mode:'raw', points:[]} — валидный ответ,
 * не ошибка (§11). Своих доменных отказов нет: STORAGE/* пробрасывает порт выше.
 *
 * ФОРМА ОТВЕТА (§5): raw — {mode:'raw', points}, daily — {mode:'daily', days}: ветка
 * строится явно (undefined-части в JSON отсутствуют, §7 — не null-простыня).
 */
import {
  RAW_POINTS_LIMIT,
  type DayPoint,
  type RawPoint,
  type StatsPeriodParam,
  type TrendResponse,
} from '@hl/contracts';
import { Instant, type Clock } from '@hl/kernel';

import { dayPartOf } from '../domain/day-part.js';
import { summarize } from '../domain/stats-math.js';
import { periodBoundsOf } from './get-period-statistics.js';
import type { MeasurementPoint, MeasurementPointsPort } from './ports/measurement-points.js';

/** Зависимости read model (§7): порт точек и время для пресетов периода (§9 054). */
export interface TrendSeriesDeps {
  /** Порт точек периода (боевой — адаптер журнала; fake — в тестах, §19). */
  readonly points: MeasurementPointsPort;
  /** Порт времени: пресеты периода считаются от «сейчас» (TASK-044). */
  readonly clock: Clock;
}

/**
 * Сравнение точек серии (§9): utc asc — график слева-направо; при равных utc —
 * id asc (uuid v7: стабильный полный порядок, NFR-10). Точки без id (ручные
 * фикстуры тестов) сохраняют порядок входа — сортировка Array#sort стабильна.
 */
function compareByUtcThenId(a: MeasurementPoint, b: MeasurementPoint): number {
  if (a.takenAt.utcMs !== b.takenAt.utcMs) {
    return a.takenAt.utcMs - b.takenAt.utcMs;
  }
  if (a.id !== undefined && b.id !== undefined && a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/**
 * Сырая точка провода (§5): плоская проекция точки порта — момент парой
 * (utcMs, tzOffsetMin) как хранится (EC-06), part правилом дня TASK-052, critical
 * прокинут. pulse/critical «нет» → поле отсутствует в JSON (§7, flat-маппинг).
 * id записи — TASK-057 §12 (переход к правке из тултипа): прокидывается, когда
 * порт его доставил (боевой адаптер — всегда; ручные фикстуры — поле отсутствует).
 * irregular — TASK-058 §7/§9 (EC-10): флаг записи «неровный пульс» — как есть.
 */
function toRawPoint(point: MeasurementPoint): RawPoint {
  return {
    utcMs: point.takenAt.utcMs,
    tzOffsetMin: point.takenAt.tzOffsetMin,
    sys: point.sys,
    dia: point.dia,
    ...(point.pulse !== undefined ? { pulse: point.pulse } : {}),
    part: dayPartOf(point.takenAt),
    ...(point.critical !== undefined ? { critical: point.critical } : {}),
    ...(point.irregular === true ? { irregular: true } : {}),
    ...(point.arm !== undefined ? { arm: point.arm } : {}),
    ...(point.id !== undefined ? { id: point.id } : {}),
  };
}

/** Настенная дата момента 'YYYY-MM-DD' (TASK-046): срез ISO-строки kernel — календарная математика не дублируется. */
function wallDateOf(instant: Instant): string {
  return Instant.toIso(instant).slice(0, 10);
}

/**
 * Агрегат одного дня (§13): день существует, пока в нём есть точки, поэтому
 * avg/min/max определены (инвариант конструирования — юнит-тесты фиксируют);
 * avg округлён правилом отображения 052 (1 знак), min/max целые. morningSysAvg/
 * eveningSysAvg — только при наличии утренних/вечерних записей в дне (§13).
 * pulseAvg/pulseCount — TASK-058 §5/§13: среднее пульса дня (правило 052) и число
 * записей с измеренным пульсом — только при наличии таких записей («не измерен»
 * не тянет ни avg, ни count — согласовано со статистикой 052, §13 058).
 */
function dayPointOf(wallDate: string, dayPoints: readonly MeasurementPoint[]): DayPoint {
  const sys = summarize(dayPoints.map((point) => point.sys));
  const dia = summarize(dayPoints.map((point) => point.dia));
  const morningSys = summarize(
    dayPoints.filter((point) => dayPartOf(point.takenAt) === 'morning').map((point) => point.sys),
  );
  const eveningSys = summarize(
    dayPoints.filter((point) => dayPartOf(point.takenAt) === 'evening').map((point) => point.sys),
  );
  const pulseValues = dayPoints.flatMap((point) =>
    point.pulse === undefined ? [] : [point.pulse],
  );
  const pulse = summarize(pulseValues);
  return {
    wallDate,
    sysAvg: sys.avg as number,
    sysMin: sys.min as number,
    sysMax: sys.max as number,
    diaAvg: dia.avg as number,
    diaMin: dia.min as number,
    diaMax: dia.max as number,
    ...(morningSys.avg !== undefined ? { morningSysAvg: morningSys.avg } : {}),
    ...(eveningSys.avg !== undefined ? { eveningSysAvg: eveningSys.avg } : {}),
    ...(pulse.avg !== undefined ? { pulseAvg: pulse.avg } : {}),
    ...(pulseValues.length > 0 ? { pulseCount: pulseValues.length } : {}),
    count: dayPoints.length,
  };
}

/**
 * Группировка точек по настенным дням (§4/§13): день — настенная дата точки с ЕЁ
 * offset (EC-06); выход сортирован wallDate asc ЯВНО (utc-порядок входа при смешанных
 * offset может не совпадать с настенным). Порядок точек внутри дня на агрегаты не
 * влияет (§19: агрегаты порядок-инвариантны).
 */
export function buildDayPoints(points: readonly MeasurementPoint[]): DayPoint[] {
  const byDay = new Map<string, MeasurementPoint[]>();
  for (const point of points) {
    const wallDate = wallDateOf(point.takenAt);
    const bucket = byDay.get(wallDate);
    if (bucket === undefined) {
      byDay.set(wallDate, [point]);
    } else {
      bucket.push(point);
    }
  }
  return [...byDay.entries()]
    .sort(([aDate], [bDate]) => (aDate < bDate ? -1 : aDate > bDate ? 1 : 0))
    .map(([wallDate, dayPoints]) => dayPointOf(wallDate, dayPoints));
}

/** Read model серий точек графика (§5): getTrendSeries(profileId, period) → TrendResponse. */
export class TrendSeries {
  private readonly points: MeasurementPointsPort;

  private readonly clock: Clock;

  constructor(deps: TrendSeriesDeps) {
    this.points = deps.points;
    this.clock = deps.clock;
  }

  /**
   * Серия точек периода (§9): границы периода (пресеты — от Clock, custom — как есть,
   * переиспользование periodBoundsOf TASK-054) → точки порта → режим по порогу →
   * ответ. Детерминизм: одинаковые запросы на неизменных данных — одинаковые ответы
   * (кэш-дружелюбность, §12/TD-8).
   */
  async getTrendSeries(profileId: string, period: StatsPeriodParam): Promise<TrendResponse> {
    const bounds = periodBoundsOf(period, this.clock.nowMs());
    const points = await this.points.listByPeriod({ profileId, ...bounds });

    // Пустой период — валидный ответ (§11), не ошибка.
    if (points.length === 0) {
      return { mode: 'raw', points: [] };
    }

    const sorted = [...points].sort(compareByUtcThenId);

    // Порог по точкам ПЕРИОДА (§7/§13): ровно 500 → raw, 501 → daily.
    if (sorted.length > RAW_POINTS_LIMIT) {
      return { mode: 'daily', days: buildDayPoints(sorted) };
    }
    return { mode: 'raw', points: sorted.map(toRawPoint) };
  }
}
