/**
 * TASK-099 §2/§5/§4/§14/§16: секция «Приватность» экрана настроек (US-33, витрина
 * BG-2 — проверяемая честность: журнал совпадает с наблюдаемым трафиком).
 * Состав (§5): обещание-шапка (golden-строка), список операций политики с
 * переключателями согласий (OperationsList), живая лента сетевых активностей
 * (ActivityFeed), ссылка-пояснение «Как проверить самостоятельно?» — раскрывающийся
 * блок с инструкцией мониторинга соединений ОС (честность-паттерн, §14).
 *
 * СОСТОЯНИЕ (§12): useQuery-хуки 098 — usePrivacyJournal (живая лента: событие
 * net:activity → инвалидация → refetch) и usePrivacyConsents (optimistic-мутация
 * с откатом). БЛОКИРОВКА (§13): подписка на состояние ModelStore — useAiModels
 * (кэш обновляется событием ai:progress): активная загрузка модели блокирует
 * отключение modelsDownload до конца загрузки.
 *
 * ДАННЫЕ (§5): ops/entries приходят из канала privacy/journal (ops == политике —
 * инвариант main-тестов 098); до загрузки — пустые списки (не скелетоны: секция
 * статична, значения приходят за один IPC-вызов). Лента ≤50 записей (§15).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAiModels } from '../../ai/api/use-ai-models';
import { usePrivacyConsents, usePrivacyJournal } from '../api/use-privacy';
import { ActivityFeed } from './ActivityFeed';
import { OperationsList } from './OperationsList';

/** Секция «Приватность» (§5): обещание, операции, живая лента, самопроверка. */
export function PrivacyScreen(): JSX.Element {
  const { t } = useTranslation();
  const { data: journal } = usePrivacyJournal();
  const { consents, setConsents } = usePrivacyConsents();
  // §13: подписка на состояние загрузок ModelStore (ai:progress → кэш — живая).
  const { data: models } = useAiModels();
  const downloadInProgress = (models?.models ?? []).some((model) => model.state === 'downloading');
  const [selfCheckOpen, setSelfCheckOpen] = useState(false);

  return (
    <section aria-labelledby="privacy-title" data-testid="privacy-section" className="mt-6">
      <h2 id="privacy-title" className="mb-2 text-base font-medium">
        {t('privacy.title')}
      </h2>
      {/* §5: обещание-шапка (golden-строка) — честность формулируется до деталей. */}
      <p
        data-testid="privacy-promise"
        role="note"
        className="rounded-[10px] bg-surface p-3 text-sm text-text"
      >
        {t('privacy.promise')}
      </p>

      <OperationsList
        ops={journal?.ops ?? []}
        consents={consents}
        downloadInProgress={downloadInProgress}
        onToggle={(patch) => setConsents.mutate(patch)}
      />

      {/* §16: live-область ленты — новая запись (включая empty→строка) озвучивается. */}
      <div aria-live="polite">
        <ActivityFeed entries={journal?.entries ?? []} />
      </div>

      <div className="mt-6">
        {/* §14: инструкция самопроверки — не скрытый уговор: конкретные шаги Windows. */}
        <button
          type="button"
          data-testid="privacy-selfcheck-toggle"
          aria-expanded={selfCheckOpen}
          aria-controls="privacy-selfcheck-body"
          onClick={() => setSelfCheckOpen((open) => !open)}
          className="min-h-11 rounded-xl bg-fill px-4 text-base font-semibold text-text"
        >
          {t('privacy.selfCheck.title')}
        </button>
        {/* §16: раскрытие — условный рендер: блок появляется в DOM целиком. */}
        {selfCheckOpen ? (
          <div
            id="privacy-selfcheck-body"
            data-testid="privacy-selfcheck-body"
            className="mt-2 rounded-[10px] bg-surface p-3 text-sm text-text"
          >
            <p className="font-medium">{t('privacy.selfCheck.intro')}</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>{t('privacy.selfCheck.step1')}</li>
              <li>{t('privacy.selfCheck.step2')}</li>
              <li>{t('privacy.selfCheck.step3')}</li>
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}
