// TASK-067 §19/§13: юниты форматтеров отчёта — настенные дата/время (Intl ru по
// offset ТОЧКИ, EC-06), прочерки отсутствующих значений, целые числа, лимит
// таблицы 2000 (§9) и разбивка строк таблицы на страницы (§19 «логика строк
// на страницу»). Чистые функции домена — детерминизм NFR-10.
import { describe, expect, it } from 'vitest';

import { Instant } from '@hl/kernel';

import {
  TABLE_ROW_LIMIT,
  TABLE_ROWS_PER_PAGE,
  formatBp,
  formatDateTime,
  formatInt,
  formatLongDate,
  formatWallDate,
  formatWallTime,
  limitLastRows,
  paginateRows,
} from './report-format.ts';

/** Компоненты Instant из настенной ISO-строки (прецедент regularity.test.ts). */
const at = (iso: string): { utcMs: number; tzOffsetMin: number } => {
  const instant = Instant.fromIso(iso);
  return { utcMs: instant.utcMs, tzOffsetMin: instant.tzOffsetMin };
};

describe('formatWallDate / formatWallTime — настенное время точки (§13, EC-06)', () => {
  it('дата и время по offset записи (не по машинной таймзоне)', () => {
    const { utcMs, tzOffsetMin } = at('2026-09-01T21:30:00.000+03:00');
    expect(formatWallDate(utcMs, tzOffsetMin)).toBe('01.09.2026');
    expect(formatWallTime(utcMs, tzOffsetMin)).toBe('21:30');
  });

  it('отрицательный offset (EC-06)', () => {
    const { utcMs, tzOffsetMin } = at('2026-03-01T02:30:00.000-05:00');
    expect(formatWallDate(utcMs, tzOffsetMin)).toBe('01.03.2026');
    expect(formatWallTime(utcMs, tzOffsetMin)).toBe('02:30');
  });

  it('переход через полночь: настенная дата — следующая, UTC-дата — предыдущая', () => {
    const { utcMs, tzOffsetMin } = at('2026-09-02T01:30:00.000+03:00');
    expect(formatWallDate(utcMs, tzOffsetMin)).toBe('02.09.2026');
    expect(formatWallTime(utcMs, tzOffsetMin)).toBe('01:30');
  });

  it('нулевые минуты и часы с ведущими нулями', () => {
    const { utcMs, tzOffsetMin } = at('2026-12-31T00:05:00.000+03:00');
    expect(formatWallDate(utcMs, tzOffsetMin)).toBe('31.12.2026');
    expect(formatWallTime(utcMs, tzOffsetMin)).toBe('00:05');
  });
});

describe('formatLongDate / formatDateTime — титул отчёта (§5)', () => {
  it('длинная дата в родительном падеже по-русски', () => {
    const { utcMs, tzOffsetMin } = at('2026-09-01T12:00:00.000+03:00');
    expect(formatLongDate(utcMs, tzOffsetMin)).toBe('1 сентября 2026 г.');
  });

  it('дата-время одной строкой для «Сформировано»', () => {
    const { utcMs, tzOffsetMin } = at('2026-09-29T21:07:00.000+03:00');
    expect(formatDateTime(utcMs, tzOffsetMin)).toBe('29.09.2026, 21:07');
  });
});

describe('formatInt / formatBp — числа целые, прочерк отсутствующих (§13)', () => {
  it('дробные средние отображаются целыми (округление к ближайшему)', () => {
    expect(formatInt(127.4)).toBe('127');
    expect(formatInt(127.5)).toBe('128');
    expect(formatInt(80)).toBe('80');
  });

  it('прочерк: undefined-пульс (§13), число — целым', () => {
    expect(formatBp(undefined)).toBe('—');
    expect(formatBp(72)).toBe('72');
    expect(formatBp(72.6)).toBe('73');
  });
});

describe('limitLastRows — ограничение таблицы последними 2000 (§9)', () => {
  it('константа лимита — 2000 (§9, решение зафиксировано)', () => {
    expect(TABLE_ROW_LIMIT).toBe(2000);
  });

  it('3000 записей → последние 2000 в порядке asc, omitted 1000', () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ utcMs: i }));
    const limited = limitLastRows(rows);
    expect(limited.total).toBe(3000);
    expect(limited.omitted).toBe(1000);
    expect(limited.rows).toHaveLength(2000);
    // «Последние» — хвост в исходном (asc) порядке, без перестановки.
    expect(limited.rows[0]).toEqual({ utcMs: 1000 });
    expect(limited.rows.at(-1)).toEqual({ utcMs: 2999 });
  });

  it('ровно 2000 и меньше — без изменений и без приписки', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ utcMs: i }));
    const limited = limitLastRows(rows);
    expect(limited.rows).toHaveLength(2000);
    expect(limited.omitted).toBe(0);
    expect(limitLastRows([{ utcMs: 1 }]).omitted).toBe(0);
  });

  it('пустой период — пустой список (валидная структура, §9 052)', () => {
    expect(limitLastRows([])).toEqual({ rows: [], total: 0, omitted: 0 });
  });
});

describe('paginateRows — логика строк на страницу (§19)', () => {
  it('константа строк на страницу — 30 (читаемость ≥9pt, §16)', () => {
    expect(TABLE_ROWS_PER_PAGE).toBeGreaterThan(0);
  });

  it('75 строк → страницы 30/30/15', () => {
    const rows = Array.from({ length: 75 }, (_, i) => i);
    expect(paginateRows(rows, 30)).toEqual([
      rows.slice(0, 30),
      rows.slice(30, 60),
      rows.slice(60, 75),
    ]);
  });

  it('ровно кратное число строк — без пустой последней страницы', () => {
    const rows = Array.from({ length: 60 }, (_, i) => i);
    expect(paginateRows(rows, 30)).toEqual([rows.slice(0, 30), rows.slice(30, 60)]);
  });

  it('пустая таблица — ни одной страницы', () => {
    expect(paginateRows([], 30)).toEqual([]);
  });

  it('perPage < 1 — отказ (fail-fast §13)', () => {
    expect(() => paginateRows([1], 0)).toThrow(TypeError);
    expect(() => paginateRows([1], -5)).toThrow(TypeError);
  });
});
