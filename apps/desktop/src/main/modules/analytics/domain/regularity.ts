/**
 * TASK-052 §5/§13: регулярность периода — уникальные настенные дни с измерениями и
 * longest streak (максимум ПОДРЯД идущих дней с ≥1 измерением). Период замкнут:
 * streak считается внутри периода, «не до сегодня» (§13) и без штрафов за пропуски
 * до первого/после последнего дня с измерениями (FR-4.4 — дружелюбно, без «провалов»).
 *
 * Настенный день — по дате момента с ЕГО собственным offset (EC-06/07, согласовано
 * с TASK-033 §13): перелёт не «переезжает» исторические записи. Чистая функция над
 * Instant (арх. 02 §5), порядок входа не влияет на результат (§19); O(n log n) из
 * сортировки уникальных дней.
 */
import type { Instant } from '@hl/kernel';

/** Регулярность периода (§7): дней с измерениями и самая длинная серия подряд. */
export interface Regularity {
  /** Уникальных настенных дней с ≥1 измерением (FR-4.4). */
  readonly daysWithMeasurements: number;
  /** Максимум подряд идущих таких дней внутри периода (FR-4.4, §13). */
  readonly longestStreakDays: number;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1_440;

/** Индекс настенного дня момента: (UTC-минуты + offset записи) / 1440 (EC-06). */
function wallDayIndex(instant: Instant): number {
  const wallMinutes = Math.floor(instant.utcMs / MS_PER_MINUTE) + instant.tzOffsetMin;
  return Math.floor(wallMinutes / MINUTES_PER_DAY);
}

/**
 * Регулярность набора моментов (§5): уникальные настенные дни + longest streak
 * подряд. Пустой вход → {0, 0} (пустой период — корректная структура, §9).
 */
export function regularity(instants: readonly Instant[]): Regularity {
  const days = new Set<number>();
  for (const instant of instants) {
    days.add(wallDayIndex(instant));
  }

  const sorted = [...days].sort((a, b) => a - b);
  let longest = 0;
  let current = 0;
  let previous = Number.NaN;
  for (const day of sorted) {
    current = day === previous + 1 ? current + 1 : 1;
    if (current > longest) {
      longest = current;
    }
    previous = day;
  }

  return { daysWithMeasurements: days.size, longestStreakDays: longest };
}
