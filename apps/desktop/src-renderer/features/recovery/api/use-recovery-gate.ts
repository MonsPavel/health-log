/**
 * TASK-101 §10/§12: api-слой гейта восстановления. Режим читается из `app/meta`
 * (канал версий/режима, НЕ secure — доступен и в recovery): ответ несёт
 * опциональный recovery-контекст {reason, details} — undefined/отсутствие поля —
 * обычный старт. Ключ запроса ['app-meta'] ОБЩИЙ с секцией «О приложении»
 * (§12: один кэш — прецедент ['vault-status'] 095); в passphrase-режиме recovery
 * вводится ПОСЛЕ unlock — гейт App перечитывает meta по инвалидации из
 * setUnlocked (use-lock-gate), переключая экран без перезапуска.
 *
 * Фаза loading — meta ещё не пришла: контент (роутер/оверлей блокировки) не
 * рендерится (§13 прецедента — «данные скрыты даже в момент загрузки»).
 */
import type { RecoveryContext } from '@hl/contracts';

import { useAppMeta } from '../../settings/api/use-about';

/** Фаза гейта восстановления: loading — режим неизвестен; recovery — экран 101. */
export type RecoveryPhase = 'loading' | 'recovery' | 'app';

/** Состояние гейта для App: фаза + контекст (для RecoveryScreen). */
export interface RecoveryGate {
  readonly phase: RecoveryPhase;
  readonly recovery?: RecoveryContext;
}

/** Чтение режима из app/meta (§10: проверка режима до роутера). */
export function useRecoveryGate(): RecoveryGate {
  const { data } = useAppMeta();
  if (data === undefined) {
    return { phase: 'loading' };
  }
  return data.recovery !== undefined
    ? { phase: 'recovery', recovery: data.recovery }
    : { phase: 'app' };
}
