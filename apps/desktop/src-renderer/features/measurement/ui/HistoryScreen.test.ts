/**
 * TASK-033 §19/§20: интеграционный тест экрана истории — скелетон при pending,
 * пустое состояние (текст + CTA → форма), группировка фикстуры 2 дня / 3 записи
 * («Сегодня»/«Вчера»), содержимое строки (время, 125/82, пульс, рука, заметка),
 * «Показать ещё» → offset=200 + подпись «N из M», live-обновление по событию
 * measurement:changed, ошибка → тост + retry, добавление из формы возвращает
 * к списку без перезагрузки, a11y-семантика (роли) и axe — без critical.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementDto, MeasurementListResponse } from '@hl/contracts';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { PROFILE_ID } from '../api/use-add-measurement';
import { HISTORY_PAGE_LIMIT } from '../api/use-measurements';
import { localDateKey, previousDayKey } from '../model/wall-date';
import { HistoryScreen } from './HistoryScreen';

/** Фиксированное «сейчас» теста: 2026-09-27 15:00 UTC. */
const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);
/** Смещение устройства теста (машинонезависимо: локальные ключи считаем сами). */
const TZ_OFFSET_MIN = -new Date(NOW_MS).getTimezoneOffset();
const TODAY_KEY = localDateKey(NOW_MS);
const YESTERDAY_KEY = previousDayKey(TODAY_KEY);

/** Instant полудня настенного дня dayKey в поясе устройства (детерминированно). */
function wallNoon(dayKey: string): { utcMs: number; tzOffsetMin: number } {
  const [y, m, d] = dayKey.split('-').map(Number);
  return {
    utcMs: Date.UTC(y, (m ?? 1) - 1, d ?? 1, 12) - TZ_OFFSET_MIN * 60_000,
    tzOffsetMin: TZ_OFFSET_MIN,
  };
}

/** DTO-минимум; note — 50 'z' (проверка обрезки 40, §14). */
function dto(
  id: string,
  takenAt: { utcMs: number; tzOffsetMin: number },
  overrides: Partial<MeasurementDto> = {},
): MeasurementDto {
  return {
    id,
    profileId: PROFILE_ID,
    sys: 125,
    dia: 82,
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

const LIST_OK = (response: MeasurementListResponse) => ({ v: 1, ok: true, data: response });

let invoke: ReturnType<typeof vi.fn>;

function renderHistory(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(HistoryScreen)),
    ),
  );
}

/** Мост с перехватом подписок: name → последний handler (для live-теста §19). */
function bridgeMock(): Map<string, (payload: unknown) => void> {
  const handlers = new Map<string, (payload: unknown) => void>();
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn((name: string, handler: (payload: unknown) => void) => {
        handlers.set(name, handler);
        return () => undefined;
      }),
    },
  });
  return handlers;
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  invoke = vi.fn().mockResolvedValue(LIST_OK({ items: [], total: 0 }));
  bridgeMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('HistoryScreen — состояния (§10)', () => {
  it('pending: скелетон 3 строки, списка и кнопок нет', () => {
    invoke.mockReturnValue(new Promise(() => undefined));
    renderHistory();

    expect(screen.getByTestId('history-skeleton')).toBeDefined();
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Добавить' })).toBeNull();
  });

  it('пусто: обучающее состояние (заголовок + подсказка) с CTA «Добавить» (FR-9.2)', () => {
    renderHistory();

    return waitFor(() => {
      expect(screen.getByTestId('empty-history')).toBeDefined();
      expect(screen.getByText('Пока нет измерений')).toBeDefined();
      expect(screen.getByText('Измерьте давление и нажмите «Добавить» — история появится здесь.')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Добавить' })).toBeDefined();
    });
  });

  it('клик CTA пустого состояния открывает форму (§19)', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByTestId('empty-history')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    expect(screen.getByTestId('input-sys')).toBeDefined();
    expect(screen.queryByTestId('empty-history')).toBeNull();
  });

  it('ошибка: тост + retry-кнопка; повторный вызов list при клике (§10)', async () => {
    invoke
      .mockResolvedValueOnce({
        v: 1,
        ok: false,
        error: { code: 'APP/INTERNAL', messageKey: 'errors.internal' },
      })
      .mockResolvedValueOnce(LIST_OK({ items: [], total: 0 }));
    renderHistory();

    await waitFor(() =>
      expect(screen.getByText('Что-то пошло не так. Попробуйте ещё раз.')).toBeDefined(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('empty-history')).toBeDefined());
  });
});

describe('HistoryScreen — данные и группировка (§5/§13/§19)', () => {
  /** Фикстура §19: 2 дня, 3 записи (сегодня 2, вчера 1), desc. */
  function fixture(): MeasurementDto[] {
    return [
      dto('m-evening', wallNoon(TODAY_KEY)),
      dto('m-morning', wallNoon(TODAY_KEY)),
      dto('m-yesterday', wallNoon(YESTERDAY_KEY)),
    ];
  }

  it('заголовки «Сегодня»/«Вчера» по h3; сегодня-группа первая; 3 строки', async () => {
    invoke.mockResolvedValue(LIST_OK({ items: fixture(), total: 3 }));
    renderHistory();

    await waitFor(() => expect(screen.getAllByTestId('day-group')).toHaveLength(2));
    const headers = screen.getAllByRole('heading', { level: 3 });
    expect(headers.map((h) => h.textContent)).toEqual(['Сегодня', 'Вчера']);
    expect(screen.getAllByTestId('measurement-row')).toHaveLength(3);
  });

  it('строка: время HH:MM, 125/82, «70 уд/мин», рука с title, заметка обрезана до 40 (§5/§14)', async () => {
    const note = 'z'.repeat(50);
    invoke.mockResolvedValue(
      LIST_OK({
        items: [
          dto('m-full', wallNoon(TODAY_KEY), {
            pulse: 70,
            arm: 'left',
            note,
          }),
        ],
        total: 1,
      }),
    );
    renderHistory();

    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(1));
    expect(screen.getByText('125/82')).toBeDefined();
    expect(screen.getByText('70 уд/мин')).toBeDefined();
    const arm = screen.getByText('левая рука');
    expect(arm.getAttribute('title')).toBe('левая рука');
    // Обрезка 40 символов (§14) + многоточие; полный текст — только в title.
    expect(screen.getByText(`${'z'.repeat(40)}…`)).toBeDefined();
    expect(screen.getByText(`${'z'.repeat(40)}…`).getAttribute('title')).toBe(note);
    expect(screen.getByText('12:00')).toBeDefined();
  });

  it('без пульса — «уд/мин» не показывается; правая рука подписана (§16)', async () => {
    invoke.mockResolvedValue(
      LIST_OK({
        items: [dto('m-no-pulse', wallNoon(TODAY_KEY), { arm: 'right' })],
        total: 1,
      }),
    );
    renderHistory();

    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(1));
    expect(screen.queryByText(/уд\/мин/u)).toBeNull();
    expect(screen.getByText('правая рука')).toBeDefined();
  });

  it('кнопка «Добавить» открывает форму (§5)', async () => {
    invoke.mockResolvedValue(LIST_OK({ items: fixture(), total: 3 }));
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('day-group')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    expect(screen.getByTestId('input-sys')).toBeDefined();
    expect(screen.queryByTestId('day-group')).toBeNull();
  });

  it('a11y-семантика: списки по дням — list/listitem, заголовки — h3 (§16)', async () => {
    invoke.mockResolvedValue(LIST_OK({ items: fixture(), total: 3 }));
    renderHistory();

    await waitFor(() => expect(screen.getAllByRole('list')).toHaveLength(2));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
  });
});

describe('HistoryScreen — «Показать ещё» (§5/§10/§20)', () => {
  it('страница 200 из 201: подпись точна, клик → offset=200, затем кнопка скрыта', async () => {
    const page = (from: number, to: number): MeasurementDto[] =>
      Array.from({ length: to - from }, (_, i) => dto(`m-${from + i}`, wallNoon(TODAY_KEY)));
    invoke
      .mockResolvedValueOnce(
        LIST_OK({ items: page(0, HISTORY_PAGE_LIMIT), total: HISTORY_PAGE_LIMIT + 1 }),
      )
      .mockResolvedValueOnce(
        LIST_OK({ items: page(HISTORY_PAGE_LIMIT, HISTORY_PAGE_LIMIT + 1), total: HISTORY_PAGE_LIMIT + 1 }),
      );
    renderHistory();

    await waitFor(() => expect(screen.getByTestId('history-shown').textContent).toBe('Показано 200 из 201'));
    expect(screen.getAllByTestId('measurement-row')).toHaveLength(HISTORY_PAGE_LIMIT);

    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith('measurements/list', {
        profileId: PROFILE_ID,
        limit: HISTORY_PAGE_LIMIT,
        offset: HISTORY_PAGE_LIMIT,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('history-shown').textContent).toBe('Показано 201 из 201'),
    );
    expect(screen.getAllByTestId('measurement-row')).toHaveLength(HISTORY_PAGE_LIMIT + 1);
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });

  it('всё загружено (total <= показано) — кнопки «Показать ещё» нет (§20)', async () => {
    invoke.mockResolvedValue(LIST_OK({ items: [dto('m-1', wallNoon(TODAY_KEY))], total: 1 }));
    renderHistory();

    await waitFor(() => expect(screen.getByTestId('history-shown').textContent).toBe('Показано 1 из 1'));
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });
});

describe('HistoryScreen — live-обновление (§5/§10/§20)', () => {
  it('событие measurement:changed → refetch, новая запись видна без перезагрузки', async () => {
    const handlers = bridgeMock();
    const first = [dto('m-1', wallNoon(TODAY_KEY))];
    const second = [dto('m-2', wallNoon(TODAY_KEY)), ...first];
    invoke
      .mockResolvedValueOnce(LIST_OK({ items: first, total: 1 }))
      .mockResolvedValue(LIST_OK({ items: second, total: 2 }));
    renderHistory();

    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(1));
    const handler = handlers.get('measurement:changed');
    expect(handler).toBeTypeOf('function');

    handler?.({ profileId: PROFILE_ID });

    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(2));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('сохранение из формы: возврат к списку, новая запись видна (событие/инвалидация, §20)', async () => {
    const added = dto('m-new', wallNoon(TODAY_KEY));
    invoke.mockImplementation((channel: string) => {
      if (channel === 'measurements/list') {
        const items = screen.queryByTestId('input-sys') === null ? [] : [added];
        return Promise.resolve(LIST_OK({ items, total: items.length }));
      }
      if (channel === 'measurements/add') {
        return Promise.resolve({ v: 1, ok: true, data: { measurement: added, flags: {} } });
      }
      return Promise.resolve({ v: 1, ok: true, data: {} });
    });
    renderHistory();

    await waitFor(() => expect(screen.getByTestId('empty-history')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(screen.getByTestId('input-sys')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(screen.queryByTestId('input-sys')).toBeNull());
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(1));
  });
});

describe('HistoryScreen — axe (§20)', () => {
  it('пустое состояние и данные: violations с impact=critical отсутствуют', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ToastProvider, null, createElement(HistoryScreen)),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('empty-history')).toBeDefined());
    const emptyResults = await axe.run(container);
    expect(emptyResults.violations.filter((v) => v.impact === 'critical')).toEqual([]);

    invoke.mockResolvedValue(
      LIST_OK({ items: [dto('m-1', wallNoon(TODAY_KEY), { pulse: 70 })], total: 1 }),
    );
    // axe на состоянии данных — отдельный рендер с успешным ответом.
    cleanup();
    const queryClient2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container: container2 } = render(
      createElement(
        QueryClientProvider,
        { client: queryClient2 },
        createElement(ToastProvider, null, createElement(HistoryScreen)),
      ),
    );
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(1));
    const dataResults = await axe.run(container2);
    expect(dataResults.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});
