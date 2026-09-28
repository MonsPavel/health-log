/**
 * TASK-061 §5/§13/§16/§19: тесты карточки «Последнее измерение» домашней сводки.
 *
 * ДАННЫЕ (§5): крупно 125/82, пульс (если есть), «когда» — сегодня/вчера/
 * дата Intl (настенное время записи через lib/i18n-date + model/wall-date —
 * прецедент DayGroup TASK-033). CTA «Добавить измерение» — крупная ≥48px (§16:
 * главное действие экрана; min-h-12 = 3rem растёт с масштабом FR-8.2).
 *
 * КРИТИЧЕСКОЕ (§5/§13): флаг critical записи → бейдж TASK-042 кликабелен,
 * клик открывает мини-панель срочности TASK-041 (CriticalPanel в диалоге —
 * прецедент FlagBadges) СО ЗНАЧЕНИЯМИ записи; без флага — панели и кнопки нет.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';

import { PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { localDateKey, previousDayKey, wallDateKey } from '../../measurement/model/wall-date';
import { LastMeasurementCard } from './LastMeasurementCard';

import '../../../i18n';

/** Фиксированное «сейчас» теста (машинонезависимо — прецедент HistoryScreen.test). */
const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);
/** Смещение устройства теста: локальные ключи считаем сами. */
const TZ_OFFSET_MIN = -new Date(NOW_MS).getTimezoneOffset();
const TODAY_KEY = localDateKey(NOW_MS);
const YESTERDAY_KEY = previousDayKey(TODAY_KEY);

/** Instant настенной даты dayKey в время wallTime 'HH:MM' пояса устройства. */
function wallAt(dayKey: string, wallTime: string): { utcMs: number; tzOffsetMin: number } {
  const [y, m, d] = dayKey.split('-').map(Number);
  const [h, min] = wallTime.split(':').map(Number);
  return {
    utcMs: Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1, h ?? 0, min ?? 0) - TZ_OFFSET_MIN * 60_000,
    tzOffsetMin: TZ_OFFSET_MIN,
  };
}

/** DTO-минимум последней записи. */
function dto(overrides: Partial<MeasurementDto> = {}): MeasurementDto {
  const takenAt = wallAt(TODAY_KEY, '08:12');
  return {
    id: 'm-last',
    profileId: PROFILE_ID,
    sys: 125,
    dia: 82,
    pulse: 72,
    irregularPulse: false,
    arm: 'left',
    takenAtUtcMs: takenAt.utcMs,
    tzOffsetMin: takenAt.tzOffsetMin,
    source: 'manual',
    createdAtUtcMs: takenAt.utcMs,
    updatedAtUtcMs: takenAt.utcMs,
    ...overrides,
  };
}

function renderCard(measurement: MeasurementDto, onAdd = (): void => undefined): void {
  render(createElement(LastMeasurementCard, { measurement, nowMs: NOW_MS, onAdd }));
}

afterEach(() => cleanup());

describe('LastMeasurementCard — значения записи (§5: крупно)', () => {
  it('давление крупно «125/82», пульс «Пульс 72 уд/мин», h3 «Последнее измерение»', () => {
    renderCard(dto());

    const card = screen.getByTestId('last-measurement-card');
    expect(card.querySelector('h3')?.textContent).toBe('Последнее измерение');
    expect(screen.getByTestId('last-bp').textContent).toBe('125/82');
    expect(screen.getByTestId('last-pulse').textContent).toBe('Пульс 72 уд/мин');
  });

  it('пульса нет в записи — строка пульса не рендерится (честно)', () => {
    renderCard(dto({ pulse: undefined }));

    expect(screen.queryByTestId('last-pulse')).toBeNull();
    expect(screen.getByTestId('last-bp')).not.toBeNull();
  });
});

describe('LastMeasurementCard — «когда» (§5: сегодня/вчера/дата Intl)', () => {
  it('сегодня 08:12 → «Сегодня 08:12»', () => {
    renderCard(dto());

    expect(screen.getByTestId('last-when').textContent).toBe('Сегодня 08:12');
  });

  it('вчера 20:05 → «Вчера 20:05»', () => {
    const takenAt = wallAt(YESTERDAY_KEY, '20:05');
    renderCard(dto({ takenAtUtcMs: takenAt.utcMs, tzOffsetMin: takenAt.tzOffsetMin }));

    expect(screen.getByTestId('last-when').textContent).toBe('Вчера 20:05');
  });

  it('раньше (15.01.2026 07:30) → дата Intl «15.01.2026, 07:30»', () => {
    const takenAt = wallAt('2026-01-15', '07:30');
    renderCard(dto({ takenAtUtcMs: takenAt.utcMs, tzOffsetMin: takenAt.tzOffsetMin }));

    expect(screen.getByTestId('last-when').textContent).toBe('15.01.2026, 07:30');
  });

  it('граница полуночи решается по настенной дате записи (§13: ключ дня, не часы)', () => {
    // Запись сегодня в 00:30 устройства: wall-ключ == сегодня → «Сегодня».
    const takenAt = wallAt(TODAY_KEY, '00:30');
    renderCard(dto({ takenAtUtcMs: takenAt.utcMs, tzOffsetMin: takenAt.tzOffsetMin }));

    expect(screen.getByTestId('last-when').textContent).toBe('Сегодня 00:30');
    expect(wallDateKey({ utcMs: takenAt.utcMs, tzOffsetMin: takenAt.tzOffsetMin })).toBe(TODAY_KEY);
  });
});

describe('LastMeasurementCard — критическое значение (§5/§13: панель срочности доступна)', () => {
  it('critical high → бейдж-кнопка; клик открывает панель со значениями 190/125', async () => {
    renderCard(dto({ sys: 190, dia: 125, critical: 'high' }));

    fireEvent.click(screen.getByTestId('flag-critical'));
    await waitFor(() => {
      const panel = screen.getByTestId('critical-panel');
      expect(panel.textContent).toContain('190/125');
      expect(screen.getByTestId('flag-panel-dialog').contains(panel)).toBe(true);
    });
  });

  it('critical low → та же панель срочности (низкий вариант текста)', async () => {
    renderCard(dto({ sys: 85, dia: 55, critical: 'low' }));

    fireEvent.click(screen.getByTestId('flag-critical'));
    await waitFor(() => expect(screen.getByTestId('critical-panel')).not.toBeNull());
  });

  it('без critical — бейджа и панели нет (место не резервируется, §13)', () => {
    renderCard(dto());

    expect(screen.queryByTestId('flag-critical')).toBeNull();
    expect(screen.queryByTestId('flag-panel-dialog')).toBeNull();
  });
});

describe('LastMeasurementCard — CTA «Добавить измерение» (§5/§16)', () => {
  it('CTA — обычная кнопка, клик → колбэк (журнал/форма); крупная ≥48px (min-h-12)', () => {
    const onAdd = vi.fn();
    renderCard(dto(), onAdd);

    const cta = screen.getByRole('button', { name: 'Добавить измерение' });
    expect(cta.className).toContain('min-h-12');
    fireEvent.click(cta);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
