/**
 * TASK-081 §4/§5 + TASK-088 §6 + TASK-090: маршрут /ai — экран ИИ с ВКЛАДКАМИ «Разбор»/«Чат»/
 * «Модель» (§6 088: роутер /ai — вкладки; экраны — свои задачи, чат реализует TASK-090). Онбординг-
 * паттерн (UC-07 A3) остаётся: баннер «ИИ не настроен» (НЕ модальный, role=status)
 * над вкладками с ссылкой «Настроить позже».
 *
 * ВКЛАДКИ (§5 РЕШЕНИЕ 088): URL `?tab=` — истина (прецедент period/view), дефолт —
 * «Разбор» (главная ценность ИИ; AC-5.4 ведёт оттуда на «Модель»). Переключатель —
 * кнопки aria-pressed (§10 058: «tablist ИЛИ кнопки aria-pressed»). Дефолт удаляет
 * параметр (адрес чистый, прецедент view=).
 *
 * «ПОЗЖЕ» (§5 081, РЕШЕНИЕ): dismissed навсегда до явного «Настроить» из настроек —
 * prefs.aiSettings.dismissed целиком (модель не теряется). Баннер скрыт и когда ИИ
 * настроен (выбранная модель installed). Пока prefs не загружены — баннера нет.
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { usePreferences } from '../../settings/model/use-preferences';
import { useAiModels } from '../api/use-ai-models';
import { ChatScreen } from './ChatScreen';
import { InsightScreen } from './InsightScreen';
import { ModelsScreen } from './ModelsScreen';

/** Вкладки /ai (§6 088): разбор периода, чат (090), витрина моделей (081). */
const TAB_IDS = ['insight', 'chat', 'model'] as const;

/** Тип вкладки (§6). */
export type AiTab = (typeof TAB_IDS)[number];

const TAB_META: Readonly<Record<AiTab, { readonly labelKey: string; readonly testId: string }>> = {
  insight: { labelKey: 'ai.tabs.insight', testId: 'ai-tab-insight' },
  chat: { labelKey: 'ai.tabs.chat', testId: 'ai-tab-chat' },
  model: { labelKey: 'ai.tabs.model', testId: 'ai-tab-model' },
};

/** Хук вкладки (§6): URL `?tab=` — истина; мусор/отсутствие → дефолт insight (§14). */
function useAiTab(): readonly [AiTab, (tab: AiTab) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab: AiTab = TAB_IDS.find((candidate) => candidate === raw) ?? 'insight';
  const setTab = useCallback(
    (next: AiTab) => {
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          if (next === 'insight') {
            params.delete('tab');
          } else {
            params.set('tab', next);
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return [tab, setTab] as const;
}

/** Экран ИИ (/ai): баннер онбординга + вкладки «Разбор»/«Чат»/«Модель» (§6 088). */
export function AiPage(): JSX.Element {
  const { t } = useTranslation();
  const { prefs, setPreferences } = usePreferences();
  const { data } = useAiModels();
  const [tab, setTab] = useAiTab();

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
      aiSettings: { ...(aiSettings ?? { dismissed: false, includeNotes: false }), dismissed: true },
    });
  };

  return (
    <section className="mx-auto max-w-2xl p-4" aria-labelledby="ai-title">
      <h1 id="ai-title" className="hl-large-title mb-4">
        {t('common.nav.ai')}
      </h1>

      {showBanner ? (
        <div
          data-testid="ai-banner"
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-status-warn/10 px-4 py-3"
        >
          <div className="min-w-0">
            <p data-testid="ai-banner-title" className="text-sm font-semibold text-text">
              {t('ai.banner.title')}
            </p>
            <p className="mt-0.5 text-sm text-muted">{t('ai.banner.body')}</p>
          </div>
          <button
            type="button"
            data-testid="ai-banner-later"
            onClick={handleLater}
            className="min-h-11 shrink-0 rounded-xl bg-fill px-4 text-sm font-semibold text-text hover:bg-accent/10"
          >
            {t('ai.banner.later')}
          </button>
        </div>
      ) : null}

      {/* §6 088: вкладки — кнопки aria-pressed (§10 058: различимы вне цвета). */}
      <div
        data-testid="ai-tabs"
        role="group"
        aria-label={t('ai.tabs.label')}
        className="mb-4 flex flex-wrap gap-2"
      >
        {TAB_IDS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            data-testid={TAB_META[candidate].testId}
            aria-pressed={tab === candidate}
            onClick={() => setTab(candidate)}
            className={`min-h-11 rounded-[10px] px-4 text-sm font-medium ${
              tab === candidate ? 'bg-accent text-bg' : 'bg-fill text-text hover:bg-accent/10'
            }`}
          >
            {t(TAB_META[candidate].labelKey)}
          </button>
        ))}
      </div>

      {tab === 'insight' ? (
        <InsightScreen onGoToModel={() => setTab('model')} />
      ) : tab === 'chat' ? (
        // Чат — TASK-090 (§6 088: вкладка владеет адресом; CTA → вкладка «Модель»).
        <ChatScreen onGoToModel={() => setTab('model')} />
      ) : (
        <ModelsScreen />
      )}
    </section>
  );
}
