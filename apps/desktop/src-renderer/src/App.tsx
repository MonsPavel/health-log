/**
 * Корень рендерера (TASK-007 §10; TASK-011 §5/§10; TASK-013 §5/§6; TASK-095 §4/§14):
 * корневой AppErrorBoundary + ToastProvider обёртывают каркас — AppProviders (тема,
 * i18n, QueryClient) и ГЕЙТ блокировки (TASK-095): при locked оверлей LockOverlay
 * верхним слоем, маршруты НЕ монтируются (§14 РЕШЕНИЕ: выгрузка строже aria-hidden+
 * inert — контента в DOM нет вообще, §13 «данные скрыты даже в момент загрузки»);
 * при open — AppRouter как раньше (откат: mode none — оверлей не появляется, §24).
 * Пока статус vault/status неизвестен — loading без контента (§13). Параллельно
 * живёт heartbeat активности (lib/heartbeat, §5: pointerdown/keydown → app/heartbeat,
 * троттл 30 с — корректный автоблок).
 */
import { useTranslation } from 'react-i18next';

import { AppErrorBoundary, type BoundaryErrorInfo } from '../app/ErrorBoundary';
import { translateMessageKey } from '../app/errors';
import { AppProviders } from '../app/providers';
import { AppRouter } from '../app/router';
import { ToastProvider } from '../app/toast';
import { useHeartbeat } from '../lib/heartbeat';
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

export function App(): JSX.Element {
  return (
    <AppErrorBoundary fallback={RendererCrashScreen}>
      <ToastProvider>
        <AppProviders>
          <LockGate />
        </AppProviders>
      </ToastProvider>
    </AppErrorBoundary>
  );
}
