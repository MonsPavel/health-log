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
 *
 * TASK-060 §5/§13/§19/§20: пустые/мало-данные состояния — пустой период (в обоих
 * режимах raw/daily) → EmptyChartState («За выбранный период измерений нет»,
 * CTA «Добавить измерение» → журнал, «Показать всё время» → период all; на all
 * действие-нооп скрыто); 1≤N<7 → FewDataNote «Мало данных — N …» НАД графиком
 * (порог kernel — готовый флаг stats.insufficientData.tooFewMeasurements: рендерер
 * kernel не импортирует, арх. 03 §4); ≥7 — график без пометки; смена периода
 * с данными на пустой — заглушка без ошибок консоли (§20 AC4).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import type { MeasurementListResponse, StatsResponse, TrendResponse } from '@hl/contracts';

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

/**
 * Фикстура stats/period (TASK-059 §19): резюме и aria-метка графика потребляют
 * ИМЕННО эти числа (тест-сверка §13: «резюме-числа == числа графика — одни read
 * models» — оба DOM-узла строятся из одного mock-ответа stats).
 */
const STATS_RESPONSE: StatsResponse = {
  stats: {
    count: 90,
    sys: { avg: 128, min: 112, max: 145 },
    dia: { avg: 82, min: 76, max: 90 },
    critical: { high: false, low: false },
    daysWithMeasurements: 30,
    longestStreakDays: 30,
    insufficientData: { tooFewMeasurements: false, tooFewDays: false },
  },
  scale: { code: 'esc-esh-2018', version: '1.0.0', sourceLabel: 'ESC/ESH 2018' },
};

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

/** Мост window.hl: диспетчер по каналу (trend/scale/list); override получает payload. */
function mockHl(overrides: Record<string, (payload: unknown) => unknown> = {}): void {
  invoke = vi.fn((channel: string, payload: unknown) => {
    const override = overrides[channel];
    if (override !== undefined) {
      return Promise.resolve(override(payload));
    }
    if (channel === 'trend/series') {
      return Promise.resolve({ v: 1, ok: true, data: RAW_RESPONSE });
    }
    if (channel === 'stats/period') {
      return Promise.resolve({ v: 1, ok: true, data: STATS_RESPONSE });
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

/**
 * Stats фикстуры «мало данных» (TASK-060 §19): порог «мало данных» приходит
 * готовым флагом stats.insufficientData.tooFewMeasurements (kernel-константа
 * AI_MIN_MEASUREMENTS=7 считается в main — period-statistics.ts; рендерер kernel
 * не импортирует, арх. 03 §4). Подменяется ВМЕСТЕ с трендом (mockHl — полный
 * мост: второй вызов затёр бы первый override).
 */
function fewStats(count: number): StatsResponse {
  return {
    stats: {
      count,
      sys: { avg: 122, min: 118, max: 128 },
      dia: { avg: 80, min: 76, max: 82 },
      critical: { high: false, low: false },
      daysWithMeasurements: count,
      longestStreakDays: count,
      insufficientData: { tooFewMeasurements: true, tooFewDays: true },
    },
    scale: { code: 'esc-esh-2018', version: '1.0.0', sourceLabel: 'ESC/ESH 2018' },
  };
}

/** Тренд+stats одним мостом (TASK-060: оба канала согласованы — N точек и флаг). */
function mockTrendWithStats(response: TrendResponse, stats: StatsResponse): void {
  mockHl({
    'trend/series': () => ({ v: 1, ok: true, data: response }),
    'stats/period': () => ({ v: 1, ok: true, data: stats }),
  });
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

  it('(060 §20 AC1) empty: заглушка «За выбранный период измерений нет», CTA «Добавить измерение» → журнал', async () => {
    mockTrend({ mode: 'raw', points: [] });
    renderScreen();

    const empty = await screen.findByTestId('empty-chart');
    expect(empty.textContent).toContain('За выбранный период измерений нет');
    fireEvent.click(screen.getByRole('button', { name: 'Добавить измерение' }));
    await waitFor(() => expect(screen.getByText('ЖУРНАЛ-ПРОБА')).not.toBeNull());
  });

  it('(060 §5) «Показать всё время» → период all (URL ?period=all, каналы перечитаны); пусто и на all — действие скрыто', async () => {
    mockTrend({ mode: 'raw', points: [] });
    const { probe } = renderScreen();

    await screen.findByTestId('empty-chart');
    fireEvent.click(screen.getByRole('button', { name: 'Показать всё время' }));
    expect(probe.search).toBe('?period=all');
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('trend/series', { profileId: PROFILE_ID, period: 'all' }),
    );
    // Пусто и на «всё время» — записей нет вовсе: действие-нооп скрыто, CTA остаётся.
    expect(await screen.findByTestId('empty-chart')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Показать всё время' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Добавить измерение' })).not.toBeNull();
  });

  it('(060 §13) daily без дней — та же заглушка (пустота определяется в обоих режимах)', async () => {
    mockTrend({ mode: 'daily', days: [] });
    renderScreen();

    expect(await screen.findByTestId('empty-chart')).not.toBeNull();
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

describe('DashboardScreen — мало данных (TASK-060 §13/§19/§20)', () => {
  it('(AC2) 3 точки → пометка «Мало данных — 3 …» над графиком (role=note), график присутствует', async () => {
    mockTrendWithStats(
      { mode: 'raw', points: [fixturePoint(0, 0), fixturePoint(1, 0), fixturePoint(2, 0)] },
      fewStats(3),
    );
    renderScreen();

    const note = await screen.findByTestId('few-data-note');
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toContain('Мало данных — 3 измерения за период');
    expect(await screen.findByTestId('trend-chart')).not.toBeNull();
    // Пометка НАД графиком (§5: полоса над графиком).
    expect(note.nextElementSibling?.contains(screen.getByTestId('trend-chart')) ?? false).toBe(
      true,
    );
  });

  it('(AC3) 7+ точек, порог kernel пройден (tooFewMeasurements=false) — график без пометки', async () => {
    renderScreen();

    expect(await screen.findByTestId('trend-chart')).not.toBeNull();
    expect(screen.queryByTestId('few-data-note')).toBeNull();
  });

  it('(§13) порог — готовый флаг stats (kernel в main): tooFewMeasurements=true при пустом тренде — заглушка без пометки', async () => {
    mockTrendWithStats({ mode: 'raw', points: [] }, fewStats(0));
    renderScreen();

    expect(await screen.findByTestId('empty-chart')).not.toBeNull();
    expect(screen.queryByTestId('few-data-note')).toBeNull();
  });

  it('(AC4) смена периода с данными на пустой — заглушка появляется, ошибок консоли нет', async () => {
    const consoleError = vi.spyOn(console, 'error');
    // 30d — данные; 7d — пусто (mockHl различает периоды по payload, TASK-060).
    mockHl({
      'trend/series': (payload) => ({
        v: 1,
        ok: true,
        data:
          (payload as { period?: string }).period === '7d'
            ? { mode: 'raw', points: [] }
            : { mode: 'raw', points: [...TREND_30_DAYS] },
      }),
      'stats/period': (payload) => ({
        v: 1,
        ok: true,
        data: (payload as { period?: string }).period === '7d' ? fewStats(0) : STATS_RESPONSE,
      }),
    });
    const { probe } = renderScreen();

    await screen.findByTestId('trend-chart');
    fireEvent.click(screen.getByTestId('dashboard-period-7d'));
    expect(probe.search).toBe('?period=7d');

    expect(await screen.findByTestId('empty-chart')).not.toBeNull();
    expect(screen.queryByTestId('trend-chart')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
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

describe('DashboardScreen — «График/Таблица» и резюме (TASK-059 §5/§12/§19/§20)', () => {
  it('дефолт chart: сегмент «Представление» (aria-pressed), график; stats/period запрошен с тем же периодом', async () => {
    renderScreen();

    expect(await screen.findByTestId('trend-chart')).not.toBeNull();
    expect(screen.getByTestId('dashboard-as-chart').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('dashboard-as-table').getAttribute('aria-pressed')).toBe('false');
    expect(invoke).toHaveBeenCalledWith('stats/period', { profileId: PROFILE_ID, period: '30d' });
  });

  it('(AC3) резюме под графиком — числа фикстуры stats: «Среднее СДА за 30 дней: 128 (диапазон 112–145)»', async () => {
    renderScreen();

    const summary = await screen.findByTestId('trend-summary');
    expect(summary.getAttribute('role')).toBe('note');
    expect(summary.textContent).toContain('Среднее СДА за 30 дней: 128 (диапазон 112–145)');
    expect(summary.textContent).toContain('Среднее ДДА за 30 дней: 82 (диапазон 76–90)');
    expect(summary.textContent).toContain('Измерений: 90');
  });

  it('(§13 тест-сверка) aria-метка графика = числа резюме: оба узла — из одного stats-ответа', async () => {
    renderScreen();

    const figure = await screen.findByTestId('trend-chart');
    const label = figure.getAttribute('aria-label') ?? '';
    expect(label).toContain('в среднем 128 (диапазон 112–145)');
    expect(label).toContain('измерений: 90');
    const summary = await screen.findByTestId('trend-summary');
    expect(summary.textContent).toContain('128 (диапазон 112–145)');
    expect(summary.textContent).toContain('Измерений: 90');
  });

  it('(AC1) клик «Таблица» → таблица тех же данных вместо графика, URL ?as=table, без повторного запроса (кэш общий)', async () => {
    const { probe } = renderScreen();
    await screen.findByTestId('trend-chart');
    invoke.mockClear();

    fireEvent.click(screen.getByTestId('dashboard-as-table'));

    expect(await screen.findByTestId('trend-table')).not.toBeNull();
    expect(screen.queryByTestId('trend-chart')).toBeNull();
    expect(probe.search).toBe('?as=table');
    expect(invoke.mock.calls.filter(([channel]) => channel === 'trend/series')).toHaveLength(0);
  });

  it('(AC1) загрузка с ?as=table — таблица сразу (URL переживает перезагрузку); сегмент «Давление/Пульс» скрыт (на таблицу не влияет); обратно «График» возвращает вид', async () => {
    renderScreen('/dashboard?as=table');

    expect(await screen.findByTestId('trend-table')).not.toBeNull();
    expect(screen.queryByTestId('dashboard-view')).toBeNull();

    fireEvent.click(screen.getByTestId('dashboard-as-chart'));
    expect(await screen.findByTestId('trend-chart')).not.toBeNull();
    expect(screen.queryByTestId('dashboard-view')).not.toBeNull();
  });

  it('мусор в ?as= → дефолт chart (§14: без ошибок, URL не переписывается при загрузке)', async () => {
    const { probe } = renderScreen('/dashboard?as=pivot');

    expect(await screen.findByTestId('trend-chart')).not.toBeNull();
    expect(screen.queryByTestId('trend-table')).toBeNull();
    expect(screen.getByTestId('dashboard-as-chart').getAttribute('aria-pressed')).toBe('true');
    expect(probe.search).toBe('?as=pivot');
  });

  it('таблица на фикстуре тренда: строка на каждую точку, значения те же (§13: одни данные); резюме — под графиком, в таблице его нет', async () => {
    renderScreen('/dashboard?as=table');

    const rows = await screen.findAllByTestId('trend-table-row');
    expect(rows.length).toBe(TREND_30_DAYS.length);
    const first = TREND_30_DAYS[0];
    if (first === undefined) {
      throw new Error('фикстура 30 дней должна содержать точки');
    }
    expect(rows[0]?.textContent).toContain(String(first.sys));
    expect(rows[0]?.textContent).toContain(String(first.dia));
    expect(screen.queryByTestId('trend-summary')).toBeNull();
  });

  it('смена периода в режиме таблицы: as сохранён, тренд и stats перечитаны с новым периодом (§12)', async () => {
    const { probe } = renderScreen('/dashboard?as=table');
    await screen.findByTestId('trend-table');

    fireEvent.click(screen.getByTestId('dashboard-period-7d'));

    expect(probe.search).toBe('?period=7d&as=table');
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('trend/series', { profileId: PROFILE_ID, period: '7d' }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('stats/period', { profileId: PROFILE_ID, period: '7d' }),
    );
  });

  it('measurement:changed → инвалидация серий И статистики (§10: резюме тоже свежие после ввода)', async () => {
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
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('stats/period', { profileId: PROFILE_ID, period: '30d' }),
    );
  });
});
