/**
 * TASK-031 §20/§16: axe-прогон формы — ноль critical-нарушений (база a11y-тестов
 * §16: aria-label/invalid/describedby проверяются юнит-тестами, здесь — axe-core
 * по всем включённым правилам; контраст в jsdom даёт incomplete, не violation).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { MeasurementForm } from './MeasurementForm';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('MeasurementForm — axe: без critical-нарушений (§20)', () => {
  it('axe.run: violations с impact=critical отсутствуют', async () => {
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: { invoke: vi.fn(), on: vi.fn(() => () => undefined) },
    });
    const { container } = render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ToastProvider, null, createElement(MeasurementForm)),
      ),
    );

    const results = await axe.run(container);

    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical).toEqual([]);
  });
});
