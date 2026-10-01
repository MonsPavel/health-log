/**
 * TASK-088 §2/§5/§10/§12/§13: экран «Разбор» (вкладка /ai) — выбор периода
 * (7/30/90/произвольный — общий паттерн period lib/period + CustomRangeFields,
 * URL `?period=` — истина, прецедент дашборда), превью «Что передаётся ИИ» с
 * тумблером заметок (FR-5.5, prefs.aiSettings.includeNotes — событие обновляет
 * preview), генерация: «Объяснить период» → requestId → стрим-текст (авто-скролл,
 * «Стоп») → финал (сохранён — статус-тост / «из кэша» / отказ-стиль), стейлс-бейдж
 * (latest.stale — клик = перегенерация), несъёмный дисклеймер с периодом (AC-5.2),
 * «Повторить», «Очистить разборы» с подтверждением, BUSY-подсказка.
 *
 * МОДЕЛЬ (AC-5.4): не настроена (нет modelId в prefs ИЛИ выбранная не установлена —
 * тот же критерий, что у баннера AiPage) → CTA-карточка на вкладку «Модель» вместо
 * кнопки генерации (превью остаётся — канал работает без модели, modelId участвует
 * только в hash 083). Пока prefs/список не загружены — состояния не показываем
 * (без вспышки CTA, прецедент баннера §5 081).
 *
 * СОСТОЯНИЯ ОТОБРАЖЕНИЯ (§5): идёт генерация или есть финал — текст стрима
 * (отказ — серый, стоп — как есть); иначе сохранённый разбор периода (latest,
 * со стейлс-бейджем); иначе — обучающая подсказка. Дисклеймер у стрима — i18n
 * (стрим ещё не сохранён), у сохранённого — DTO-поля (§17 087: авторитетные).
 *
 * ГОНКИ (§13): смена периода во время генерации → авто-cancel текущей (reset);
 * уход с экрана → cancel (cleanup в use-summary); BUSY — отказ канала → тост.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import * as AlertDialog from '@radix-ui/react-alert-dialog';

import { APP_INTERNAL_ERROR } from '@hl/contracts';
import type { StatsPeriodParam } from '@hl/contracts';

import { useToast } from '../../../app/toast';
import {
  parsePeriodState,
  periodToStatsParam,
  serializePeriodState,
  type Period,
  type PeriodState,
} from '../../../lib/period';
import { PROFILE_ID } from '../../measurement/api/use-add-measurement';
import { CustomRangeFields } from '../../measurement/ui/CustomRangeFields';
import { usePreferences } from '../../settings/model/use-preferences';
import {
  type SummaryFinal,
  SummaryIpcError,
  useContextPreview,
  useDeleteSummaries,
  useLatestSummary,
  useSummaryGeneration,
} from '../api/use-summary';
import { useAiModels } from '../api/use-ai-models';
import { ContextPreview } from './ContextPreview';
import { SummaryView } from './SummaryView';

/** Props экрана (§6): переход на вкладку «Модель» из CTA (AC-5.4). */
export interface InsightScreenProps {
  /** CTA «Модель не настроена» → вкладка «Модель» (владеет AiPage). */
  readonly onGoToModel: () => void;
}

/** Пункты периода экрана (§5: 7/30/90/custom — «всё» не входит в объём §5). */
const PERIOD_OPTIONS = ['7d', '30d', '90d', 'custom'] as const;

/** Ключи подписей периода — общие с журналом/дашбордом (один паттерн period). */
const PERIOD_KEY: Readonly<
  Record<
    Exclude<Period, 'all'>,
    | 'measurement.filters.period.7d'
    | 'measurement.filters.period.30d'
    | 'measurement.filters.period.90d'
    | 'measurement.filters.period.custom'
  >
> = {
  '7d': 'measurement.filters.period.7d',
  '30d': 'measurement.filters.period.30d',
  '90d': 'measurement.filters.period.90d',
  custom: 'measurement.filters.period.custom',
};

/** Публичный API периода экрана (та же семантика, что useDashboardPeriod). */
interface InsightPeriod {
  readonly state: PeriodState;
  readonly param: StatsPeriodParam;
  readonly setPeriod: (period: Period) => void;
  readonly setRange: (from: string | undefined, to: string | undefined) => void;
}

/**
 * Хук периода (§5 «общий паттерн»): URL — истина; применения переписывают URL
 * (replace), посторонние параметры (tab= вкладок) сохраняются — мерж как у
 * useDashboardPeriod (§12 057).
 */
function useInsightPeriod(): InsightPeriod {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  const state = useMemo(() => parsePeriodState(searchParams), [search]);
  const nowUtcMs = useMemo(() => Date.now(), [search]);
  const param = useMemo(() => periodToStatsParam(state, nowUtcMs), [state, nowUtcMs]);

  const apply = useCallback(
    (next: PeriodState) => {
      setSearchParams(
        (previous) => {
          const params = serializePeriodState(next);
          for (const [key, value] of previous.entries()) {
            if (key !== 'period' && key !== 'from' && key !== 'to' && !params.has(key)) {
              params.set(key, value);
            }
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setPeriod = useCallback(
    (period: Period) => {
      if (period === 'custom') {
        apply({ ...state, period: 'custom' });
        return;
      }
      apply({ period });
    },
    [apply, state],
  );
  const setRange = useCallback(
    (from: string | undefined, to: string | undefined) => {
      apply({
        period: 'custom',
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      });
    },
    [apply],
  );

  return { state, param, setPeriod, setRange };
}

/** Экран «Разбор» (§2). */
export function InsightScreen({ onGoToModel }: InsightScreenProps): JSX.Element {
  const { t } = useTranslation();
  const { showToast, showMessage } = useToast();
  const period = useInsightPeriod();
  const { prefs, setPreferences } = usePreferences();
  const { data: modelsData } = useAiModels();
  const generation = useSummaryGeneration();
  const deleteSummaries = useDeleteSummaries();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Стоп-различение (§5): финал без summaryId после «Стоп» — не отказ (частичный
  // текст показывается как есть), отказ — только без остановки пользователем.
  const [stoppedByUser, setStoppedByUser] = useState(false);

  const includeNotes = prefs?.aiSettings.includeNotes ?? false;
  const preview = useContextPreview(PROFILE_ID, period.param, includeNotes);
  const latest = useLatestSummary(PROFILE_ID, period.param);

  // AC-5.4: критерий «настроена» — как у баннера AiPage (§5 081): modelId выбран
  // И эта модель установлена. Пока данных нет — состояние неизвестно (без вспышки).
  const aiSettings = prefs?.aiSettings;
  const modelStateKnown = prefs !== undefined && modelsData !== undefined;
  const modelConfigured =
    aiSettings?.modelId !== undefined &&
    (modelsData?.models.some(
      (model) => model.descriptor.id === aiSettings.modelId && model.state === 'installed',
    ) ??
      false);

  /** Генерация (§5): «Повторить»/стейлс-клик/кнопка — один путь; BUSY — тост dto. */
  const handleGenerate = useCallback((): void => {
    setStoppedByUser(false);
    void generation.start({ period: period.param, includeNotes }).catch((error: unknown) => {
      if (error instanceof SummaryIpcError) {
        showToast(error.dto);
      } else {
        showToast(APP_INTERNAL_ERROR);
      }
    });
  }, [generation, includeNotes, period.param, showToast]);

  /** «Стоп» (§10): виден только во время генерации. */
  const handleStop = useCallback((): void => {
    setStoppedByUser(true);
    generation.stop();
  }, [generation]);

  // §13: смена периода во время генерации → авто-cancel текущей (решение спеки).
  const paramRef = useRef(period.param);
  useEffect(() => {
    if (paramRef.current !== period.param) {
      paramRef.current = period.param;
      generation.reset();
    }
  }, [period.param, generation]);

  const streaming = generation.phase === 'streaming';
  const final = generation.final;
  const showStream = streaming || final !== undefined;
  const refusal =
    final !== undefined && final.summaryId === undefined && !final.cached && !stoppedByUser;

  /** Подпись текущего периода (те же ключи, что у сегмента — §17; «всё» вне §5). */
  const periodLabel =
    period.state.period === 'all'
      ? t('measurement.filters.period.all')
      : t(PERIOD_KEY[period.state.period]);

  // §5 cache-hit: use case НЕ стримит текст из кэша (движок не трогается, решение
  // 087) — после cache-hit-финала показываем сохранённый текст из latest (финал
  // инвалидирует latest, §12; до refetch — пустой стрим-текст на миг).
  const cachedSummary = final?.cached === true ? latest.data?.summary : undefined;
  const displayedText = cachedSummary !== undefined ? cachedSummary.contentMd : generation.text;
  const displayedDisclaimer =
    cachedSummary !== undefined ? cachedSummary.disclaimerText : t('ai.insight.disclaimer');
  const displayedPeriodText = cachedSummary !== undefined ? cachedSummary.periodText : periodLabel;

  const handleNotesToggle = (next: boolean): void => {
    // prefs.aiSettings — объект ЦЕЛИКОМ (семантика патча контракта, §5 047).
    setPreferences.mutate({
      aiSettings: {
        ...(aiSettings ?? { dismissed: false, includeNotes: false }),
        includeNotes: next,
      },
    });
  };

  const handleDelete = (): void => {
    setConfirmOpen(false);
    deleteSummaries.mutate(undefined, {
      onError: (error: unknown) => {
        if (error instanceof SummaryIpcError) {
          showToast(error.dto);
        } else {
          showToast(APP_INTERNAL_ERROR);
        }
      },
    });
  };

  // §5 «финал: сохранён (тост)»: свежесохранённый разбор (summaryId, не из кэша) —
  // статус-тост в общем регионе; ОДИН раз на финал (identity-сравнение объекта).
  const savedToastShownRef = useRef<SummaryFinal | undefined>(undefined);
  useEffect(() => {
    const outcome = generation.final;
    if (
      outcome !== undefined &&
      outcome.summaryId !== undefined &&
      !outcome.cached &&
      savedToastShownRef.current !== outcome
    ) {
      savedToastShownRef.current = outcome;
      showMessage(t('ai.insight.saved'));
    }
  }, [generation.final, showMessage, t]);

  return (
    <section data-testid="insight-screen" aria-labelledby="insight-title">
      <h2 id="insight-title" className="mb-3 text-xl font-semibold">
        {t('ai.insight.title')}
      </h2>

      {/* §5: период-контрол 7/30/90/custom — сегмент на нативных radio
          (прецедент PeriodSwitcher 057). */}
      <fieldset data-testid="insight-period" className="mb-4 border-0 p-0">
        <legend className="text-sm text-accent">{t('measurement.filters.periodLabel')}</legend>
        <div className="flex flex-wrap gap-2">
          {PERIOD_OPTIONS.map((option) => (
            <label
              key={option}
              className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border border-border px-3 text-base hover:bg-accent/10"
            >
              <input
                type="radio"
                name="insight-period"
                data-testid={`insight-period-${option}`}
                value={option}
                checked={period.state.period === option}
                onChange={() => period.setPeriod(option)}
                className="h-5 w-5 accent-[var(--hl-accent)]"
              />
              {t(PERIOD_KEY[option])}
            </label>
          ))}
        </div>
        {period.state.period === 'custom' && (
          <div className="mt-3">
            <CustomRangeFields
              from={period.state.from}
              to={period.state.to}
              onApply={period.setRange}
            />
          </div>
        )}
      </fieldset>

      {/* §5: блок «Что передаётся ИИ» — точный текст проекции + тумблер заметок. */}
      <section
        data-testid="insight-preview-section"
        className="mb-4"
        aria-labelledby="insight-preview-title"
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 id="insight-preview-title" className="text-base font-semibold">
            {t('ai.insight.preview.title')}
          </h3>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              data-testid="insight-notes-toggle"
              checked={includeNotes}
              onChange={(event) => handleNotesToggle(event.target.checked)}
              className="h-4 w-4"
            />
            {t('ai.insight.preview.includeNotes')}
          </label>
        </div>
        {preview.isPending ? (
          <p role="status" className="text-sm text-accent">
            {t('ai.insight.preview.loading')}
          </p>
        ) : preview.isError ? (
          <p
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-text dark:border-red-500/40 dark:bg-red-500/10"
          >
            {t('ai.insight.preview.loadError')}
          </p>
        ) : preview.data !== undefined ? (
          <ContextPreview text={preview.data.text} />
        ) : null}
      </section>

      {/* AC-5.4: модель не настроена → CTA-карточка вместо кнопки генерации. */}
      {modelStateKnown && !modelConfigured ? (
        <div
          data-testid="insight-model-cta"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-neutral-50 px-4 py-3 dark:bg-neutral-900"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text">{t('ai.insight.modelCta.title')}</p>
            <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-300">
              {t('ai.insight.modelCta.body')}
            </p>
          </div>
          <button
            type="button"
            data-testid="insight-model-cta-go"
            onClick={onGoToModel}
            className="min-h-11 shrink-0 rounded-md bg-accent px-4 text-sm font-semibold text-bg"
          >
            {t('ai.insight.modelCta.go')}
          </button>
        </div>
      ) : null}

      {modelConfigured ? (
        <div className="mb-4">
          {streaming ? (
            <button
              type="button"
              data-testid="insight-stop"
              onClick={handleStop}
              className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {t('ai.insight.stop')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="insight-generate"
              onClick={handleGenerate}
              className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg"
            >
              {t('ai.insight.generate')}
            </button>
          )}
        </div>
      ) : null}

      {/* §5: прерванная генерация — блок ошибки с «Повторить» (WORKER_CRASHED-стиль). */}
      {generation.interrupted && !showStream ? (
        <div
          data-testid="insight-error"
          role="alert"
          className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 dark:border-red-500/40 dark:bg-red-500/10"
        >
          <p className="text-sm font-medium text-text">{t('ai.insight.errorInterrupted')}</p>
          <button
            type="button"
            data-testid="insight-retry"
            onClick={handleGenerate}
            className="mt-2 min-h-11 rounded-md border border-border bg-bg px-4 text-sm font-semibold text-text"
          >
            {t('ai.insight.retry')}
          </button>
        </div>
      ) : null}

      {/* §5: текст — стрим/финал; иначе сохранённый разбор; иначе подсказка.
          Дисклеймер внутри SummaryView несъёмный (AC-5.2). */}
      {showStream ? (
        <SummaryView
          text={displayedText}
          streaming={streaming}
          cached={final?.cached === true}
          refusal={refusal}
          disclaimerText={displayedDisclaimer}
          periodText={displayedPeriodText}
          onStaleClick={handleGenerate}
        />
      ) : latest.data?.summary !== undefined ? (
        <SummaryView
          text={latest.data.summary.contentMd}
          stale={latest.data.stale}
          disclaimerText={latest.data.summary.disclaimerText}
          periodText={latest.data.summary.periodText}
          onStaleClick={handleGenerate}
        />
      ) : !latest.isPending ? (
        <p data-testid="insight-empty" className="text-sm text-neutral-600 dark:text-neutral-300">
          {t('ai.insight.empty')}
        </p>
      ) : null}

      {/* §5: «Очистить разборы» — видимая, с подтверждением (Radix AlertDialog,
          прецедент WipeFlow 073). */}
      <div className="mt-6 border-t border-border pt-4">
        <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialog.Trigger asChild>
            <button
              type="button"
              data-testid="insight-clear"
              className="min-h-11 rounded-md border border-border bg-bg px-4 text-sm font-semibold text-text hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {t('ai.insight.clear.button')}
            </button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
            <AlertDialog.Content
              data-testid="insight-clear-dialog"
              className="fixed left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg p-6 shadow-lg"
            >
              <AlertDialog.Title
                data-testid="insight-clear-title"
                className="text-lg font-semibold text-text"
              >
                {t('ai.insight.clear.title')}
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-2 text-sm text-text">
                {t('ai.insight.clear.body')}
              </AlertDialog.Description>
              <div className="mt-4 flex flex-wrap justify-end gap-3">
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    data-testid="insight-clear-cancel"
                    className="min-h-11 rounded-md border border-border bg-bg px-6 text-base font-semibold text-text"
                  >
                    {t('ai.insight.clear.cancel')}
                  </button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  data-testid="insight-clear-confirm"
                  disabled={deleteSummaries.isPending}
                  onClick={handleDelete}
                  className="min-h-11 rounded-md bg-accent px-6 text-base font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('ai.insight.clear.confirm')}
                </button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </div>

      {/* Статус-тост «сохранён» (§5): финал с summaryId свежей генерации — тот же
          регион тостов, что и ошибки (useToast.showMessage, §10 каркаса). */}
    </section>
  );
}
