/**
 * TASK-011 §10/§12/§16/§19: тест системного тоста — появление с текстом по messageKey,
 * автоскрытие 6 с, очередь max 3, кнопка «Закрыть», a11y-атрибуты (role="status",
 * aria-live="polite" — §16, §20 п. 5).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppErrorDto } from '@hl/contracts';

import { ToastProvider, useToast } from './toast';

/** Зонд: кнопка, вызывающая showToast (API провайдера, §12 — useState, без zustand). */
function Probe({ error }: { readonly error: AppErrorDto }): ReactElement {
  const { showToast } = useToast();
  return createElement('button', { 'data-testid': 'trigger', onClick: () => showToast(error) });
}

function renderProvider(error: AppErrorDto): void {
  render(createElement(ToastProvider, null, createElement(Probe, { error })));
}

const INTERNAL: AppErrorDto = { code: 'APP/INTERNAL', messageKey: 'errors.internal' };

function clickTrigger(times = 1): void {
  for (let i = 0; i < times; i += 1) {
    fireEvent.click(screen.getByTestId('trigger'));
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ToastProvider — появление и текст (§5/§17)', () => {
  it('showToast показывает текст по messageKey каталога', () => {
    renderProvider(INTERNAL);
    clickTrigger();

    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(screen.getByTestId('toast').textContent).toContain(
      'Что-то пошло не так. Попробуйте ещё раз.',
    );
  });

  it('невалидный messageKey — fallback errors.internal, не «undefined» (§20 п. 4)', () => {
    renderProvider({ code: 'APP/INTERNAL', messageKey: 'errors.nope' });
    clickTrigger();

    const text = screen.getByTestId('toast').textContent ?? '';
    expect(text).toContain('Что-то пошло не так.');
    expect(text).not.toContain('undefined');
  });
});

describe('ToastProvider — a11y (§16, §20 п. 5)', () => {
  it('регион тостов: role="status", aria-live="polite"', () => {
    renderProvider(INTERNAL);
    clickTrigger();

    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('кнопка «Закрыть» убирает тост', () => {
    renderProvider(INTERNAL);
    clickTrigger();

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));

    expect(screen.queryByTestId('toast')).toBeNull();
  });
});

describe('ToastProvider — автоскрытие 6 с (§10)', () => {
  it('тост скрывается через 6 секунд', () => {
    vi.useFakeTimers();
    renderProvider(INTERNAL);
    clickTrigger();
    expect(screen.getByTestId('toast')).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(screen.getByTestId('toast')).toBeDefined(); // ещё виден

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});

describe('ToastProvider — очередь max 3 (§10)', () => {
  it('при 5 вызовах видны последние 3 тоста', () => {
    renderProvider(INTERNAL);
    clickTrigger(5);

    expect(screen.getAllByTestId('toast')).toHaveLength(3);
  });
});

describe('useToast — контракт провайдера (§12)', () => {
  it('вне ToastProvider — developer-ошибка с понятным сообщением', () => {
    expect(() => render(createElement(Probe, { error: INTERNAL }))).toThrow(/вне ToastProvider/);
  });
});
