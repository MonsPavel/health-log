/**
 * TASK-045 §10/§11/§12: api-слой поиска заметок — useQuery поверх канала
 * `notes/search`.
 *
 * DEBOUNCE (§10/§12): 300 мс — набранный текст перестаёт меняться, прежде чем уйдёт
 * запрос (гигиена IPC и кэша: каждое нажатие клавиши не плодит ключи). Место
 * debounce —
 * хук: URL ?q= обновляет панель фильтров сразу при применении (источник истины §12),
 * а fetch ждёт стабилизации ввода; черновик до применения живёт в HistoryFilters.
 *
 * КЛЮЧ (§12): ['measurements','search',query] — корень ['measurements'] общий с
 * журналом, ветка 'search' отделяет поисковые запросы от списков профиля; инвалидация
 * по событию measurement:changed — префиксом ['measurements','search'] (HistoryScreen).
 *
 * placeholderData: keepPreviousData (§10, прецедент use-measurements): при смене
 * запроса предыдущий список показывается до прихода нового, панель не размонтируется
 * — фокус остаётся на контроле (§16).
 *
 * ОТМЕНА (§12): TanStack передаёт AbortSignal в queryFn; мост window.hl сигнала не
 * принимает, поэтому signal проверяется после ответа — результат устаревшего запроса
 * отбрасывается исключением AbortError (сам query TanStack уже игнорирует по ключу).
 *
 * enabled: непустой запрос — пустой не создаёт ключей-«мусора» и не дёргает канал
 * (§20 AC5: пустой запрос — пустой результат).
 *
 * Конверт разворачивается: ok:false → IpcApiError c AppErrorDto (прецедент
 * use-measurements — отказ чтения данные, не технический краш).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { NotesSearchRequest, NotesSearchResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from './use-add-measurement';

/** Размер страницы поиска (§13): дефолт канала — 50; UI предупреждает об усечении. */
export const SEARCH_PAGE_LIMIT = 50;

/** Debounce ввода (§10/§15): 300 мс. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Корень поисковой ветки кэша (§12) — точка инвалидаций поиска. */
export const SEARCH_KEY_ROOT = ['measurements', 'search'] as const;

/** Ключ запроса поиска (§12). */
export function notesSearchKey(query: string): readonly [...typeof SEARCH_KEY_ROOT, string] {
  return [...SEARCH_KEY_ROOT, query];
}

/** Debounced-значение: обновляется, когда input не менялся delayMs (§10). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Вызов канала search: разворот конверта; отмена/ошибка → AbortError/IpcApiError (§11). */
async function searchNotes(
  request: NotesSearchRequest,
  signal?: AbortSignal,
): Promise<NotesSearchResponse> {
  const result = await call('notes/search', request);
  // Мост не отменяет запрос физически — отбрасываем ответ устаревшего ключа (§12).
  signal?.throwIfAborted();
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Хук поиска (§5): query — значение из URL (?q=); '' — поиск выключен. */
export function useNotesSearch(query: string) {
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  return useQuery({
    queryKey: notesSearchKey(debouncedQuery),
    queryFn: ({ signal }) => searchNotes({ query: debouncedQuery, limit: SEARCH_PAGE_LIMIT }, signal),
    enabled: debouncedQuery !== '',
    placeholderData: keepPreviousData,
  });
}
