/**
 * TASK-018 §2/§7: TypoHeuristic — чистая функция «вероятной опечатки» давления
 * (персона П3, тремор рук: 215 вместо 125, SRS FR-1.6). Для каждого поля (sys, dia
 * — независимо) считает медиану значений истории и отклонение кандидата
 * abs(value − median); флаг — по худшему отклонению, только если оно СТРОГО больше
 * TYPO_THRESHOLD_MMHG (§13: ровно 40 — сигнала нет). Медиана (не среднее) —
 * устойчивость к уже содержащимся опечаткам и редким пикам (§4); чётный массив —
 * среднее двух центральных (стандартное определение).
 *
 * Чистая математика (§7): функция НЕ знает про время — окно TYPO_WINDOW_DAYS
 * отсекает use case (TASK-029) Instant-сравнением относительно момента кандидата,
 * сюда приходит уже отфильтрованный список. Пустая история или <2 записей →
 * undefined — нет базы сравнения, не подсказываем (EC-09-дух, §13). Пульс не
 * проверяется — сознательное решение (§5: SRS FR-1.6 говорит только про мм рт. ст.).
 *
 * Флаг — ПОДСКАЗКА, а не запрет (§3): реальные аномальные значения сохраняются
 * (EC-03), решение за пользователем — диалог TASK-032 («обычно около {median},
 * вы ввели {value}»), решает use case TASK-029. Без чтения времени и побочных
 * эффектов: O(n log n) на массиве ≤100 (§15), вызывается только при вводе.
 */
import type { BpMeasurement } from './bp-measurement.js';
import type { BpField } from './blood-pressure.js';
import { TYPO_THRESHOLD_MMHG } from './constants.js';

/**
 * Сигнал «вероятная опечатка» (§5/§16–17): params диалога TASK-032 и подстановки
 * ключа errors.typoHint — {field, median, value}.
 */
export interface TypoFlag {
  /** Поле, отклонение которого превысило порог. */
  readonly field: BpField;
  /** Медиана истории по этому полю (может быть *.5 при чётной длине, §13). */
  readonly median: number;
  /** Введённое кандидатом значение этого поля. */
  readonly value: number;
  /** abs(value − median) — строго больше TYPO_THRESHOLD_MMHG (§13). */
  readonly deviation: number;
}

/** Медиана по стандартному определению (§13): чётный массив — среднее двух центральных. */
function medianOf(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Детектор вероятной опечатки (§2/§7): flag по полю с худшим превышением; при
 * равных превышениях выбирается sys (стабильный порядок полей). undefined —
 * сигнала нет (включая историю <2 записей, §13).
 */
export function detectTypo(
  history: ReadonlyArray<BpMeasurement>,
  candidate: { sys: number; dia: number },
): TypoFlag | undefined {
  if (history.length < 2) {
    return undefined;
  }
  const candidates: TypoFlag[] = (
    [
      ['sys', medianOf(history.map((m) => m.bp.sys)), candidate.sys],
      ['dia', medianOf(history.map((m) => m.bp.dia)), candidate.dia],
    ] as const
  ).map(([field, median, value]) => ({
    field,
    median,
    value,
    deviation: Math.abs(value - median),
  }));

  let worst: TypoFlag | undefined;
  for (const item of candidates) {
    if (
      item.deviation > TYPO_THRESHOLD_MMHG &&
      (worst === undefined || item.deviation > worst.deviation)
    ) {
      worst = item;
    }
  }
  return worst;
}
