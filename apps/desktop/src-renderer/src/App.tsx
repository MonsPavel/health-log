/**
 * Корень рендерера (TASK-007 §10; TASK-011 §5/§10; TASK-013 §5/§6): корневой
 * AppErrorBoundary + ToastProvider обёртывают каркас — AppProviders (тема, i18n,
 * QueryClient) и AppRouter (HashRouter, пять маршрутов-заглушек). Заглушка
 * TASK-007 («Health Log» + тестовая ссылка) заменена каркасом TASK-013.
 */
import { AppErrorBoundary, type BoundaryErrorInfo } from '../app/ErrorBoundary';
import { translateMessageKey } from '../app/errors';
import { AppProviders } from '../app/providers';
import { AppRouter } from '../app/router';
import { ToastProvider } from '../app/toast';

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

export function App(): JSX.Element {
  return (
    <AppErrorBoundary fallback={RendererCrashScreen}>
      <ToastProvider>
        <AppProviders>
          <AppRouter />
        </AppProviders>
      </ToastProvider>
    </AppErrorBoundary>
  );
}
