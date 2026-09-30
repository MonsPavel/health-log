/**
 * TASK-081 §19/§20: компонентные тесты экрана «Модель»:
 *  - AC2: первый «Скачать» БЕЗ согласия → согласие-диалог; до подтверждения
 *    `ai/models/download` НЕ вызван (spy = «сети не было», gateway-перехват UI);
 *    отказ («Отмена») — сети не было; подтверждение — prefs/set согласия и download;
 *  - согласие уже выдано — диалога нет, download сразу (§13);
 *  - AC3: прогресс обновляется из fake-события ai:progress (§12: setQueryData);
 *  - «Выбрать» → ai/models/select (§5/§9);
 *  - отказ list (битый манифест) — состояние ошибки, не краш (§13).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HlEventMap } from '@hl/contracts';

import '../../../i18n';
import { createQueryClient } from '../../../lib/query-client';
import { ModelsScreen } from './ModelsScreen';

let invoke: ReturnType<typeof vi.fn>;
let eventListeners: Partial<Record<keyof HlEventMap, (payload: unknown) => void>>;

const OK = (data: unknown) => ({ v: 1, ok: true, data });
const FAIL = (code: string, messageKey: string) => ({ v: 1, ok: false, error: { code, messageKey } });

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

/** Витрина list (§7): dev-модель 2 ГБ, PLACEHOLDER-host (§14: реальный домен в тексте). */
const LIST = {
  models: [
    {
      descriptor: {
        id: 'dev-placeholder-ru',
        name: 'Dev Placeholder Model',
        version: '0.0.0-dev',
        file: 'dev-placeholder.gguf',
        url: 'https://PLACEHOLDER.invalid/models/dev-placeholder.gguf',
        sha256: '0'.repeat(64),
        sizeBytes: 2_147_483_648,
        languages: ['ru', 'en'],
        minRamGb: 8,
        license: 'UNLICENSED-DEV-PLACEHOLDER',
      },
      state: 'not_installed',
    },
  ],
  ramTotalGb: 31.3,
  uiLanguage: 'ru',
};

function renderScreen(): void {
  render(
    createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      createElement(ModelsScreen),
    ),
  );
}

beforeEach(() => {
  invoke = vi.fn().mockImplementation((channel: string) => {
    if (channel === 'ai/models/list') {
      return Promise.resolve(OK(LIST));
    }
    if (channel === 'prefs/get') {
      return Promise.resolve(OK(PREFS()));
    }
    if (channel === 'ai/models/download' || channel === 'ai/models/select') {
      return Promise.resolve(OK({ state: 'installed' }));
    }
    if (channel === 'prefs/set') {
      return Promise.resolve(OK(PREFS()));
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

const downloadCalls = (): unknown[][] =>
  invoke.mock.calls.filter((call) => call[0] === 'ai/models/download');

describe('ModelsScreen — согласие до первой загрузки (TASK-081 §20 AC2, §14)', () => {
  it('первый «Скачать» без согласия → диалог с размером и host; download НЕ вызван', async () => {
    renderScreen();
    const download = await screen.findByTestId('model-download');
    fireEvent.click(download);

    const dialog = await screen.findByTestId('consent-dialog');
    expect(dialog.textContent).toContain('2 ГБ');
    // §14: host в тексте согласия — из URL манифеста (реальный домен, каноничные
    // строчные — как показывает браузер), не «интернет».
    expect(dialog.textContent).toContain('placeholder.invalid');
    expect(downloadCalls()).toHaveLength(0);
  });

  it('отказ («Отмена») → диалога нет, сети не было (spy download пуст)', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('model-download'));
    fireEvent.click(await screen.findByTestId('consent-cancel'));

    await waitFor(() => expect(screen.queryByTestId('consent-dialog')).toBeNull());
    expect(downloadCalls()).toHaveLength(0);
  });

  it('подтверждение → prefs/set согласия (целиком) и затем download (§13)', async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId('model-download'));
    fireEvent.click(await screen.findByTestId('consent-confirm'));

    await waitFor(() => expect(downloadCalls()).toHaveLength(1));
    expect(downloadCalls()[0]?.[1]).toEqual({ modelId: 'dev-placeholder-ru' });
    const setCalls = invoke.mock.calls.filter((call) => call[0] === 'prefs/set');
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.[1]).toEqual({
      patch: { netConsents: { updatesCheck: false, modelsDownload: true } },
    });
  });

  it('согласие уже выдано — диалога нет, download сразу (§13)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'prefs/get') {
        return Promise.resolve(
          OK(PREFS({ netConsents: { updatesCheck: false, modelsDownload: true } })),
        );
      }
      if (channel === 'ai/models/list') {
        return Promise.resolve(OK(LIST));
      }
      return Promise.resolve(OK({ state: 'installed' }));
    });
    renderScreen();

    fireEvent.click(await screen.findByTestId('model-download'));

    await waitFor(() => expect(downloadCalls()).toHaveLength(1));
    expect(screen.queryByTestId('consent-dialog')).toBeNull();
  });
});

describe('ModelsScreen — прогресс из события ai:progress (§20 AC3, §12)', () => {
  it('fake-событие обновляет карточку: aria-valuenow 40 и текст «40%»', async () => {
    renderScreen();
    await screen.findByTestId('model-card');

    const listener = eventListeners['ai:progress'];
    expect(listener).toBeDefined();
    listener?.({
      modelId: 'dev-placeholder-ru',
      downloadedBytes: 858_993_459,
      totalBytes: 2_147_483_648,
      state: 'downloading',
    } as HlEventMap['ai:progress']);

    await waitFor(() =>
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40'),
    );
    expect(screen.getByTestId('model-progress-percent').textContent).toBe('40%');
  });
});

describe('ModelsScreen — выбор модели и состояния экрана (§5/§9/§13)', () => {
  it('installed-карточка: «Выбрать» → ai/models/select {modelId}', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai/models/list') {
        return Promise.resolve(
          OK({ ...LIST, models: [{ ...LIST.models[0], state: 'installed' }] }),
        );
      }
      if (channel === 'prefs/get') {
        return Promise.resolve(OK(PREFS()));
      }
      return Promise.resolve(OK({ modelId: 'dev-placeholder-ru' }));
    });
    renderScreen();

    fireEvent.click(await screen.findByTestId('model-select'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai/models/select', { modelId: 'dev-placeholder-ru' }),
    );
  });

  it('отказ list (битый манифест) → состояние ошибки, не краш (§13)', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai/models/list') {
        return Promise.resolve(FAIL('APP/INTERNAL', 'errors.internal'));
      }
      if (channel === 'prefs/get') {
        return Promise.resolve(OK(PREFS()));
      }
      return Promise.resolve(OK({}));
    });
    renderScreen();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('список моделей');
    expect(screen.queryByTestId('model-card')).toBeNull();
  });
});
