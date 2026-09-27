/**
 * TASK-052 §5/§13: части суток по НАСТЕННОМУ времени Instant (UTC + offset записи).
 * EC-06/07 (арх. 04 §2): запись хранит СВОЙ offset — перелёты и перевод часов не
 * «перемешивают» утренние и вечерние измерения; ночные записи (00:00–05:59) —
 * 'other', а не «вчера-вечер» (§13). Окна §5: утро 06:00–11:59, вечер 18:00–23:59,
 * иначе 'other'. Границы включительно по минуте: ровно 06:00 → утро, 11:59:59.999 →
 * утро, 12:00 → other, 18:00 → вечер, 23:59:59.999 → вечер (§13/AC §20).
 *
 * Чистые функции (арх. 02 §5); целочисленная арифметика без Date — O(1) на точку,
 * 50k точек ≈ единицы мс (§15). Константы окон экспортированы — единственный
 * источник чисел домена (§5: «константы»).
 */
import type { Instant } from '@hl/kernel';

/** Окна частей суток в минутах суток (§5): утро [360,720), вечер [1080,1440), иначе other. */
export const DAY_PART_WINDOWS_MIN = {
  /** 06:00 — начало окна утра (включительно). */
  morningStart: 360,
  /** 12:00 — конец окна утра (ИСКЛЮЧИТЕЛЬНО: 11:59:59.999 ещё утро, §13). */
  morningEndExclusive: 720,
  /** 18:00 — начало окна вечера (включительно, до конца суток). */
  eveningStart: 1080,
} as const;

/** Часть суток (§5): 'morning' | 'evening' | 'other'. */
export type DayPart = 'morning' | 'evening' | 'other';

/** Раскладка точек по частям суток (§5); внутри части сохранён исходный порядок, ссылки те же. */
export interface DayPartSplit<T> {
  readonly morning: T[];
  readonly evening: T[];
  readonly other: T[];
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1_440;

/**
 * Часть суток момента по настенному времени (§5/§13): минута суток = UTC-минуты +
 * offset записи (mod 1440 — корректно для отрицательных offset, EC-06). Точность —
 * минутная: 11:59:59.999 → минута 719 → утро; 12:00:00 → 720 → other (§13).
 */
export function dayPartOf(instant: Instant): DayPart {
  const wallMinute =
    (((Math.floor(instant.utcMs / MS_PER_MINUTE) + instant.tzOffsetMin) % MINUTES_PER_DAY) +
      MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  if (
    wallMinute >= DAY_PART_WINDOWS_MIN.morningStart &&
    wallMinute < DAY_PART_WINDOWS_MIN.morningEndExclusive
  ) {
    return 'morning';
  }
  if (wallMinute >= DAY_PART_WINDOWS_MIN.eveningStart) {
    return 'evening';
  }
  return 'other';
}

/**
 * Раскладка точек по трём частям суток (§5). Обобщение по точке с takenAt: домен
 * не знает полного вида записи (sys/dia/пульс) — сборщик (application) передаёт
 * точки порта как есть. Пустой вход → три пустых списка (не undefined: решение
 * «часть без измерений не показывается» — §13 — принимает сборщик).
 */
export function splitByDayPart<T extends { readonly takenAt: Instant }>(
  points: readonly T[],
): DayPartSplit<T> {
  const split: DayPartSplit<T> = { morning: [], evening: [], other: [] };
  for (const point of points) {
    split[dayPartOf(point.takenAt)].push(point);
  }
  return split;
}
