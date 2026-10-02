/**
 * TASK-099 §19/§20: DOM-тесты секции «Приватность» (мок каналов 098 и событий 075):
 *  - AC1: обещание-шапка присутствует (golden-строка §5); ops == каналу
 *    (2 операции политики с названиями/описаниями);
 *  - AC2: переключение согласия — invoke privacy/consents {patch}; мгновенно
 *    (optimistic — aria-checked меняется ДО ответа), отказ канала — откат (§10);
 *  - AC3: лента live — событие net:activity приводит новую запись БЕЗ действий
 *    пользователя (эффект доверия BG-2, §4);
 *  - AC4: инструкция самопроверки раскрывается и содержит шаги для Windows —
 *    «Монитор ресурсов»/resmon (golden §14);
 *  - блокировка переключателя при активной загрузке модели (§13/§10, мок state).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiModelsListResponse, Consents, PrivacyJournalResponse } from '@hl/contracts';

import '../../../i18n';
import { PrivacyScreen } from './PrivacyScreen';

type InvokeMock = ReturnType<typeof vi.fn<(channel: string) => Promise<unknown>>>;

const T = Date.UTC(2026, 0, 15, 9, 30);

const OK = (data: unknown) => ({ v: 1, ok: true, data });

const JOURNAL: PrivacyJournalResponse = {
  entries: [],
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

const MODELS_IDLE: AiModelsListResponse = {
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

const MODELS_DOWNLOADING: AiModelsListResponse = {
  ...MODELS_IDLE,
  models: [{ ...MODELS_IDLE.models[0], state: 'downloading' as const, bytesLoaded: 1024 }],
};

const ENTRY_OK: PrivacyJournalResponse['entries'][number] = {
  kind: 'models.download',
  endpoint: 'https://cdn.example.com/qwen3-4b.gguf',
  status: 'ok',
  bytes: 2048,
  atUtc: T,
};

let invoke: InvokeMock;
let listeners: Map<string, (payload: unknown) => void>;

interface HlOptions {
  readonly journal?: PrivacyJournalResponse;
  readonly consents?: Consents;
  readonly models?: AiModelsListResponse;
}

/** Мост: privacy/*, ai/models/list; события — captured-слушатели useHlEvent. */
function makeHl(options: HlOptions = {}): void {
  listeners = new Map();
  const journal = options.journal ?? JOURNAL;
  const consents = options.consents ?? CONSENTS;
  const models = options.models ?? MODELS_IDLE;
  invoke = vi.fn((channel: string) => {
    if (channel === 'privacy/journal') {
      return Promise.resolve(OK(journal));
    }
    if (channel === 'privacy/consents') {
      return Promise.resolve(OK(consents));
    }
    if (channel === 'ai/models/list') {
      return Promise.resolve(OK(models));
    }
    return Promise.resolve(OK(null));
  });
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return () => undefined;
      }),
    },
  });
}

/** Эмуляция события main→renderer (§11: net:activity 075). */
function fire(name: string, payload: unknown): void {
  act(() => {
    listeners.get(name)?.(payload);
  });
}

function renderScreen(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  render(createElement(PrivacyScreen), { wrapper });
}

/** Согласие по названию операции (aria-labelledby — названия из каталога). */
function switchByName(name: string): HTMLElement {
  return screen.getByRole('switch', { name });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('PrivacyScreen — обещание-шапка и ops == каналу (§5/AC1)', () => {
  it('golden-шапка присутствует; заголовок «Приватность»', async () => {
    makeHl();
    renderScreen();

    expect(screen.getByRole('heading', { name: 'Приватность' })).toBeDefined();
    expect(
      await screen.findByText(
        'Ваши данные обрабатываются только на этом компьютере. Ниже — все случаи, когда приложение может выйти в сеть',
      ),
    ).toBeDefined();
  });

  it('обе операции политики — с названиями и описаниями «зачем» (§5)', async () => {
    makeHl();
    renderScreen();

    expect(await screen.findByRole('switch', { name: 'Загрузка моделей ИИ' })).toBeDefined();
    expect(screen.getByRole('switch', { name: 'Проверка обновлений' })).toBeDefined();
    expect(
      screen.getByText('Скачивает файлы локальных ИИ-моделей с CDN по вашему запросу'),
    ).toBeDefined();
    expect(
      screen.getByText('Спрашивает сервер обновлений о новой версии приложения'),
    ).toBeDefined();
  });
});

describe('PrivacyScreen — переключение согласия (§5/§10/AC2)', () => {
  it('включение мгновенно: invoke privacy/consents {patch:{updatesCheck:true}}', async () => {
    makeHl();
    renderScreen();
    const sw = await screen.findByRole('switch', { name: 'Проверка обновлений' });

    fireEvent.click(sw);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('privacy/consents', { patch: { updatesCheck: true } }),
    );
  });

  it('optimistic: aria-checked меняется ДО ответа канала (§5 «мгновенное применение»)', async () => {
    makeHl();
    renderScreen();
    const sw = await screen.findByRole('switch', { name: 'Проверка обновлений' });
    // Ответ канала висит — переключение применилось только в кэше (optimistic).
    invoke.mockImplementation((channel: string) =>
      channel === 'privacy/consents'
        ? new Promise(() => undefined)
        : Promise.resolve(OK(channel === 'privacy/journal' ? JOURNAL : MODELS_IDLE)),
    );

    fireEvent.click(sw);

    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
  });

  it('отказ канала — откат: aria-checked вернулся (§10, прецедент use-privacy)', async () => {
    makeHl();
    renderScreen();
    const sw = await screen.findByRole('switch', { name: 'Проверка обновлений' });
    invoke.mockImplementation((channel: string) => {
      if (channel === 'privacy/consents') {
        return Promise.resolve({
          v: 1,
          ok: false,
          error: { code: 'STORAGE/FAILED', messageKey: 'errors.STORAGE_FAILED' },
        });
      }
      return Promise.resolve(OK(channel === 'privacy/journal' ? JOURNAL : MODELS_IDLE));
    });

    fireEvent.click(sw);

    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
  });

  it('отключение — за confirm: «загрузка моделей станет недоступна»; подтверждение → invoke patch false (golden §5)', async () => {
    makeHl();
    renderScreen();
    const sw = await screen.findByRole('switch', { name: 'Загрузка моделей ИИ' });

    fireEvent.click(sw);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Загрузка моделей станет недоступна');
    fireEvent.click(screen.getByTestId('privacy-confirm-accept'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('privacy/consents', { patch: { modelsDownload: false } }),
    );
  });

  it('confirm-отмена: invoke НЕ вызван (AC4-дефолт)', async () => {
    makeHl();
    renderScreen();
    const sw = await screen.findByRole('switch', { name: 'Загрузка моделей ИИ' });

    fireEvent.click(sw);
    fireEvent.click(await screen.findByTestId('privacy-confirm-cancel'));

    expect(invoke).not.toHaveBeenCalledWith('privacy/consents', {
      patch: { modelsDownload: false },
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});

describe('PrivacyScreen — блокировка при активной загрузке (§13/§10/§19)', () => {
  it('модель скачивается: modelsDownload disabled + tooltip «идёт загрузка»', async () => {
    makeHl({ models: MODELS_DOWNLOADING });
    renderScreen();

    const modelsSwitch = await screen.findByRole('switch', { name: 'Загрузка моделей ИИ' });
    await waitFor(() => expect(modelsSwitch.hasAttribute('disabled')).toBe(true));
    expect(modelsSwitch.getAttribute('title')).toContain('загрузк');
    expect(screen.getByRole('switch', { name: 'Проверка обновлений' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
});

describe('PrivacyScreen — живая лента (§4/§5/AC3)', () => {
  it('пустая лента: «Сетевых активностей не было»; событие net:activity → запись появилась (AC3)', async () => {
    makeHl();
    renderScreen();
    expect(await screen.findByTestId('feed-empty')).toBeDefined();
    expect(await screen.findByTestId('privacy-section')).toBeDefined();
    // Seed запроса должен устояться ДО события (гонка микротасок, прецедент 097).
    await act(() => Promise.resolve(undefined));

    const UPDATED: PrivacyJournalResponse = { entries: [ENTRY_OK], ops: JOURNAL.ops };
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(OK(channel === 'privacy/journal' ? UPDATED : channel === 'privacy/consents' ? CONSENTS : MODELS_IDLE)),
    );
    fire('net:activity', { kind: 'models.download', endpoint: 'https://cdn.example.com' });

    await waitFor(() => expect(screen.getAllByTestId('feed-row')).toHaveLength(1));
    expect(screen.queryByTestId('feed-empty')).toBeNull();
  });
});

describe('PrivacyScreen — инструкция самопроверки (§14/AC4)', () => {
  it('раскрывается по клику и содержит шаги для Windows: «Монитор ресурсов», resmon (golden)', async () => {
    makeHl();
    renderScreen();
    await screen.findByTestId('privacy-section');

    // До клика инструкция скрыта (условный рендер — из DOM целиком, §16).
    expect(screen.queryByTestId('privacy-selfcheck-body')).toBeNull();
    fireEvent.click(screen.getByTestId('privacy-selfcheck-toggle'));

    const body = await screen.findByTestId('privacy-selfcheck-body');
    expect(body.textContent).toContain('Монитор ресурсов');
    expect(body.textContent).toContain('resmon');
    expect(screen.getByTestId('privacy-selfcheck-toggle').getAttribute('aria-expanded')).toBe(
      'true',
    );
  });
});
