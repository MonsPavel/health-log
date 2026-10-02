/**
 * Корень рендерера (TASK-007 §10; TASK-011 §5/§10; TASK-013 §5/§6; TASK-095 §4/§14;
 * TASK-101 §10): корневой AppErrorBoundary + ToastProvider обёртывают каркас —
 * AppProviders (тема, i18n, QueryClient), ГЕЙТ восстановления (TASK-101: при
 * recovery-режиме контейнера — RecoveryScreen вместо всего контента: БД не открыта,
 * secure-каналы закрыты STORAGE/RECOVERY_MODE, маршруты не монтируются) и ГЕЙТ
 * блокировки (TASK-095): при locked оверлей LockOverlay верхним слоем, маршруты НЕ
 * монтируются (§14 РЕШЕНИЕ: выгрузка строже aria-hidden+inert — контента в DOM нет
 * вообще, §13 «данные скрыты даже в момент загрузки»); при open — AppRouter как
 * раньше (откат: mode none — оверлей не появляется, §24). Пока статус vault/status
 * неизвестен — loading без контента (§13). Параллельно живёт heartbeat активности
 * (lib/heartbeat, §5: pointerdown/keydown → app/heartbeat, троттл 30 с — корректный
 * автоблок).
 */
import { useTranslation } from 'react-i18next';

import { AppErrorBoundary, type BoundaryErrorInfo } from '../app/ErrorBoundary';
import { translateMessageKey } from '../app/errors';
import { AppProviders } from '../app/providers';
import { AppRouter } from '../app/router';
import { ToastProvider } from '../app/toast';
import { useHeartbeat } from '../lib/heartbeat';
import { useRecoveryGate } from '../features/recovery/api/use-recovery-gate';
import { RecoveryScreen } from '../features/recovery/ui/RecoveryScreen';
import { useLockGate } from '../features/security/api/use-lock-gate';
import { LockOverlay } from '../features/security/ui/LockOverlay';

/**
 * Полноэкранный fallback корневой границы (§10): «Что-то сломалось, перезагрузите»
 * по ключу errors.renderer; a11y (§16): role="alert", кнопка «Перезагрузить» —
 * нативный button, в tab-порядке. Перезагрузка — восстановление после краша рендера
 * (§13); подпись кнопки — RU-константа, ДОПУСТИМОЕ ИСКЛЮЧЕНИЕ из §17 (UI-хром,
 * перенос в каталог — с UI-фичами, TASK-031+).
 */
export function RendererCrashScreen(info: BoundaryErrorInfo): JSX.Element {
  return (
    <div role="alert">
      <p>{translateMessageKey(info.messageKey)}</p>
      <button type="button" onClick={() => location.reload()}>
        Перезагрузить
      </button>
    </div>
  );
}

/**
 * Гейт блокировки (§5/§12): оверлей вне роутера (арх. 06 §4) — верхний слой вместо
 * контента при locked; heartbeat монтируется на весь срок жизни окна (активность
 * нужна и в открытой сессии; в locked вызовы безвредны — touchActivity).
 */
function LockGate(): JSX.Element {
  const { t } = useTranslation();
  const { phase, setUnlocked } = useLockGate();
  useHeartbeat();

  if (phase === 'loading') {
    // Статус неизвестен: нейтральный текст без контентных данных (§13/§14).
    return (
      <div role="status" className="flex h-screen items-center justify-center text-accent">
        {t('common.loading')}
      </div>
    );
  }
  if (phase === 'locked') {
    return <LockOverlay onUnlocked={setUnlocked} />;
  }
  return <AppRouter />;
}

/**
 * Гейт восстановления (TASK-101 §10): режим проверяется ответом app/meta ДО
 * роутера — при recovery весь контент замещается RecoveryScreen (БД не открыта,
 * маршруты не монтируются). Пока meta не пришла — нейтральный loading без
 * контента (§13); в здоровом старте — LockGate без задержек после meta.
 */
function RecoveryGate(): JSX.Element {
  const { t } = useTranslation();
  const { phase, recovery } = useRecoveryGate();

  if (phase === 'loading') {
    return (
      <div role="status" className="flex h-screen items-center justify-center text-accent">
        {t('common.loading')}
      </div>
    );
  }
  if (phase === 'recovery' && recovery !== undefined) {
    return <RecoveryScreen recovery={recovery} />;
  }
  return <LockGate />;
}

export function App(): JSX.Element {
  return (
    <AppErrorBoundary fallback={RendererCrashScreen}>
      <ToastProvider>
        <AppProviders>
          <RecoveryGate />
        </AppProviders>
      </ToastProvider>
    </AppErrorBoundary>
  );
}
