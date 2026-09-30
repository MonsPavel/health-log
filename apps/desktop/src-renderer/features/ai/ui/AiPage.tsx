/**
 * TASK-081 §4/§5: маршрут /ai — экран ИИ. Онбординг-паттерн (UC-07 A3): баннер
 * «ИИ не настроен» (НЕ модальный, role=status — фокус не перехватывает) с ссылкой
 * «Настроить позже»; витрина моделей — вкладка «Модель» (ModelsScreen). Чат/резюме
 * — TASK-088/090 (вкладки добавятся туда же).
 *
 * «ПОЗЖЕ» (§5 РЕШЕНИЕ, §20 AC5): dismissed навсегда до явного «Настроить» из
 * настроек — prefs.aiSettings.dismissed целиком (модель не теряется); экран моделей
 * остаётся на /ai всегда — доступен вручную. Баннер скрыт и когда ИИ настроен
 * (выбранная модель installed). Пока prefs не загружены — баннера нет (без вспышки).
 */
import { useTranslation } from 'react-i18next';

import { usePreferences } from '../../settings/model/use-preferences';
import { useAiModels } from '../api/use-ai-models';
import { ModelsScreen } from './ModelsScreen';

/** Экран ИИ (/ai): баннер онбординга + вкладка «Модель» (§4/§5). */
export function AiPage(): JSX.Element {
  const { t } = useTranslation();
  const { prefs, setPreferences } = usePreferences();
  const { data } = useAiModels();

  const aiSettings = prefs?.aiSettings;
  // ИИ настроен: выбранная модель установлена (баннер не нужен, §5).
  const selectedInstalled =
    aiSettings?.modelId !== undefined &&
    (data?.models.some(
      (model) => model.descriptor.id === aiSettings.modelId && model.state === 'installed',
    ) ??
      false);
  const showBanner = prefs !== undefined && aiSettings?.dismissed !== true && !selectedInstalled;

  /** §5 РЕШЕНИЕ: «позже» — навсегда (объект aiSettings целиком, modelId не трогаем). */
  const handleLater = (): void => {
    setPreferences.mutate({
      aiSettings: { ...(aiSettings ?? { dismissed: false }), dismissed: true },
    });
  };

  return (
    <section className="mx-auto max-w-2xl p-4" aria-labelledby="ai-title">
      <h1 id="ai-title" className="mb-4 text-xl font-semibold">
        {t('common.nav.ai')}
      </h1>

      {showBanner ? (
        <div
          data-testid="ai-banner"
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-500/10"
        >
          <div className="min-w-0">
            <p data-testid="ai-banner-title" className="text-sm font-semibold text-text">
              {t('ai.banner.title')}
            </p>
            <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-300">
              {t('ai.banner.body')}
            </p>
          </div>
          <button
            type="button"
            data-testid="ai-banner-later"
            onClick={handleLater}
            className="min-h-11 shrink-0 rounded-md border border-border bg-bg px-4 text-sm font-semibold text-text hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ai.banner.later')}
          </button>
        </div>
      ) : null}

      <ModelsScreen />
    </section>
  );
}
