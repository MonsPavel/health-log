/**
 * TASK-031 §13: сборка takenAt формы — семантика kernel Instant (арх. 04 §2:
 * момент = пара {utcMs, tzOffsetMin}, запись хранит СВОЙ offset). Рендерер не
 * импортирует @hl/kernel (депкруз renderer-not-node, арх. 03 §4) — плоская
 * структурная форма InstantLike и целочисленная арифметика повторены здесь;
 * контракт пары совпадает с i18n-date.ts (TASK-013) и схемами contracts.
 *
 * «Сейчас» — takenAt собирается на момент SUBMIT (§13), не открытия формы:
 * Date.now()/смещение зоны запрашивает submit-путь формы, не store.
 *
 * Заднее число: input type=date/time даёт локальные компоненты стены →
 * utcMs = Date.UTC(компоненты) − tzOffsetMin·60_000; смещение устройства —
 * инвертированный знак Date.getTimezoneOffset (§13), передаётся параметром —
 * чистая функция без скрытых Date.now().
 */

/** Плоский структурный аналог kernel-Instant (прецедент i18n-date.ts §7). */
export interface InstantLike {
  /** Миллисекунды с эпохи Unix (UTC). */
  readonly utcMs: number;
  /** Смещение пояса момента в минутах: UTC+3 → 180, UTC-5 → -300. */
  readonly tzOffsetMin: number;
}

/** Локальные компоненты стены (значения input type=date / type=time). */
export interface LocalWallParts {
  /** Год, например 2026. */
  readonly y: number;
  /** Месяц 1–12. */
  readonly mo: number;
  /** День 1–31. */
  readonly d: number;
  /** Час 0–23; отсутствие времени = неполный ввод. */
  readonly h?: number;
  /** Минута 0–59. */
  readonly mi?: number;
}

/** Миллисекунд в минуте (целочисленная арифметика — §15, прецедент kernel). */
export const MS_PER_MINUTE = 60_000;

/**
 * Смещение зоны устройства в минутах для момента nowMs (UTC+3 → 180) —
 * TASK-057 §4/§6: каноническое определение перенесено в общий lib/period.ts,
 * здесь реэкспорт для совместимости импортов формы (WhenField, use-add-measurement).
 */
export { tzOffsetMinOf } from '../../../lib/period';

/**
 * Локальная стена → Instant; неполный ввод (время не выбрано) → null —
 * клиентская ошибка поля «когда» (§5: простые поля дата/время, TD-11).
 */
export function fromLocalWall(wall: LocalWallParts, tzOffsetMin: number): InstantLike | null {
  const { y, mo, d, h, mi } = wall;
  if (h === undefined || mi === undefined) {
    return null;
  }
  return {
    utcMs: Date.UTC(y, mo - 1, d, h, mi) - tzOffsetMin * MS_PER_MINUTE,
    tzOffsetMin,
  };
}
