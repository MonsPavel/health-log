/**
 * TASK-057 §4/§5/§6: юнит-тесты lib/period — общие период-утилиты продукта
 * (перенос из features/measurement/model: filters.ts-период + range.ts +
 * tzOffsetMinOf; старые точки импорта — реэкспорты, их поведение держат старые
 * тесты filters.test/range.test без изменений).
 *
 * Новая поверхность экрана «Динамика» (§6): PeriodState — период-часть
 * URL-семантики TASK-044/046 без arm/noted/q (один паттерн period по продукту);
 * periodToStatsParam — конвертация состояния в период каналов stats/period и
 * trend/series (схема STATS_PERIOD_PARAM — та же, §23 054/056).
 */
import { describe, expect, it } from 'vitest';

import { DAY_MS, MS_PER_MINUTE, parsePeriodState, periodToStatsParam, serializePeriodState, tzOffsetMinOf } from './period';

/** Фиксированное «сейчас» — не Date.now (чистая функция, детерминизм §19). */
const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);

/** Смещение зоны устройства для NOW (границы custom — в зоне момента now). */
const OFFSET_MIN = tzOffsetMinOf(NOW_MS);

/** Полночь настенного дня в зоне устройства (ожидание для границ custom). */
const wallMidnightUtcMs = (iso: string): number => {
  const [y, mo, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, mo - 1, d) - OFFSET_MIN * MS_PER_MINUTE;
};

/** 23:59:59.999 настенного дня в зоне устройства (включительный конец). */
const wallDayEndUtcMs = (iso: string): number =>
  wallMidnightUtcMs(iso) + DAY_MS - 1;

describe('parsePeriodState — URL → состояние периода (§14: мусор → дефолт)', () => {
  const paramsOf = (query: string): URLSearchParams => new URLSearchParams(query);

  it('пресеты 7d/30d/90d/all читаются; отсутствие периода → дефолт 30d', () => {
    expect(parsePeriodState(paramsOf('period=7d')).period).toBe('7d');
    expect(parsePeriodState(paramsOf('period=90d')).period).toBe('90d');
    expect(parsePeriodState(paramsOf('period=all')).period).toBe('all');
    expect(parsePeriodState(paramsOf(''))).toEqual({ period: '30d' });
  });

  it('неизвестный период и регистр — мусор → дефолт (§14: строгий enum)', () => {
    expect(parsePeriodState(paramsOf('period=week')).period).toBe('30d');
    expect(parsePeriodState(paramsOf('period=7D')).period).toBe('30d');
  });

  it('custom: from/to настенных дат читаются только в режиме custom', () => {
    expect(parsePeriodState(paramsOf('period=custom&from=2026-09-01&to=2026-09-10'))).toEqual({
      period: 'custom',
      from: '2026-09-01',
      to: '2026-09-10',
    });
    // Вне custom даты — посторонние параметры, игнорируются (§14).
    expect(parsePeriodState(paramsOf('period=30d&from=2026-09-01&to=2026-09-10'))).toEqual({
      period: '30d',
    });
  });

  it('custom: мусорная дата отбрасывается, from > to — весь custom мусорен → дефолт', () => {
    expect(parsePeriodState(paramsOf('period=custom&from=2026-02-30'))).toEqual({
      period: 'custom',
    });
    expect(parsePeriodState(paramsOf('period=custom&from=2026-09-10&to=2026-09-01'))).toEqual({
      period: '30d',
    });
  });

  it('посторонние параметры (arm/noted/q журнала) игнорируются', () => {
    expect(parsePeriodState(paramsOf('period=7d&arm=left&noted=1&q=поиск'))).toEqual({
      period: '7d',
    });
  });
});

describe('serializePeriodState — состояние → URL (§12: период всегда, from/to — custom)', () => {
  it('период пишется всегда — дефолт виден в адресе (прецедент serializeHistoryFilters §5)', () => {
    expect(serializePeriodState({ period: '30d' }).toString()).toBe('period=30d');
    expect(serializePeriodState({ period: 'all' }).toString()).toBe('period=all');
  });

  it('custom: даты — параметрами from/to как есть (валидность гарантирует парсер/UI)', () => {
    const state = { period: 'custom' as const, from: '2026-09-01', to: '2026-09-10' };
    expect(serializePeriodState(state).toString()).toBe('period=custom&from=2026-09-01&to=2026-09-10');
    // Поля вне custom в адрес не попадают.
    expect(serializePeriodState({ period: '7d', from: '2026-09-01' }).toString()).toBe('period=7d');
  });

  it('roundtrip parse∘serialize — тождество на UI-достижимых состояниях', () => {
    const states = [
      { period: '30d' as const },
      { period: '7d' as const },
      { period: 'all' as const },
      { period: 'custom' as const },
      { period: 'custom' as const, from: '2026-09-01', to: '2026-09-10' },
    ];
    for (const state of states) {
      expect(parsePeriodState(serializePeriodState(state))).toEqual(state);
    }
  });
});

describe('periodToStatsParam — состояние → период каналов stats/trend (§4 057, §23 054/056)', () => {
  it('пресеты уходят строкой — границы считает main от Clock (§9 054)', () => {
    expect(periodToStatsParam({ period: '7d' }, NOW_MS)).toBe('7d');
    expect(periodToStatsParam({ period: '30d' }, NOW_MS)).toBe('30d');
    expect(periodToStatsParam({ period: '90d' }, NOW_MS)).toBe('90d');
    expect(periodToStatsParam({ period: 'all' }, NOW_MS)).toBe('all');
  });

  it('custom с обеими датами: полночь from / 23:59:59.999 to в зоне устройства (включительно, §13 046)', () => {
    expect(
      periodToStatsParam(
        { period: 'custom', from: '2026-09-01', to: '2026-09-10' },
        NOW_MS,
      ),
    ).toEqual({
      fromUtcMs: wallMidnightUtcMs('2026-09-01'),
      toUtcMs: wallDayEndUtcMs('2026-09-10'),
    });
  });

  it('custom с открытой стороной закрывается: без to → now, без from → 0 (канал требует обе границы)', () => {
    expect(periodToStatsParam({ period: 'custom', from: '2026-09-01' }, NOW_MS)).toEqual({
      fromUtcMs: wallMidnightUtcMs('2026-09-01'),
      toUtcMs: NOW_MS,
    });
    expect(periodToStatsParam({ period: 'custom', to: '2026-09-10' }, NOW_MS)).toEqual({
      fromUtcMs: 0,
      toUtcMs: wallDayEndUtcMs('2026-09-10'),
    });
  });

  it('custom пустой/невалидный → границы дефолтного 30d (§10/§14 046: «всё» из мусора не строится)', () => {
    expect(periodToStatsParam({ period: 'custom' }, NOW_MS)).toEqual({
      fromUtcMs: NOW_MS - 30 * DAY_MS,
      toUtcMs: NOW_MS,
    });
    expect(
      periodToStatsParam({ period: 'custom', from: '2026-09-10', to: '2026-09-01' }, NOW_MS),
    ).toEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS, toUtcMs: NOW_MS });
    // to в будущем (EC-20) parseRange отсекает → тот же дефолт.
    expect(
      periodToStatsParam(
        { period: 'custom', from: '2026-09-01', to: '2027-01-01' },
        NOW_MS,
      ),
    ).toEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS, toUtcMs: NOW_MS });
  });
});
