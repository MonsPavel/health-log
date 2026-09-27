/**
 * TASK-046 §7/§13/§14/§19: юнит-тесты конвертера/валидатора произвольного периода.
 *
 * parseRange (§7): настенные даты устройства → границы utcMs через ПЕРЕДАННУЮ
 * зону (чистая функция — прецедент taken-at; момент «сейчас» — параметр).
 * Границы (§13): from = полночь настенного дня ВКЛЮЧИТЕЛЬНО, to = 23:59:59.999
 * настенного дня ВКЛЮЧИТЕЛЬНО; записи включаются по НАСТЕННОМУ дню измерения
 * (Instant.wallTime, TASK-033), поэтому ночная запись 00:15 «вчерашнего» дня
 * попадает в диапазон «вчера», хотя её UTC-день — позавчерашний.
 *
 * Валидация (§5/§20): from ≤ to (иначе invalidOrder), to не в будущем
 * (futureTo — EC-20-согласованность), мусор формата → invalidFormat (§14).
 * Неполный диапазон (§10): одно поле — «открытая» вторая граница, оба пустых —
 * ок без границ (дефолт 30d решает вызывающий — toQuery).
 *
 * Смещения в тестах ЯВНЫЕ (tzOffsetMin параметр) — детерминизм на любой машине:
 * UTC+3 → 180, UTC−1 → −60; DST-случай (§13) — фиксированный offset, настенные
 * дни не дублируются и не выпадают.
 */
import { describe, expect, it } from 'vitest';

import { DAY_MS, MS_PER_MINUTE, parseIsoDate, parseRange } from './range';

/** Фиксированное «сейчас» — 2026-09-27 15:00 UTC (чистая функция, §19). */
const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);

/** Зона устройства в тестах по умолчанию: UTC+3 (180 мин, как МСК). */
const TZ_180 = 180;

/** Настенный момент в зоне tzOffsetMin → utcMs (инверсия taken-at.fromLocalWall). */
function wallToUtc(y: number, mo: number, d: number, h = 0, mi = 0, tzOffsetMin = TZ_180): number {
  return Date.UTC(y, mo - 1, d, h, mi) - tzOffsetMin * MS_PER_MINUTE;
}

describe('parseIsoDate — строгий разбор URL-даты (§14)', () => {
  it('валидная ISO-дата → компоненты', () => {
    expect(parseIsoDate('2026-03-01')).toStrictEqual({ y: 2026, mo: 3, d: 1 });
    expect(parseIsoDate('2026-12-31')).toStrictEqual({ y: 2026, mo: 12, d: 31 });
  });

  it('мусор формата → null: не-дата, неполные компоненты, лишние символы', () => {
    expect(parseIsoDate('xx')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate('2026-3-1')).toBeNull(); // без ведущих нулей
    expect(parseIsoDate('2026-03-01T00:00')).toBeNull(); // не только дата
    expect(parseIsoDate('2026/03/01')).toBeNull();
    expect(parseIsoDate(undefined)).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
  });

  it('несуществующая календарная дата → null (§14: 02-30, 02-29 невисокосного)', () => {
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-02-29')).toBeNull(); // 2026 — не високосный
    expect(parseIsoDate('2024-02-29')).toStrictEqual({ y: 2024, mo: 2, d: 29 }); // високосный
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-00-10')).toBeNull();
    expect(parseIsoDate('2026-03-00')).toBeNull();
  });
});

describe('parseRange — нормальный диапазон (§5/§20 AC1)', () => {
  it('1–15 марта: from = полночь 1-го, to = 23:59:59.999 15-го настенного (включительно)', () => {
    expect(parseRange('2026-03-01', '2026-03-15', NOW_MS, TZ_180)).toStrictEqual({
      ok: true,
      fromUtcMs: wallToUtc(2026, 3, 1),
      toUtcMs: wallToUtc(2026, 3, 15, 23, 59) + 59_999,
    });
  });

  it('AC1: 00:15 первого и 23:59:59.999 пятнадцатого настенного — внутри границ', () => {
    const range = parseRange('2026-03-01', '2026-03-15', NOW_MS, TZ_180);
    if (!range.ok) {
      throw new Error('ожидался валидный диапазон');
    }
    expect(range.fromUtcMs).toBeLessThanOrEqual(wallToUtc(2026, 3, 1, 0, 15));
    expect(range.toUtcMs).toBeGreaterThanOrEqual(wallToUtc(2026, 3, 15, 23, 59, 59_999));
  });

  it('однодневный диапазон from=to — ровно этот настенный день', () => {
    expect(parseRange('2026-09-26', '2026-09-26', NOW_MS, TZ_180)).toStrictEqual({
      ok: true,
      fromUtcMs: wallToUtc(2026, 9, 26),
      toUtcMs: wallToUtc(2026, 9, 26, 23, 59) + 59_999,
    });
  });

  it('отрицательный offset (UTC−1): границы сдвигаются в другую сторону', () => {
    expect(parseRange('2026-09-26', '2026-09-26', NOW_MS, -60)).toStrictEqual({
      ok: true,
      fromUtcMs: wallToUtc(2026, 9, 26, 0, 0, -60),
      toUtcMs: wallToUtc(2026, 9, 26, 23, 59, -60) + 59_999,
    });
  });
});

describe('parseRange — валидация (§5/§20 AC2/AC3)', () => {
  it('from > to → invalidOrder (AC2)', () => {
    expect(parseRange('2026-03-15', '2026-03-01', NOW_MS, TZ_180)).toStrictEqual({
      ok: false,
      error: 'invalidOrder',
    });
  });

  it('to в будущем настенного дня → futureTo (AC3, EC-20); today — разрешён', () => {
    // now = 2026-09-27 15:00 UTC → настенное «сегодня» в UTC+3 — 27-е.
    expect(parseRange('2026-09-01', '2026-09-28', NOW_MS, TZ_180)).toStrictEqual({
      ok: false,
      error: 'futureTo',
    });
    expect(parseRange('2026-09-01', '2026-09-27', NOW_MS, TZ_180).ok).toBe(true);
  });

  it('граница полуночи: 00:30 настенного 28-го (сейчас) — 27-е уже будущее (§13)', () => {
    // 2026-09-27 21:30 UTC в UTC+3 — настенно 2026-09-28 00:30: «сегодня» — 28-е.
    const nowAtNight = Date.UTC(2026, 8, 27, 21, 30);
    expect(parseRange('2026-09-01', '2026-09-28', nowAtNight, TZ_180).ok).toBe(true);
    expect(parseRange('2026-09-01', '2026-09-29', nowAtNight, TZ_180)).toStrictEqual({
      ok: false,
      error: 'futureTo',
    });
  });

  it('мусор формата любой из дат → invalidFormat (§14)', () => {
    expect(parseRange('xx', '2026-09-01', NOW_MS, TZ_180)).toStrictEqual({
      ok: false,
      error: 'invalidFormat',
    });
    expect(parseRange('2026-09-01', '2026-02-30', NOW_MS, TZ_180)).toStrictEqual({
      ok: false,
      error: 'invalidFormat',
    });
  });

  it('from в будущем при открытом to — валидацией не запрещено (§5 валидирует только to)', () => {
    expect(parseRange('2030-01-01', undefined, NOW_MS, TZ_180).ok).toBe(true);
  });
});

describe('parseRange — неполный диапазон (§10 прогрессивно)', () => {
  it('только from — «от даты до ∞»: одна граница', () => {
    expect(parseRange('2026-03-01', undefined, NOW_MS, TZ_180)).toStrictEqual({
      ok: true,
      fromUtcMs: wallToUtc(2026, 3, 1),
    });
  });

  it('только to — «до даты от −∞», будущее по-прежнему ошибка', () => {
    expect(parseRange(undefined, '2026-03-15', NOW_MS, TZ_180)).toStrictEqual({
      ok: true,
      toUtcMs: wallToUtc(2026, 3, 15, 23, 59) + 59_999,
    });
    expect(parseRange(undefined, '2026-09-28', NOW_MS, TZ_180)).toStrictEqual({
      ok: false,
      error: 'futureTo',
    });
  });

  it('оба пустых — ок без границ (дефолт 30d решает вызывающий, §10)', () => {
    expect(parseRange(undefined, undefined, NOW_MS, TZ_180)).toStrictEqual({ ok: true });
    expect(parseRange('', '', NOW_MS, TZ_180)).toStrictEqual({ ok: true });
  });
});

describe('parseRange — настенное правило ночной записи (§13/§22)', () => {
  /** Диапазон «вчера» по настенному дню устройства (UTC+3): 2026-09-26. */
  const yesterday = parseRange('2026-09-26', '2026-09-26', NOW_MS, TZ_180);
  const yesterdayFrom =
    yesterday.ok && yesterday.fromUtcMs !== undefined ? yesterday.fromUtcMs : NaN;
  const yesterdayTo = yesterday.ok && yesterday.toUtcMs !== undefined ? yesterday.toUtcMs : NaN;
  if (Number.isNaN(yesterdayFrom) || Number.isNaN(yesterdayTo)) {
    throw new Error('ожидался валидный диапазон');
  }

  it('запись 00:15 настенного 26-го (свой offset +180) — UTC-день 25-й, но входит: настенный день решает', () => {
    // Настенно 26-е 00:15 при offset +180 → utc 2026-09-25T21:15Z (UTC-день 25-го:
    // наивный utc-фильтр по 26-му запись потерял бы — §22 снят настенным правилом).
    const nightUtcMs = wallToUtc(2026, 9, 26, 0, 15);
    expect(new Date(nightUtcMs).getUTCDate()).toBe(25); // доказательство ловушки utc-дня
    expect(yesterdayFrom).toBeLessThanOrEqual(nightUtcMs);
    expect(nightUtcMs).toBeLessThanOrEqual(yesterdayTo);
  });

  it('запись 00:30 настенного 27-го («сегодня», свой offset +180) — UTC-день 26-й, но НЕ входит', () => {
    // Настенно 27-е 00:30 при offset +180 → utc 2026-09-26T21:30Z: utc-день 26-го
    // наивный utc-фильтр включил бы — настенное правило исключает.
    const utcMs = wallToUtc(2026, 9, 27, 0, 30);
    expect(new Date(utcMs).getUTCDate()).toBe(26); // доказательство ловушки utc-дня
    expect(utcMs).toBeGreaterThan(yesterdayTo);
  });
});

describe('parseRange — DST-переход внутри диапазона при фиксированном offset (§13)', () => {
  it('2026-03-01..2026-04-01 (переход EU 2026-03-29): настенные дни не дублируются', () => {
    const range = parseRange('2026-03-01', '2026-04-01', NOW_MS, TZ_180);
    if (!range.ok || range.fromUtcMs === undefined || range.toUtcMs === undefined) {
      throw new Error('ожидался валидный диапазон');
    }
    const { fromUtcMs, toUtcMs } = range;
    // Фиксированный offset → настенные дни идут подряд по 24 ч: ровно 32 суток
    // минус 1 мс включительной границы — ни дублей, ни выпавших часов.
    expect(toUtcMs - fromUtcMs).toBe(32 * DAY_MS - 1);
    expect(fromUtcMs).toBe(wallToUtc(2026, 3, 1));
    expect(toUtcMs).toBe(wallToUtc(2026, 4, 1, 23, 59) + 59_999);
  });
});
