/**
 * TASK-098 §12/§19: api-слой экрана «Приватность» (UI — TASK-099) поверх каналов
 * TASK-098 `privacy/journal|consents`.
 *
 * СОСТОЯНИЕ (§12): useQuery ключей ['privacy','journal'] и ['privacy','consents'].
 * ЖИВАЯ ЛЕНТА (§5 «события: invalidate по net:activity»): подписка useHlEvent
 * инвалидирует journal — пользователь видит запись СЕТИ мгновенно (эффект доверия
 * BG-2), включая blocked-отказы (журнал честен и про отказы, §9 075). limit — 50
 * (§15 «мгновенно»; ключ ровно §12 — без параметров в ключе).
 *
 * СОГЛАСИЯ (§14): переключение — ТОЛЬКО мутацией этого канала (prefs direct-запись
 * из UI запрещена — конвенция). OPTIMISTIC (§10-прецедент use-preferences): patch
 * в кэш сразу, успех — ответ канала (источник истины), отказ — откат.
 *
 * Отказ конверта — IpcApiError с DTO (§11, прецедент use-preferences/use-updates).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ApiResult, Consents, PrivacyConsentsPatch, PrivacyJournalResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { useHlEvent } from '../../../lib/events';
import { IpcApiError } from '../model/use-preferences';

/** Ключ запроса журнала (§12); инвалидация — событие net:activity (живая лента). */
export const PRIVACY_JOURNAL_QUERY_KEY = ['privacy', 'journal'] as const;

/** Ключ запроса согласий (§12); перечитывается мутацией (источник истины — ответ). */
export const PRIVACY_CONSENTS_QUERY_KEY = ['privacy', 'consents'] as const;

/** Лимит ленты (§5: {limit=50}; §15 — мгновенно). */
const JOURNAL_LIMIT = 50;

/** Разворот конверта: ok:false — IpcApiError с DTO (§11, прецедент use-preferences). */
function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Журнал приватности (§2): последние записи + перечень операций политики. */
async function loadJournal(): Promise<PrivacyJournalResponse> {
  return unwrap(await call('privacy/journal', { limit: JOURNAL_LIMIT }));
}

/** Чтение согласий (§5): текущее состояние переключателей. */
async function loadConsents(): Promise<Consents> {
  return unwrap(await call('privacy/consents', {}));
}

/** Вызов канала переключения (§5/§14): разворот конверта. */
async function patchConsents(patch: PrivacyConsentsPatch): Promise<Consents> {
  return unwrap(await call('privacy/consents', { patch }));
}

/**
 * Журнал + операции (§12). Живая лента: каждое событие net:activity инвалидирует
 * запрос — refetch показывает свежую запись (AC4).
 */
export function usePrivacyJournal() {
  const queryClient = useQueryClient();

  useHlEvent('net:activity', () => {
    void queryClient.invalidateQueries({ queryKey: PRIVACY_JOURNAL_QUERY_KEY });
  });

  return useQuery({
    queryKey: PRIVACY_JOURNAL_QUERY_KEY,
    queryFn: loadJournal,
  });
}

/** API согласий (§12/§14): документ + мутация переключения (optimistic с откатом). */
export function usePrivacyConsents() {
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: PRIVACY_CONSENTS_QUERY_KEY, queryFn: loadConsents });

  const setConsents = useMutation<Consents, Error, PrivacyConsentsPatch, { previous: Consents | undefined }>({
    mutationFn: patchConsents,
    // §10 optimistic: patch в кэш сразу; previous — в контекст для отката.
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: PRIVACY_CONSENTS_QUERY_KEY });
      const previous = queryClient.getQueryData<Consents>(PRIVACY_CONSENTS_QUERY_KEY);
      if (previous !== undefined) {
        queryClient.setQueryData<Consents>(PRIVACY_CONSENTS_QUERY_KEY, {
          updatesCheck: patch.updatesCheck ?? previous.updatesCheck,
          modelsDownload: patch.modelsDownload ?? previous.modelsDownload,
        });
      }
      return { previous };
    },
    // §10: отказ — откат кэша (значение не применилось — UI не лжёт).
    onError: (_error, _patch, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(PRIVACY_CONSENTS_QUERY_KEY, context.previous);
      }
    },
    // §12: сервер — источник истины; полный документ перезаписывает optimistic.
    onSuccess: (data) => {
      queryClient.setQueryData(PRIVACY_CONSENTS_QUERY_KEY, data);
    },
  });

  return { consents: query.data, query, setConsents };
}
