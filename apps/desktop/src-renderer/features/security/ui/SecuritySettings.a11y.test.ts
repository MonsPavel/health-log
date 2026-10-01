/**
 * TASK-095 §16/§20: axe-прогон секции «Защита паролем» (обе формы: выключено и
 * включено) — ноль critical-нарушений (прецедент DashboardScreen.a11y.test.ts):
 * label/select/кнопки размечены, секция — section+heading. Контраст в jsdom даёт
 * incomplete, не violation.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SecuritySettings } from './SecuritySettings';

import '../../../i18n';

const PREFS = {
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false, modelsDownload: false },
  autoLockMin: 5,
};

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('SecuritySettings — axe: без critical-нарушений (§20)', () => {
  const mockHl = (mode: 'none' | 'passphrase'): void => {
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: {
        invoke: vi.fn((channel: string) =>
          Promise.resolve(
            channel === 'vault/status'
              ? { v: 1, ok: true, data: { mode, locked: false } }
              : { v: 1, ok: true, data: PREFS },
          ),
        ),
        on: vi.fn(() => () => undefined),
      },
    });
  };

  const renderSection = (): HTMLElement => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { container } = render(createElement(SecuritySettings), { wrapper });
    return container;
  };

  it('выключено (кнопка «Включить»): violations с impact=critical отсутствуют', async () => {
    mockHl('none');
    const container = renderSection();

    await waitFor(() =>
      expect(container.querySelector('[data-testid="security-section"]')).not.toBeNull(),
    );
    await waitFor(() =>
      expect(container.querySelector('[data-testid="security-enable"]')).not.toBeNull(),
    );

    const results = await axe.run(container);

    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical).toEqual([]);
  });

  it('включено (смена/снятие/автоблок): violations с impact=critical отсутствуют', async () => {
    mockHl('passphrase');
    const container = renderSection();

    await waitFor(() =>
      expect(container.querySelector('[data-testid="security-change"]')).not.toBeNull(),
    );

    const results = await axe.run(container);

    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical).toEqual([]);
  });
});
