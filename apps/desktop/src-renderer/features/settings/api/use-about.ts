/**
 * TASK-100 §12/§19: api-слой секции «О приложении» поверх каналов TASK-100
 * `app/selfcheck|meta|integrity-full`.
 *
 * СОСТОЯНИЕ (§12): useQuery ['selfcheck'] — снимок старта СТАТИЧЕН за сессию
 * (staleTime Infinity — прецедент scales/active 051); ['app-meta'] — версии, тоже
 * статичны за сессию (appVersion/шкала/модель не меняются без перезапуска).
 * Полная проверка — useMutation (долгий запрос по кнопке, §11: progress не нужен,
 * <10 с); результат мутирующий — живёт в компоненте, стартовый снимок не трогает
 * (§7: «отдельный результат в UI»).
 *
 * Отказ конверта — IpcApiError с DTO (§11, прецедент use-privacy/use-preferences).
 */
import { useMutation, useQuery } from '@tanstack/react-query';

import type {
  ApiResult,
  AppIntegrityFullResponse,
  AppMetaResponse,
  AppSelfcheckResponse,
} from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from '../model/use-preferences';

/** Ключ запроса снимка сампроверки (§12: статичен за сессию). */
export const SELFCHECK_QUERY_KEY = ['selfcheck'] as const;

/** Ключ запроса версий «О приложении» (статичен за сессию). */
export const APP_META_QUERY_KEY = ['app-meta'] as const;

/** Разворот конверта: ok:false — IpcApiError с DTO (§11). */
function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Снимок сампроверки старта (null — самчек ещё не выполнялся, locked-старт). */
async function loadSelfcheck(): Promise<AppSelfcheckResponse> {
  return unwrap(await call('app/selfcheck', {}));
}

/** Версии «О приложении». */
async function loadAppMeta(): Promise<AppMetaResponse> {
  return unwrap(await call('app/meta', {}));
}

/** Полная проверка БД (долгая — по кнопке, §11). */
async function runIntegrityFull(): Promise<AppIntegrityFullResponse> {
  return unwrap(await call('app/integrity-full', {}));
}

/** Снимок сампроверки (§12): статичен за сессию — Infinity без refetch. */
export function useSelfcheck() {
  return useQuery({
    queryKey: SELFCHECK_QUERY_KEY,
    queryFn: loadSelfcheck,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Версии «О приложении» (§12): статичны за сессию. */
export function useAppMeta() {
  return useQuery({
    queryKey: APP_META_QUERY_KEY,
    queryFn: loadAppMeta,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Мутация полной проверки (§12): результат — в компоненте, снимок не мутирует (§7). */
export function useIntegrityFull() {
  return useMutation({ mutationFn: runIntegrityFull });
}
