/**
 * TASK-073 §2/§5/§19: тесты секции «Данные» на экране «Отчёты» (DataSection) —
 * тонкий оркестратор трёх операций. Матрица: заголовок и три операции обособлены
 * (§22); кнопки открывают свои потоки (диалог копии / мастер-флоу восстановления /
 * диалог удаления — открытие wipe запрашивает план каналом data/wipe); axe — без
 * critical (§20).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnvelope } from '@hl/contracts';

import '../../../i18n';
import { DataSection } from './DataSection';

/** Мост `window.hl` с журналом вызовов (§19, прецедент ExportButtons.test). */
const invoke = vi.fn<(channel: string, payload: unknown) => Promise<ApiEnvelope<unknown>>>();

beforeEach(() => {
  Object.defineProperty(window, 'hl', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
  invoke.mockResolvedValue({
    v: 1,
    ok: true,
    data: {
      plan: { files: [], counts: { measurements: 0 }, rendererLocalStorage: true },
    },
  });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

function renderSection(): void {
  const client = new QueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(DataSection) as ReactElement,
    ) as ReactNode,
  );
}

describe('DataSection — секция «Данные» на «Отчётах» (§5)', () => {
  it('заголовок «Данные» и три операции обособлены (§22)', () => {
    renderSection();

    expect(screen.getByRole('heading', { name: 'Данные' })).toBeDefined();
    expect(screen.getByTestId('data-backup-button').textContent).toBe('Создать копию');
    expect(screen.getByTestId('data-restore-button').textContent).toBe('Восстановить из копии');
    expect(screen.getByTestId('data-wipe-button').textContent).toBe('Удалить все данные');
  });

  it('«Создать копию» → диалог пароля копии с предупреждением о забытой пароле', async () => {
    renderSection();

    fireEvent.click(screen.getByTestId('data-backup-button'));

    await waitFor(() => expect(screen.getByTestId('data-backup-dialog')).toBeDefined());
    expect(screen.getByTestId('data-backup-forgot-warning').textContent).toContain('Забыли пароль');
  });

  it('«Восстановить из копии» → мастер-флоу (шаг выбора файла)', async () => {
    renderSection();

    fireEvent.click(screen.getByTestId('data-restore-button'));

    await waitFor(() => expect(screen.getByTestId('data-restore-dialog')).toBeDefined());
    expect(screen.getByTestId('data-restore-pick').textContent).toContain('Выбрать файл копии');
  });

  it('«Удалить все данные» → диалог удаления с планом канала data/wipe', async () => {
    renderSection();

    fireEvent.click(screen.getByTestId('data-wipe-button'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('data/wipe', { phase: 'plan' }));
    await waitFor(() => expect(screen.getByTestId('data-wipe-dialog')).toBeDefined());
  });

  it('axe — violations с impact=critical отсутствуют (§20)', async () => {
    const { container } = renderSectionWrapper();

    const results = await axe.run(container);

    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });
});

/** Обёртка для axe: возвращает container (renderSection не отдаёт). */
function renderSectionWrapper(): { container: HTMLElement } {
  const client = new QueryClient();
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(DataSection) as ReactElement,
    ) as ReactNode,
  );
}
