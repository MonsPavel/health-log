/**
 * TASK-068 §5/§10/§12/§13/§16/§17: сборка PDF-отчёта на экране «Отчёты» (UC-05).
 *
 * ФОРМА (§4 РЕШЕНИЕ): предпросмотр = экран настроек с итогами и точным перечнем
 * разделов (чек-лист «Состав отчёта»), НЕ рендер PDF в окне — сам PDF открывается
 * системным просмотрщиком после сохранения (FR-6.7).
 *
 * ПЕРИОД (§5 «переиспользование TASK-046»): семантики lib/period (044/046) —
 * пресеты 7д/30д/90д + произвольный (CustomRangeFields). «Всё» НЕ предлагается:
 * ReportPeriod (067) требует конкретные границы для титула отчёта (от — до),
 * открытый период титул не строит — честнее не предлагать (решение задачи).
 * Границы для канала — готовые utcMs (periodToBounds + закрытие открытых сторон,
 * §11 057: «нет to» → now, «нет from» → 0).
 *
 * ПУСТОЙ ПЕРИОД (§13): кнопка disabled ЗАРАНЬШЕ — по count из stats/period
 * (useStats — тот же канал/кэш, что у дашборда); use case перепроверяет своим
 * count-запросом (§9).
 *
 * ЧЕКБОКС ИИ (§12): в P4 всегда disabled с честной подсказкой «появится вместе
 * с ИИ-разбором» (кэш резюме появится в P5); tooltip про маркировку — §10.
 * В канал уходит includeAiSection: false.
 *
 * СОСТОЯНИЯ (§10): настройки → rendering (спиннер + aria-busy + честная оценка
 * «до 30 секунд», §15/§16) → done (тост: basename текстом, полный путь в title
 * §16 + кнопка «Открыть папку» → app/reveal-path) / error (текст messageKey dto).
 * Отмена диалога — тихо (§7, AC). Тост автоскрывается 6 с (§10-прецедент 065).
 *
 * profileId — seed-профиль MVP (PROFILE_ID, прецедент ExportButtons).
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type ReportPdfResponse } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import {
  IpcApiError,
  PROFILE_ID,
} from '../../measurement/api/use-add-measurement';
import { useStats } from '../../dashboard/api/use-stats';
import { CustomRangeFields } from '../../measurement/ui/CustomRangeFields';
import {
  periodToBounds,
  periodToStatsParam,
  type Period,
  type PeriodState,
} from '../../../lib/period';

/** Автоскрытие тоста, мс (§10 — тот же интервал, что у экспорта 065). */
const NOTICE_MS = 6000;

/** Пресеты периода отчёта (§5): без «всё» — титул требует конкретные границы. */
const PERIOD_OPTIONS = ['7d', '30d', '90d', 'custom'] as const;

/** Ключи подписей пресетов (общие с журналом/дашбордом — один паттерн period). */
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

/** Локальный тост: успех (с путём) или ошибка (текст по messageKey dto); отмена — тихо. */
interface ReportNotice {
  readonly kind: 'success' | 'error';
  readonly path?: string;
  readonly messageKey?: string;
}

/** Basename пути (разделители обеих платформ) — для тоста (§10). */
function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}

/** Вызов канала сборки отчёта: разворот конверта; failure → IpcApiError (§11). */
async function buildReport(period: { fromUtcMs: number; toUtcMs: number }): Promise<ReportPdfResponse> {
  const result = await call('report/pdf', {
    profileId: PROFILE_ID,
    period,
    includeAiSection: false,
  });
  if (!result.ok) {
    throw new IpcApiError(result.error);
  }
  return result.data;
}

const GENERATE_CLASS =
  'inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-base ' +
  'font-medium hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50';

/** Сборка PDF-отчёта (§5): период, чекбокс ИИ, состав, кнопка, тост, открыть папку. */
export function ReportBuilder(): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<PeriodState>({ period: '30d' });
  const [notice, setNotice] = useState<ReportNotice | null>(null);

  // «Сейчас» фиксируется на изменение периода (прецедент useDashboardPeriod §13 044):
  // границы пересчитываются при смене периода, не на каждом рендере.
  const stateKey = `${state.period}\u0000${state.from ?? ''}\u0000${state.to ?? ''}`;
  const nowUtcMs = useMemo(() => Date.now(), [stateKey]);
  // Период канала stats/period (§23: та же схема, что у дашборда) — count для
  // чек-листа и заранее disabled кнопки пустого периода (§13).
  const statsParam = useMemo(() => periodToStatsParam(state, nowUtcMs), [state, nowUtcMs]);
  // Готовые границы отчёта (ReportPeriod 067): открытые стороны закрываются
  // («нет to» → now, «нет from» → 0 — §11 057; «всё» в контроле нет — шапка).
  const period = useMemo(() => {
    const bounds = periodToBounds(state, nowUtcMs);
    return {
      fromUtcMs: bounds.fromUtcMs ?? 0,
      toUtcMs: bounds.toUtcMs ?? nowUtcMs,
    };
  }, [state, nowUtcMs]);

  const stats = useStats(PROFILE_ID, statsParam);
  const count = stats.data?.stats.count;
  const isEmpty = count === 0;

  // §12: useMutation поверх call('report/pdf'); отмена — тихо (§7/AC), отказ —
  // тост текстом messageKey (§10), успех — тост + «Открыть папку» (§5).
  const mutation = useMutation({
    mutationFn: () => buildReport(period),
    onSuccess: (data) => {
      if ('canceled' in data) {
        return;
      }
      setNotice({ kind: 'success', path: data.path });
    },
    onError: (error) => {
      const dto = error instanceof IpcApiError ? error.dto : undefined;
      setNotice({ kind: 'error', messageKey: dto?.messageKey ?? 'errors.REPORT_RENDER_FAILED' });
    },
  });

  // Автоскрытие тоста (§16: регион role=status, прецедент 065).
  useEffect(() => {
    if (notice === null) {
      return undefined;
    }
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const isBusy = mutation.isPending;
  const isDisabled = isBusy || stats.isLoading || count === undefined || isEmpty;

  return (
    <div className="rounded-md border border-border p-3">
      {/* §5: период-контрол — семантики TASK-046 (пресеты + CustomRangeFields). */}
      <fieldset data-testid="report-period" className="mb-4 border-0 p-0">
        <legend className="text-sm text-accent">{t('report.period.label')}</legend>
        <div className="flex flex-wrap gap-2">
          {PERIOD_OPTIONS.map((option) => (
            <label
              key={option}
              className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border border-border px-3 text-base hover:bg-accent/10"
            >
              <input
                type="radio"
                name="report-period"
                data-testid={`report-period-${option}`}
                value={option}
                checked={state.period === option}
                onChange={() =>
                  setState(option === 'custom' ? { ...state, period: 'custom' } : { period: option })
                }
                className="h-5 w-5 accent-[var(--hl-accent)]"
              />
              {t(PERIOD_KEY[option])}
            </label>
          ))}
        </div>
        {state.period === 'custom' && (
          <div className="mt-3">
            <CustomRangeFields
              from={state.from}
              to={state.to}
              onApply={(from, to) => setState({ period: 'custom', ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) })}
            />
          </div>
        )}
      </fieldset>

      {/* §12: чекбокс ИИ — честная заглушка P4 (§17 report.includeAi.*). */}
      <div className="mb-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="report-ai"
            checked={false}
            disabled
            title={t('report.includeAi.tooltip')}
            className="h-5 w-5 accent-[var(--hl-accent)]"
          />
          <span className="text-base">{t('report.includeAi.label')}</span>
        </label>
        <span data-testid="report-ai-hint" className="text-sm text-accent">
          {t('report.includeAi.hint')}
        </span>
      </div>

      {/* §4/§5: карточка «Состав отчёта» — чек-лист разделов + count из stats. */}
      <div data-testid="report-compose" className="mb-4 rounded-md border border-border p-3">
        <h3 className="mb-2 text-base font-semibold">{t('report.compose.title')}</h3>
        <ul className="list-inside list-disc text-base">
          <li>{t('report.compose.table')}</li>
          <li>{t('report.compose.averages')}</li>
          <li>{t('report.compose.chart')}</li>
          <li>{t('report.compose.regularity')}</li>
        </ul>
        {count !== undefined ? (
          <p data-testid="report-compose-count" className="mt-2 text-sm text-accent">
            {t('report.compose.count', { count })}
          </p>
        ) : null}
      </div>

      {/* §13/§16: пустой период — кнопка disabled заранее + подсказка. */}
      {isEmpty ? (
        <p data-testid="report-empty-hint" className="mb-2 text-sm text-accent">
          {t('report.emptyHint')}
        </p>
      ) : null}
      <button
        type="button"
        disabled={isDisabled}
        aria-busy={isBusy}
        onClick={() => void mutation.mutate()}
        className={GENERATE_CLASS}
      >
        {isBusy ? <Spinner /> : null}
        {t('report.generate')}
      </button>

      {/* §16: ожидание — роль status и честная оценка длительности (§15). */}
      {isBusy ? (
        <div role="status" data-testid="report-progress" className="mt-3 text-sm text-accent">
          {t('report.progressNote')}
        </div>
      ) : null}

      {/* §16: итог — роль status; basename — полный текст, путь — title (§10). */}
      {notice !== null && !isBusy ? (
        <div role="status" className="mt-3 text-sm text-accent" data-testid="report-notice">
          {notice.kind === 'success' && notice.path !== undefined ? (
            <>
              <span title={notice.path}>{t('report.done', { basename: basenameOf(notice.path) })}</span>{' '}
              <button
                type="button"
                onClick={() => void call('app/reveal-path', { path: notice.path ?? '' })}
                className="rounded-md border border-border px-3 py-1 text-sm font-medium hover:bg-accent/10"
              >
                {t('report.openFolder')}
              </button>
            </>
          ) : (
            <span>{t(notice.messageKey ?? 'errors.REPORT_RENDER_FAILED')}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Спиннер кнопки (§10: состояние loading); декоративный (§16). */
function Spinner(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

/** Секция PDF-отчёта экрана «Отчёты» (§5/§6): заголовок + сборщик. */
export function ReportScreen(): JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="mb-6" aria-labelledby="report-title">
      <h2 id="report-title" className="mb-3 text-lg font-semibold">
        {t('report.title')}
      </h2>
      <ReportBuilder />
    </section>
  );
}
