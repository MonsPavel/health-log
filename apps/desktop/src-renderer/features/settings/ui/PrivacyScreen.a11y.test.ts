/**
 * TASK-099 §16/§20: axe-прогон секции «Приватность» (лента с тремя статусами,
 * переключатели, раскрытая инструкция) — ноль critical-нарушений (прецедент
 * SecuritySettings.a11y.test.ts): switch-паттерн с подписью, статусы с полными
 * aria-метками, live-область, section+heading. Контраст в jsdom даёт incomplete,
 * не violation.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AiModelsListResponse, Consents, PrivacyJournalResponse } from '@hl/contracts';

import '../../../i18n';
import { PrivacyScreen } from './PrivacyScreen';

const T = Date.UTC(2026, 0, 15, 9, 30);

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const JOURNAL: PrivacyJournalResponse = {
  entries: [
    {
      kind: 'models.download',
      endpoint: 'https://cdn.example.com/m.gguf',
      status: 'ok',
      bytes: 2048,
      atUtc: T,
    },
    { kind: 'updates.check', endpoint: '', status: 'blocked', atUtc: T + 1 },
    {
      kind: 'models.download',
      endpoint: 'https://cdn.example.com/m.gguf',
      status: 'failed',
      atUtc: T + 2,
    },
  ],
  ops: [
    {
      op: 'models.download',
      consentKey: 'modelsDownload',
      descriptionKey: 'privacy.ops.models_download',
      enabled: true,
    },
    {
      op: 'updates.check',
      consentKey: 'updatesCheck',
      descriptionKey: 'privacy.ops.updates_check',
      enabled: false,
    },
  ],
};

const CONSENTS: Consents = { updatesCheck: false, modelsDownload: true };

const MODELS: AiModelsListResponse = {
  models: [
    {
      descriptor: {
        id: 'qwen3-4b',
        name: 'Qwen3 4B',
        version: '1.0',
        file: 'qwen3-4b.gguf',
        url: 'https://cdn.example.com/qwen3-4b.gguf',
        sha256: 'a'.repeat(64),
        sizeBytes: 2_400_000_000,
        languages: ['ru'],
        minRamGb: 8,
        license: 'Apache-2.0',
      },
      state: 'not_installed',
    },
  ],
  ramTotalGb: 16,
  uiLanguage: 'ru',
};

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('PrivacyScreen — axe: без critical-нарушений (§20)', () => {
  it('лента с ok/blocked/failed, переключатели, инструкция раскрыта', async () => {
    Object.defineProperty(window, 'hl', {
      configurable: true,
      writable: true,
      value: {
        invoke: vi.fn((channel: string) =>
          Promise.resolve(
            OK(
              channel === 'privacy/journal'
                ? JOURNAL
                : channel === 'privacy/consents'
                  ? CONSENTS
                  : MODELS,
            ),
          ),
        ),
        on: vi.fn(() => () => undefined),
      },
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { container } = render(createElement(PrivacyScreen), { wrapper });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="privacy-section"]')).not.toBeNull(),
    );
    await waitFor(() => expect(container.querySelectorAll('[data-testid="feed-row"]')).toHaveLength(3));

    const results = await axe.run(container);

    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical).toEqual([]);
  });
});
