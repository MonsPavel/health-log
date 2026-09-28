// Спайк TASK-055: тренд СДА/ДДА на @visx (низкоуровневые примитивы, «собери сам»).
// Объём по §5: 2 серии + ЧСС на своей оси, опорная линия 140 с подписью источника,
// утро/вечер формой точки, тултип, клик по точке → обратный вызов, агрегация день=avg+range.
import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { AxisBottom, AxisLeft, AxisRight } from '@visx/axis';
import { curveMonotoneX } from '@visx/curve';
import { Area, Line, LinePath } from '@visx/shape';
import { scaleLinear, scaleTime } from '@visx/scale';
import { Text } from '@visx/text';
import { defaultStyles, TooltipWithBounds, useTooltip } from '@visx/tooltip';
import { aggregateByDay, dayTime, makeData, type DayAgg, type Measurement } from './data';

const W = 720;
const H = 340;
const M = { top: 24, right: 56, bottom: 30, left: 46 };
const C = {
  sys: '#b91c1c', // СДА
  dia: '#1d4ed8', // ДДА
  hr: '#047857', // ЧСС
  band: '#9ca3af',
  bandDia: '#60a5fa',
  ref: '#d97706',
  grid: '#e5e7eb',
  text: '#374151',
};
const PART_RU = { morning: 'утро', evening: 'вечер' } as const;
const fmtDay = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });
const fmtFull = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const REF = 140;
const REF_LABEL = 'Порог АГ — 140 (ВОЗ)';

function diamondPath(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`;
}

export interface TrendChartProps {
  n: number;
  mode: 'raw' | 'day';
  onOpenRecord?: (id: string) => void;
}

export function TrendChart({ n, mode, onOpenRecord }: TrendChartProps) {
  const raw = useMemo(() => makeData(n), [n]);
  const agg = useMemo(() => aggregateByDay(raw), [raw]);
  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<Measurement | null>(null);

  const x = scaleTime<number>({
    domain: [raw[0].t, raw[raw.length - 1].t],
    range: [M.left, W - M.right],
  });
  const y = scaleLinear<number>({ domain: [60, 165], range: [H - M.bottom, M.top] });
  const yHr = scaleLinear<number>({ domain: [40, 120], range: [H - M.bottom, M.top] });

  // точка графика: утро = круг, вечер = ромб (форма), цвет = цвет серии
  const point = (m: Measurement, yv: number, color: string): ReactNode =>
    m.part === 'morning' ? (
      <circle key={m.id + yv} cx={x(m.t)} cy={yv} r={2.5} fill={color} />
    ) : (
      <path key={m.id + yv} d={diamondPath(x(m.t), yv, 3.2)} fill={color} />
    );

  // бисекция по монотонному x — ближайшая точка к курсору (один обработчик на весь график)
  const nearest = (clientX: number): Measurement => {
    const rect = document.querySelector('svg')!.getBoundingClientRect();
    const tx = clientX - rect.left;
    let lo = 0;
    let hi = raw.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((x(raw[mid].t) as number) < tx) lo = mid;
      else hi = mid;
    }
    const a = raw[lo];
    const b = raw[hi];
    return Math.abs((x(a.t) as number) - tx) <= Math.abs((x(b.t) as number) - tx) ? a : b;
  };

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const m = nearest(e.clientX);
    showTooltip({ tooltipData: m, tooltipLeft: x(m.t) as number, tooltipTop: y(m.sys) as number });
  };
  const onClickPoint = () => {
    if (tooltipData) onOpenRecord?.(tooltipData.id);
  };

  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  return (
    <div style={{ position: 'relative', width: W }}>
      <svg width={W} height={H} role="img" aria-label="Динамика давления за 30 дней">
        {/* коридор min–max (режим «по дням»): Area с y0/y1 */}
        {mode === 'day' && (
          <>
            <Area<DayAgg>
              data={agg}
              x={(d) => x(dayTime(d.day)) as number}
              y0={(d) => y(d.sysMin) as number}
              y1={(d) => y(d.sysMax) as number}
              fill={C.band}
              fillOpacity={0.35}
              curve={curveMonotoneX}
            />
            <Area<DayAgg>
              data={agg}
              x={(d) => x(dayTime(d.day)) as number}
              y0={(d) => y(d.diaMin) as number}
              y1={(d) => y(d.diaMax) as number}
              fill={C.bandDia}
              fillOpacity={0.3}
              curve={curveMonotoneX}
            />
          </>
        )}

        {/* опорная линия 140 с подписью источника */}
        <Line
          from={{ x: M.left, y: y(REF) as number }}
          to={{ x: W - M.right, y: y(REF) as number }}
          stroke={C.ref}
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
        <Text
          x={W - M.right - 6}
          y={(y(REF) as number) - 6}
          textAnchor="end"
          fill={C.ref}
          fontSize={11}
        >
          {REF_LABEL}
        </Text>

        {/* серии: СДА, ДДА (левая ось), ЧСС (правая ось); day-режим = средние поверх коридоров */}
        {mode === 'raw' ? (
          <>
            <LinePath<Measurement>
              data={raw}
              x={(d) => x(d.t) as number}
              y={(d) => y(d.sys) as number}
              stroke={C.sys}
              strokeWidth={1.5}
              curve={curveMonotoneX}
              fill="none"
            />
            <LinePath<Measurement>
              data={raw}
              x={(d) => x(d.t) as number}
              y={(d) => y(d.dia) as number}
              stroke={C.dia}
              strokeWidth={1.5}
              curve={curveMonotoneX}
              fill="none"
            />
            <LinePath<Measurement>
              data={raw}
              x={(d) => x(d.t) as number}
              y={(d) => yHr(d.hr) as number}
              stroke={C.hr}
              strokeWidth={1.5}
              curve={curveMonotoneX}
              fill="none"
            />
          </>
        ) : (
          <>
            <LinePath<DayAgg>
              data={agg}
              x={(d) => x(dayTime(d.day)) as number}
              y={(d) => y(d.sysAvg) as number}
              stroke={C.sys}
              strokeWidth={2.5}
              curve={curveMonotoneX}
              fill="none"
            />
            <LinePath<DayAgg>
              data={agg}
              x={(d) => x(dayTime(d.day)) as number}
              y={(d) => y(d.diaAvg) as number}
              stroke={C.dia}
              strokeWidth={2.5}
              curve={curveMonotoneX}
              fill="none"
            />
            <LinePath<DayAgg>
              data={agg}
              x={(d) => x(dayTime(d.day)) as number}
              y={(d) => yHr(d.hrAvg) as number}
              stroke={C.hr}
              strokeWidth={1.5}
              curve={curveMonotoneX}
              fill="none"
            />
          </>
        )}

        {/* точки утро/вечер на обеих сериях давления — только в режиме точек */}
        {mode === 'raw' && raw.map((m) => point(m, y(m.sys) as number, C.sys))}
        {mode === 'raw' && raw.map((m) => point(m, y(m.dia) as number, C.dia))}

        {/* оси: слева давление, справа ЧСС, снизу дни */}
        <AxisBottom
          scale={x}
          top={H - M.bottom}
          numTicks={6}
          tickFormat={(t) => fmtDay.format(t as number)}
          stroke={C.grid}
          tickStroke={C.grid}
          tickLabelProps={() => ({ fill: C.text, fontSize: 11, textAnchor: 'middle' })}
        />
        <AxisLeft
          scale={y}
          left={M.left}
          numTicks={5}
          label="мм рт. ст."
          labelProps={{ fill: C.text, fontSize: 11, textAnchor: 'middle' }}
          stroke={C.grid}
          tickStroke={C.grid}
          tickLabelProps={() => ({ fill: C.text, fontSize: 11, textAnchor: 'end', dx: -4 })}
        />
        <AxisRight
          scale={yHr}
          left={W - M.right}
          numTicks={5}
          label="уд/мин"
          labelProps={{ fill: C.text, fontSize: 11, textAnchor: 'middle' }}
          stroke={C.grid}
          tickStroke={C.grid}
          tickLabelProps={() => ({ fill: C.text, fontSize: 11, textAnchor: 'start', dx: 4 })}
        />

        {/* оверлей: тултип по ближайшей точке + клик = переход к записи */}
        <rect
          x={M.left}
          y={M.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={hideTooltip}
          onClick={onClickPoint}
        />
      </svg>

      {tooltipOpen && tooltipData && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          style={{ ...defaultStyles, padding: 0, background: 'transparent', border: 'none' }}
        >
          <div className="tip">
            <div>
              {fmtFull.format(tooltipData.t)} · {PART_RU[tooltipData.part]}
            </div>
            <div>
              СДА {tooltipData.sys} · ДДА {tooltipData.dia} · ЧСС {tooltipData.hr}
            </div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>клик — открыть запись</div>
          </div>
        </TooltipWithBounds>
      )}

      <Legend />
    </div>
  );
}

function Legend(): ReactNode {
  return (
    <p style={{ margin: '4px 0 0', fontSize: 12, color: C.text }}>
      <svg width={12} height={12}>
        <circle cx={6} cy={6} r={4} fill="#6b7280" />
      </svg>{' '}
      утро{' '}
      <svg width={12} height={12}>
        <path d={diamondPath(6, 6, 4.5)} fill="#6b7280" />
      </svg>{' '}
      вечер <span style={{ color: C.sys }}>— СДА</span>{' '}
      <span style={{ color: C.dia }}>— ДДА</span>{' '}
      <span style={{ color: C.hr }}>— ЧСС (правая ось)</span>{' '}
      <span style={{ color: C.ref }}>– – порог {REF}</span>
    </p>
  );
}
