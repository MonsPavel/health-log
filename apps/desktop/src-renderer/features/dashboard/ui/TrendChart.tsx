/**
 * TASK-057 §5/§13/§16/§19: график тренда — ComposedChart Recharts 3 (ADR-0003 §7:
 * «TASK-057 строится на ComposedChart/Line/Area/ReferenceLine/Tooltip как в
 * прототипе; read model отдаёт и сырые точки, и day-агрегаты, рендерер только
 * переключает режим»).
 *
 * RAW (§5): две линии sys/dia — цвета ИЗ ТОКЕНОВ (--hl-accent сплошная,
 * --hl-text штрих — различимы при дальтонизме не только цветом), маркеры по
 * части суток ФОРМОЙ (§13: morning=circle, evening=rect, other=polygon —
 * атрибут data-part дублирует форму программно); клик по точке → onEditPoint
 * (§12: переход к правке TASK-038; ADR-0003 §2 «activeDot.onClick →
 * onOpenRecord(id)»). DAILY (§5): коридор min–max — range-Area (dataKey →
 * [min, max], ADR §2 «без ручной отрисовки») + линии avg; правки нет (§12).
 *
 * ОПРЕМЕНТАЦИЯ a11y (§16, ADR-0003 §2/§7): figure role="img" с aria-label-
 * резюме ИЗ ЗАГРУЖЕННЫХ ДАННЫХ (stats/period экран не потребляет в 057 — §11;
 * полное резюме и таблица — TASK-059); содержимое SVG aria-hidden (маркеры
 * скрыты от скринридера группировкой, ADR «проверяемо в TASK-057»). Клавиатурный
 * доступ к значениям (§16: «фокусируемые точки или список-мини-таблица — по
 * возможностям библиотеки, решение в ADR-комментарии реализации»): hover-тултип
 * Recharts не доступен с клавиатуры, у фокусируемых SVG-точек 500 стоп-табов —
 * выбран СПИСОК-МИНИ-ТАБЛИЦА строк-кнопок под графиком (raw-режим; daily —
 * агрегат, правки не имеет) — Task-059 заменит полной таблицей.
 *
 * ОСЬ Y (§22 риск): правило компонента — фикс-минимум 60 мм рт. ст. и padding
 * ±20 вокруг данных: [max(60, min−20), max+20] (yDomainOf) — авто-масштаб
 * не «прыгает». Ось X — время (число utcMs, шкала time); подписи тиков —
 * настенные даты зоны устройства (Intl, §17). Анимации отключены — правило
 * ADR-0003 §2 (isAnimationActive=false при больших данных).
 *
 * Размеры — явные width/height (дефолт 800×360): ResponsiveContainer в jsdom
 * не измеряется (0×0 — SVG пуст), явные размеры детерминированы тестами;
 * контейнер с overflow-x-auto для узких окон.
 */
import { useTranslation } from 'react-i18next';
import { Area, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts';

import type { DayPoint, RawPoint, TrendResponse } from '@hl/contracts';

import { formatDateTime, type InstantLike } from '../../../lib/i18n-date';
import { tzOffsetMinOf } from '../../../lib/period';
import { ChartTooltip } from './ChartTooltip';
import { ReferenceLines, ScaleSourceCaption } from './ReferenceLines';

/** Цвета серий из токенов темы (§5: цвета из токенов; CSS-переменные — тема без ре-рендера). */
const SYS_STROKE = 'var(--hl-accent)';
const DIA_STROKE = 'var(--hl-text)';

/** Фикс-минимум оси Y (§22) и padding вокруг данных, мм рт. ст. */
const Y_MIN = 60;
const Y_PADDING = 20;

/** Дефолтные размеры SVG (см. шапку: явные размеры — детерминизм тестов). */
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 360;

/** Ширина маркера-формы (половина стороны квадрата/радиус круга), px. */
const MARKER_SIZE = 4;

/** Правило оси Y (§22): [max(60, min−20), max+20] — документировано в шапке. */
export function yDomainOf(values: readonly number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [Math.max(Y_MIN, min - Y_PADDING), max + Y_PADDING];
}

/** Число в ru-формате (§17 Intl; максимум 1 знак — правило отображения 052). */
function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
}

/** Клавиши-литералы i18n (§22: динамических ключей нет — check-i18n видит ключ). */
type PointLabelKey = 'dashboard.a11y.pointLabel' | 'dashboard.a11y.pointLabelPulse';

/** Свойства TrendChart (§5): ответ trend/series + активная шкала + колбэк правки. */
export interface TrendChartProps {
  readonly response: TrendResponse;
  /** Активная шкала (scales/active) — опорные линии и подпись источника; undefined — ещё грузится. */
  readonly scale?: import('@hl/contracts').ActiveScale;
  /** Подпись периода для aria-резюме («30 дней» из каталога — формирует экран). */
  readonly periodLabel: string;
  /**
   * Готовая aria-метка ИЗ stats-резюме (TASK-059 §5: «aria-label = краткое резюме,
   * те же числа» — резюме и метка строятся из одного stats/period-ответа).
   * undefined — stats ещё грузится: метка считается по загруженным точкам
   * (локальный расчёт ниже, прецедент 057) и заменяется при приходе stats.
   */
  readonly ariaLabel?: string;
  /** Клик по точке/кнопке тултипа/строке списка → переход к правке записи (§12). */
  readonly onEditPoint?: (point: RawPoint) => void;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Маркер точки по части суток (§13: форма+цвет). Recharts клонирует элемент
 * dot, добавляя cx/cy/payload/index; onClick — переход к правке (§12, ADR
 * activeDot.onClick → onOpenRecord). data-part — программная различимость
 * формы (§20.2 «атрибут/элемент DOM различен»).
 */
function PartDot(props: {
  readonly cx?: number;
  readonly cy?: number;
  readonly payload?: unknown;
  readonly channel: 'sys' | 'dia';
  readonly onEditPoint?: (point: RawPoint) => void;
}): JSX.Element | null {
  const { cx, cy, payload, channel, onEditPoint } = props;
  if (cx === undefined || cy === undefined || payload === undefined) {
    return null;
  }
  const point = payload as RawPoint;
  const color = channel === 'sys' ? SYS_STROKE : DIA_STROKE;
  const handleClick = (event: { stopPropagation(): void }): void => {
    event.stopPropagation();
    onEditPoint?.(point);
  };
  const shapeProps = {
    fill: color,
    stroke: 'none',
    'data-testid': 'trend-dot',
    'data-part': point.part,
    onClick: handleClick,
  } as const;
  switch (point.part) {
    case 'morning':
      // Утро — круг (§13).
      return <circle cx={cx} cy={cy} r={MARKER_SIZE} {...shapeProps} />;
    case 'evening':
      // Вечер — квадрат (§13).
      return (
        <rect
          x={cx - MARKER_SIZE}
          y={cy - MARKER_SIZE}
          width={MARKER_SIZE * 2}
          height={MARKER_SIZE * 2}
          {...shapeProps}
        />
      );
    default:
      // Другое время — треугольник (§13).
      return (
        <polygon
          points={`${cx},${cy - MARKER_SIZE - 1} ${cx + MARKER_SIZE + 1},${cy + MARKER_SIZE} ${cx - MARKER_SIZE - 1},${cy + MARKER_SIZE}`}
          {...shapeProps}
        />
      );
  }
}

/** Тик оси X raw-режима: настенная дата момента в зоне устройства (§17 Intl).
 *  Экспорт: PulseChart (TASK-058) использует те же оси времени — одна копия. */
export function rawTickOf(utcMs: number): string {
  const ms = Number(utcMs);
  const instant: InstantLike = { utcMs: ms, tzOffsetMin: tzOffsetMinOf(ms) };
  return formatDateTime(instant, { preset: 'date' });
}

/** Тик оси X daily-режима: настенная дата 'YYYY-MM-DD' → короткая Intl-дата (одна копия с PulseChart). */
export function dayTickOf(wallDate: string): string {
  const [y, mo, d] = String(wallDate).split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(
    Date.UTC(y, mo - 1, d),
  );
}

/** Среднее и границы выборки для aria-резюме (§16; 1 знак — правило отображения 052). */
function summaryOf(values: readonly number[]): { avg: number; min: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { avg: Math.round(avg * 10) / 10, min, max };
}

/** Итоговое содержимое легенды: raw — серии+части суток, daily — avg+коридор (§5, §16). */
function Legend({ mode }: { readonly mode: 'raw' | 'daily' }): JSX.Element {
  const { t } = useTranslation();
  return (
    <ul
      data-testid="trend-legend"
      className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-accent"
    >
      {mode === 'raw' ? (
        <>
          <li className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block w-6 border-t-2"
              style={{ borderColor: SYS_STROKE }}
            />
            {t('dashboard.legend.sys')}
          </li>
          <li className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block w-6 border-t-2"
              style={{ borderColor: DIA_STROKE, borderTopStyle: 'dashed' }}
            />
            {t('dashboard.legend.dia')}
          </li>
          <li className="flex items-center gap-1">
            <span aria-hidden="true">●</span>
            {t('dashboard.legend.morning')}
          </li>
          <li className="flex items-center gap-1">
            <span aria-hidden="true">■</span>
            {t('dashboard.legend.evening')}
          </li>
          <li className="flex items-center gap-1">
            <span aria-hidden="true">▲</span>
            {t('dashboard.legend.other')}
          </li>
        </>
      ) : (
        <>
          <li className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block w-6 border-t-2"
              style={{ borderColor: SYS_STROKE }}
            />
            {t('dashboard.legend.avg')}
          </li>
          <li className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-6 border"
              style={{ borderColor: 'var(--hl-border)' }}
            />
            {t('dashboard.legend.range')}
          </li>
        </>
      )}
    </ul>
  );
}

export function TrendChart({
  response,
  scale,
  periodLabel,
  ariaLabel,
  onEditPoint,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: TrendChartProps): JSX.Element {
  const { t } = useTranslation();
  const isDaily = response.mode === 'daily';
  const days = isDaily ? (response.days ?? []) : [];
  const points = isDaily ? [] : (response.points ?? []);

  // Данные осей (§22): yDomainOf — правило документа; x — время (raw) / настенные дни.
  const bpValues = isDaily
    ? days.flatMap((day) => [day.sysMin, day.sysMax, day.diaMin, day.diaMax])
    : points.flatMap((point) => [point.sys, point.dia]);
  const yDomain = yDomainOf(bpValues.length > 0 ? bpValues : [120, 80]);

  // aria-резюме из загруженных данных (§16; полное — TASK-059).
  const sysSummary = summaryOf(
    isDaily ? days.map((day) => day.sysAvg) : points.map((point) => point.sys),
  );
  const diaSummary = summaryOf(
    isDaily ? days.map((day) => day.diaAvg) : points.map((point) => point.dia),
  );
  const count = isDaily ? days.reduce((sum, day) => sum + day.count, 0) : points.length;
  const chartLabel = t('dashboard.a11y.chartLabel', {
    period: periodLabel,
    sysAvg: formatNumber(sysSummary.avg),
    sysMin: formatNumber(sysSummary.min),
    sysMax: formatNumber(sysSummary.max),
    diaAvg: formatNumber(diaSummary.avg),
    diaMin: formatNumber(diaSummary.min),
    diaMax: formatNumber(diaSummary.max),
    count,
  });

  /** Строка мини-таблицы (§16): aria-метка = видимый текст, значения полные. */
  const pointLabelOf = (point: RawPoint): string => {
    const instant: InstantLike = { utcMs: point.utcMs, tzOffsetMin: point.tzOffsetMin };
    const key: PointLabelKey =
      point.pulse === undefined ? 'dashboard.a11y.pointLabel' : 'dashboard.a11y.pointLabelPulse';
    return t(key, {
      datetime: formatDateTime(instant, { preset: 'datetime' }),
      sys: point.sys,
      dia: point.dia,
      ...(point.pulse !== undefined ? { pulse: point.pulse } : {}),
      part: t(
        point.part === 'morning'
          ? 'dashboard.tooltip.partMorning'
          : point.part === 'evening'
            ? 'dashboard.tooltip.partEvening'
            : 'dashboard.tooltip.partOther',
      ),
    });
  };

  /** Тултип: content-элемент клонируется Recharts (active/label/payload приходят от графика). */
  const tooltipContent = <ChartTooltip mode={response.mode} onEditPoint={onEditPoint} />;

  // Обе ветки — плоские строки-объекты; единая форма строк графика без приведения
  // на месте пропа (generic ComposedChart выводится от ширины Record-строки).
  const chartData: readonly Record<string, unknown>[] = isDaily ? days : points;

  return (
    <section>
      {/* §16: резюме для вспомогательных технологий (ariaLabel — из stats, TASK-059;
          fallback — локальный расчёт, пока stats грузится); SVG внутри aria-hidden
          (ADR-0003 §2/§7: маркеры скрыты от скринридера — группа aria-hidden). */}
      <figure
        role="img"
        aria-label={ariaLabel ?? chartLabel}
        data-testid="trend-chart"
        className="m-0"
      >
        {/* TASK-108 §5 (aria-hidden-focus): скролл-контейнер остаётся вне
            aria-hidden (Chromium делает скролл-области фокусируемыми — axe считает
            их фокусируемыми даже с tabIndex=-1); aria-hidden — на внутренней
            обёртке SVG (ADR-0003 §2/§7: маркеры скрыты от скринридера). */}
        <div className="overflow-x-auto">
          <div aria-hidden="true">
            <ComposedChart
              width={width}
              height={height}
              data={chartData}
              margin={{ top: 12, right: 16, bottom: 4, left: 0 }}
            >
              <CartesianGrid stroke="var(--hl-border)" strokeDasharray="1 4" strokeOpacity={0.6} />
              <XAxis
                dataKey={isDaily ? 'wallDate' : 'utcMs'}
                type={isDaily ? 'category' : 'number'}
                scale={isDaily ? 'auto' : 'time'}
                domain={isDaily ? undefined : ['dataMin', 'dataMax']}
                tickFormatter={isDaily ? dayTickOf : rawTickOf}
                stroke="var(--hl-border)"
                tick={{ fill: 'var(--hl-text)', fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
                domain={yDomain}
                tickFormatter={(value: number) => String(value)}
                stroke="var(--hl-border)"
                tick={{ fill: 'var(--hl-text)', fontSize: 11 }}
                tickLine={false}
                width={40}
                label={{
                  value: 'мм рт. ст.',
                  angle: -90,
                  position: 'insideLeft',
                  fill: 'var(--hl-text)',
                  fontSize: 11,
                }}
              />
              <Tooltip content={tooltipContent} isAnimationActive={false} />

              {isDaily ? (
                <>
                  {/* Коридор min–max (§5/§20.5): range-Area [min, max] — ADR-0003 §2. */}
                  <Area
                    dataKey={(day: DayPoint) => [day.sysMin, day.sysMax] as [number, number]}
                    stroke="var(--hl-border)"
                    strokeDasharray="2 4"
                    fill="var(--hl-border)"
                    fillOpacity={0.25}
                    isAnimationActive={false}
                    dot={false}
                  />
                  <Area
                    dataKey={(day: DayPoint) => [day.diaMin, day.diaMax] as [number, number]}
                    stroke="var(--hl-border)"
                    strokeDasharray="2 4"
                    fill="var(--hl-border)"
                    fillOpacity={0.25}
                    isAnimationActive={false}
                    dot={false}
                  />
                  <Line
                    dataKey="sysAvg"
                    stroke={SYS_STROKE}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    dataKey="diaAvg"
                    stroke={DIA_STROKE}
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                </>
              ) : (
                <>
                  <Line
                    dataKey="sys"
                    stroke={SYS_STROKE}
                    strokeWidth={2}
                    isAnimationActive={false}
                    dot={<PartDot channel="sys" onEditPoint={onEditPoint} />}
                  />
                  <Line
                    dataKey="dia"
                    stroke={DIA_STROKE}
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    isAnimationActive={false}
                    dot={<PartDot channel="dia" onEditPoint={onEditPoint} />}
                  />
                </>
              )}

              {/* Опорные линии из шкалы (§13) — ТОЛЬКО SVG-узлы Recharts (ревью 057:
                дети ComposedChart монтируются внутрь <svg>, HTML там не рендерится). */}
              <ReferenceLines scale={scale} />
            </ComposedChart>
          </div>
        </div>
      </figure>

      {/* §13: подпись источника — один раз на график, ВНЕ svg и ВНЕ aria-hidden
          (ScaleSourceCaption; ревью 057). */}
      <ScaleSourceCaption scale={scale} />

      {/* §20.5: честность агрегации — подпись daily-режима. */}
      {isDaily && (
        <p data-testid="trend-daily-caption" className="mt-1 text-sm text-neutral-500">
          {t('dashboard.tooltip.aggregated')}
        </p>
      )}

      <Legend mode={response.mode} />

      {/* §16: клавиатурная доступность тултипа — список-мини-таблица (решение в шапке). */}
      {response.mode === 'raw' && (
        <div data-testid="trend-list" className="mt-2 flex flex-col items-start gap-1">
          {points.map((point) => (
            <button
              key={point.id ?? `${point.utcMs}-${point.sys}-${point.dia}`}
              type="button"
              data-testid="trend-list-row"
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
