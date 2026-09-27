/**
 * TASK-047 §5/§10/§11/§12: api-слой настроек — useQuery ключа ['prefs'] поверх
 * канала `prefs/get` + useMutation поверх `prefs/set`.
 *
 * МИГРАЦИЯ localStorage→БД (§4/§12, one-time): при ПЕРВОМ prefs/get ключи
 * hl.theme/hl.textScale (TASK-013) переносятся: валидные значения уходят единым
 * prefs/set {patch} (merge в сервисе — легаси ложится поверх дефолтов), ключи
 * localStorage удаляются НЕЗАВИСИМО от валидности значения (потреблённые). Отказ
 * set — не блокирует чтение: следующий источник — prefs/get (БД выиграет позже).
 *
 * OPTIMISTIC (§10 — простой случай, без конфликтов): patch кладётся в кэш сразу,
 * при успехе перезаписывается серверным полным документом (источник истины), при
 * отказе — откат к прежнему. Ответы разворачиваются: ok:false → IpcApiError c
 * AppErrorDto (прецедент use-add-measurement — свой класс ради изоляции чанков
 * фич, §15: settings не тянет measurement-модуль).
 *
 * СОБЫТИЕ prefs:changed (§12 main-источник): подписка useHlEvent инвалидирует
 * ['prefs'] — перечитывание гарантирует согласованность с другими источниками
 * set (дублирование с onSuccess — «двойная защита», прецедент measurement).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  THEME_SCHEMA,
  TEXT_SCALE_SCHEMA,
  type AppErrorDto,
  type Prefs,
  type PrefsPatch,
} from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { useHlEvent } from '../../../lib/events';

/** Ключ localStorage режима темы из TASK-013 (§4: мигрируется в prefs, удаляется). */
export const LEGACY_THEME_STORAGE_KEY = 'hl.theme';

/** Ключ localStorage масштаба текста из TASK-013 (§4). */
export const LEGACY_TEXT_SCALE_STORAGE_KEY = 'hl.textScale';

/** Ключ запроса настроек (§12); инвалидация — событие prefs:changed и мутация. */
export const PREFS_QUERY_KEY = ['prefs'] as const;

/** Ошибка IPC-канала с dto (ok:false конверт) — данные, не технический краш. */
export class IpcApiError extends Error {
  /** DTO ошибки из конверта (code/messageKey/params — TASK-008 §7). */
  readonly dto: AppErrorDto;

  constructor(dto: AppErrorDto) {
    super(`IPC: ${dto.code} (${dto.messageKey})`);
    this.name = 'IpcApiError';
    this.dto = dto;
  }
}

/**
 * One-time перенос легаси-ключей (§12): читает hl.theme/hl.textScale, УДАЛЯЕТ оба
 * независимо от валидности (ключ потреблён), валидные значения — в patch. Ни одного
 * ключа (или все невалидны) → null — миграции нет, prefs/set не вызывается.
 * localStorage может быть недоступен (политика) — §14: только тема/масштаб, сбой глушится.
 */
export function takeLegacyLocalPrefs(): PrefsPatch | null {
  try {
    const patch: PrefsPatch = {};
    const theme = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (theme !== null) {
      localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
      const parsed = THEME_SCHEMA.safeParse(theme);
      if (parsed.success) {
        patch.theme = parsed.data;
      }
    }
    const textScale = localStorage.getItem(LEGACY_TEXT_SCALE_STORAGE_KEY);
    if (textScale !== null) {
      localStorage.removeItem(LEGACY_TEXT_SCALE_STORAGE_KEY);
      const parsed = TEXT_SCALE_SCHEMA.safeParse(textScale);
      if (parsed.success) {
        patch.textScale = parsed.data;
      }
    }
    return Object.keys(patch).length > 0 ? patch : null;
  } catch {
    return null;
  }
}

/** Чтение настроек (§12): миграция легаси → (или) prefs/get; ответ — полный документ. */
async function loadPrefs(): Promise<Prefs> {
  const legacy = takeLegacyLocalPrefs();
  if (legacy !== null) {
    const migrated = await call('prefs/set', { patch: legacy });
    if (migrated.ok) {
      return migrated.data;
    }
    // Отказ миграции — чтение продолжается из БД (§12: источник истины — main).
  }
  const result = await call('prefs/get', {});
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Вызов канала set: разворот конверта; failure → IpcApiError (§11). */
async function setPrefs(patch: PrefsPatch): Promise<Prefs> {
  const result = await call('prefs/set', { patch });
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** API хука (§10): документ (undefined пока грузится) + мутация setPreferences. */
export function usePreferences() {
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: PREFS_QUERY_KEY, queryFn: loadPrefs });

  const setPreferences = useMutation<Prefs, Error, PrefsPatch, { previous: Prefs | undefined }>({
    mutationFn: setPrefs,
    // §10 optimistic: patch в кэш сразу; previous — в контекст для отката.
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: PREFS_QUERY_KEY });
      const previous = queryClient.getQueryData<Prefs>(PREFS_QUERY_KEY);
      if (previous !== undefined) {
        queryClient.setQueryData<Prefs>(PREFS_QUERY_KEY, {
          ...previous,
          ...patch,
          netConsents: patch.netConsents ?? previous.netConsents,
        });
      }
      return { previous };
    },
    // §10: отказ — откат кэша (значение не применилось — UI не лжёт).
    onError: (_error, _patch, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(PREFS_QUERY_KEY, context.previous);
      }
    },
    // §12: сервер — источник истины; полный документ перезаписывает optimistic.
    onSuccess: (data) => {
      queryClient.setQueryData(PREFS_QUERY_KEY, data);
    },
  });

  // §12: событие main — сигнал перечитать (мгновенное применение у провайдеров).
  useHlEvent('prefs:changed', () => {
    void queryClient.invalidateQueries({ queryKey: PREFS_QUERY_KEY });
  });

  return { prefs: query.data, query, setPreferences };
}
