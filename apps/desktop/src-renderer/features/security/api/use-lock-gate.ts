/**
 * TASK-095 §5/§12/§13/§15: api-слой гейта блокировки. ЕДИНЫЙ источник состояния —
 * сервер: запрос `vault/status` (общий ключ ['vault-status'] — гейт в App и секция
 * настроек читают один кэш) + мгновенные события lock:engaged|lock:required
 * (§15: оверлей показывается без запроса при показе; актуальное состояние уточняет
 * refetch, доставка событий at-most-once). Пока статус неизвестен — фаза loading:
 * контент НЕ рендерится (§13 «данные скрыты даже в момент загрузки», §14 — строже
 * inert: маршруты не монтируются). setUnlocked — optimistic-переключение после
 * успеха vault/unlock (§13: оверлей исчезает сразу) + инвалидация статуса и prefs
 * (ThemeProvider и защищённые чтения перечитывают — до unlock prefs/get отвечал
 * VAULT/LOCKED, §7 094).
 */
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import type { ChannelResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { useHlEvent } from '../../../lib/events';
import { PREFS_QUERY_KEY } from '../../settings/model/use-preferences';

/** Форма статуса vault (ответ канала — контракт vault.ts 094). */
export type VaultStatusDto = ChannelResponse<'vault/status'>;

/** Ключ запроса статуса (§12): гейт App + секция настроек — один кэш. */
export const VAULT_STATUS_QUERY_KEY = ['vault-status'] as const;

/** Фаза гейта (§13): loading — статус неизвестен; locked — оверлей; open — контент. */
export type LockPhase = 'loading' | 'locked' | 'open';

/** Чтение статуса (§12): разворот конверта; отказ — IpcApiError (retry 0 §12). */
async function fetchVaultStatus(): Promise<VaultStatusDto> {
  const result = await call('vault/status', {});
  if (!result.ok) {
    throw new Error(`vault/status: ${result.error.code} (${result.error.messageKey})`);
  }
  return result.data;
}

/** Запрос статуса vault (§12) — общий для гейта и настроек защиты. */
export function useVaultStatus(): UseQueryResult<VaultStatusDto, Error> {
  return useQuery({
    queryKey: VAULT_STATUS_QUERY_KEY,
    queryFn: fetchVaultStatus,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Гейт блокировки: фаза для App + optimistic-разблокировка (§13). */
export interface LockGate {
  readonly phase: LockPhase;
  /** Успех vault/unlock: мгновенно открыть контент + перечитать статус/prefs. */
  readonly setUnlocked: () => void;
}

/**
 * Состояние блокировки (§5/§12): подписка на lock:engaged|lock:required даёт
 * мгновенный override (§15), запрос — актуальную истину; override true/false
 * перекрывает данные запроса до его перечитывания.
 */
export function useLockGate(): LockGate {
  const queryClient = useQueryClient();
  const { data } = useVaultStatus();
  // null — override нет (истина из запроса); true — заблокировано (событие lock:*),
  // false — разблокировано (успешный unlock, §13).
  const [override, setOverride] = useState<boolean | null>(null);

  useHlEvent('lock:engaged', () => setOverride(true));
  useHlEvent('lock:required', () => setOverride(true));

  const setUnlocked = useCallback((): void => {
    setOverride(false);
    void queryClient.invalidateQueries({ queryKey: VAULT_STATUS_QUERY_KEY });
    // prefs при locked отвечали VAULT/LOCKED — перечитать для ThemeProvider (§7 094).
    void queryClient.invalidateQueries({ queryKey: PREFS_QUERY_KEY });
  }, [queryClient]);

  const locked = override ?? (data !== undefined ? data.locked : true);
  const phase: LockPhase =
    override === null && data === undefined ? 'loading' : locked ? 'locked' : 'open';
  return { phase, setUnlocked };
}
