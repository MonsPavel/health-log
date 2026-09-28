/**
 * TASK-057 §20.6: axe-прогон экрана «Динамика» — ноль critical-нарушений
 * (прецедент MeasurementForm.a11y.test.ts TASK-031; figure role="img" с
 * aria-label-резюме §16, мини-таблица клавиатуры §16, подпись источника —
 * текст, различимый скринридером). Контраст в jsdom даёт incomplete, не
 * violation; полный масштаб-матричный прогон — ручной §24 / TASK-108.
 *
 * TASK-059 §20: отдельный прогон режима таблицы (?as=table) — caption/th-scope/
 * aria-sort разметка без critical-нарушений (атрибутные ассерты — TrendTable.test).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { StatsResponse, TrendResponse } from '@hl/contracts';

import { ToastProvider } from '../../../app/toast';
import { DashboardScreen } from './DashboardScreen';
import { SCALE_FIXTURE, TREND_DAYS } from './__fixtures__/dashboard';

import '../../../i18n';

/** Фикстура stats/period (резюме + aria-метка графика — TASK-059 §5). */
const STATS_RESPONSE: StatsResponse = {
  stats: {
    count: 6,
    sys: { avg: 122.5, min: 118, max: 128 },
    dia: { avg: 80, min: 76, max: 82 },
    critical: { high: false, low: false },
    daysWithMeasurements: 3,
    longestStreakDays: 3,
    insufficientData: { tooFewMeasurements: false, tooFewDays: false },
  },
  scale: { code: 'esc-esh-2018', version: '1.0.0', sourceLabel: 'ESC/ESH 2018' },
};

/** Мост: шкала + daily-агрегаты (коридор/avg — обе ветки разметки графика). */
function mockHl(): void {
  const trend: TrendResponse = { mode: 'daily', days: [...TREND_DAYS] };
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke: vi.fn((channel: string) =>
        Promise.resolve(
          channel === 'trend/series'
            ? { v: 1, ok: true, data: trend }
            : channel === 'scales/active'
              ? { v: 1, ok: true, data: SCALE_FIXTURE }
              : channel === 'stats/period'
                ? { v: 1, ok: true, data: STATS_RESPONSE }
                : { v: 1, ok: true, data: { items: [], total: 0 } },
        ),
      ),
      on: vi.fn(() => () => undefined),
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

/** Рендер экрана по стартовому адресу; данные ждёт вызывающий (waitFor по testid). */
function renderScreen(initialEntry: string): HTMLElement {
  mockHl();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ToastProvider,
        null,
        createElement(MemoryRouter, { initialEntries: [initialEntry] }, children),
      ),
    );
  const { container } = render(createElement(DashboardScreen), { wrapper });
  return container;
}

describe('DashboardScreen — axe: без critical-нарушений (§20.6)', () => {
  it('axe.run: violations с impact=critical отсутствуют (экран с графиком daily и шкалой)', async () => {
    const container = renderScreen('/dashboard');

    // Ждём данных (график смонтирован) — axe по дереву с графиком.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="trend-daily-caption"]')).not.toBeNull(),
    );

    const results = await axe.run(container);

    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical).toEqual([]);
  });

  // TASK-059 §20: таблица-альтернатива — полное скринридер-представление (NFR-6):
  // caption/scope/aria-sort-разметка без critical-нарушений и в axe.
  it('(059 §20) axe.run в режиме ?as=table: violations с impact=critical отсутствуют', async () => {
    const container = renderScreen('/dashboard?as=table');

    await waitFor(() =>
      expect(container.querySelector('[data-testid="trend-table"]')).not.toBeNull(),
    );

    const results = await axe.run(container);

    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical).toEqual([]);
  });
});
