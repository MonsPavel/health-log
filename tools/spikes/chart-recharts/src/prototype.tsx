// Спайк TASK-055: тренд СДА/ДДА на Recharts (декларативные React-компоненты).
// Объём по §5: 2 серии + ЧСС на своей оси, опорная линия 140 с подписью источника,
// утро/вечер формой точки, тултип, клик по точке → обратный вызов, агрегация день=avg+range.
import { useMemo, type ReactNode } from 'react';
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { aggregateByDay, dayTime, makeData, type DayAgg, type Measurement } from './data';

const W = 720;
const H = 340;
const M = { top: 24, right: 56, bottom: 30, left: 46 };
const C = {
  sys: '#b91c1c',
  dia: '#1d4ed8',
  hr: '#047857',
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

// кастомная точка: утро = круг, вечер = ромб; клик по точке = переход к записи
function makeDot(color: string, onOpen?: (id: string) => void) {
  return function Dot(props: { cx?: number; cy?: number; payload?: Measurement }) {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null || !payload) return null;
    return payload.part === 'morning' ? (
      <circle
        cx={cx}
        cy={cy}
        r={2.5}
        fill={color}
        onClick={() => onOpen?.(payload.id)}
      />
    ) : (
      <path d={diamondPath(cx, cy, 3.2)} fill={color} onClick={() => onOpen?.(payload.id)} />
    );
  };
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Measurement | DayAgg }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  if ('part' in p) {
    return (
      <div className="tip">
        <div>
          {fmtFull.format(p.t)} · {PART_RU[p.part]}
        </div>
        <div>
          СДА {p.sys} · ДДА {p.dia} · ЧСС {p.hr}
        </div>
        <div style={{ color: '#6b7280', fontSize: 12 }}>клик — открыть запись</div>
      </div>
    );
  }
  return (
    <div className="tip">
      <div>
        {fmtDay.format(p.t)} — за день
      </div>
      <div>
        СДА {p.sysMin}–{p.sysMax} (ср. {Math.round(p.sysAvg)}) · ДДА {p.diaMin}–{p.diaMax} · ЧСС ≈{' '}
        {Math.round(p.hrAvg)}
      </div>
    </div>
  );
}

export interface TrendChartProps {
  n: number;
  mode: 'raw' | 'day';
  onOpenRecord?: (id: string) => void;
}

export function TrendChart({ n, mode, onOpenRecord }: TrendChartProps) {
  const raw = useMemo(() => makeData(n), [n]);
  const agg = useMemo(() => aggregateByDay(raw), [raw]);
  // XAxis dataKey="t": агрегированным строкам нужна метка времени (полдень дня)
  const dayRows = useMemo(() => agg.map((d) => ({ ...d, t: dayTime(d.day) })), [agg]);
  const sysDot = useMemo(() => makeDot(C.sys, onOpenRecord), [onOpenRecord]);
  const diaDot = useMemo(() => makeDot(C.dia, onOpenRecord), [onOpenRecord]);

  return (
    <div style={{ width: W }}>
      <ComposedChart
        width={W}
        height={H}
        data={mode === 'raw' ? raw : dayRows}
        margin={M}
      >
        <XAxis
          type="number"
          dataKey="t"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(t: number) => fmtDay.format(t)}
          tickCount={6}
          stroke={C.grid}
          tick={{ fill: C.text, fontSize: 11 }}
        />
        <YAxis
          domain={[60, 165]}
          tickCount={6}
          label={{ value: 'мм рт. ст.', angle: -90, position: 'insideLeft', fill: C.text, fontSize: 11 }}
          stroke={C.grid}
          tick={{ fill: C.text, fontSize: 11 }}
        />
        <YAxis
          yAxisId="hr"
          orientation="right"
          domain={[40, 120]}
          label={{ value: 'уд/мин', angle: 90, position: 'insideRight', fill: C.text, fontSize: 11 }}
          stroke={C.grid}
          tick={{ fill: C.text, fontSize: 11 }}
        />

        {/* коридор min–max в режиме «по дням»: range-Area (dataKey => [min, max]) */}
        {mode === 'day' && (
          <>
            <Area
              dataKey={(d: DayAgg) => [d.sysMin, d.sysMax]}
              fill={C.band}
              fillOpacity={0.35}
              stroke="none"
              isAnimationActive={false}
            />
            <Area
              dataKey={(d: DayAgg) => [d.diaMin, d.diaMax]}
              fill={C.bandDia}
              fillOpacity={0.3}
              stroke="none"
              isAnimationActive={false}
            />
          </>
        )}

        {/* серии: СДА, ДДА (левая ось), ЧСС (правая ось) */}
        {mode === 'raw' ? (
          <>
            <Line
              type="monotone"
              dataKey="sys"
              stroke={C.sys}
              strokeWidth={1.5}
              dot={sysDot}
              activeDot={{
                r: 5,
                onClick: (d: { payload?: Measurement }) => d.payload && onOpenRecord?.(d.payload.id),
              }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="dia"
              stroke={C.dia}
              strokeWidth={1.5}
              dot={diaDot}
              activeDot={{
                r: 5,
                onClick: (d: { payload?: Measurement }) => d.payload && onOpenRecord?.(d.payload.id),
              }}
              isAnimationActive={false}
            />
          </>
        ) : (
          <>
            <Line
              type="monotone"
              dataKey="sysAvg"
              name="СДА (ср.)"
              stroke={C.sys}
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="diaAvg"
              name="ДДА (ср.)"
              stroke={C.dia}
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
            />
          </>
        )}
        <Line
          type="monotone"
          dataKey={mode === 'raw' ? 'hr' : 'hrAvg'}
          yAxisId="hr"
          stroke={C.hr}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />

        {/* опорная линия 140 с подписью источника */}
        <ReferenceLine
          y={REF}
          stroke={C.ref}
          strokeDasharray="5 4"
          strokeOpacity={0.9}
          label={{ value: REF_LABEL, position: 'insideTopRight', fill: C.ref, fontSize: 11 }}
        />

        <Tooltip content={<ChartTooltip />} />
      </ComposedChart>

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
