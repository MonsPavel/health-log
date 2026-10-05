/**
 * TASK-113 §5/§6/§16: секция «Помощь» экрана настроек — точка интеграции
 * руководства пользователя docs/user (§4: «линк из приложения "Помощь" — экран
 * настроек»). Кнопка «Открыть руководство» вызывает канал `app/open-docs` со
 * страницей-оглавлением 'index' (§5); main сам решает — локальный файл
 * (shell.openPath) или страница репозитория (shell.openExternal, §8–12).
 *
 * РАЗМЕЩЕНИЕ (§13): секция видна ВСЕГДА — и в простом режиме: новичку (П1)
 * руководство нужнее всего, прятать его в «Продвинутые» нельзя. Стоит первой
 * секцией экрана — до «Вида» (заметность, §16).
 *
 * ОШИБКИ (§10): отказ конверта — role="alert" текстом каталога (прецедент
 * DiagSection); канал fire-and-forget (§9) — при успехе UI не меняется.
 */
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';

import type { ApiResult, AppOpenDocsResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { IpcApiError } from '../model/use-preferences';

/** Разворот конверта: ok:false — IpcApiError с DTO (§11, прецедент use-diag). */
function unwrap(result: ApiResult<AppOpenDocsResponse>): AppOpenDocsResponse {
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

/** Открыть руководство (§5: канал open-docs, оглавление index). */
async function openDocs(): Promise<AppOpenDocsResponse> {
  return unwrap(await call('app/open-docs', { page: 'index' }));
}

/** Секция «Помощь» (TASK-113 §5/§6). */
export function HelpSection(): JSX.Element {
  const { t } = useTranslation();
  const open = useMutation<AppOpenDocsResponse, Error, void>({ mutationFn: openDocs });

  return (
    <section aria-labelledby="help-title" data-testid="help-section" className="mb-6">
      <h2 id="help-title" className="mb-2 text-base font-medium">
        {t('settings.help.title')}
      </h2>
      <div className="flex flex-col gap-2 rounded-[10px] bg-surface p-3">
        <p className="text-sm text-accent">{t('settings.help.body')}</p>
        <button
          type="button"
          data-testid="help-open"
          disabled={open.isPending}
          aria-busy={open.isPending}
          onClick={() => open.mutate()}
          className="min-h-11 rounded-xl bg-fill px-4 text-base font-semibold text-text disabled:cursor-not-allowed disabled:opacity-90"
        >
          {t('settings.help.open')}
        </button>
        {open.isError ? (
          <p role="alert" data-testid="help-error" className="text-sm text-status-fail">
            {t('settings.help.error')}
          </p>
        ) : null}
      </div>
    </section>
  );
}
