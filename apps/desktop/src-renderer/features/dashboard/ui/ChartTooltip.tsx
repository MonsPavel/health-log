/**
 * TASK-057 §5/§13/§16/§17: содержимое тултипа графика (custom content Recharts
 * Tooltip — ADR-0003 §2). Показывает: дата-время (Intl, НАСТЕННОЕ время записи с
 * ЕЁ собственным offset — EC-06, прецедент lib/i18n-date), значения sys/dia,
 * пульс (строки нет — «не измерен», §7), часть суток («other» — «другое время»,
 * §13), кнопку «Изменить» → onEditPoint (переход к правке TASK-038 edit-режим;
 * у точки без id кнопки нет — править нечего; daily-режим правки не имеет
 * вообще — агрегат, §12). daily: день Intl-датой + среднее/диапазон обоих
 * каналов + число измерений (числа — Intl.NumberFormat ru, §17).
 *
 * Recharts клонирует content-элемент со своими active/label/payload — компонент
 * работает и стоя (тесты, §19), и как content внутри Tooltip.
 */
import { useTranslation } from 'react-i18next';

import type { DayPoint, RawPoint } from '@hl/contracts';

import { formatDateTime, type InstantLike } from '../../../lib/i18n-date';

/** Элемент payload тултипа Recharts (форма проверена пробником Recharts 3.10). */
export interface TooltipPayloadEntry {
  readonly dataKey?: unknown;
  readonly value?: unknown;
  readonly color?: string;
  readonly payload?: unknown;
}

/** Свойства ChartTooltip: системные от Recharts + mode/onEditPoint от графика. */
export interface ChartTooltipProps {
  readonly active?: boolean;
  readonly label?: string | number;
  readonly payload?: readonly TooltipPayloadEntry[];
  /** Ветвь данных: сырые точки или дневные агрегаты (§5 056). */
  readonly mode: 'raw' | 'daily';
  /** Клик по кнопке/точке — переход к правке записи (TASK-038; daily — нет кнопки). */
  readonly onEditPoint?: (point: RawPoint) => void;
}

/** Ключи подписей части суток — литералы в карте (§22, §13: 'other' — «другое время»). */
const PART_KEY: Readonly<
  Record<RawPoint['part'], 'dashboard.tooltip.partMorning' | 'dashboard.tooltip.partEvening' | 'dashboard.tooltip.partOther'>
> = {
  morning: 'dashboard.tooltip.partMorning',
  evening: 'dashboard.tooltip.partEvening',
  other: 'dashboard.tooltip.partOther',
};

/** Число в ru-формате (§17 Intl; максимум 1 знак — правило отображения 052). */
function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
}

/** Настенная дата 'YYYY-MM-DD' → Intl-дата (тилтип daily; wallDate валиден контрактом). */
function formatWallDate(wallDate: string): string {
  const [y, mo, d] = wallDate.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(
    Date.UTC(y, mo - 1, d),
  );
}

/** Диапазон дня «min–max» (§5: коридор min-max честно показывает разброс). */
function formatRange(min: number, max: number): string {
  return `${formatNumber(min)}–${formatNumber(max)}`;
}

export function ChartTooltip({
  active,
  payload,
  mode,
  onEditPoint,
}: ChartTooltipProps): JSX.Element | null {
  const { t } = useTranslation();
  if (active !== true || payload === undefined || payload.length === 0) {
    return null;
  }

  if (mode === 'daily') {
    // Daily: payload первого элемента — DayPoint (правки нет — агрегат, §12).
    const day = payload[0]?.payload as DayPoint | undefined;
    if (day === undefined) {
      return null;
    }
    return (
      <div
        data-testid="chart-tooltip"
        className="rounded-md border border-border bg-bg p-2 text-sm shadow-sm"
      >
        <p className="font-medium">{formatWallDate(day.wallDate)}</p>
        <p>
          {t('dashboard.tooltip.sys')}:{' '}
          <span className="font-medium">{formatNumber(day.sysAvg)}</span>,{' '}
          {t('dashboard.tooltip.range')}: <span className="font-medium">{formatRange(day.sysMin, day.sysMax)}</span>
        </p>
        <p>
          {t('dashboard.tooltip.dia')}:{' '}
          <span className="font-medium">{formatNumber(day.diaAvg)}</span>,{' '}
          {t('dashboard.tooltip.range')}: <span className="font-medium">{formatRange(day.diaMin, day.diaMax)}</span>
        </p>
        <p className="text-neutral-500">
          {t('dashboard.tooltip.measurements', { count: day.count })}
        </p>
      </div>
    );
  }

  // Raw: обе серии кладут одну и ту же строку данных — берём первую с payload.
  const point = payload.find((entry) => entry.payload !== undefined)?.payload as
    | RawPoint
    | undefined;
  if (point === undefined) {
    return null;
  }
  const instant: InstantLike = { utcMs: point.utcMs, tzOffsetMin: point.tzOffsetMin };
  return (
    <div
      data-testid="chart-tooltip"
      className="rounded-md border border-border bg-bg p-2 text-sm shadow-sm"
    >
      <p className="font-medium">{formatDateTime(instant, { preset: 'datetime' })}</p>
      <p>
        {t('dashboard.tooltip.sys')}: <span className="font-medium">{formatNumber(point.sys)}</span>
      </p>
      <p>
        {t('dashboard.tooltip.dia')}: <span className="font-medium">{formatNumber(point.dia)}</span>
      </p>
      {point.pulse !== undefined && (
        <p>
          {t('dashboard.tooltip.pulse')}:{' '}
          <span className="font-medium">{formatNumber(point.pulse)}</span>
        </p>
      )}
      <p className="text-neutral-500">{t(PART_KEY[point.part])}</p>
      {point.id !== undefined && onEditPoint !== undefined && (
        <button
          type="button"
          data-testid="chart-tooltip-edit"
          onClick={() => onEditPoint(point)}
          className="mt-1 min-h-11 rounded-md border border-border px-3 py-1 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          {t('dashboard.tooltip.edit')}
        </button>
      )}
    </div>
  );
}
