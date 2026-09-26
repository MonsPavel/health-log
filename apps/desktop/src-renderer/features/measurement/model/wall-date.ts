/**
 * TASK-033 §13: настенные дни журнала — чистая модель группировки.
 *
 * Настенный день Instant — календарная дата из пары (utcMs, tzOffsetMin): сдвинутый
 * момент utcMs + tzOffsetMin берётся UTC-компонентами (тот же приём, что
 * lib/i18n-date: запись хранит СВОЙ offset — перелёты не «перемещают» историю,
 * арх. 04 §2). Записи одного настенного дня с разными tz (EC-06) получают один
 * ключ дня и одну группу.
 *
 * «Сегодня/Вчера» — сравнение ключей настенных дат (не расстояний в часах):
 * ключ дня записи против настенной даты устройства сейчас — пограничный случай
 * полуночи решается по настенной дате записи (§13).
 *
 * Сортировка списка — контракт порта (takenAt desc, tie-break id desc, TASK-030):
 * renderer НЕ пересортировывает; группировка слиянием по ключу сохраняет
 * первый-появившийся порядок дней (устойчиво и к разрыву дня между страницами
 * пагинации — маловероятному, но допустимому при перелёте).
 */
import type { MeasurementDto } from '@hl/contracts';

/** Структурный аналог kernel-Instant (плоская форма DTO, §11). */
export interface WallInstantLike {
  /** Миллисекунды с эпохи Unix (UTC). */
  readonly utcMs: number;
  /** Смещение пояса момента в минутах: UTC+3 → 180, UTC-5 → -300. */
  readonly tzOffsetMin: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Ключ 'YYYY-MM-DD' из UTC-компонент момента (после сдвига — настенные). */
function utcDateKey(ms: number): string {
  const date = new Date(ms);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** Настенный день Instant — 'YYYY-MM-DD' по (utcMs, tzOffsetMin) (§13). */
export function wallDateKey(instant: WallInstantLike): string {
  return utcDateKey(instant.utcMs + instant.tzOffsetMin * MS_PER_MINUTE);
}

/** Настенная дата устройства (локальные компоненты момента) — 'YYYY-MM-DD'. */
export function localDateKey(ms: number): string {
  const date = new Date(ms);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Ключ предыдущего календарного дня (чистая UTC-арифметика — DST-устойчиво). */
export function previousDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return utcDateKey(Date.UTC(y, (m ?? 1) - 1, d ?? 1) - MS_PER_DAY);
}

/** Класс заголовка дня: today / yesterday / other (дата через Intl). */
export type DayKind = 'today' | 'yesterday' | 'other';

/** «Сегодня/Вчера/дата» (§13): сравнение настенных ключей дня записи и устройства. */
export function dayKind(wallKey: string, nowMs: number): DayKind {
  const todayKey = localDateKey(nowMs);
  if (wallKey === todayKey) {
    return 'today';
  }
  return wallKey === previousDayKey(todayKey) ? 'yesterday' : 'other';
}

/** Группа журнала: настенный день + записи дня (desc-порядок сохранён). */
export interface MeasurementDayGroup {
  /** Ключ настенного дня 'YYYY-MM-DD' — идентичность группы (key React, §15). */
  readonly key: string;
  /** Instant первой записи дня — источник даты заголовка (Intl, §17). */
  readonly instant: WallInstantLike;
  /** Записи дня в порядке списка (desc). */
  readonly items: readonly MeasurementDto[];
}

/** Группировка плоского desc-списка по настенным дням; дни — в порядке появления. */
export function groupByDay(items: readonly MeasurementDto[]): readonly MeasurementDayGroup[] {
  const byKey = new Map<string, MeasurementDayGroup>();
  for (const item of items) {
    const instant: WallInstantLike = { utcMs: item.takenAtUtcMs, tzOffsetMin: item.tzOffsetMin };
    const key = wallDateKey(instant);
    const group = byKey.get(key);
    if (group === undefined) {
      byKey.set(key, { key, instant, items: [item] });
    } else {
      group.items = [...group.items, item];
    }
  }
  return [...byKey.values()];
}
