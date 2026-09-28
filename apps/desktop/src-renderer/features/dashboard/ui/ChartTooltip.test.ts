/**
 * TASK-057 §5/§13/§16/§19: тесты ChartTooltip — содержимое тултипа: дата-время
 * (Intl, настенное время записи с ЕЁ offset — EC-06), значения sys/dia, пульс,
 * часть суток (§13: 'other' — «другое время»), кнопка/клик → открытие правки
 * (TASK-038 edit-режим; у точки без id кнопки нет — править нечего). daily —
 * агрегат дня (§12: правки нет): среднее/диапазон/count.
 *
 * Компонент рендерится СТОЯ (Recharts клонирует content с active/label/payload;
 * hover-симуляция в jsdom ненадёжна — содержимое проверяем напрямую, прецедент
 * изоляции презентационного слоя HistoryFilters TASK-044).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatDateTime } from '../../../lib/i18n-date';
import type { RawPoint, DayPoint } from '@hl/contracts';

import { ChartTooltip, type TooltipPayloadEntry } from './ChartTooltip';

import '../../../i18n';

/** Фикстура сырой точки (утро, с пульсом и id). */
const MORNING_POINT: RawPoint = {
  utcMs: Date.UTC(2026, 8, 14, 5, 30),
  tzOffsetMin: 180,
  sys: 125,
  dia: 82,
  pulse: 70,
  part: 'morning',
  id: 'rec-1',
};

/** Фикстура дневного агрегата (§5 056). */
const DAY_FIXTURE: DayPoint = {
  wallDate: '2026-03-02',
  sysAvg: 124,
  sysMin: 120,
  sysMax: 130,
  diaAvg: 82.3,
  diaMin: 80,
  diaMax: 85,
  morningSysAvg: 121,
  eveningSysAvg: 130,
  count: 3,
};

afterEach(() => cleanup());

/** Payload тултипа Recharts (системные серии кладут одну и ту же строку данных). */
const rawPayload = (point: RawPoint): readonly TooltipPayloadEntry[] => [
  { dataKey: 'sys', value: point.sys, color: '#111', payload: point },
  { dataKey: 'dia', value: point.dia, color: '#555', payload: point },
];

describe('ChartTooltip — raw-режим (§5: дата-время, значения, пульс, часть суток, переход к правке)', () => {
  it('дата-время записи — настенное (Intl по её собственному offset), значения sys/dia/пульс, часть суток', () => {
    render(
      createElement(ChartTooltip, {
        active: true,
        payload: rawPayload(MORNING_POINT),
        mode: 'raw',
      }),
    );

    expect(screen.getByText(formatDateTime(MORNING_POINT, { preset: 'datetime' }))).not.toBeNull();
    expect(screen.getByText('125')).not.toBeNull();
    expect(screen.getByText('82')).not.toBeNull();
    expect(screen.getByText('70')).not.toBeNull();
    expect(screen.getByText('утро')).not.toBeNull();
  });

  it("точка 'other' — подпись «другое время» (§13); точка без пульса — строки пульса нет", () => {
    const point: RawPoint = { ...MORNING_POINT, pulse: undefined, part: 'other' };
    render(createElement(ChartTooltip, { active: true, payload: rawPayload(point), mode: 'raw' }));

    expect(screen.getByText('другое время')).not.toBeNull();
    expect(screen.queryByText('Пульс')).toBeNull();
  });

  it('кнопка «Изменить» → колбэк onEditPoint с точкой (переход к правке TASK-038)', () => {
    const onEditPoint = vi.fn();
    render(
      createElement(ChartTooltip, {
        active: true,
        payload: rawPayload(MORNING_POINT),
        mode: 'raw',
        onEditPoint,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    expect(onEditPoint).toHaveBeenCalledTimes(1);
    expect(onEditPoint).toHaveBeenCalledWith(MORNING_POINT);
  });

  it('точка без id (агрегат/старый провод) — кнопки правки нет (§12: править нечего)', () => {
    const point: RawPoint = { ...MORNING_POINT, id: undefined };
    render(
      createElement(ChartTooltip, {
        active: true,
        payload: rawPayload(point),
        mode: 'raw',
        onEditPoint: vi.fn(),
      }),
    );

    expect(screen.queryByRole('button', { name: 'Изменить' })).toBeNull();
  });

  it('неактивный тултип (active=false) — ничего не рендерит (прецедент Recharts content)', () => {
    const { container } = render(
      createElement(ChartTooltip, {
        active: false,
        payload: rawPayload(MORNING_POINT),
        mode: 'raw',
      }),
    );
    expect(container.textContent).toBe('');
  });
});

describe('ChartTooltip — daily-режим (§5: коридор avg/min/max; §12: правки нет)', () => {
  it('день Intl-датой, среднее/диапазон обоих каналов, число измерений; кнопки правки нет', () => {
    const onEditPoint = vi.fn();
    render(
      createElement(ChartTooltip, {
        active: true,
        label: DAY_FIXTURE.wallDate,
        payload: [{ dataKey: 'sysAvg', value: DAY_FIXTURE.sysAvg, payload: DAY_FIXTURE }],
        mode: 'daily',
        onEditPoint,
      }),
    );

    expect(screen.getByText('02.03.2026')).not.toBeNull();
    expect(screen.getByText('124')).not.toBeNull();
    expect(screen.getByText('120–130')).not.toBeNull();
    expect(screen.getByText('82,3')).not.toBeNull();
    expect(screen.getByText('80–85')).not.toBeNull();
    expect(screen.getByText('Измерений: 3')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Изменить' })).toBeNull();
  });
});

// TASK-058 §5/§13/§16: канал pulse — тултип графика ЧСС: единица «уд/мин», пояс
// EC-10 для irregular-записей; mm рт. ст. НЕ показываются (§3: единицы не смешивать).
describe('ChartTooltip — channel=pulse (TASK-058: только ЧСС, единица, EC-10)', () => {
  it('дата-время, пульс с единицей «уд/мин»; sys/dia НЕ показываются (§3: единицы не смешивать)', () => {
    render(
      createElement(ChartTooltip, {
        active: true,
        payload: [{ dataKey: 'pulse', value: MORNING_POINT.pulse, payload: MORNING_POINT }],
        mode: 'raw',
        channel: 'pulse',
      }),
    );

    expect(screen.getByText(formatDateTime(MORNING_POINT, { preset: 'datetime' }))).not.toBeNull();
    expect(screen.getByText('70')).not.toBeNull();
    expect(screen.getByText('уд/мин')).not.toBeNull();
    expect(screen.queryByText('125')).toBeNull();
    expect(screen.queryByText('82')).toBeNull();
    expect(screen.getByText('утро')).not.toBeNull();
  });

  it('irregular-запись — пояс «Неровный пульс — значение может быть неточным» (EC-10); обычная — без пояса', () => {
    const irregular: RawPoint = { ...MORNING_POINT, irregular: true };
    render(
      createElement(ChartTooltip, {
        active: true,
        payload: [{ dataKey: 'pulse', value: irregular.pulse, payload: irregular }],
        mode: 'raw',
        channel: 'pulse',
      }),
    );
    expect(screen.getByText('Неровный пульс — значение может быть неточным')).not.toBeNull();
    cleanup();

    render(
      createElement(ChartTooltip, {
        active: true,
        payload: [{ dataKey: 'pulse', value: MORNING_POINT.pulse, payload: MORNING_POINT }],
        mode: 'raw',
        channel: 'pulse',
      }),
    );
    expect(screen.queryByText(/значение может быть неточным/)).toBeNull();
  });

  it('кнопка «Изменить» → onEditPoint с точкой (§5 058: переход к правке — как на давлении)', () => {
    const onEditPoint = vi.fn();
    render(
      createElement(ChartTooltip, {
        active: true,
        payload: [{ dataKey: 'pulse', value: MORNING_POINT.pulse, payload: MORNING_POINT }],
        mode: 'raw',
        channel: 'pulse',
        onEditPoint,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    expect(onEditPoint).toHaveBeenCalledTimes(1);
    expect(onEditPoint).toHaveBeenCalledWith(MORNING_POINT);
  });

  it('daily: среднее пульса дня с единицей, число измерений; правки нет; день без пульса — ничего', () => {
    const pulseDay: DayPoint = { ...DAY_FIXTURE, pulseAvg: 62.5, pulseCount: 2 };
    render(
      createElement(ChartTooltip, {
        active: true,
        label: pulseDay.wallDate,
        payload: [{ dataKey: 'pulseAvg', value: pulseDay.pulseAvg, payload: pulseDay }],
        mode: 'daily',
        channel: 'pulse',
      }),
    );

    expect(screen.getByText('02.03.2026')).not.toBeNull();
    expect(screen.getByTestId('chart-tooltip').textContent).toContain('Среднее за день');
    expect(screen.getByText('62,5')).not.toBeNull();
    expect(screen.getByText('уд/мин')).not.toBeNull();
    expect(screen.getByText('Измерений: 3')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Изменить' })).toBeNull();
    // Единицы давления не смешиваются с уд/мин (§3).
    expect(screen.queryByText('124')).toBeNull();
    cleanup();

    const noPulseDay: DayPoint = { ...DAY_FIXTURE };
    render(
      createElement(ChartTooltip, {
        active: true,
        label: noPulseDay.wallDate,
        payload: [{ dataKey: 'pulseAvg', value: undefined, payload: noPulseDay }],
        mode: 'daily',
        channel: 'pulse',
      }),
    );
    expect(screen.queryByText('02.03.2026')).toBeNull();
  });
});
