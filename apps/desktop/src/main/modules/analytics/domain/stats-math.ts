/**
 * TASK-052 §5/§7: доменная математика статистики — чистые функции mean/min/max/
 * sampleSd над сырыми значениями (арх. 02 §5: вычисления — чистый TS, а не
 * SQL-агрегаты: тестируемость и отсутствие SQL-диалектной математики SD, §4).
 *
 * SD — ВЫБОРОЧНОЕ (sample, знаменатель n−1) — зафиксировано §4; n<2 → undefined
 * (§13). Пустой вход mean/min/max → undefined, НЕ NaN: пустой период обязан давать
 * корректную структуру без NaN (§9, AC §20). Округление avg/sd до 1 знака —
 * правило отображения §7, применяется в summarize (единая точка; тесты фиксируют).
 *
 * Все функции чистые (арх. 02 §5): результат зависит только от аргументов, без
 * времени, I/O и состояния; O(n) — на 10k точек периода десятки мс (§15, TD-8:
 * без инкрементальных кэшей).
 */

/** Агрегаты одного измеримого канала (§7: {avg,min,max,sd}); нет данных → undefined (AC §20). */
export interface ValueStats {
  /** Среднее, округлённое до 1 знака (§7); нет данных → undefined. */
  readonly avg: number | undefined;
  /** Минимум (вход целочисленный — округление не требуется). */
  readonly min: number | undefined;
  /** Максимум (вход целочисленный — округление не требуется). */
  readonly max: number | undefined;
  /** Выборочное SD (n−1), округлённое до 1 знака; n<2 → undefined (§13). */
  readonly sd: number | undefined;
}

/** Среднее арифметическое; пустой набор → undefined (не NaN — AC §20). */
export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/** Минимум; пустой набор → undefined (AC §20). */
export function min(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  let result = values[0] as number;
  for (const v of values) {
    if (v < result) {
      result = v;
    }
  }
  return result;
}

/** Максимум; пустой набор → undefined (AC §20). */
export function max(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  let result = values[0] as number;
  for (const v of values) {
    if (v > result) {
      result = v;
    }
  }
  return result;
}

/**
 * Выборочное стандартное отклонение (знаменатель n−1, §4); n<2 → undefined (§13).
 * Формула: √( Σ(x−mean)² / (n−1) ).
 */
export function sampleSd(values: readonly number[]): number | undefined {
  const n = values.length;
  if (n < 2) {
    return undefined;
  }
  const m = mean(values) as number;
  let sumSquares = 0;
  for (const v of values) {
    sumSquares += (v - m) * (v - m);
  }
  return Math.sqrt(sumSquares / (n - 1));
}

/** Округление до 1 знака после запятой (§7: правило отображения avg/sd). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Сборка агрегатов канала из сырых значений (§7): avg/sd округляются до 1 знака
 * здесь — единственная точка правила отображения (§7, тесты фиксируют); min/max
 * остаются целыми. Пустой набор → все поля undefined (AC §20).
 */
export function summarize(values: readonly number[]): ValueStats {
  const avg = mean(values);
  const sd = sampleSd(values);
  return {
    avg: avg === undefined ? undefined : round1(avg),
    min: min(values),
    max: max(values),
    sd: sd === undefined ? undefined : round1(sd),
  };
}
