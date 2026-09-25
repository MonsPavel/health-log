/**
 * TASK-013 §7/§19: тест утилиты formatDateTime — настенное время Instant через
 * Intl.DateTimeFormat (арх. 06 §6: формат дат — Intl API по выбранной локали).
 *
 * Срез offset проверяется на переходах суток/знака: utcMs + tzOffsetMin даёт
 * настенное время, совпадающее с kernel-Instant (TASK-006); секунды/мс utcMs
 * в форматminute-пресетов не попадают (настенное время kernel — до минут).
 */
import { describe, expect, it } from 'vitest';

import { formatDateTime } from './i18n-date';

describe('formatDateTime — настенное время через Intl (§7)', () => {
  it('datetime: ru-RU, UTC+3 — 11:30 UTC = 14:30 настенного', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30), tzOffsetMin: 180 };

    expect(formatDateTime(instant, { locale: 'ru-RU', preset: 'datetime' })).toBe(
      '25.09.2026, 14:30',
    );
  });

  it('date: только календарная дата настенного времени', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30), tzOffsetMin: 180 };

    expect(formatDateTime(instant, { locale: 'ru-RU', preset: 'date' })).toBe('25.09.2026');
  });

  it('time: только настенное время до минут', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30), tzOffsetMin: 180 };

    expect(formatDateTime(instant, { locale: 'ru-RU', preset: 'time' })).toBe('14:30');
  });

  it('offset применяется к суткам: UTC+3 в 21:30 UTC — уже 26.09 00:30 настенного', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 21, 30), tzOffsetMin: 180 };

    expect(formatDateTime(instant, { locale: 'ru-RU', preset: 'datetime' })).toBe(
      '26.09.2026, 00:30',
    );
  });

  it('отрицательный offset: UTC-5 в 11:30 UTC — 06:30 того же дня', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30), tzOffsetMin: -300 };

    expect(formatDateTime(instant, { locale: 'ru-RU', preset: 'time' })).toBe('06:30');
  });

  it('секунды и миллисекунды utcMs не попадают в минутный формат (kernel — до минут)', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30, 5, 123), tzOffsetMin: 180 };

    expect(formatDateTime(instant, { locale: 'ru-RU', preset: 'time' })).toBe('14:30');
  });

  it('локаль — параметр: en-US даёт локальные формат и 12-часовой цикл (FR-8.4)', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30), tzOffsetMin: 180 };

    const time = formatDateTime(instant, { locale: 'en-US', preset: 'time' });
    expect(time).toContain('PM');
    expect(formatDateTime(instant, { locale: 'en-US', preset: 'date' })).toBe('09/25/2026');
  });

  it('locale по умолчанию ru-RU — каталог ru источник истины (§17)', () => {
    const instant = { utcMs: Date.UTC(2026, 8, 25, 11, 30), tzOffsetMin: 180 };

    expect(formatDateTime(instant, { preset: 'time' })).toBe('14:30');
  });
});
