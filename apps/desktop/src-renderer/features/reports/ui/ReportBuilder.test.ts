// TASK-068 §10/§12/§13/§16/§19/§20: тесты UI сборки PDF-отчёта (ReportBuilder +
// ReportScreen на экране «Отчёты»). Матрица:
//  - состав-чеклист отражает spec (§5: таблица/средние/график/регулярность + count);
//  - пустой период → кнопка disabled + подсказка (§13 по count из stats, AC UC-05 A2);
//  - чекбокс ИИ: в P4 всегда disabled с подсказкой (§12, тест DOM) + tooltip (§10);
//  - клик «Сформировать и сохранить» → канал report/pdf {profileId, period, false};
//    custom-период → готовые utcMs-границы настенных дней (TASK-046, lib/period);
//  - rendering: aria-busy + честная оценка «до 30 секунд» (§15/§16);
//  - done: тост с basename + полный путь в title + кнопка «Открыть папку» → канал
//    app/reveal-path (§5); отмена — тихо (§7); отказ → текст messageKey (§10);
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnvelope } from '@hl/contracts';

import { ReportBuilder, ReportScreen } from './ReportBuilder';
import { PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { tzOffsetMinOf, DAY_MS } from '../../../lib/period';

import '../../../i18n';

const invoke = vi.fn<(channel: string, payload: unknown) => Promise<ApiEnvelope<unknown>>>();

beforeEach(() => {
  Object.defineProperty(window, 'hl', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  invoke.mockReset();
});

function renderBuilder(): void {
  const client = new QueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ReportBuilder) as ReactElement,
    ) as ReactNode,
  );
}

const statsEnvelope = (count: number): ApiEnvelope<unknown> => ({
  v: 1,
  ok: true,
  data: {
    stats: { count, daysWithMeasurements: 0, longestStreakDays: 0, critical: { high: false, low: false }, insufficientData: { tooFewMeasurements: true, tooFewDays: true }, sys: {}, dia: {} },
    scale: { code: 'BP_OFFICE_ESC2018', version: '1.0.0', sourceLabel: 'ESC 2018' },
  },
});

const generateButton = (): HTMLElement =>
  screen.getByRole('button', { name: 'Сформировать и сохранить' });

describe('ReportScreen — экран PDF-отчёта (§5)', () => {
  it('заголовок секции и сборщик на месте (дом PDF на /reports)', () => {
    invoke.mockResolvedValue(statsEnvelope(3));
    const client = new QueryClient();
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ReportScreen) as ReactElement,
      ) as ReactNode,
    );

    expect(screen.getByText('PDF-отчёт для врача')).toBeDefined();
    expect(generateButton()).toBeDefined();
  });
});

describe('ReportBuilder — настройки и состав (§5/§13)', () => {
  it('карточка «Состав отчёта»: чек-лист разделов + count записей из stats', async () => {
    invoke.mockResolvedValue(statsEnvelope(12));
    renderBuilder();

    await waitFor(() => expect(screen.getByTestId('report-compose-count').textContent).toContain('12'));
    const compose = screen.getByTestId('report-compose');
    expect(compose.textContent).toContain('Таблица измерений');
    expect(compose.textContent).toContain('Средние');
    expect(compose.textContent).toContain('График');
    expect(compose.textContent).toContain('Регулярность');
  });

  it('пустой период (count=0) → кнопка disabled + подсказка (AC UC-05 A2, §13)', async () => {
    invoke.mockResolvedValue(statsEnvelope(0));
    renderBuilder();

    await waitFor(() => expect(screen.getByTestId('report-empty-hint')).toBeDefined());
    expect(generateButton().hasAttribute('disabled')).toBe(true);
  });

  it('чекбокс ИИ disabled с подсказкой (§12 честная заглушка P4) и tooltip (§10)', () => {
    invoke.mockResolvedValue(statsEnvelope(5));
    renderBuilder();

    const checkbox = screen.getByRole('checkbox', { name: 'Включить ИИ-разбор' }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    // §12: подсказка «появится вместе с ИИ-разбором» — видимый текст.
    expect(screen.getByTestId('report-ai-hint').textContent).toContain('ИИ-разбор');
    // §10: tooltip про маркировку в отчёте — title-атрибут (не единственный носитель).
    expect(checkbox.getAttribute('title')).toContain('не является медицинским заключением');
  });
});

describe('ReportBuilder — генерация (§9/§10/§16)', () => {
  it('клик → report/pdf {profileId, period{fromUtcMs,toUtcMs}, includeAiSection: false}', async () => {
    invoke.mockResolvedValue(statsEnvelope(5));
    invoke.mockResolvedValueOnce(statsEnvelope(5)).mockResolvedValueOnce({
      v: 1,
      ok: true,
      data: { path: 'C:\\out\\health-log-export-20250925-1900.pdf' },
    });
    renderBuilder();

    await waitFor(() => expect(generateButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(generateButton());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'report/pdf',
        expect.objectContaining({ profileId: PROFILE_ID, includeAiSection: false }),
      ),
    );
    const payload = invoke.mock.calls.find(([channel]) => channel === 'report/pdf')?.[1] as {
      period: { fromUtcMs: number; toUtcMs: number };
    };
    // Пресет 30d: обе границы — числа, from < to (готовые utcMs — ReportPeriod 067).
    expect(typeof payload.period.fromUtcMs).toBe('number');
    expect(typeof payload.period.toUtcMs).toBe('number');
    expect(payload.period.fromUtcMs).toBeLessThan(payload.period.toUtcMs);
  });

  it('custom-период → границы настенных дней по TASK-046 (полночь/конец дня в зоне устройства)', async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    invoke
      .mockResolvedValueOnce(statsEnvelope(5))
      .mockResolvedValueOnce({ v: 1, ok: true, data: { path: 'C:\\out\\x.pdf' } });
    renderBuilder();

    await waitFor(() => expect(generateButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByTestId('report-period-custom'));
    // Даты в прошлом (EC-20: to в будущем блокируется CustomRangeFields — §19 046).
    fireEvent.change(screen.getByTestId('filter-range-from'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByTestId('filter-range-to'), { target: { value: '2026-09-20' } });
    fireEvent.click(generateButton());

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('report/pdf', expect.anything()));
    const payload = invoke.mock.calls.find(([channel]) => channel === 'report/pdf')?.[1] as {
      period: { fromUtcMs: number; toUtcMs: number };
    };
    const tz = tzOffsetMinOf(now);
    // Полночь настенного 2026-09-01 и конец настенного 2026-09-20 (§13 046).
    expect(payload.period.fromUtcMs).toBe(Date.UTC(2026, 8, 1) - tz * 60_000);
    expect(payload.period.toUtcMs).toBe(Date.UTC(2026, 8, 20) - tz * 60_000 + DAY_MS - 1);
  });

  it('rendering: кнопка disabled + aria-busy, честная оценка «до 30 секунд» (§15/§16)', async () => {
    let release!: () => void;
    invoke
      .mockResolvedValueOnce(statsEnvelope(5))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = () =>
            resolve({ v: 1, ok: true, data: { path: 'C:\\out\\health-log-export.pdf' } });
        }),
      );
    renderBuilder();

    await waitFor(() => expect(generateButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(generateButton());

    await waitFor(() => expect(generateButton().getAttribute('aria-busy')).toBe('true'));
    expect(generateButton().hasAttribute('disabled')).toBe(true);
    // §16: сообщение «до 30 секунд» — управление ожиданием (WCAG-дружественно).
    expect(screen.getByTestId('report-progress').textContent).toContain('30 секунд');

    act(() => release());
    await waitFor(() => expect(generateButton().hasAttribute('disabled')).toBe(false));
  });

  it('done: тост с basename (полный путь — title) и кнопка «Открыть папку» → app/reveal-path', async () => {
    const path = 'C:\\Users\\me\\health-log-export-20250925-1900.pdf';
    // Дефолт — ответ reveal-канала (ок после двух Once-ответов stats/report).
    invoke
      .mockResolvedValue({ v: 1, ok: true, data: null })
      .mockResolvedValueOnce(statsEnvelope(5))
      .mockResolvedValueOnce({ v: 1, ok: true, data: { path } });
    renderBuilder();

    await waitFor(() => expect(generateButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(generateButton());

    // Тост ждём по содержимому (role=status занят прогресс-регионом до завершения).
    await screen.findByText(/health-log-export-20250925-1900\.pdf/);
    const toast = screen.getByRole('status');
    expect(toast.textContent).toContain('health-log-export-20250925-1900.pdf');
    expect(toast.querySelector('span[title]')?.getAttribute('title')).toBe(path);

    fireEvent.click(screen.getByRole('button', { name: 'Открыть папку' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app/reveal-path', { path }));
  });

  it('отмена save-диалога {canceled: true} → БЕЗ тоста (§7/AC)', async () => {
    invoke
      .mockResolvedValueOnce(statsEnvelope(5))
      .mockResolvedValueOnce({ v: 1, ok: true, data: { canceled: true } });
    renderBuilder();

    await waitFor(() => expect(generateButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(generateButton());
    await waitFor(() => expect(generateButton().hasAttribute('disabled')).toBe(false));

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('отказ RENDER_FAILED → тост текстом messageKey (§10)', async () => {
    invoke
      .mockResolvedValueOnce(statsEnvelope(5))
      .mockResolvedValueOnce({
        v: 1,
        ok: false,
        error: { code: 'REPORT/RENDER_FAILED', messageKey: 'errors.REPORT_RENDER_FAILED' },
      });
    renderBuilder();

    await waitFor(() => expect(generateButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(generateButton());

    // Тост ждём по тексту (role=status занят прогресс-регионом до завершения).
    await screen.findByText('Не удалось сформировать отчёт. Попробуйте ещё раз.');
    expect(screen.getByRole('status').textContent).toContain('Не удалось сформировать отчёт');
  });
});
