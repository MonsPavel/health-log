/**
 * TASK-081 §2/§5/§10/§13: экран «Модель» (вкладка /ai) — витрина моделей из
 * манифеста одним вызовом list (§7), карточки по машине состояний 080, запрос
 * согласия ДО первой загрузки (§14: UI-перехват раньше gateway-блока), выбор
 * активной модели (§9: prefs — ensureModel лениво 087).
 *
 * СОГЛАСИЕ (§13): первый «Скачать» при prefs.netConsents.modelsDownload=false →
 * ConsentDialog; подтверждение — prefs/set согласия ЦЕЛИКОМ (await — запись в main
 * ДО старта загрузки: gateway на первый HEAD уже видит согласие, гонки нет),
 * затем download; отказ — сети не было. Повторные «Скачать» идут сразу (§13).
 *
 * ОШИБКИ (§13): отказ list (битый манифест 079) — состояние ошибки экрана (не краш);
 * отказ мутаций — карточку обновит следующий list (error-состояние store), UI не
 * дублирует тексты (§18).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ModelDescriptor } from '@hl/contracts';

import { usePreferences } from '../../settings/model/use-preferences';
import { useAiModels } from '../api/use-ai-models';
import { ConsentDialog } from './ConsentDialog';
import { ModelCard } from './ModelCard';

/** Экран «Модель» (§5). */
export function ModelsScreen(): JSX.Element {
  const { t } = useTranslation();
  const { prefs, setPreferences } = usePreferences();
  const { data, isLoading, isError, download, pause, resume, reset, select } = useAiModels();
  const [consentTarget, setConsentTarget] = useState<ModelDescriptor | null>(null);

  const selectedId = prefs?.aiSettings.modelId;
  const consentGiven = prefs?.netConsents.modelsDownload === true;

  /** §14: согласие уже дано — сразу грузим; иначе — диалог до первого запроса. */
  const handleDownload = (descriptor: ModelDescriptor): void => {
    if (consentGiven) {
      download.mutate(descriptor.id);
      return;
    }
    setConsentTarget(descriptor);
  };

  /** §13: подтверждение — согласие целиком в prefs (await: запись до сети), затем download. */
  const handleConsentConfirm = async (): Promise<void> => {
    if (consentTarget === null) {
      return;
    }
    const target = consentTarget;
    setConsentTarget(null);
    await setPreferences.mutateAsync({
      netConsents: {
        updatesCheck: prefs?.netConsents.updatesCheck ?? false,
        modelsDownload: true,
      },
    });
    download.mutate(target.id);
  };

  const busy =
    download.isPending || pause.isPending || resume.isPending || reset.isPending || select.isPending;

  return (
    <section data-testid="ai-models-section" aria-labelledby="ai-models-title" className="mt-4">
      <h2 id="ai-models-title" className="mb-3 text-xl font-semibold">
        {t('ai.models.title')}
      </h2>

      {isLoading ? (
        <p role="status" className="text-accent">
          {t('ai.models.loading')}
        </p>
      ) : null}
      {isError ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-text dark:border-red-500/40 dark:bg-red-500/10">
          {t('ai.models.loadError')}
        </p>
      ) : null}

      {data?.models.map((view) => (
        <ModelCard
          key={view.descriptor.id}
          view={view}
          ramTotalGb={data.ramTotalGb}
          uiLanguage={data.uiLanguage}
          selected={view.descriptor.id === selectedId}
          busy={busy}
          onDownload={() => handleDownload(view.descriptor)}
          onPause={() => pause.mutate(view.descriptor.id)}
          onResume={() => resume.mutate(view.descriptor.id)}
          onReset={() => reset.mutate(view.descriptor.id)}
          onSelect={() => select.mutate(view.descriptor.id)}
        />
      ))}

      <ConsentDialog
        target={consentTarget}
        onConfirm={() => void handleConsentConfirm()}
        onClose={() => setConsentTarget(null)}
      />
    </section>
  );
}
