/**
 * TASK-059 §2/§5/§13/§16: текстовое резюме тренда под графиком — ИЗ stats-ответа
 * (stats/period TASK-054), не из пересчёта по точкам (§5: «переиспользование
 * данных, не дублирование вычислений»; §13: резюме-числа == числа таблицы ==
 * числа графика — одни read models, тест-сверка на фикстуре).
 *
 * ФОРМА (§20 AC3): «Среднее СДА за {{period}}: {{avg}} (диапазон {{min}}–{{max}})»
 * — и та же строка для ДДА; «Измерений: {{count}}». Дробные — ru-формат Intl
 * (максимум 1 знак — правило отображения 052, formatNumberRu — единая копия,
 * aria-метка графика строит свои params тем же форматтером).
 *
 * ДОСТУПНОСТЬ (§16): role="note" СТАТИЧНО (решение спеки против aria-live —
 * смена периода перерисовывает резюме, но озвучивать его автоматически не нужно:
 * пользователь сам перечитывает регион). Канал без агрегатов (пустой период,
 * нет записей канала) — строка не рендерится, count остаётся (честность §13).
 */
import { useTranslation } from 'react-i18next';

import type { PeriodStatisticsDto, StatsValueStats } from '@hl/contracts';

/** Число в ru-формате (§17 Intl; максимум 1 знак — правило отображения 052). */
export function formatNumberRu(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
}

/** Свойства резюме (§5): stats-ответ того же периода, что у графика/таблицы. */
export interface TrendSummaryProps {
  readonly stats: PeriodStatisticsDto;
  /** Подпись периода («30 дней» — формирует экран, те же подписи, что у сегмента). */
  readonly periodLabel: string;
}

/** Агрегаты канала определены — есть и среднее, и диапазон (read model 052: цельно). */
function hasRange(value: StatsValueStats): boolean {
  return value.avg !== undefined && value.min !== undefined && value.max !== undefined;
}

/** Строка канала «Среднее СДА за {{period}}: {{avg}} (диапазон {{min}}–{{max}})». */
function ChannelLine({
  periodLabel,
  lineKey,
  value,
}: {
  readonly periodLabel: string;
  readonly lineKey: 'dashboard.summary.sys' | 'dashboard.summary.dia';
  readonly value: StatsValueStats;
}): JSX.Element | null {
  const { t } = useTranslation();
  if (!hasRange(value)) {
    return null;
  }
  return (
    <p
      data-testid={lineKey === 'dashboard.summary.sys' ? 'trend-summary-sys' : 'trend-summary-dia'}
    >
      {t(lineKey, {
        period: periodLabel,
        avg: formatNumberRu(value.avg as number),
        min: formatNumberRu(value.min as number),
        max: formatNumberRu(value.max as number),
      })}
    </p>
  );
}

/** Резюме тренда под графиком (§2/§5): числа — только из stats-ответа. */
export function TrendSummary({ stats, periodLabel }: TrendSummaryProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div data-testid="trend-summary" role="note" className="mt-2 flex flex-col gap-1 text-sm">
      <ChannelLine periodLabel={periodLabel} lineKey="dashboard.summary.sys" value={stats.sys} />
      <ChannelLine periodLabel={periodLabel} lineKey="dashboard.summary.dia" value={stats.dia} />
      <p data-testid="trend-summary-count">
        {t('dashboard.summary.count', { count: stats.count })}
      </p>
    </div>
  );
}
