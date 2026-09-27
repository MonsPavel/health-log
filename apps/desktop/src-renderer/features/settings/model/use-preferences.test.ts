/**
 * TASK-047 §10/§12/§19: тест api-хука настроек — useQuery ['prefs'] + мутация set
 * (optimistic update с откатом, §10) + one-time миграция localStorage→БД (§4/§12:
 * при первом prefs/get ключи hl.theme/hl.textScale переносятся в prefs и удаляются).
 *
 * Матрица:
 *  - монтирование → prefs/get {} → данные доступны (ключ ['prefs']);
 *  - легаси-ключи в localStorage: первый вызов — prefs/set {patch}, ключи удалены,
 *    документ из ответа set (prefs/get не вызывается);
 *  - мусорное значение легаси-ключа: ключ потреблён и удалён, patch не отправляется
 *    (дальше обычный prefs/get);
 *  - отказ prefs/set при миграции → падение на prefs/get (не блокирует чтение);
 *  - setPreferences: optimistic — patch в кэше сразу; успех — серверный документ;
 *  - setPreferences: отказ канала → откат кэша к прежнему документу (§10);
 *  - подписка prefs:changed инвалидирует запрос (main-источник, §12).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prefs } from '@hl/contracts';

import { PREFS_QUERY_KEY, takeLegacyLocalPrefs, usePreferences } from './use-preferences';

/** Дефолтный документ для моков ответов prefs/get (значения §8: parse({}) схемы). */
const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false },
};

const OK_ENVELOPE = (data: unknown) => ({ v: 1, ok: true, data });

let invoke: ReturnType<typeof vi.fn>;
let listener: ((payload: { patchKeys: readonly string[] }) => void) | undefined;

function renderPreferences() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, ...renderHook(() => usePreferences(), { wrapper }) };
}

beforeEach(() => {
  localStorage.clear();
  listener = undefined;
  invoke = vi.fn().mockResolvedValue(OK_ENVELOPE(DEFAULT_PREFS));
  Object.defineProperty(window, 'hl', {
    configurable: true,
    writable: true,
    value: {
      invoke,
      on: vi.fn((name: string, cb: (payload: { patchKeys: readonly string[] }) => void) => {
        if (name === 'prefs:changed') {
          listener = cb;
        }
        return () => undefined;
      }),
    },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'hl', { configurable: true, value: undefined, writable: true });
  localStorage.clear();
});

describe('usePreferences — чтение (§5/§12)', () => {
  it('монтирование: prefs/get {} → документ в кэше под ключом ["prefs"]', async () => {
    const { result } = renderPreferences();

    await waitFor(() => expect(result.current.prefs).toBeDefined());
    expect(invoke).toHaveBeenCalledWith('prefs/get', {});
    expect(PREFS_QUERY_KEY).toEqual(['prefs']);
    expect(result.current.prefs?.theme).toBe('system');
  });
});

describe('миграция localStorage→БД (§4/§12, §20 AC4)', () => {
  it('hl.theme → первый вызов prefs/set {patch:{theme}}, ключ удалён, prefs/get не нужен', async () => {
    localStorage.setItem('hl.theme', 'dark');
    invoke.mockResolvedValue(OK_ENVELOPE({ ...DEFAULT_PREFS, theme: 'dark' }));

    const { result } = renderPreferences();

    await waitFor(() => expect(result.current.prefs?.theme).toBe('dark'));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { theme: 'dark' } });
    expect(localStorage.getItem('hl.theme')).toBeNull();
  });

  it('оба легаси-ключа переносятся одним prefs/set (patch двух полей)', async () => {
    localStorage.setItem('hl.theme', 'light');
    localStorage.setItem('hl.textScale', '125');

    renderPreferences();

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('prefs/set', {
      patch: { theme: 'light', textScale: '125' },
    });
    expect(localStorage.getItem('hl.theme')).toBeNull();
    expect(localStorage.getItem('hl.textScale')).toBeNull();
  });

  it('мусорное значение: ключ потреблён/удалён, patch не отправлен → обычный prefs/get', async () => {
    localStorage.setItem('hl.theme', 'hacker-mode"');

    renderPreferences();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('prefs/get', {}));
    expect(invoke).not.toHaveBeenCalledWith('prefs/set', expect.anything());
    expect(localStorage.getItem('hl.theme')).toBeNull();
  });

  it('легаси-ключей нет → миграции нет (чистый prefs/get)', () => {
    expect(takeLegacyLocalPrefs()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('отказ prefs/set при миграции → чтение падает на prefs/get (не блокирует)', async () => {
    localStorage.setItem('hl.textScale', '112.5');
    invoke
      .mockResolvedValueOnce({
        v: 1,
        ok: false,
        error: { code: 'STORAGE/FAILED', messageKey: 'errors.STORAGE_FAILED' },
      })
      .mockResolvedValueOnce(OK_ENVELOPE({ ...DEFAULT_PREFS, textScale: '112.5' }));

    const { result } = renderPreferences();

    await waitFor(() => expect(result.current.prefs?.textScale).toBe('112.5'));
    expect(invoke).toHaveBeenNthCalledWith(1, 'prefs/set', { patch: { textScale: '112.5' } });
    expect(invoke).toHaveBeenNthCalledWith(2, 'prefs/get', {});
  });
});

describe('usePreferences — setPreferences (§10: optimistic + откат)', () => {
  it('успех: prefs/set вызван, серверный документ в кэше', async () => {
    const { result, queryClient } = renderPreferences();
    await waitFor(() => expect(result.current.prefs).toBeDefined());

    invoke.mockResolvedValueOnce(OK_ENVELOPE({ ...DEFAULT_PREFS, theme: 'dark' }));
    act(() => {
      result.current.setPreferences.mutate({ theme: 'dark' });
    });

    await waitFor(() => expect(result.current.setPreferences.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledWith('prefs/set', { patch: { theme: 'dark' } });
    // onSuccess: сервер (источник истины) перезаписал optimistic.
    expect(queryClient.getQueryData(['prefs'])).toEqual({ ...DEFAULT_PREFS, theme: 'dark' });
  });

  it('optimistic: patch виден в кэше сразу, до ответа канала', async () => {
    let resolveSet: (value: unknown) => void = () => undefined;
    const { result, queryClient } = renderPreferences();
    await waitFor(() => expect(result.current.prefs).toBeDefined());

    invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSet = resolve;
      }),
    );
    act(() => {
      result.current.setPreferences.mutate({ theme: 'dark' });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(['prefs'])).toMatchObject({ theme: 'dark' }),
    );

    resolveSet(OK_ENVELOPE({ ...DEFAULT_PREFS, theme: 'dark' }));
    await waitFor(() => expect(result.current.setPreferences.isSuccess).toBe(true));
  });

  it('отказ: откат кэша к прежнему документу (§10)', async () => {
    const { result, queryClient } = renderPreferences();
    await waitFor(() => expect(result.current.prefs).toBeDefined());
    const before = queryClient.getQueryData(['prefs']);

    invoke.mockResolvedValueOnce({
      v: 1,
      ok: false,
      error: { code: 'STORAGE/FAILED', messageKey: 'errors.STORAGE_FAILED' },
    });
    act(() => {
      result.current.setPreferences.mutate({ theme: 'dark' });
    });

    await waitFor(() => expect(result.current.setPreferences.isError).toBe(true));
    expect(queryClient.getQueryData(['prefs'])).toEqual(before);
  });
});

describe('usePreferences — событие prefs:changed (§12 main-источник)', () => {
  it('подписка активна: событие инвалидирует запрос → перечитывание prefs/get', async () => {
    const { result } = renderPreferences();
    await waitFor(() => expect(result.current.prefs).toBeDefined());
    expect(invoke).toHaveBeenCalledTimes(1);

    invoke.mockResolvedValue(OK_ENVELOPE({ ...DEFAULT_PREFS, theme: 'dark' }));
    act(() => {
      listener?.({ patchKeys: ['theme'] });
    });

    await waitFor(() => expect(result.current.prefs?.theme).toBe('dark'));
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
