/**
 * TASK-061 §16/§19: axe-прогон домашнего экрана-сводки — ноль critical-
 * нарушений (прецедент DashboardScreen.a11y.test.ts 057/059). Два состояния:
 * приветствие пустого дневника (обучающий экран, FR-9.2) и карточки с данными
 * (иерархия section/h3 §16, CTA ≥48px, флаг critical — бейдж TASK-042 с
 * панелью TASK-041 в диалоге). Контраст в jsdom даёт incomplete, не violation;
 * полный масштаб-матричный прогон — e2e visual-scales (правило 048, обновлён).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { MeasurementListResponse, StatsResponse } from '@hl/contracts';

import { PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { localDateKey } from '../../measurement/model/wall-date';
import { ToastProvider } from '../../../app/toast';
import { SCALE_FIXTURE } from './__fixtures__/dashboard';
import { SummaryScreen } from './SummaryScreen';

import '../../../i18n';

/** stats 7d с классификацией; 30d — регулярность (одни read models с тестами 061). */
const STATS_7D: StatsResponse = {
  stats: {
    count: 12,
    sys: { avg: 124.3, min: 110, max: 140 },
    dia: { avg: 79.5, min: 70, max: 88 },
    pulse: { avg: 66.25 },
    critical: { high: false, low: false },
    daysWithMeasurements: 10,
    longestStreakDays: 6,
    insufficientData: { tooFewMeasurements: false, tooFewDays: false },
    classification: {
      category: {
        code: 'normal',
        label: 'Нормальное',
        sysRange: { min: 120, max: 129 },
        diaRange: { min: 80, max: 84 },
      },
      notes: [{ kind: 'homeBP', text: 'Классификация для домашних измерений давления' }],
    },
  },
  scale: { code: 'esc-esh-2018', version: '1.0.0', sourceLabel: 'ESC/ESH 2018' },
};

const STATS_30D: StatsResponse = {
  stats: {
    count: 66,
    sys: { avg: 125, min: 110, max: 145 },
    dia: { avg: 80, min: 70, max: 90 },
    critical: { high: false, low: false },
    daysWithMeasurements: 22,
    longestStreakDays: 5,
    insufficientData: { tooFewMeasurements: false, tooFewDays: false },
  },
  scale: { code: 'esc-esh-2018', version: '1.0.0', sourceLabel: 'ESC/ESH 2018' },
};

/** Последняя запись: сегодня 08:12 (машинонезависимо), с пульсом, без флагов. */
function lastPage(): MeasurementListResponse {
  const todayKey = localDateKey(Date.now());
  const [y, m, d] = todayKey.split('-').map(Number);
  const tzOffsetMin = -new Date().getTimezoneOffset();
  const utcMs = Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1, 8, 12) - tzOffsetMin * 60_000;
  return {
    items: [
      {
        id: 'm-last',
        profileId: PROFILE_ID,
        sys: 125,
        dia: 82,
        pulse: 72,
        irregularPulse: false,
        arm: 'left',
        takenAtUtcMs: utcMs,
        tzOffsetMin,
        source: 'manual',
        createdAtUtcMs: utcMs,
        updatedAtUtcMs: utcMs,
      },
    ],
    total: 5,
  };
}

/** Мост: каналы сводки + каналы графика (сводка монтирует DashboardScreen). */
function mockHl(withData: boolean): void {
  const list: MeasurementListResponse = withData ? lastPage() : { items: [], total: 0 };
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke: vi.fn((channel: string, payload: unknown) => {
        if (channel === 'measurements/list') {
          return Promise.resolve({ v: 1, ok: true, data: list });
        }
        if (channel === 'stats/period') {
          const stats = (payload as { period?: string }).period === '7d' ? STATS_7D : STATS_30D;
          return Promise.resolve({ v: 1, ok: true, data: stats });
        }
        if (channel === 'scales/active') {
          return Promise.resolve({ v: 1, ok: true, data: SCALE_FIXTURE });
        }
        // График на пустом мосте — empty-состояние (TASK-060); сводке хватает.
        return Promise.resolve({ v: 1, ok: true, data: { mode: 'raw', points: [] } });
      }),
      on: vi.fn(() => () => undefined),
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

/** Рендер экрана под провайдерами; axe-дерево — контейнер (§20.6 прецедент). */
async function renderAndAxe(marker: string): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ToastProvider,
        null,
        createElement(MemoryRouter, { initialEntries: ['/dashboard'] }, children),
      ),
    );
  const { container } = render(createElement(SummaryScreen), { wrapper });

  // Ждём готовности состояния по маркеру — axe по дереву с контентом.
  await waitFor(() => expect(container.querySelector(marker)).not.toBeNull());

  const results = await axe.run(container);
  const critical = results.violations.filter((violation) => violation.impact === 'critical');
  expect(critical).toEqual([]);
}

describe('SummaryScreen — axe: без critical-нарушений (§16/§19)', () => {
  it('приветствие пустого дневника: violations с impact=critical отсутствуют', async () => {
    mockHl(false);
    await renderAndAxe('[data-testid="dashboard-welcome"]');
  });

  it('карточки с данными (сводка + график ниже): violations с impact=critical отсутствуют', async () => {
    mockHl(true);
    await renderAndAxe('[data-testid="last-measurement-card"]');
  });
});
