/**
 * TASK-098 §19/§20: тест api-хуков экрана «Приватность» — useQuery ключей §12
 * (['privacy','journal'], ['privacy','consents']) поверх каналов privacy/* +
 * ЖИВАЯ ЛЕНТА: событие net:activity инвалидирует journal → перечитывание (AC4).
 * Мутация согласий — optimistic с откатом (§10-прецедент use-preferences).
 *
 * Матрица:
 *  - монтирование → privacy/journal {limit: 50} → данные в кэше (ключ §12);
 *  - net:activity → инвалидация → повторный privacy/journal (AC4, живая лента);
 *  - usePrivacyConsents: чтение → privacy/consents {} → согласия;
 *  - setConsents: optimistic — patch в кэше сразу; успех — ответ канала;
 *  - setConsents: отказ канала → откат кэша к прежним согласиям.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Consents, PrivacyJournalResponse } from '@hl/contracts';

import {
  PRIVACY_CONSENTS_QUERY_KEY,
  PRIVACY_JOURNAL_QUERY_KEY,
  usePrivacyConsents,
  usePrivacyJournal,
} from './use-privacy';

const JOURNAL: PrivacyJournalResponse = {
  entries: [
    {
      kind: 'models.download',
      endpoint: 'https://cdn.example.com/m.bin',
      status: 'ok',
      bytes: 2048,
      atUtc: 1_758_816_000_000,
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

const OK_ENVELOPE = (data: unknown) => ({ v: 1, ok: true, data });

/** Мок моста с сигнатурой канала (прецедент AiPage.test: no-misused-promises на mockImplementation). */
type InvokeMock = ReturnType<typeof vi.fn<(channel: string) => Promise<unknown>>>;

let invoke: InvokeMock;
let listener: ((payload: { kind: string; endpoint: string }) => void) | undefined;

function renderPrivacy() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return {
    queryClient,
    journal: renderHook(() => usePrivacyJournal(), { wrapper }),
    consents: renderHook(() => usePrivacyConsents(), { wrapper }),
  };
}

beforeEach(() => {
  listener = undefined;
  invoke = vi.fn<(channel: string) => Promise<unknown>>((channel) => {
    if (channel === 'privacy/journal') {
      return Promise.resolve(OK_ENVELOPE(JOURNAL));
    }
    return Promise.resolve(OK_ENVELOPE(CONSENTS));
  });
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn((name: string, cb: (payload: { kind: string; endpoint: string }) => void) => {
        if (name === 'net:activity') {
          listener = cb;
        }
        return () => undefined;
      }),
    },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
});

describe('usePrivacyJournal — чтение (§5/§12)', () => {
  it('монтирование: privacy/journal {limit: 50} → данные в кэше под ключом ["privacy","journal"]', async () => {
    const { journal, queryClient } = renderPrivacy();

    await waitFor(() => expect(journal.result.current.data).toBeDefined());
    expect(invoke).toHaveBeenCalledWith('privacy/journal', { limit: 50 });
    expect(PRIVACY_JOURNAL_QUERY_KEY).toEqual(['privacy', 'journal']);
    expect(queryClient.getQueryData(PRIVACY_JOURNAL_QUERY_KEY)).toEqual(JOURNAL);
  });
});

describe('живая лента — net:activity → refetch (§12/AC4)', () => {
  it('событие инвалидирует journal: повторный вызов канала, новые данные в кэше', async () => {
    const { journal } = renderPrivacy();
    await waitFor(() => expect(journal.result.current.data).toBeDefined());
    const journalCalls = () =>
      invoke.mock.calls.filter(([channel]) => channel === 'privacy/journal');
    expect(journalCalls()).toHaveLength(1);

    const UPDATED: PrivacyJournalResponse = {
      entries: [
        {
          kind: 'updates.check',
          endpoint: '',
          status: 'blocked',
          atUtc: 1_758_816_000_001,
        },
        ...JOURNAL.entries,
      ],
      ops: JOURNAL.ops,
    };
    invoke.mockImplementation((channel: string): Promise<unknown> => {
      if (channel === 'privacy/journal') {
        return Promise.resolve(OK_ENVELOPE(UPDATED));
      }
      return Promise.resolve(OK_ENVELOPE(CONSENTS));
    });

    act(() => {
      listener?.({ kind: 'updates.check', endpoint: '' });
    });

    await waitFor(() => expect(journal.result.current.data?.entries).toHaveLength(2));
    expect(journalCalls()).toHaveLength(2);
    expect(invoke).toHaveBeenLastCalledWith('privacy/journal', { limit: 50 });
  });
});

describe('usePrivacyConsents — чтение и переключение (§5/§14)', () => {
  it('монтирование: privacy/consents {} → согласия под ключом ["privacy","consents"]', async () => {
    const { consents } = renderPrivacy();

    await waitFor(() => expect(consents.result.current.consents).toBeDefined());
    expect(invoke).toHaveBeenCalledWith('privacy/consents', {});
    expect(consents.result.current.consents).toEqual(CONSENTS);
  });

  it('setConsents: optimistic — patch виден в кэше сразу, успех — ответ канала', async () => {
    const { consents, queryClient } = renderPrivacy();
    await waitFor(() => expect(consents.result.current.consents).toBeDefined());

    let resolveSet: (value: unknown) => void = () => undefined;
    invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSet = resolve;
      }),
    );
    act(() => {
      consents.result.current.setConsents.mutate({ updatesCheck: true });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(PRIVACY_CONSENTS_QUERY_KEY)).toMatchObject({
        updatesCheck: true,
      }),
    );

    resolveSet(OK_ENVELOPE({ updatesCheck: true, modelsDownload: true }));
    await waitFor(() => expect(consents.result.current.setConsents.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledWith('privacy/consents', { patch: { updatesCheck: true } });
    expect(queryClient.getQueryData(PRIVACY_CONSENTS_QUERY_KEY)).toEqual({
      updatesCheck: true,
      modelsDownload: true,
    });
  });

  it('setConsents: отказ канала → откат кэша к прежним согласиям (§10)', async () => {
    const { consents, queryClient } = renderPrivacy();
    await waitFor(() => expect(consents.result.current.consents).toBeDefined());
    const before = queryClient.getQueryData(PRIVACY_CONSENTS_QUERY_KEY);

    invoke.mockResolvedValueOnce({
      v: 1,
      ok: false,
      error: { code: 'STORAGE/FAILED', messageKey: 'errors.STORAGE_FAILED' },
    });
    act(() => {
      consents.result.current.setConsents.mutate({ updatesCheck: true });
    });

    await waitFor(() => expect(consents.result.current.setConsents.isError).toBe(true));
    expect(queryClient.getQueryData(PRIVACY_CONSENTS_QUERY_KEY)).toEqual(before);
  });
});
