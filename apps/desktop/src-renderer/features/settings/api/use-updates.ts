/**
 * TASK-097 §11/§12: api-слой секции «Обновления» поверх каналов TASK-096
 * (updates/check|download|install; события update:available|progress|ready).
 *
 * СОСТОЯНИЕ (§12 — useQuery ['updates','status']): канала ЧТЕНИЯ снапшота main не
 * предоставляет (096 — только действия), поэтому seed запроса — локальный
 * {state:'idle'} (staleTime ∞ — refetch не сбрасывает состояние), а актуальное
 * состояние пишут в кэш: ответы мутаций check/download (финал) и события
 * update:* (§12 «событие-инвалидация»; БЕЗ канала чтения инвалидация вернула бы
 * seed — события пишут данные напрямую, семантика та же: UI реагирует мгновенно).
 * install не меняет снапшот — {restarting:true}, приложение перезапускает updater.
 *
 * СОГЛАСИЕ (§13) — гейт UI-слоя: мутации вызываются ТОЛЬКО при
 * prefs.netConsents.updatesCheck; без согласия компонент показывает подсказку.
 * Отказ конверта (NET/BLOCKED_BY_POLICY и пр.) — IpcApiError, onError ставит
 * состояние error (инлайн-текст, §9 «не креш и не тост-спам»).
 *
 * «ПРОВЕРЕНО: {время}» (§5): момент последней завершённой проверки —
 * localStorage hl.updates.lastCheckAt (префикс hl. — стирается при wipe 072;
 * persistance переживает перезапуск, в отличие от снапшота main). Пишется на
 * ЛЮБОЙ ответ check (проверка была — и available/latest, и error); localStorage
 * может быть недоступен — сбой глушится (UI-состояние, не данные).
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import type { ApiResult, UpdatesStatusResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { useHlEvent } from '../../../lib/events';
import { IpcApiError } from '../../settings/model/use-preferences';

/** Состояние обновления (снапшот main 096 §7 — зеркалим строкой, рендерер не импортирует main). */
export type UpdatesState =
  'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'ready' | 'error';

/** Снимок состояния для UI (§7 096): state + версия/прогресс, когда есть. */
export interface UpdatesStatusSnapshot {
  readonly state: UpdatesState;
  readonly version?: string;
  /** Процент загрузки 0..100 (state=downloading). */
  readonly progress?: number;
}

/** Ключ запроса статуса (§12). */
export const UPDATES_STATUS_QUERY_KEY = ['updates', 'status'] as const;

/** Ключ localStorage «момент последней проверки» (§5; префикс hl. — wipe 072). */
export const LAST_CHECK_STORAGE_KEY = 'hl.updates.lastCheckAt';

/** Seed запроса (§12): снапшот main до первых действий/событий неизвестен UI. */
function seedStatus(): Promise<UpdatesStatusSnapshot> {
  return Promise.resolve({ state: 'idle' as const });
}

/** Запрос статуса (§12): seed + события update:* пишут актуальное состояние. */
export function useUpdatesStatus(): UseQueryResult<UpdatesStatusSnapshot, Error> {
  const queryClient = useQueryClient();

  useHlEvent('update:available', (payload) => {
    queryClient.setQueryData<UpdatesStatusSnapshot>(UPDATES_STATUS_QUERY_KEY, {
      state: 'available',
      version: payload.version,
    });
  });
  useHlEvent('update:progress', (payload) => {
    queryClient.setQueryData<UpdatesStatusSnapshot>(UPDATES_STATUS_QUERY_KEY, (old) => ({
      state: 'downloading',
      progress: payload.percent,
      version: old?.version,
    }));
  });
  useHlEvent('update:ready', () => {
    queryClient.setQueryData<UpdatesStatusSnapshot>(UPDATES_STATUS_QUERY_KEY, (old) => ({
      state: 'ready',
      version: old?.version,
    }));
  });

  return useQuery({
    queryKey: UPDATES_STATUS_QUERY_KEY,
    queryFn: seedStatus,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Момент последней завершённой проверки (§5); нет/недоступен — undefined («никогда»). */
export function readLastCheckAtMs(storage: Storage = localStorage): number | undefined {
  try {
    const raw = storage.getItem(LAST_CHECK_STORAGE_KEY);
    if (raw === null) {
      return undefined;
    }
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}

/** Фиксация факта проверки (§5); недоступный storage глушится (UI-состояние). */
function writeLastCheckAtMs(nowMs: number, storage: Storage = localStorage): void {
  try {
    storage.setItem(LAST_CHECK_STORAGE_KEY, String(nowMs));
  } catch {
    // §14-прецедент takeLegacyLocalPrefs: политика может запретить storage.
  }
}

/** Разворот конверта: ok:false — IpcApiError с DTO (§11, прецедент use-preferences). */
function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Маппинг единой формы статуса канала (§11 096) в снимок UI (§7 096). */
function snapshotOf(response: UpdatesStatusResponse): UpdatesStatusSnapshot {
  switch (response.status) {
    case 'available':
      return { state: 'available', version: response.version };
    case 'latest':
      return { state: 'latest' };
    case 'ready':
      return { state: 'ready', version: response.version };
    case 'error':
      return { state: 'error' };
  }
}

/** Мутация «Проверить» (§11): invokes updates/check; факт проверки → lastCheck. */
export function useUpdatesCheck(): ReturnType<
  typeof useMutation<UpdatesStatusResponse, Error, void>
> {
  const queryClient = useQueryClient();
  return useMutation<UpdatesStatusResponse, Error, void>({
    mutationFn: async () => unwrap(await call('updates/check', {})),
    // Старт проверки — мгновенный статус checking (§7 096: сервис ставит его же).
    onMutate: () => {
      queryClient.setQueryData<UpdatesStatusSnapshot>(UPDATES_STATUS_QUERY_KEY, {
        state: 'checking',
      });
    },
    onSuccess: (data) => {
      writeLastCheckAtMs(Date.now());
      queryClient.setQueryData(UPDATES_STATUS_QUERY_KEY, snapshotOf(data));
    },
    // Отказ конверта (политика/согласие main) — видимое состояние ошибки (§9).
    onError: () => {
      queryClient.setQueryData<UpdatesStatusSnapshot>(UPDATES_STATUS_QUERY_KEY, {
        state: 'error',
      });
    },
  });
}

/** Мутация «Скачать» (§11): invokes updates/download; ход — событиями update:progress. */
export function useUpdatesDownload(): ReturnType<
  typeof useMutation<UpdatesStatusResponse, Error, void>
> {
  const queryClient = useQueryClient();
  return useMutation<UpdatesStatusResponse, Error, void>({
    mutationFn: async () => unwrap(await call('updates/download', {})),
    // Старт скачивания — статус downloading (ход уточняют события update:progress).
    onMutate: () => {
      queryClient.setQueryData<UpdatesStatusSnapshot>(UPDATES_STATUS_QUERY_KEY, (old) => ({
        state: 'downloading',
        progress: 0,
        version: old?.version,
      }));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(UPDATES_STATUS_QUERY_KEY, snapshotOf(data));
    },
    onError: () => {
      queryClient.setQueryData<UpdatesStatusSnapshot>(UPDATES_STATUS_QUERY_KEY, {
        state: 'error',
      });
    },
  });
}

/**
 * Мутация «Установить и перезапустить» (§11): invokes updates/install;
 * {restarting:true} — перезапуск делает updater (снапшот не меняется).
 */
export function useUpdatesInstall(): ReturnType<
  typeof useMutation<{ restarting: true }, Error, void>
> {
  return useMutation<{ restarting: true }, Error, void>({
    mutationFn: async () => unwrap(await call('updates/install', {})),
  });
}
