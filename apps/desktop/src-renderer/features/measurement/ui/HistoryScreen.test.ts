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
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeasurementDto, MeasurementListResponse } from '@hl/contracts';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { PROFILE_ID } from '../api/use-add-measurement';
import { HISTORY_PAGE_LIMIT } from '../api/use-measurements';
import { useFormStore } from '../model/form-store';
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
    utcMs: Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1, 12) - TZ_OFFSET_MIN * 60_000,
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
      expect(
        screen.getByText('Измерьте давление и нажмите «Добавить» — история появится здесь.'),
      ).toBeDefined();
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

describe('HistoryScreen — легенда флагов (TASK-042 §5)', () => {
  it('есть запись с флагом (critical) → легенда над списком (flag-legend)', async () => {
    invoke.mockResolvedValue(
      LIST_OK({
        items: [dto('m-high', wallNoon(TODAY_KEY), { sys: 190, dia: 125, critical: 'high' })],
        total: 1,
      }),
    );
    renderHistory();

    await waitFor(() => expect(screen.getAllByTestId('day-group')).toHaveLength(1));

    expect(screen.getByTestId('flag-legend')).toBeDefined();
  });

  it('есть запись с irregularPulse → легенда тоже показывается (§5: хоть один флаг)', async () => {
    invoke.mockResolvedValue(
      LIST_OK({ items: [dto('m-irr', wallNoon(TODAY_KEY), { irregularPulse: true })], total: 1 }),
    );
    renderHistory();

    await waitFor(() => expect(screen.getAllByTestId('day-group')).toHaveLength(1));

    expect(screen.getByTestId('flag-legend')).toBeDefined();
  });

  it('все записи без флагов → легенды нет (§5: только при наличии хоть одного флага)', async () => {
    invoke.mockResolvedValue(LIST_OK({ items: [dto('m-plain', wallNoon(TODAY_KEY))], total: 1 }));
    renderHistory();

    await waitFor(() => expect(screen.getAllByTestId('day-group')).toHaveLength(1));

    expect(screen.queryByTestId('flag-legend')).toBeNull();
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
        LIST_OK({
          items: page(HISTORY_PAGE_LIMIT, HISTORY_PAGE_LIMIT + 1),
          total: HISTORY_PAGE_LIMIT + 1,
        }),
      );
    renderHistory();

    await waitFor(() =>
      expect(screen.getByTestId('history-shown').textContent).toBe('Показано 200 из 201'),
    );
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

    await waitFor(() =>
      expect(screen.getByTestId('history-shown').textContent).toBe('Показано 1 из 1'),
    );
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
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce(LIST_OK({ items: [], total: 0 })) // первый list — пусто
      .mockResolvedValueOnce({ v: 1, ok: true, data: { measurement: added, flags: {} } }) // add
      .mockResolvedValue(LIST_OK({ items: [added], total: 1 })); // list после инвалидации
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

describe('HistoryScreen — правка и удаление (TASK-038 §5/§19/§20)', () => {
  /** Фикстура CRUD-тестов: 3 записи, desc (сегодня 2, вчера 1). */
  function crudFixture(): MeasurementDto[] {
    return [
      dto('m-evening', wallNoon(TODAY_KEY)),
      dto('m-morning', wallNoon(TODAY_KEY), { pulse: 70 }),
      dto('m-yesterday', wallNoon(YESTERDAY_KEY)),
    ];
  }

  /**
   * Мост с маршрутизацией по каналам: list отдаёт текущее состояние rows,
   * update/delete мутируются тестом напрямую (следующий refetch видит
   * результат — «список обновился без перезагрузки», §20 AC1/AC3).
   */
  function mockCrudRoutes(
    rows: MeasurementDto[],
    overrides: { readonly update?: unknown; readonly delete?: unknown } = {},
  ): void {
    invoke = vi.fn((channel: string, payload: unknown) => {
      if (channel === 'measurements/update') {
        return Promise.resolve(
          overrides.update ?? {
            v: 1,
            ok: true,
            data: { measurement: dto('m-updated', wallNoon(TODAY_KEY)) },
          },
        );
      }
      if (channel === 'measurements/delete') {
        return Promise.resolve(overrides.delete ?? { v: 1, ok: true, data: { deleted: true } });
      }
      void payload;
      return Promise.resolve(LIST_OK({ items: [...rows], total: rows.length }));
    });
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
  }

  beforeEach(() => {
    useFormStore.getState().resetAll();
  });

  it('меню ⋮ в строке открывается: «Изменить» и «Удалить» (§19: меню открывается)', async () => {
    const user = userEvent.setup();
    const rows = crudFixture();
    mockCrudRoutes(rows);
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(3));

    await user.click(screen.getByTestId('row-menu-m-evening'));

    await waitFor(() => expect(screen.getByTestId('row-menu-content')).toBeDefined());
    expect(screen.getByTestId('row-menu-edit').textContent).toBe('Изменить');
    expect(screen.getByTestId('row-menu-delete').textContent).toBe('Удалить');
  });

  it('«Изменить» → форма edit предзаполнена значениями записи, списка нет (§19)', async () => {
    const user = userEvent.setup();
    const rows = crudFixture();
    mockCrudRoutes(rows);
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(3));

    // m-morning — запись с пульсом 70 (фикстура).
    await user.click(screen.getByTestId('row-menu-m-morning'));
    await user.click(await screen.findByTestId('row-menu-edit'));

    expect(screen.getByTestId('form-title').textContent).toBe('Изменение записи');
    expect(screen.getByTestId<HTMLInputElement>('input-sys').value).toBe('125');
    expect(screen.getByTestId<HTMLInputElement>('input-dia').value).toBe('82');
    expect(screen.getByTestId<HTMLInputElement>('input-pulse').value).toBe('70');
    expect(screen.queryByTestId('measurement-row')).toBeNull();
  });

  it('отмена правки (Esc) → список, запись на месте, фокус вернулся в строку (§20 AC2/AC5)', async () => {
    const user = userEvent.setup();
    const rows = crudFixture();
    mockCrudRoutes(rows);
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(3));

    await user.click(screen.getByTestId('row-menu-m-evening'));
    await user.click(await screen.findByTestId('row-menu-edit'));
    fireEvent.keyDown(screen.getByTestId('measurement-form'), { key: 'Escape' });

    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(3));
    expect(useFormStore.getState().editingId).toBeNull();
    // AC5: фокус возвращается в строку списка (кнопке меню той же записи).
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-row-menu')).toBe('m-evening'),
    );
  });

  it('правка 125→127: update-канал с id, список показывает 127 без перезагрузки, тост (§20 AC1)', async () => {
    const user = userEvent.setup();
    const rows = crudFixture();
    // update мутирует состояние rows — следующий refetch вернёт 127 (без перезагрузки).
    invoke = vi.fn((channel: string) => {
      if (channel === 'measurements/update') {
        const first = rows[0];
        const updated: MeasurementDto =
          first === undefined ? dto('m-evening', wallNoon(TODAY_KEY)) : { ...first, sys: 127 };
        if (first !== undefined) {
          rows[0] = updated;
        }
        return Promise.resolve({ v: 1, ok: true, data: { measurement: updated } });
      }
      return Promise.resolve(LIST_OK({ items: [...rows], total: rows.length }));
    });
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(3));

    await user.click(screen.getByTestId('row-menu-m-evening'));
    await user.click(await screen.findByTestId('row-menu-edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Очистить поле' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ввести 7' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'measurements/update',
        expect.objectContaining({ id: 'm-evening', sys: 127, dia: 82 }),
      ),
    );
    // Список обновился без перезагрузки: мутированный refetch вернул 127 (AC1).
    await waitFor(() => expect(screen.getByText('127/82')).toBeDefined());
    expect(screen.queryByTestId('input-sys')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('history-notice').textContent).toBe('Правка применена'),
    );
    // Порядок не изменился: правленая запись осталась в своей группе первой (AC1).
    expect(
      screen
        .getAllByTestId('measurement-row')[0]
        ?.querySelector('[data-row-menu]')
        ?.getAttribute('data-row-menu'),
    ).toBe('m-evening');
  });

  it('«Удалить» → диалог с датой/временем записи; «Отмена» — запись на месте (§20 AC3)', async () => {
    const user = userEvent.setup();
    const rows = crudFixture();
    mockCrudRoutes(rows);
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(3));

    await user.click(screen.getByTestId('row-menu-m-evening'));
    await user.click(await screen.findByTestId('row-menu-delete'));

    const title = screen.getByTestId('delete-confirm-title');
    expect(title.textContent).toContain('Удалить запись от');
    expect(title.textContent).toContain('12:00'); // wallNoon — настенное время записи
    expect(screen.getByTestId('delete-confirm-body').textContent).toContain('необратимо');

    fireEvent.click(screen.getByTestId('delete-cancel'));

    await waitFor(() => expect(screen.queryByTestId('delete-confirm-dialog')).toBeNull());
    expect(screen.getAllByTestId('measurement-row')).toHaveLength(3);
    expect(invoke.mock.calls.some(([channel]) => channel === 'measurements/delete')).toBe(false);
  });

  it('«Удалить» в диалоге → measurements/delete {id}, запись исчезла, тост «Удалено» (§5/§20 AC3)', async () => {
    const user = userEvent.setup();
    const rows = crudFixture();
    invoke = vi.fn((channel: string, payload: unknown) => {
      if (channel === 'measurements/delete') {
        const id = (payload as { id: string }).id;
        const index = rows.findIndex((row) => row.id === id);
        rows.splice(index, 1);
        return Promise.resolve({ v: 1, ok: true, data: { deleted: true } });
      }
      return Promise.resolve(LIST_OK({ items: [...rows], total: rows.length }));
    });
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(3));

    await user.click(screen.getByTestId('row-menu-m-evening'));
    await user.click(await screen.findByTestId('row-menu-delete'));
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('measurements/delete', { id: 'm-evening' }),
    );
    // Без перезагрузки: refetch после инвалидации вернул 2 записи (AC3).
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(2));
    expect(screen.queryByTestId('row-menu-m-evening')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('history-notice').textContent).toBe('Удалено'));
    // AC5: фокус в строке списка (ближайшая оставшаяся строка).
    await waitFor(() => expect(document.activeElement?.hasAttribute('data-row-menu')).toBe(true));
  });

  it('delete NOT_FOUND (§13) → тост «Запись уже удалена», диалог закрыт, список не тронут', async () => {
    const user = userEvent.setup();
    const rows = crudFixture();
    mockCrudRoutes(rows, {
      delete: {
        v: 1,
        ok: false,
        error: { code: 'MEASUREMENT/NOT_FOUND', messageKey: 'errors.MEASUREMENT_NOT_FOUND' },
      },
    });
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('measurement-row')).toHaveLength(3));

    await user.click(screen.getByTestId('row-menu-m-evening'));
    await user.click(await screen.findByTestId('row-menu-delete'));
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => expect(screen.getByText('Запись уже удалена')).toBeDefined());
    await waitFor(() => expect(screen.queryByTestId('delete-confirm-dialog')).toBeNull());
    expect(screen.getAllByTestId('measurement-row')).toHaveLength(3);
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
