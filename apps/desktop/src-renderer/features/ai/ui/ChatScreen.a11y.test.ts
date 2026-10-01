/**
 * TASK-090 §20: axe-прогон экрана «Чат» — ноль critical-нарушений (прецедент
 * DashboardScreen.a11y.test.ts 057 / MeasurementForm.a11y.test.ts 031).
 * Контраст в jsdom даёт incomplete, не violation; полный масштаб-матричный
 * прогон — ручной §24 / TASK-108. Атрибутные ассерты (role=log, aria-live,
 * label поля) — ChatScreen.test.ts §16.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import '../../../i18n';
import { ToastProvider } from '../../../app/toast';
import { ChatScreen } from './ChatScreen';

/** Мост: витрина с установленной моделью (композер смонтирован) + пустая история. */
function mockHl(): void {
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke: vi.fn((channel: string) =>
        Promise.resolve(
          channel === 'prefs/get'
            ? {
                v: 1,
                ok: true,
                data: {
                  theme: 'system',
                  textScale: '100',
                  dateFormat: 'auto',
                  advancedMode: false,
                  netConsents: { updatesCheck: false, modelsDownload: true },
                  jobState: { jobs: {}, shown: {} },
                  aiSettings: {
                    dismissed: true,
                    includeNotes: false,
                    modelId: 'dev-placeholder-ru',
                  },
                },
              }
            : channel === 'ai/models/list'
              ? {
                  v: 1,
                  ok: true,
                  data: {
                    models: [
                      {
                        descriptor: {
                          id: 'dev-placeholder-ru',
                          name: 'Dev Placeholder Model',
                          version: '0.0.0-dev',
                          file: 'dev-placeholder.gguf',
                          url: 'https://PLACEHOLDER.invalid/models/dev-placeholder.gguf',
                          sha256: '0'.repeat(64),
                          sizeBytes: 1,
                          languages: ['ru', 'en'],
                          minRamGb: 8,
                          license: 'UNLICENSED-DEV-PLACEHOLDER',
                        },
                        state: 'installed',
                      },
                    ],
                    ramTotalGb: 31.3,
                    uiLanguage: 'ru',
                  },
                }
              : channel === 'ai/chat/list'
                ? { v: 1, ok: true, data: { messages: [] } }
                : { v: 1, ok: true, data: {} },
        ),
      ),
      on: vi.fn(() => () => undefined),
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('ChatScreen — axe: без critical-нарушений (§20)', () => {
  it('axe.run: violations с impact=critical отсутствуют (лента + композер + empty-state)', async () => {
    mockHl();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          ToastProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/?tab=chat'] }, children),
        ),
      );
    const { container } = render(createElement(ChatScreen, { onGoToModel: () => undefined }), {
      wrapper,
    });

    // Ждём композера (prefs/models загружены) — axe по размонтированному экрану.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="chat-input"]')).not.toBeNull(),
    );

    const results = await axe.run(container);

    const critical = results.violations.filter((violation) => violation.impact === 'critical');
    expect(critical).toEqual([]);
  });
});
