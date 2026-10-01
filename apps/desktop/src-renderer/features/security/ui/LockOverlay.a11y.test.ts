/**
 * TASK-095 §16/§20: axe-прогон экрана блокировки — ноль critical-нарушений
 * (прецедент DashboardScreen.a11y.test.ts): диалоговая семантика (role="dialog"
 * + aria-labelledby), label поля, видимый отсчёт backoff (aria-live polite).
 * Контраст в jsdom даёт incomplete, не violation.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LockOverlay } from './LockOverlay';

import '../../../i18n';

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('LockOverlay — axe: без critical-нарушений (§20)', () => {
  it('axe.run: violations с impact=critical отсутствуют', async () => {
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: {
        invoke: vi.fn(() =>
          Promise.resolve({ v: 1, ok: true, data: { mode: 'passphrase', locked: true } }),
        ),
        on: vi.fn(() => () => undefined),
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { container } = render(createElement(LockOverlay, { onUnlocked: () => undefined }), {
      wrapper,
    });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="lock-pass"]')).not.toBeNull(),
    );

    const results = await axe.run(container);

    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical).toEqual([]);
  });
});
