/**
 * TASK-081 §4/§5/§20 AC5: баннер «ИИ не настроен» на /ai — ненавязчивый (UC-07 A3,
 * не модальный): «Настроить позже» схлопывает НАВСЕГДА (prefs.aiSettings.dismissed,
 * РЕШЕНИЕ спеки), экран моделей остаётся доступен вручную; баннер не показывается,
 * пока выбранная модель не установлена (ИИ настроен).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HlEventMap } from '@hl/contracts';

import '../../../i18n';
import { createQueryClient } from '../../../lib/query-client';
import { AiPage } from './AiPage';

/** Типизированный мок моста: канал → Promise (no-misused-promises, §19). */
type InvokeMock = ReturnType<typeof vi.fn<(channel: string) => Promise<unknown>>>;

let invoke: InvokeMock;
let eventListeners: Partial<Record<keyof HlEventMap, (payload: unknown) => void>>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const PREFS = (over: Record<string, unknown> = {}) => ({
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false, modelsDownload: false },
  jobState: { jobs: {}, shown: {} },
  aiSettings: { dismissed: false },
  ...over,
});

/** Витрина: модель установлена (для сценария «ИИ настроен»). */
const LIST_INSTALLED = {
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
};

const LIST_NOT_INSTALLED = {
  ...LIST_INSTALLED,
  models: [{ ...(LIST_INSTALLED.models[0] as object), state: 'not_installed' }],
};

function renderPage(): void {
  render(
    createElement(QueryClientProvider, { client: createQueryClient() }, createElement(AiPage)),
  );
}

beforeEach(() => {
  invoke = vi.fn<(channel: string) => Promise<unknown>>().mockImplementation((channel: string) => {
    if (channel === 'ai/models/list') {
      return Promise.resolve(OK(LIST_NOT_INSTALLED));
    }
    if (channel === 'prefs/get') {
      return Promise.resolve(OK(PREFS()));
    }
    if (channel === 'prefs/set') {
      return Promise.resolve(OK(PREFS({ aiSettings: { dismissed: true } })));
    }
    return Promise.resolve(OK({}));
  });
  eventListeners = {};
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn((name: keyof HlEventMap, listener: (payload: unknown) => void) => {
        eventListeners[name] = listener;
        return () => undefined;
      }),
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
  localStorage.clear();
});

describe('AiPage — баннер «ИИ не настроен» (TASK-081 §20 AC5, §4/§5)', () => {
  it('не настроен и не отклонён: баннер виден; «Настроить позже» → prefs/set dismissed', async () => {
    renderPage();

    const banner = await screen.findByTestId('ai-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('ИИ не настроен');

    fireEvent.click(screen.getByTestId('ai-banner-later'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('prefs/set', {
        patch: { aiSettings: { dismissed: true } },
      }),
    );
  });

  it('«позже» не навязывается: dismissed=true → баннера нет; экран моделей доступен', async () => {
    invoke.mockImplementation((channel: string): Promise<unknown> => {
      if (channel === 'ai/models/list') {
        return Promise.resolve(OK(LIST_NOT_INSTALLED));
      }
      if (channel === 'prefs/get') {
        return Promise.resolve(OK(PREFS({ aiSettings: { dismissed: true } })));
      }
      return Promise.resolve(OK({}));
    });
    renderPage();

    await screen.findByTestId('model-card');
    expect(screen.queryByTestId('ai-banner')).toBeNull();
    // §20 AC5: экран моделей доступен вручную — список на месте.
    expect(screen.getByTestId('ai-models-section')).toBeDefined();
  });

  it('выбранная модель установлена — баннер не показывается (ИИ настроен, §5)', async () => {
    invoke.mockImplementation((channel: string): Promise<unknown> => {
      if (channel === 'ai/models/list') {
        return Promise.resolve(OK(LIST_INSTALLED));
      }
      if (channel === 'prefs/get') {
        return Promise.resolve(
          OK(PREFS({ aiSettings: { dismissed: false, modelId: 'dev-placeholder-ru' } })),
        );
      }
      return Promise.resolve(OK({}));
    });
    renderPage();

    await screen.findByTestId('model-card');
    expect(screen.queryByTestId('ai-banner')).toBeNull();
  });

  it('пока prefs не загружены — баннера нет (без вспышки), потом появляется', async () => {
    let resolvePrefs: (value: unknown) => void = () => undefined;
    invoke.mockImplementation((channel: string): Promise<unknown> => {
      if (channel === 'prefs/get') {
        return new Promise((resolve) => {
          resolvePrefs = resolve;
        });
      }
      if (channel === 'ai/models/list') {
        return Promise.resolve(OK(LIST_NOT_INSTALLED));
      }
      return Promise.resolve(OK({}));
    });
    renderPage();

    await screen.findByTestId('model-card');
    expect(screen.queryByTestId('ai-banner')).toBeNull();

    resolvePrefs(OK(PREFS()));
    await screen.findByTestId('ai-banner');
  });
});
