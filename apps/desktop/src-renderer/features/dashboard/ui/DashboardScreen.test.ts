/**
 * TASK-057 §5/§10/§11/§12/§19/§20: интеграционные тесты экрана «Динамика».
 *
 * Матрица (§20): заголовок «Динамика»; выборка trend/series и scales/active
 * (§11); периоды переключаются, URL меняется, «Произвольный» работает (§20.4,
 * сквозной с PeriodSwitcher/lib-period); клик по точке → startEdit полным DTO +
 * переход к правке на /journal (§20.3 сквозной; TASK-038 edit-режим);
 * daily-режим — подпись агрегации (§20.5); empty — каркас TASK-060 «Нет данных
 * за период» + CTA (§10); live-инвалидация measurement:changed (§10: данные
 * свежие после ввода); pending — скелетон-оси (§10).
 *
 * TASK-058 §5/§12/§19: переключатель вида «Давление/Пульс» — URL ?view=
 * (дефолт pressure, мусор → дефолт); переключение меняет график (DOM) без
 * повторного запроса (кэш trend/series общий, §12); view=pulse переживает
 * перезагрузку (URL — истина) и смену периода (PeriodSwitcher сохраняет чужие
 * параметры).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import type { MeasurementListResponse, TrendResponse } from '@hl/contracts';

import { PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { useFormStore } from '../../measurement/model/form-store';
import { ToastProvider } from '../../../app/toast';
import { DashboardScreen } from './DashboardScreen';
import { PULSE_DAYS, SCALE_FIXTURE, TREND_30_DAYS, fixturePoint } from './__fixtures__/dashboard';

import '../../../i18n';

/** DTO фикстуры для правки (measurements/list отвечает полной записью). */
const DTO_FIXTURE = {
  id: 'rec-0-0',
  profileId: PROFILE_ID,
  sys: 120,
  dia: 78,
  pulse: 62,
  irregularPulse: false,
  arm: 'left' as const,
  note: undefined,
  takenAtUtcMs: fixturePoint(0, 0).utcMs,
  tzOffsetMin: 180,
  source: 'manual' as const,
  createdAtUtcMs: fixturePoint(0, 0).utcMs,
  updatedAtUtcMs: fixturePoint(0, 0).utcMs,
};

const RAW_RESPONSE: TrendResponse = { mode: 'raw', points: [...TREND_30_DAYS] };

/** Проба адреса: MemoryRouter не пишет window.location — читаем useLocation внутри. */
function LocationProbeTarget({
  probe,
}: {
  readonly probe: { pathname: string; search: string };
}): null {
  const { pathname, search } = useLocation();
  probe.pathname = pathname;
  probe.search = search;
  return null;
}

/** Мост-мок: сигнатура с Promise-ответом — прецедент HistoryScreen.search.test. */
let invoke: Mock<(channel: string, payload: unknown) => Promise<unknown>>;

/** Мок подписки на события (measurement:changed-тест читает обработчики). */
let on: Mock<(name: string, handler: (payload: unknown) => void) => () => void>;

/** Мост window.hl: диспетчер по каналу (trend/scale/list). */
function mockHl(overrides: Record<string, () => unknown> = {}): void {
  invoke = vi.fn((channel: string) => {
    const override = overrides[channel];
    if (override !== undefined) {
      return Promise.resolve(override());
    }
    if (channel === 'trend/series') {
      return Promise.resolve({ v: 1, ok: true, data: RAW_RESPONSE });
    }
    if (channel === 'scales/active') {
      return Promise.resolve({ v: 1, ok: true, data: SCALE_FIXTURE });
    }
    if (channel === 'measurements/list') {
      return Promise.resolve({
        v: 1,
        ok: true,
        data: { items: [DTO_FIXTURE], total: 1 } satisfies MeasurementListResponse,
      });
    }
    return Promise.resolve({ v: 1, ok: true, data: {} });
  });
  on = vi.fn(() => () => undefined);
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: { invoke, on },
  });
}

/** Подключённый экран: настоящий MemoryRouter (useSearchParams/useNavigate) + провайдеры. */
function renderScreen(initialEntry = '/dashboard'): {
  probe: { pathname: string; search: string };
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const probe = { pathname: '', search: '' };
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ToastProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [initialEntry] },
          // Подключённый экран через Route: useSearchParams/useNavigate настоящие.
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/dashboard', element: children }),
            createElement(Route, {
              path: '/journal',
              element: createElement('div', {}, 'ЖУРНАЛ-ПРОБА'),
            }),
          ),
          createElement(LocationProbeTarget, { probe }),
        ),
      ),
    );
  render(createElement(DashboardScreen), { wrapper });
  return { probe };
}

/** Тренд-ответ с подменой для конкретного кейса. */
function mockTrend(response: TrendResponse): void {
  mockHl({ 'trend/series': () => ({ v: 1, ok: true, data: response }) });
}

beforeEach(() => {
  mockHl();
  useFormStore.getState().resetAll();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('DashboardScreen — состояния (§10: loading/empty/данные)', () => {
  it('pending — скелетон-оси (role=status), запросы trend/series и scales/active уходят', () => {
    renderScreen();

    // role=status (в дополнение к testid): aria-label «Загрузка…» из каталога.
    expect(screen.getByTestId('dashboard-skeleton').getAttribute('aria-label')).toBe('Загрузка…');
    expect(invoke).toHaveBeenCalledWith('trend/series', { profileId: PROFILE_ID, period: '30d' });
    expect(invoke).toHaveBeenCalledWith('scales/active', {});
  });

  it('данные: график с легендой и опорными линиями шкалы, заголовок «Динамика»', async () => {
    renderScreen();

    expect(await screen.findByTestId('trend-chart')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Динамика' })).not.toBeNull();
    expect(screen.getByTestId('scale-source').textContent).toContain('ESC/ESH 2018');
    expect(screen.getByTestId('trend-legend')).not.toBeNull();
  });

  it('empty (§10): «Нет данных за период» + CTA каркаса TASK-060 → журнал', async () => {
    mockTrend({ mode: 'raw', points: [] });
    renderScreen();

    const empty = await screen.findByTestId('empty-chart');
    expect(empty.textContent).toContain('Нет данных за период');
    fireEvent.click(screen.getByRole('button', { name: 'Открыть журнал' }));
    await waitFor(() => expect(screen.getByText('ЖУРНАЛ-ПРОБА')).not.toBeNull());
  });

  it('daily-режим: подпись «Агрегировано по дням» (§20.5 честность агрегации)', async () => {
    mockTrend({
      mode: 'daily',
      days: [
        {
          wallDate: '2026-03-01',
          sysAvg: 122,
          sysMin: 118,
          sysMax: 128,
          diaAvg: 79,
          diaMin: 76,
          diaMax: 82,
          count: 3,
        },
      ],
    });
    renderScreen();

    const caption = await screen.findByTestId('trend-daily-caption');
    expect(caption.textContent).toContain('Агрегировано по дням');
  });
});

describe('DashboardScreen — периоды и переход к правке (§20.3/§20.4)', () => {
  it('(AC4) клик пресета «7 дней» → URL ?period=7d и повторный запрос с периодом 7d', async () => {
    const { probe } = renderScreen();

    await screen.findByTestId('trend-chart');
    fireEvent.click(screen.getByTestId('dashboard-period-7d'));
    expect(probe.search).toBe('?period=7d');
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('trend/series', { profileId: PROFILE_ID, period: '7d' }),
    );
  });

  it('загрузка с ?period=7d — запрос сразу с периодом 7d (URL — истина, §12)', async () => {
    renderScreen('/dashboard?period=7d');

    await screen.findByTestId('trend-chart');
    expect(invoke).toHaveBeenCalledWith('trend/series', { profileId: PROFILE_ID, period: '7d' });
  });

  it('(AC3) клик по точке → list по utc записи → startEdit полным DTO → /journal (сквозной)', async () => {
    const { probe } = renderScreen();

    const chart = await screen.findByTestId('trend-chart');
    const dot = chart.querySelector('circle[data-testid="trend-dot"]');
    if (dot === null) {
      throw new Error('маркер утренней точки обязан быть в DOM (raw-режим с точками)');
    }
    fireEvent.click(dot);

    // Полный DTO из measurements/list (from=to=utcMs точки; страница-дефолт, §12).
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('measurements/list', {
        profileId: PROFILE_ID,
        limit: 200,
        offset: 0,
        fromUtcMs: fixturePoint(0, 0).utcMs,
        toUtcMs: fixturePoint(0, 0).utcMs,
      }),
    );
    // Режим правки TASK-038: поля из DTO, editingId записи.
    const state = useFormStore.getState();
    expect(state.editingId).toBe('rec-0-0');
    expect(state.sys).toBe('120');
    // Переход к журналу — форма там откроется (editingId ≠ null).
    await waitFor(() => expect(probe.pathname).toBe('/journal'));
    // Барьер изоляции: сброс к add-режиму.
    useFormStore.getState().cancelEdit();
  });

  it('measurement:changed → инвалидация серий → повторный запрос (§10: свежие после ввода)', async () => {
    renderScreen();
    await screen.findByTestId('trend-chart');
    invoke.mockClear();

    const changedHandler = on.mock.calls.find(([name]) => name === 'measurement:changed')?.[1] as
      ((payload: { profileId: string }) => void) | undefined;
    if (changedHandler === undefined) {
      throw new Error('экран обязан подписаться на measurement:changed (§10)');
    }
    changedHandler({ profileId: PROFILE_ID });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('trend/series', { profileId: PROFILE_ID, period: '30d' }),
    );
  });
});

describe('DashboardScreen — вид «Давление/Пульс» (TASK-058 §5/§12/§19/§20)', () => {
  it('дефолт: сегмент с aria-pressed, график давления; ?view=pulse → график ЧСС (AC5: перезагрузка)', async () => {
    renderScreen();

    await screen.findByTestId('trend-chart');
    expect(screen.queryByTestId('pulse-chart')).toBeNull();
    expect(screen.getByTestId('dashboard-view-pressure').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('dashboard-view-pulse').getAttribute('aria-pressed')).toBe('false');
    cleanup();

    renderScreen('/dashboard?view=pulse');
    await screen.findByTestId('pulse-chart');
    expect(screen.queryByTestId('trend-chart')).toBeNull();
    expect(screen.getByTestId('dashboard-view-pulse').getAttribute('aria-pressed')).toBe('true');
  });

  it('(§19) переключение вкладки меняет график (DOM) и пишет ?view=pulse без повторного запроса (кэш общий)', async () => {
    const { probe } = renderScreen();
    await screen.findByTestId('trend-chart');
    invoke.mockClear();

    fireEvent.click(screen.getByTestId('dashboard-view-pulse'));

    expect(await screen.findByTestId('pulse-chart')).not.toBeNull();
    expect(screen.queryByTestId('trend-chart')).toBeNull();
    expect(probe.search).toBe('?view=pulse');
    const trendCalls = invoke.mock.calls.filter(([channel]) => channel === 'trend/series');
    expect(trendCalls).toHaveLength(0);
  });

  it('обратно «Давление» → график давления, view из URL убран', async () => {
    const { probe } = renderScreen('/dashboard?view=pulse');
    await screen.findByTestId('pulse-chart');

    fireEvent.click(screen.getByTestId('dashboard-view-pressure'));

    expect(await screen.findByTestId('trend-chart')).not.toBeNull();
    expect(probe.search).toBe('');
  });

  it('мусор в ?view= → дефолт pressure (§14: без ошибок, URL не переписывается при загрузке)', async () => {
    const { probe } = renderScreen('/dashboard?view=chart');

    await screen.findByTestId('trend-chart');
    expect(screen.queryByTestId('pulse-chart')).toBeNull();
    expect(probe.search).toBe('?view=chart');
  });

  it('смена периода на виде «Пульс»: view сохранён, серия перечитана с новым периодом (§12)', async () => {
    const { probe } = renderScreen('/dashboard?view=pulse');
    await screen.findByTestId('pulse-chart');

    fireEvent.click(screen.getByTestId('dashboard-period-7d'));

    expect(probe.search).toBe('?period=7d&view=pulse');
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('trend/series', { profileId: PROFILE_ID, period: '7d' }),
    );
    expect(await screen.findByTestId('pulse-chart')).not.toBeNull();
  });

  it('daily-пульс: график ЧСС рендерит агрегаты (PULSE_DAYS), empty общий для обоих видов', async () => {
    mockTrend({ mode: 'daily', days: [...PULSE_DAYS] });
    renderScreen('/dashboard?view=pulse');

    expect(await screen.findByTestId('pulse-chart')).not.toBeNull();
    expect(screen.getByTestId('pulse-daily-caption').textContent).toContain('Агрегировано по дням');
    cleanup();

    mockTrend({ mode: 'raw', points: [] });
    renderScreen('/dashboard?view=pulse');
    expect(await screen.findByTestId('empty-chart')).not.toBeNull();
  });

  it('переход к правке с пульс-графика — тот же openEdit (сквозной, как на давлении, §5)', async () => {
    const { probe } = renderScreen('/dashboard?view=pulse');
    const chart = await screen.findByTestId('pulse-chart');
    const dot = chart.querySelector('[data-testid="pulse-dot"]');
    if (dot === null) {
      throw new Error('маркер точки ЧСС обязан быть в DOM (фикстура с пульсом)');
    }
    fireEvent.click(dot);

    await waitFor(() => expect(useFormStore.getState().editingId).toBe('rec-0-0'));
    await waitFor(() => expect(probe.pathname).toBe('/journal'));
    useFormStore.getState().cancelEdit();
  });
});
