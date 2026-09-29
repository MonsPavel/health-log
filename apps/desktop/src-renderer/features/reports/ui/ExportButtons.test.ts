/**
 * TASK-065 §10/§16/§19/§20: тесты UI экспорта — ExportButtons на экране «Отчёты».
 * Матрица (§5 «тесты: клик → loading → тост», §20):
 *  - клик CSV → вызов канала report/export-csv {profileId}; loading: кнопки disabled,
 *    на нажатой aria-busy (§16); ответ {path} → тост успеха с basename (текст —
 *    полный носитель, §16) и title=полный путь (§10);
 *  - отмена диалога {canceled: true} → БЕЗ тоста, кнопка разблокирована (AC2);
 *  - отказ канала EXPORT/FAILED → тост failed+hint (AC4);
 *  - одновременный один экспорт (§10): во время операции обе кнопки недоступны;
 *  - тост автоскрывается (§16 роль status).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnvelope } from '@hl/contracts';

import { ExportButtons } from './ExportButtons';
import { PROFILE_ID } from '../../measurement/api/use-add-measurement';

import '../../../i18n';

/** Мост `window.hl` с журналом вызовов (§19, прецедент use-add-measurement.test). */
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

function renderButtons(): void {
  const client = new QueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ExportButtons) as ReactElement,
    ) as ReactNode,
  );
}

const csvButton = (): HTMLElement => screen.getByRole('button', { name: 'Экспорт CSV' });
const jsonButton = (): HTMLElement => screen.getByRole('button', { name: 'Экспорт JSON' });

const okPath = (path: string): ApiEnvelope<unknown> => ({ v: 1, ok: true, data: { path } });
const canceledEnvelope = (): ApiEnvelope<unknown> => ({
  v: 1,
  ok: true,
  data: { canceled: true },
});
const failedEnvelope = (): ApiEnvelope<unknown> => ({
  v: 1,
  ok: false,
  error: { code: 'EXPORT/FAILED', messageKey: 'errors.EXPORT_FAILED' },
});

describe('ExportButtons — клик → loading → тост (TASK-065 §19/§20)', () => {
  it('клик CSV → канала report/export-csv {profileId}; тост успеха: basename текстом, полный путь в title (§10/§16)', async () => {
    const path = 'C:\\Users\\me\\health-log-export-20260925-1600.csv';
    invoke.mockResolvedValue(okPath(path));
    renderButtons();

    fireEvent.click(csvButton());

    await waitFor(() => expect(screen.getByRole('status')).toBeDefined());
    expect(invoke).toHaveBeenCalledWith('report/export-csv', { profileId: PROFILE_ID });
    // §10/§16: basename — текст тоста (полный носитель), полный путь — только title.
    const toast = screen.getByRole('status');
    expect(toast.textContent).toContain('health-log-export-20260925-1600.csv');
    expect(toast.textContent).not.toContain('C:\\Users');
    expect(toast.querySelector('span[title]')?.getAttribute('title')).toBe(path);
    expect(toast.querySelector('span[title]')?.textContent).toBe(
      'health-log-export-20260925-1600.csv',
    );
  });

  it('клик JSON → канала report/export-json {profileId} (§5: аналогично)', async () => {
    invoke.mockResolvedValue(okPath('C:\\out\\health-log-export-20260925-1600.json'));
    renderButtons();

    fireEvent.click(jsonButton());

    await waitFor(() => expect(screen.getByRole('status')).toBeDefined());
    expect(invoke).toHaveBeenCalledWith('report/export-json', { profileId: PROFILE_ID });
  });

  it('loading: во время операции обе кнопки disabled, на активной aria-busy (§10/§16)', async () => {
    let release!: () => void;
    invoke.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(okPath('C:\\x.csv'));
      }),
    );
    renderButtons();

    fireEvent.click(csvButton());
    await waitFor(() => expect(csvButton().getAttribute('aria-busy')).toBe('true'));
    // §10: одновременно один экспорт — обе кнопки недоступны.
    expect(csvButton().hasAttribute('disabled')).toBe(true);
    expect(jsonButton().hasAttribute('disabled')).toBe(true);

    act(() => release());
    await waitFor(() => expect(csvButton().hasAttribute('disabled')).toBe(false));
    expect(jsonButton().hasAttribute('disabled')).toBe(false);
    expect(csvButton().getAttribute('aria-busy')).toBe('false');
  });

  it('отмена диалога → БЕЗ тоста-ошибки, кнопка разблокирована (AC2)', async () => {
    invoke.mockResolvedValue(canceledEnvelope());
    renderButtons();

    fireEvent.click(csvButton());
    await waitFor(() => expect(csvButton().hasAttribute('disabled')).toBe(false));

    expect(screen.queryByRole('status')).toBeNull();
    expect(csvButton().hasAttribute('disabled')).toBe(false);
  });

  it('отказ EXPORT/FAILED → тост failed+hint (AC4, §10)', async () => {
    invoke.mockResolvedValue(failedEnvelope());
    renderButtons();

    fireEvent.click(jsonButton());
    await waitFor(() => expect(screen.getByRole('status')).toBeDefined());

    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('Экспорт не удался.');
    expect(text).toContain('Выберите другое место и повторите попытку.');
  });

  it('тост автоскрывается (§16: role=status регион, прецедент notice 038)', async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue(okPath('C:\\x\\health-log-export-20260925-1600.csv'));
    renderButtons();

    fireEvent.click(csvButton());
    await vi.waitFor(() => expect(screen.getByRole('status')).toBeDefined());

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
