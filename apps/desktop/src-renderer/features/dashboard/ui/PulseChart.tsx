/**
 * TASK-058 §2/§5/§10/§13/§16/§19: график ЧСС вкладки «Пульс» — тот же канал
 * trend/series (056): пульс уже в точках, никакого нового запроса (§15); единицы
 * мм рт. ст. на этом графике НЕ показываются (§3: смешивать нельзя).
 *
 * RAW (§5): линия точек pulse — записи без пульса пропускаются (Recharts не
 * рисует точку без значения; согласовано со статистикой 052 — она считает только
 * записи с пульсом, §13); irregular-запись (EC-10) — маркер-кольцо вокруг точки
 * (ФОРМА, не только цвет — §16) + пояс в тултипе («неровный пульс — значение
 * может быть неточным», ChartTooltip channel='pulse'). DAILY (§5): среднее
 * пульса дня (pulseAvg 058) — правки нет (агрегат, §12).
 *
 * ОПОРНЫЙ КОРИДОР 60–100 (§5): полупрозрачная полоса между линиями PULSE_REF_LOW/
 * HIGH из КОНСТАНТ КОНТРАКТА (@hl/contracts — одна копия, тест импорта) —
 * СПРАВКА, НЕ КЛАССИФИКАЦИЯ: подпись pulse.refNote под графиком (вне svg и вне
 * aria-hidden — ревью-прецедент 057: HTML внутри svg в Chromium не рендерится).
 *
 * ОСЬ Y (§10): pulseYDomainOf — коридор 60–100 всегда в домене, вокруг данных
 * padding ±10 уд/мин; авто-масштаб не «прячет» справку. Ось подписана «уд/мин».
 *
 * ЧЕСТНОСТЬ (§13): расхождение «записей больше, чем показанных точек» — подпись
 * pulse.hiddenCount (plural, Intl.PluralRules — прецедент foundN TASK-045):
 * raw — записи с pulse undefined; daily — Σcount − ΣpulseCount (058).
 *
 * ПЕРЕХОД К ПРАВКЕ (§5: «как давление»): клик точки/строки мини-таблицы →
 * onEditPoint (экран делает startEdit+navigate, §12 057); daily-режим правки не
 * имеет. a11y (§16): figure role="img" с резюме ИЗ ЗАГРУЖЕННЫХ ДАННЫХ (прецедент
 * TrendChart 057: stats/period экран не потребляет), SVG внутри aria-hidden,
 * клавиатурный доступ — мини-таблица строк-кнопок (только показанные точки).
 *
 * Размеры — явные width/height (дефолт 800×360; ResponsiveContainer в jsdom не
 * измеряется — прецедент TrendChart); анимации отключены (ADR-0003 §2).
 */
import { useTranslation } from 'react-i18next';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { PULSE_REF_HIGH, PULSE_REF_LOW, type RawPoint, type TrendResponse } from '@hl/contracts';

import { formatDateTime, type InstantLike } from '../../../lib/i18n-date';
import { ChartTooltip } from './ChartTooltip';
import { dayTickOf, rawTickOf } from './TrendChart';

/** Цвет серии из токенов темы (§5: цвета из токенов; одна серия — accent). */
const PULSE_STROKE = 'var(--hl-accent)';

/** Цвет опорного коридора-справки (токен границы — не пересекается с серией). */
const REF_STROKE = 'var(--hl-border)';

/** Padding оси Y вокруг данных, уд/мин (коридор 60–100 всегда в домене). */
const PULSE_PADDING = 10;

/** Дефолтные размеры SVG (прецедент TrendChart: детерминизм тестов). */
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 360;

/** Радиус маркера точки и зазор кольца irregular-маркера, px. */
const MARKER_SIZE = 4;
const IRREGULAR_RING_GAP = 3;

/**
 * Правило оси Y пульс-графика (§10): коридор 60–100 — всегда в домене; данные —
 * с запасом ±10 уд/мин. Чистая функция (тест импорта констант: хардкод 60/100
 * в компоненте ломает сравнение с PULSE_REF_LOW/HIGH из контракта).
 */
export function pulseYDomainOf(values: readonly number[]): [number, number] {
  if (values.length === 0) {
    return [PULSE_REF_LOW - PULSE_PADDING, PULSE_REF_HIGH + PULSE_PADDING];
  }
  return [
    Math.min(PULSE_REF_LOW, Math.min(...values) - PULSE_PADDING),
    Math.max(PULSE_REF_HIGH, Math.max(...values) + PULSE_PADDING),
  ];
}

/**
 * Число записей без пульса, скрытых графиком (§13): raw — точки с pulse
 * undefined; daily — Σcount − ΣpulseCount (пульс-агрегаты дня 058; день без
 * pulseCount — все его записи скрыты).
 */
export function hiddenPulseCountOf(response: TrendResponse): number {
  if (response.mode === 'daily') {
    const days = response.days ?? [];
    const total = days.reduce((sum, day) => sum + day.count, 0);
    const withPulse = days.reduce((sum, day) => sum + (day.pulseCount ?? 0), 0);
    return total - withPulse;
  }
  return (response.points ?? []).filter((point) => point.pulse === undefined).length;
}

/** Число в ru-формате (§17 Intl; максимум 1 знак — правило отображения 052). */
function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
}

/** Клавиши-литералы i18n (§22: динамических ключей нет — check-i18n видит ключ). */
type PulsePointLabelKey = 'dashboard.pulse.pointLabel' | 'dashboard.pulse.pointLabelIrregular';

/** Ключи скрытых записей — LDML-суффиксы каталога (§17; прецедент foundN TASK-045). */
type HiddenCountKey =
  | 'dashboard.pulse.hiddenCount_one'
  | 'dashboard.pulse.hiddenCount_few'
  | 'dashboard.pulse.hiddenCount_many'
  | 'dashboard.pulse.hiddenCount_other';

/** Категория plural → полный литерал ключа (§22: карта литералов, не подстановка). */
const HIDDEN_KEY: Readonly<Record<'one' | 'few' | 'many' | 'other', HiddenCountKey>> = {
  one: 'dashboard.pulse.hiddenCount_one',
  few: 'dashboard.pulse.hiddenCount_few',
  many: 'dashboard.pulse.hiddenCount_many',
  other: 'dashboard.pulse.hiddenCount_other',
};

/** Ключ подписи скрытых по числу (§17): Intl.PluralRules('ru') + карта литералов. */
function hiddenKeyFor(count: number): HiddenCountKey {
  switch (new Intl.PluralRules('ru').select(count)) {
    case 'one':
      return HIDDEN_KEY.one;
    case 'few':
      return HIDDEN_KEY.few;
    case 'many':
      return HIDDEN_KEY.many;
    default:
      return HIDDEN_KEY.other;
  }
}

/** Среднее и границы выборки для aria-резюме (§16; 1 знак — правило отображения 052). */
function summaryOf(values: readonly number[]): { avg: number; min: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { avg: Math.round(avg * 10) / 10, min, max };
}

/** Свойства PulseChart (§5): ответ trend/series + подпись периода + колбэк правки. */
export interface PulseChartProps {
  readonly response: TrendResponse;
  /** Подпись периода для aria-резюме («30 дней» — формирует экран, как в 057). */
  readonly periodLabel: string;
  /** Клик по точке/строке мини-таблицы → переход к правке записи (§5: как на давлении). */
  readonly onEditPoint?: (point: RawPoint) => void;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Маркер точки ЧСС (§5/§16): круг; irregular-запись (EC-10) — кольцо вокруг
 * (ФОРМА, различима не только цветом). Recharts клонирует элемент, добавляя
 * cx/cy/payload; onClick — переход к правке (§12 057: activeDot.onClick).
 */
function PulseDot(props: {
  readonly cx?: number;
  readonly cy?: number;
  readonly payload?: unknown;
  readonly onEditPoint?: (point: RawPoint) => void;
}): JSX.Element | null {
  const { cx, cy, payload, onEditPoint } = props;
  if (cx === undefined || cy === undefined || payload === undefined) {
    return null;
  }
  const point = payload as RawPoint;
  const handleClick = (event: { stopPropagation(): void }): void => {
    event.stopPropagation();
    onEditPoint?.(point);
  };
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={MARKER_SIZE}
        fill={PULSE_STROKE}
        stroke="none"
        data-testid="pulse-dot"
        onClick={handleClick}
      />
      {point.irregular === true && (
        <circle
          cx={cx}
          cy={cy}
          r={MARKER_SIZE + IRREGULAR_RING_GAP}
          fill="none"
          stroke={PULSE_STROKE}
          strokeWidth={2}
          strokeDasharray="2 2"
          data-testid="pulse-dot-irregular"
        />
      )}
    </g>
  );
}

/** Итоговое содержимое легенды: raw — серия+irregular, daily — среднее за день (§16). */
function Legend({ mode }: { readonly mode: 'raw' | 'daily' }): JSX.Element {
  const { t } = useTranslation();
  return (
    <ul
      data-testid="pulse-legend"
      className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-accent"
    >
      <li className="flex items-center gap-1">
        <span
          aria-hidden="true"
          className="inline-block w-6 border-t-2"
          style={{ borderColor: PULSE_STROKE }}
        />
        {mode === 'raw' ? t('dashboard.tooltip.pulse') : t('dashboard.legend.avg')}
      </li>
      {mode === 'raw' && (
        <li className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 rounded-full border-2 border-dashed"
            style={{ borderColor: PULSE_STROKE }}
          />
          {t('dashboard.pulse.irregular')}
        </li>
      )}
    </ul>
  );
}

export function PulseChart({
  response,
  periodLabel,
  onEditPoint,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: PulseChartProps): JSX.Element {
  const { t } = useTranslation();
  const isDaily = response.mode === 'daily';
  const days = isDaily ? (response.days ?? []) : [];
  const points = isDaily ? [] : (response.points ?? []);

  // Показанные значения (§16: резюме из загруженных данных): raw — пульсы точек,
  // daily — средние дней; день без пульса (pulseAvg отсутствует) — не точка.
  const pulseValues = isDaily
    ? days.flatMap((day) => (day.pulseAvg === undefined ? [] : [day.pulseAvg]))
    : points.flatMap((point) => (point.pulse === undefined ? [] : [point.pulse]));
  const yDomain = pulseYDomainOf(pulseValues);

  // aria-резюме (§16): среднее/диапазон показанных значений; пусто — честная ветка.
  const chartLabel =
    pulseValues.length === 0
      ? t('dashboard.pulse.chartLabelEmpty', { period: periodLabel })
      : t('dashboard.pulse.chartLabel', {
          period: periodLabel,
          avg: formatNumber(summaryOf(pulseValues).avg),
          min: formatNumber(summaryOf(pulseValues).min),
          max: formatNumber(summaryOf(pulseValues).max),
          count: pulseValues.length,
        });

  /** Строка мини-таблицы (§16): aria-метка полная; irregular — с поясом EC-10. */
  const pointLabelOf = (point: RawPoint): string => {
    const instant: InstantLike = { utcMs: point.utcMs, tzOffsetMin: point.tzOffsetMin };
    const key: PulsePointLabelKey =
      point.irregular === true
        ? 'dashboard.pulse.pointLabelIrregular'
        : 'dashboard.pulse.pointLabel';
    return t(key, {
      datetime: formatDateTime(instant, { preset: 'datetime' }),
      pulse: point.pulse,
      part: t(
        point.part === 'morning'
          ? 'dashboard.tooltip.partMorning'
          : point.part === 'evening'
            ? 'dashboard.tooltip.partEvening'
            : 'dashboard.tooltip.partOther',
      ),
    });
  };

  const hiddenCount = hiddenPulseCountOf(response);
  /** Строки мини-таблицы — только ПОКАЗАННЫЕ точки (§13: скрытые объясняет подпись). */
  const listedPoints = points.filter((point) => point.pulse !== undefined);

  /** Тултип: content-элемент клонируется Recharts (channel pulse — §5 058). */
  const tooltipContent = (
    <ChartTooltip mode={response.mode} channel="pulse" onEditPoint={onEditPoint} />
  );

  const chartData: readonly Record<string, unknown>[] = isDaily ? days : points;

  return (
    <section>
      {/* §16: резюме для вспомогательных технологий; SVG внутри aria-hidden
          (прецедент TrendChart 057: маркеры скрыты от скринридера). */}
      <figure role="img" aria-label={chartLabel} data-testid="pulse-chart" className="m-0">
        {/* TASK-108 §5 (aria-hidden-focus): прецедент TrendChart — aria-hidden на
            внутренней обёртке, скролл-контейнер вне aria-hidden;
            accessibilityLayer=false — клавиатурный слой recharts 3 внутри
            aria-hidden недостижим и даёт serious-нарушение (a11y — aria-label
            фигуры + таблица). */}
        <div className="overflow-x-auto">
          <div aria-hidden="true">
            <ComposedChart
              width={width}
              height={height}
              data={chartData}
              margin={{ top: 12, right: 16, bottom: 4, left: 0 }}
              accessibilityLayer={false}
            >
              <CartesianGrid stroke={REF_STROKE} strokeDasharray="1 4" strokeOpacity={0.6} />
              <XAxis
                dataKey={isDaily ? 'wallDate' : 'utcMs'}
                type={isDaily ? 'category' : 'number'}
                scale={isDaily ? 'auto' : 'time'}
                domain={isDaily ? undefined : ['dataMin', 'dataMax']}
                tickFormatter={isDaily ? dayTickOf : rawTickOf}
                stroke={REF_STROKE}
                tick={{ fill: 'var(--hl-text)', fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
                domain={yDomain}
                tickFormatter={(value: number) => String(value)}
                stroke={REF_STROKE}
                tick={{ fill: 'var(--hl-text)', fontSize: 11 }}
                tickLine={false}
                width={40}
                label={{
                  value: t('dashboard.pulse.unit'),
                  angle: -90,
                  position: 'insideLeft',
                  fill: 'var(--hl-text)',
                  fontSize: 11,
                }}
              />
              <Tooltip content={tooltipContent} isAnimationActive={false} />

              {/* Опорный коридор 60–100 (§5/§10): полупрозрачная полоса + линии-
                границы ИЗ КОНСТАНТ КОНТРАКТА — справка, не классификация. */}
              <ReferenceArea
                y1={PULSE_REF_LOW}
                y2={PULSE_REF_HIGH}
                fill={REF_STROKE}
                fillOpacity={0.15}
                stroke="none"
                ifOverflow="extendDomain"
              />
              <ReferenceLine
                y={PULSE_REF_LOW}
                stroke={REF_STROKE}
                strokeDasharray="2 4"
                ifOverflow="extendDomain"
              />
              <ReferenceLine
                y={PULSE_REF_HIGH}
                stroke={REF_STROKE}
                strokeDasharray="2 4"
                ifOverflow="extendDomain"
              />

              <Line
                dataKey={isDaily ? 'pulseAvg' : 'pulse'}
                stroke={PULSE_STROKE}
                strokeWidth={2}
                connectNulls={false}
                isAnimationActive={false}
                dot={isDaily ? false : <PulseDot onEditPoint={onEditPoint} />}
              />
            </ComposedChart>
          </div>
        </div>
      </figure>

      {/* §5: подпись коридора-справки — ВНЕ svg и ВНЕ aria-hidden (ревью 057). */}
      <p data-testid="pulse-ref-note" className="mt-1 text-xs text-neutral-500">
        {t('dashboard.pulse.refNote')}
      </p>

      {/* §20.5: честность агрегации — подпись daily-режима (прецедент TrendChart). */}
      {isDaily && (
        <p data-testid="pulse-daily-caption" className="mt-1 text-sm text-neutral-500">
          {t('dashboard.tooltip.aggregated')}
        </p>
      )}

      {/* §13: расхождение «записей больше, чем показанных точек» — честная подпись. */}
      {hiddenCount > 0 && (
        <p data-testid="pulse-hidden-count" className="mt-1 text-sm text-neutral-500">
          {t(hiddenKeyFor(hiddenCount), { count: hiddenCount })}
        </p>
      )}

      <Legend mode={response.mode} />

      {/* §16: клавиатурная доступность тултипа — мини-таблица (raw; daily — агрегат). */}
      {response.mode === 'raw' && (
        <div data-testid="pulse-list" className="mt-2 flex flex-col items-start gap-1">
          {listedPoints.map((point) => (
            <button
              key={point.id ?? `${point.utcMs}-${point.pulse}`}
              type="button"
              data-testid="pulse-list-row"
              aria-label={pointLabelOf(point)}
              onClick={() => onEditPoint?.(point)}
              className="min-h-11 rounded-md px-1 text-left text-sm underline-offset-2 hover:underline"
            >
              {pointLabelOf(point)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
