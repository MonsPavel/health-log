/**
 * TASK-033 §13/§19: чистая логика настенных дней — группировка журнала по
 * wallDate(takenAt) из пары (utcMs, tzOffsetMin), «Сегодня/Вчера» по настенной
 * дате устройства сейчас, слияние групп по ключу дня (EC-06: перелёт — записи
 * одного настенного дня с разными tz в одной группе).
 */
import { describe, expect, it } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';

import {
  dayKind,
  groupByDay,
  localDateKey,
  previousDayKey,
  wallDateKey,
  type WallInstantLike,
} from './wall-date';

/** Instant из НАСТЕННЫХ компонентов в фиксированном поясе (utcMs выводится). */
function instant(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tzOffsetMin: number,
): WallInstantLike {
  return { utcMs: Date.UTC(y, mo - 1, d, h, mi) - tzOffsetMin * 60_000, tzOffsetMin };
}

/** DTO-минимум для группировки: id + takenAt-пара. */
function dto(id: string, takenAt: WallInstantLike): MeasurementDto {
  return {
    id,
    profileId: 'seed-profile-0001',
    sys: 125,
    dia: 82,
    irregularPulse: false,
    arm: 'left',
    takenAtUtcMs: takenAt.utcMs,
    tzOffsetMin: takenAt.tzOffsetMin,
    source: 'manual',
    createdAtUtcMs: takenAt.utcMs,
    updatedAtUtcMs: takenAt.utcMs,
  };
}

describe('wallDateKey — настенная дата из (utcMs, tzOffsetMin) (§13)', () => {
  it('вечер UTC уже «завтра» по стене UTC+3: ключ по настенным компонентам', () => {
    // utcMs = 2026-09-27 21:00 UTC; +180 мин → стена 2026-09-28 00:00.
    expect(wallDateKey({ utcMs: Date.UTC(2026, 8, 27, 21, 0), tzOffsetMin: 180 })).toBe(
      '2026-09-28',
    );
  });

  it('отрицательное смещение: UTC-вечер в UTC-05:00 — ещё тот же день стены', () => {
    // utcMs = 2026-09-27 17:00 UTC; −300 мин → стена 2026-09-27 12:00.
    expect(wallDateKey({ utcMs: Date.UTC(2026, 8, 27, 17, 0), tzOffsetMin: -300 })).toBe(
      '2026-09-27',
    );
  });

  it('EC-06: одна настенная дата, разные пояса (перелёт) — один ключ', () => {
    // Полдень стены дома (UTC+3) и полдень стены в отпуске (UTC-05:00) —
    // календарная дата одинаковая, момент UTC — разный.
    const home = wallDateKey(instant(2026, 9, 27, 12, 0, 180));
    const abroad = wallDateKey(instant(2026, 9, 27, 12, 0, -300));
    expect(home).toBe('2026-09-27');
    expect(abroad).toBe('2026-09-27');
  });
});

describe('localDateKey/previousDayKey — настенная дата устройства (§13)', () => {
  it('localDateKey — локальные (устройства) компоненты момента', () => {
    // 2026-09-27 21:30 UTC; в UTC+3 это уже 2026-09-28, в UTC-05:00 — 2026-09-27.
    const ms = Date.UTC(2026, 8, 27, 21, 30);
    const offsetMin = -new Date(ms).getTimezoneOffset();
    const expected = utcKeyWithOffset(ms, offsetMin);
    expect(localDateKey(ms)).toBe(expected);
  });

  it('previousDayKey: граница месяца и года', () => {
    expect(previousDayKey('2026-03-01')).toBe('2026-02-28');
    expect(previousDayKey('2026-01-01')).toBe('2025-12-31');
    expect(previousDayKey('2026-09-28')).toBe('2026-09-27');
  });
});

describe('dayKind — «Сегодня/Вчера/дата» по настенным дням (§13)', () => {
  it('настенный день записи = настенный день устройства → today', () => {
    const nowMs = Date.UTC(2026, 8, 27, 15, 0);
    const offsetMin = -new Date(nowMs).getTimezoneOffset();
    const key = localDateKey(nowMs);
    const recordMs = Date.UTC(2026, 8, 27, 9, 0) - offsetMin * 60_000;
    expect(dayKind(localDateKey(recordMs), nowMs)).toBe('today');
    expect(key).toBe(localDateKey(recordMs));
  });

  it('граница полуночи: «вчера» по настенной дате записи, не по расстоянию в часах', () => {
    const nowMs = Date.UTC(2026, 8, 28, 0, 1); // только что наступила полночь
    const offsetMin = -new Date(nowMs).getTimezoneOffset();
    // Запись 30 часов назад — позапозавчерашний день (other), хотя «близко».
    const olderMs = nowMs - 30 * 3_600_000 - offsetMin * 60_000;
    // Запись 23 часа назад — вчера по настенной дате.
    const recentMs = nowMs - 23 * 3_600_000 - offsetMin * 60_000;
    expect(dayKind(localDateKey(olderMs), nowMs)).toBe('other');
    expect(dayKind(localDateKey(recentMs), nowMs)).toBe('yesterday');
  });

  it('не сегодня и не вчера → other (заголовок — дата)', () => {
    const nowMs = Date.UTC(2026, 8, 27, 15, 0);
    const offsetMin = -new Date(nowMs).getTimezoneOffset();
    const weekAgoMs = Date.UTC(2026, 8, 20, 12, 0) - offsetMin * 60_000;
    expect(dayKind(localDateKey(weekAgoMs), nowMs)).toBe('other');
  });
});

describe('groupByDay — группировка журнала по настенным дням (§5/§13)', () => {
  it('desc-фикстура 2 дня / 3 записи → 2 группы, порядок сохранён', () => {
    const tz = 180;
    const a = dto('a', instant(2026, 9, 27, 20, 5, tz)); // сегодня (позже)
    const b = dto('b', instant(2026, 9, 27, 8, 30, tz)); // сегодня (раньше)
    const c = dto('c', instant(2026, 9, 26, 22, 0, tz)); // вчера
    const groups = groupByDay([a, b, c]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.key).toBe('2026-09-27');
    expect(groups[0]?.items.map((m) => m.id)).toEqual(['a', 'b']);
    expect(groups[1]?.key).toBe('2026-09-26');
    expect(groups[1]?.items.map((m) => m.id)).toEqual(['c']);
  });

  it('записи одного настенного дня с разными tz попадают в одну группу (EC-06)', () => {
    const home = dto('home', instant(2026, 9, 27, 12, 0, 180));
    const abroad = dto('abroad', instant(2026, 9, 27, 12, 0, -300)); // тот же настенный день
    const groups = groupByDay([home, abroad]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((m) => m.id)).toEqual(['home', 'abroad']);
  });

  it('пустой список → без групп', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

/** Ожидаемый локальный ключ даты для ms в заданном смещении (эталон теста). */
function utcKeyWithOffset(ms: number, offsetMin: number): string {
  const shifted = new Date(ms + offsetMin * 60_000);
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}
