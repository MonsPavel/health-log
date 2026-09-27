/**
 * TASK-052 §7/§9: сборка read model PeriodStatistics — ЕДИНЫЙ контракт потребителей:
 * дашборд (TASK-061), PDF-отчёт (TASK-068), ИИ-контекст (TASK-083) (§3). Гибрид §4:
 * точки периода доставляет порт MeasurementPointsPort (зеркало measurement.listByPeriod,
 * без нового SQL), ВСЯ математика — чистые функции домена analytics (арх. 02 §3.2/§5),
 * здесь только сборка: агрегаты каналов → части суток → delta → критические →
 * регулярность → пороги «мало данных».
 *
 * Правила §13: part-stats только при ≥1 измерении в части (пустая часть — undefined,
 * UI не показывает пустые части); delta = evening−morning по каждому из СДА/ДДА и
 * только при обеих частях; pulse-агрегат — только по записям с измеренным пульсом
 * («не измерен» не тянет среднее), нет ни одного — undefined; regularity — по
 * настенным дням (EC-06); пороги insufficientData — kernel AI_MIN_MEASUREMENTS/
 * AI_MIN_DAYS (одно правило с AI Insight, арх. 02 §3.2). Пустой период → корректная
 * структура count=0 без NaN (§9, AC §20 п. 2). Округление avg/sd до 1 знака — §7,
 * делает домен (stats-math.summarize).
 *
 * scaleCategories — резерв TASK-053 (§5): с TASK-053 заменён типизированным полем
 * classification (категория «худшая из двух» + обязательные заметки FR-4.2): опциональный
 * параметр шкалы (расширение вызова аддитивно — без шкалы поля нет), insufficientData
 * (пороги kernel) → средние подаются классификатору как undefined → категория undefined
 * + note insufficientData (§13).
 */
import { AI_MIN_DAYS, AI_MIN_MEASUREMENTS } from '@hl/kernel';

import {
  classify,
  type Classification,
  type ScaleForClassification,
} from '../domain/classifier.js';
import { splitByDayPart } from '../domain/day-part.js';
import { regularity } from '../domain/regularity.js';
import {
  criticalPeriodFlag,
  difference,
  max,
  summarize,
  type BpAverages,
  type ValueStats,
} from '../domain/stats-math.js';

import type { MeasurementPoint } from './ports/measurement-points.js';

export type { ValueStats } from '../domain/stats-math.js';

/** Агрегаты одной части суток (§7): своя выборка, свой пульс. */
export interface PartStats {
  /** Измерений в части (≥1 — часть существует, §13). */
  readonly count: number;
  readonly sys: ValueStats;
  readonly dia: ValueStats;
  /** Пульс части: только по записям части с измеренным пульсом; нет таких → undefined. */
  readonly pulse: ValueStats | undefined;
}

/** Read model статистики периода (§7) — контракт TASK-061/068/083 (§3). */
export interface PeriodStatistics {
  /** Измерений в периоде. */
  readonly count: number;
  readonly sys: ValueStats;
  readonly dia: ValueStats;
  /** Пульс периода: нет ни одного измеренного пульса → undefined (§13). */
  readonly pulse: ValueStats | undefined;
  /** Части суток: нет измерений в части → undefined (§13). */
  readonly morning: PartStats | undefined;
  readonly evening: PartStats | undefined;
  readonly other: PartStats | undefined;
  /** вечер−утро по СДА/ДДА; только при обеих частях (§13). */
  readonly delta: { readonly sys: number; readonly dia: number } | undefined;
  /** Пометка критических значений за период (FR-4.3, политика TASK-020 по точкам). */
  readonly critical: { readonly high: boolean; readonly low: boolean };
  /** Уникальных настенных дней с измерениями (FR-4.4). */
  readonly daysWithMeasurements: number;
  /** Самая длинная серия подряд идущих таких дней (FR-4.4, §13 — период замкнут). */
  readonly longestStreakDays: number;
  /** Момент последнего измерения периода (max по takenAt.utcMs); период пуст → поля нет. */
  readonly lastMeasurementUtcMs?: number;
  /** «Мало данных» по порогам kernel (FR-5.4) — честный отказ ИИ от обобщений. */
  readonly insufficientData: {
    readonly tooFewMeasurements: boolean;
    readonly tooFewDays: boolean;
  };
  /**
   * Классификация средних по активной шкале (TASK-053 §5): категория «худшая из
   * двух» + ОБЕ заметки FR-4.2; insufficientData (пороги kernel) → категория
   * undefined + note insufficientData (§13). Шкала не передана → поля нет
   * (аддитивное расширение вызова).
   */
  readonly classification?: Classification;
}

/**
 * Агрегаты части суток (§13): часть создаётся только при ≥1 измерении — поэтому
 * undefined-средних внутри неё не бывает; пульс без измерений → undefined.
 */
function partStats(points: readonly MeasurementPoint[]): PartStats | undefined {
  if (points.length === 0) {
    return undefined;
  }
  const pulses = points.flatMap((point) => (point.pulse === undefined ? [] : [point.pulse]));
  return {
    count: points.length,
    sys: summarize(points.map((point) => point.sys)),
    dia: summarize(points.map((point) => point.dia)),
    pulse: pulses.length > 0 ? summarize(pulses) : undefined,
  };
}

/**
 * Средние части для delta (§13): часть существует только при ≥1 записи, значит
 * avg определён — инвариант конструирования partStats (тесты golden фиксируют).
 */
function partAverages(part: PartStats): BpAverages {
  return { sys: part.sys.avg as number, dia: part.dia.avg as number };
}

/**
 * Собирает PeriodStatistics из сырых точек периода (§7). Чистая функция: результат
 * зависит только от аргументов, порядок точек не влияет (§19 property-тесты).
 * Шкала (TASK-053 §5) опциональна: передана → собранные средние классифицируются;
 * при insufficientData (хотя бы один порог kernel поднят — единое правило EC-09)
 * в classify уходят undefined вместо средних — пороги kernel не дублируются в
 * классификаторе (§13: единый источник).
 */
export function buildPeriodStatistics(
  points: readonly MeasurementPoint[],
  scale?: ScaleForClassification,
): PeriodStatistics {
  const sysValues = points.map((point) => point.sys);
  const diaValues = points.map((point) => point.dia);
  const pulseValues = points.flatMap((point) => (point.pulse === undefined ? [] : [point.pulse]));

  const split = splitByDayPart(points);
  const morning = partStats(split.morning);
  const evening = partStats(split.evening);
  const other = partStats(split.other);

  const delta =
    morning !== undefined && evening !== undefined
      ? difference(partAverages(morning), partAverages(evening))
      : undefined;

  const days = regularity(points.map((point) => point.takenAt));
  const lastMeasurementUtcMs = max(points.map((point) => point.takenAt.utcMs));

  const insufficientData = {
    tooFewMeasurements: points.length < AI_MIN_MEASUREMENTS,
    tooFewDays: days.daysWithMeasurements < AI_MIN_DAYS,
  };

  const statistics: PeriodStatistics = {
    count: points.length,
    sys: summarize(sysValues),
    dia: summarize(diaValues),
    pulse: pulseValues.length > 0 ? summarize(pulseValues) : undefined,
    morning,
    evening,
    other,
    delta,
    critical: criticalPeriodFlag(points.map((point) => point.critical)),
    daysWithMeasurements: days.daysWithMeasurements,
    longestStreakDays: days.longestStreakDays,
    insufficientData,
  };

  // TASK-053 §5: шкала не передана → классификации нет (аддитивность); передана —
  // округлённые avg подаются как есть (§13), при insufficientData — как undefined.
  const insufficient = insufficientData.tooFewMeasurements || insufficientData.tooFewDays;
  const classification =
    scale === undefined
      ? undefined
      : classify(
          insufficient ? undefined : statistics.sys.avg,
          insufficient ? undefined : statistics.dia.avg,
          scale,
        );
  const withClassification =
    classification === undefined ? statistics : { ...statistics, classification };

  // Пустой период — поля нет вовсе (§7: lastMeasurementUtcMs? — опционально).
  return lastMeasurementUtcMs === undefined
    ? withClassification
    : { ...withClassification, lastMeasurementUtcMs };
}
