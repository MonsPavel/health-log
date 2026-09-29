/**
 * TASK-061 §5/§11/§12/§19/§20: интеграционные тесты домашнего экрана-сводки.
 *
 * Матрица (§20): чистая БД → приветственный экран «Начните дневник» с CTA
 * (клик → журнал — форма открывается кнопкой «Добавить» журнала; форма не
 * URL-адресуема — интерпретация AC1 как у TASK-060); с данными — карточки
 * заполнены ИЗ mock-каналов (§4: принцип задачи — без новых вычислений);
 * 3 записи → «мало данных» у средних, категория отсутствует; последняя запись
 * 190/125 → доступ к панели срочности со сводки; серия — golden-тексты
 * (детально в RegularityCard.test).
 *
 * ЗАПРОСЫ (§12/§15): measurements/list {limit:1} — последняя запись (list
 * отсортирован desc — TASK-030); stats/period 7d (средние) и 30d (регулярность)
 * — параллельные useQuery; live-инвалидация measurement:changed → перечитывание
 * (§12: сводка живая).
 *
 * СТРУКТУРА (§6 УПРОЩЕНИЕ): /dashboard = сводка + под ней график (TASK-057)
 * — секции на одном маршруте, якорь #trends. Пустая БД → сводка-приветствие
 * ЗАМЕНЯЕТ экран целиком (обе обучающие заглушки стопкой — двойной шум; график
 * появляется вместе с данными).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import type { MeasurementListResponse, StatsResponse } from '@hl/contracts';

import { PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { localDateKey } from '../../measurement/model/wall-date';
import { ToastProvider } from '../../../app/toast';
import { SCALE_FIXTURE } from './__fixtures__/dashboard';
import { SummaryScreen } from './SummaryScreen';

import '../../../i18n';

/** DTO фикстуры для правки (measurements/list страницы — прецедент 057). */
const DTO_PAGE_FIXTURE = {
  id: 'rec-0-0',
  profileId: PROFILE_ID,
  sys: 120,
  dia: 78,
  pulse: 62,
  irregularPulse: false,
  arm: 'left' as const,
  note: undefined,
  takenAtUtcMs: Date.UTC(2026, 8, 1, 7, 0),
  tzOffsetMin: 180,
  source: 'manual' as const,
  createdAtUtcMs: Date.UTC(2026, 8, 1, 7, 0),
  updatedAtUtcMs: Date.UTC(2026, 8, 1, 7, 0),
};

/** «Сейчас» теста: DTO последней записи строится от него (сегодня 08:12). */
const NOW_MS = Date.now();
const TODAY_KEY = localDateKey(NOW_MS);
const TZ_OFFSET_MIN = -new Date(NOW_MS).getTimezoneOffset();

/** Instant «сегодня 08:12» в поясе устройства (машинонезависимо). */
function todayAt(wallTime: string): { utcMs: number; tzOffsetMin: number } {
  const [y, m, d] = TODAY_KEY.split('-').map(Number);
  const [h, min] = wallTime.split(':').map(Number);
  return {
    utcMs: Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1, h ?? 0, min ?? 0) - TZ_OFFSET_MIN * 60_000,
    tzOffsetMin: TZ_OFFSET_MIN,
  };
}

/** Последняя запись (нормальная): 125/82, пульс 72, сегодня 08:12. */
function lastDto(
  overrides: Record<string, unknown> = {},
): MeasurementListResponse['items'][number] {
  const takenAt = todayAt('08:12');
  return {
    id: 'm-last',
    profileId: PROFILE_ID,
    sys: 125,
    dia: 82,
    pulse: 72,
    irregularPulse: false,
    arm: 'left',
    note: undefined,
    takenAtUtcMs: takenAt.utcMs,
    tzOffsetMin: takenAt.tzOffsetMin,
    source: 'manual',
    createdAtUtcMs: takenAt.utcMs,
    updatedAtUtcMs: takenAt.utcMs,
    ...overrides,
  };
}

/** stats 7d с классификацией (§20 AC2: категория+notes из канала; label едет в ответе). */
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

/** stats 30d — источник регулярности (§5: серия + дни с измерениями). */
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

/** stats 7d «мало данных»: 3 записи, классификатор вернул undefined-категорию. */
const STATS_7D_FEW: StatsResponse = {
  stats: {
    count: 3,
    sys: { avg: 122, min: 118, max: 128 },
    dia: { avg: 80, min: 76, max: 82 },
    critical: { high: false, low: false },
    daysWithMeasurements: 3,
    longestStreakDays: 3,
    insufficientData: { tooFewMeasurements: true, tooFewDays: true },
    classification: {
      notes: [
        {
          kind: 'insufficientData',
          text: 'Данных пока мало: среднее и категория за период не определяются — продолжайте измерения.',
        },
      ],
    },
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

/** Мост-мок: сигнатура с Promise-ответом — прецедент DashboardScreen.test. */
let invoke: Mock<(channel: string, payload: unknown) => Promise<unknown>>;

/** Мок подписки на события (live-тест читает обработчики). */
let on: Mock<(name: string, handler: (payload: unknown) => void) => () => void>;

/** Ответ last-measurement по умолчанию (переназначается в тестах). */
let lastResponse: MeasurementListResponse;

/** Мост window.hl: диспетчер по каналу/периоду (§12 каналы сводки + каналы графика). */
function mockHl(overrides: Record<string, (payload: unknown) => unknown> = {}): void {
  invoke = vi.fn((channel: string, payload: unknown) => {
    const override = overrides[channel];
    if (override !== undefined) {
      return Promise.resolve(override(payload));
    }
    if (channel === 'measurements/list') {
      const request = payload as { limit?: number };
      // limit 1 — канал «последняя запись» сводки; страница 200 — правка точек графика.
      return Promise.resolve({
        v: 1,
        ok: true,
        data:
          request.limit === 1
            ? lastResponse
            : ({ items: [DTO_PAGE_FIXTURE], total: 1 } satisfies MeasurementListResponse),
      });
    }
    if (channel === 'stats/period') {
      const period = (payload as { period?: string }).period;
      const data = period === '7d' ? STATS_7D : STATS_30D;
      return Promise.resolve({ v: 1, ok: true, data });
    }
    if (channel === 'trend/series') {
      return Promise.resolve({ v: 1, ok: true, data: { mode: 'raw', points: [] } });
    }
    if (channel === 'scales/active') {
      return Promise.resolve({ v: 1, ok: true, data: SCALE_FIXTURE });
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

/** Подключённый экран: MemoryRouter + провайдеры (§12: настоящие useNavigate). */
function renderScreen(): { probe: { pathname: string; search: string } } {
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
          { initialEntries: ['/dashboard'] },
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
  render(createElement(SummaryScreen), { wrapper });
  return { probe };
}

beforeEach(() => {
  lastResponse = { items: [lastDto()], total: 5 };
  mockHl();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('SummaryScreen — запросы и каркас (§12/§15/§6)', () => {
  it('pending — скелетон (role=status); три запроса уходят: list limit1, stats 7d, stats 30d', () => {
    renderScreen();

    expect(screen.getByTestId('summary-skeleton').getAttribute('aria-label')).toBe('Загрузка…');
    expect(invoke).toHaveBeenCalledWith('measurements/list', {
      profileId: PROFILE_ID,
      limit: 1,
      offset: 0,
    });
    expect(invoke).toHaveBeenCalledWith('stats/period', { profileId: PROFILE_ID, period: '7d' });
    expect(invoke).toHaveBeenCalledWith('stats/period', { profileId: PROFILE_ID, period: '30d' });
  });

  it('(§6) с данными: сводка сверху, график ниже в секции-якорь #trends', async () => {
    mockHl({
      'trend/series': () => ({
        v: 1,
        ok: true,
        data: {
          mode: 'raw',
          points: [{ utcMs: Date.now(), tzOffsetMin: 0, sys: 120, dia: 80, part: 'morning' }],
        },
      }),
    });
    renderScreen();

    await screen.findByTestId('trend-chart');
    const trends = document.getElementById('trends');
    expect(trends).not.toBeNull();
    expect(trends?.contains(screen.getByTestId('trend-chart'))).toBe(true);
    // Сводка присутствует рядом (один маршрут — секции, §6).
    expect(screen.getByTestId('last-measurement-card')).not.toBeNull();
  });
});

describe('SummaryScreen — пустая БД (§20 AC1: приветственный экран)', () => {
  it('(AC1) 0 записей → «Начните дневник» + CTA; карточек и графика нет; CTA → журнал', async () => {
    lastResponse = { items: [], total: 0 };
    const { probe } = renderScreen();

    const welcome = await screen.findByTestId('dashboard-welcome');
    expect(welcome.textContent).toContain('Начните дневник');
    // Обучающий экран один: карточек-сводки и графика под ним нет (без стопки заглушек).
    expect(screen.queryByTestId('last-measurement-card')).toBeNull();
    expect(screen.queryByTestId('trend-chart')).toBeNull();
    expect(document.getElementById('trends')).toBeNull();

    fireEvent.click(screen.getByTestId('dashboard-welcome-add'));
    await waitFor(() => expect(probe.pathname).toBe('/journal'));
  });
});

describe('SummaryScreen — карточки из каналов (§20 AC2: mock-значения)', () => {
  it('(AC2) последнее: 125/82, пульс, «Сегодня 08:12» — из measurements/list limit1', async () => {
    renderScreen();

    await screen.findByTestId('last-measurement-card');
    expect(screen.getByTestId('last-bp').textContent).toBe('125/82');
    expect(screen.getByTestId('last-pulse').textContent).toBe('Пульс 72 уд/мин');
    expect(screen.getByTestId('last-when').textContent).toBe('Сегодня 08:12');
  });

  it('(AC2) средние 7д: числа stats-канала, категория по шкале, notes', async () => {
    renderScreen();

    await screen.findByTestId('average-card');
    expect(screen.getByTestId('average-sys').textContent).toBe('СДА 124,3');
    expect(screen.getByTestId('average-dia').textContent).toBe('ДДА 79,5');
    expect(screen.getByTestId('average-pulse').textContent).toBe('ЧСС 66,3 уд/мин');
    expect(screen.getByTestId('average-count').textContent).toBe('Измерений: 12');
    expect(screen.getByTestId('average-category').textContent).toBe('Категория: Нормальное');
    expect(screen.getByTestId('average-notes').textContent).toContain(
      'Классификация для домашних измерений давления',
    );
  });

  it('(AC2) регулярность: серия и дни — из stats 30d (golden «Серия: 5 дней»)', async () => {
    renderScreen();

    await screen.findByTestId('regularity-card');
    expect(screen.getByTestId('regularity-streak').textContent).toBe('Серия: 5 дней');
    expect(screen.getByTestId('regularity-days').textContent).toBe(
      'за 30 дней: 22 дня с измерениями',
    );
  });

  it('live: measurement:changed → перечитывание list-канала и stats (сводка живая, §12)', async () => {
    renderScreen();
    await screen.findByTestId('regularity-card');
    invoke.mockClear();

    const changedHandler = on.mock.calls.find(([name]) => name === 'measurement:changed')?.[1] as
      ((payload: { profileId: string }) => void) | undefined;
    if (changedHandler === undefined) {
      throw new Error('сводка обязана подписаться на measurement:changed (§12)');
    }
    changedHandler({ profileId: PROFILE_ID });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('measurements/list', {
        profileId: PROFILE_ID,
        limit: 1,
        offset: 0,
      }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('stats/period', { profileId: PROFILE_ID, period: '7d' }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('stats/period', { profileId: PROFILE_ID, period: '30d' }),
    );
  });
});

describe('SummaryScreen — мало данных и критическое (§20 AC3/AC5)', () => {
  it('(AC3) 3 записи → «Мало данных — 3 …» у средних, категория отсутствует', async () => {
    mockHl({
      'stats/period': (payload) =>
        Promise.resolve({
          v: 1,
          ok: true,
          data: (payload as { period?: string }).period === '7d' ? STATS_7D_FEW : STATS_30D,
        }),
    });
    renderScreen();

    const note = await screen.findByTestId('few-data-note');
    expect(note.textContent).toContain('Мало данных — 3 измерения за период');
    expect(screen.queryByTestId('average-category')).toBeNull();
    expect(screen.getByTestId('average-count').textContent).toBe('Измерений: 3');
  });

  it('(AC5) последняя запись 190/125 critical → клик бейджа открывает панель срочности', async () => {
    lastResponse = {
      items: [lastDto({ sys: 190, dia: 125, pulse: undefined, critical: 'high' })],
      total: 5,
    };
    renderScreen();

    await screen.findByTestId('last-measurement-card');
    fireEvent.click(screen.getByTestId('flag-critical'));
    await waitFor(() =>
      expect(screen.getByTestId('critical-panel').textContent).toContain('190/125'),
    );
  });
});

describe('SummaryScreen — подсказка о копии (TASK-074 §5/§10/§12/§19)', () => {
  /** Обработчик события job:backup-reminder из мока моста (§11: доставка баннера). */
  function reminderHandler(): (payload: Record<string, never>) => void {
    const handler = on.mock.calls.find(([name]) => name === 'job:backup-reminder')?.[1];
    if (handler === undefined) {
      throw new Error('сводка обязана подписаться на job:backup-reminder (TASK-074 §11)');
    }
    return handler;
  }

  it('баннера нет по умолчанию; событие job:backup-reminder → баннер на дашборде', async () => {
    renderScreen();
    await screen.findByTestId('last-measurement-card');
    expect(screen.queryByTestId('backup-reminder-banner')).toBeNull();

    reminderHandler()({});

    expect(await screen.findByTestId('backup-reminder-banner')).not.toBeNull();
  });

  it('«Позже» скрывает баннер (локальный state от события, §12)', async () => {
    renderScreen();
    await screen.findByTestId('last-measurement-card');
    reminderHandler()({});
    await screen.findByTestId('backup-reminder-banner');

    fireEvent.click(screen.getByTestId('backup-reminder-later'));

    expect(screen.queryByTestId('backup-reminder-banner')).toBeNull();
  });

  it('«Создать копию» скрывает баннер и открывает диалог 073; отмена закрывает', async () => {
    renderScreen();
    await screen.findByTestId('last-measurement-card');
    reminderHandler()({});
    await screen.findByTestId('backup-reminder-banner');

    fireEvent.click(screen.getByTestId('backup-reminder-create'));

    expect(await screen.findByTestId('data-backup-dialog')).not.toBeNull();
    expect(screen.queryByTestId('backup-reminder-banner')).toBeNull();

    fireEvent.click(screen.getByTestId('data-backup-cancel'));
    await waitFor(() => expect(screen.queryByTestId('data-backup-dialog')).toBeNull());
  });
});
