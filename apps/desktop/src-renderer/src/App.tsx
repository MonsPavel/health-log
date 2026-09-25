/**
 * Корень рендерера (TASK-007 §10; TASK-011 §5/§10): корневой AppErrorBoundary +
 * ToastProvider обёртывают контент каркаса. «Health Log» — имя продукта, не
 * переводимый контент (§17); i18n-ключ появится с TASK-013. Ссылка ниже — заглушка
 * для ручной проверки блокировки внешней навигации (§20, шаг 5).
 */
import { AppErrorBoundary, type BoundaryErrorInfo } from '../app/ErrorBoundary';
import { translateMessageKey } from '../app/errors';
import { ToastProvider } from '../app/toast';

/**
 * Полноэкранный fallback корневой границы (§10): «Что-то сломалось, перезагрузите»
 * по ключу errors.renderer; a11y (§16): role="alert", кнопка «Перезагрузить» —
 * нативный button, в tab-порядке. Перезагрузка — восстановление после краша рендера
 * (§13); подпись кнопки — RU-константа, ДОПУСТИМОЕ ИСКЛЮЧЕНИЕ из §17 (UI-хром,
 * каталоги UI-текстов приходят с TASK-013, аналог диалога main §9).
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
        <main>
          <h1>Health Log</h1>
          <p>
            <a href="https://example.org/">Внешняя ссылка — навигация должна блокироваться</a>
          </p>
        </main>
      </ToastProvider>
    </AppErrorBoundary>
  );
}
