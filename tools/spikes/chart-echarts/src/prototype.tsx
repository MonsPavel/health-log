// Спайк TASK-055: тренд СДА/ДДА на Apache ECharts 6 (SVG-рендерер, тонкая React-обёртка).
// Объём по §5: 2 серии + ЧСС на своей оси, опорная линия 140 с подписью источника,
// утро/вечер формой точки, тултип, клик по точке → обратный вызов, агрегация день=avg+range.
// Band min–max строится stack-трюком (базовая невидимая линия + разница с areaStyle).
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { aggregateByDay, dayTime, makeData, type DayAgg, type Measurement } from './data';

echarts.use([LineChart, GridComponent, MarkLineComponent, TooltipComponent, SVGRenderer]);

const W = 720;
const H = 340;
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

type EChartsType = ReturnType<typeof echarts.init>;

export interface TrendChartProps {
  n: number;
  mode: 'raw' | 'day';
  onOpenRecord?: (id: string) => void;
}

// императивная опция — состояние графика живёт вне React (в отличие от visx/Recharts)
function buildOption(mode: 'raw' | 'day', raw: Measurement[], agg: DayAgg[]) {
  const byTime = new Map<number, Measurement>(raw.map((m) => [m.t, m]));
  const byDay = new Map<number, DayAgg>(agg.map((d) => [dayTime(d.day), d]));
  const markLine = {
    silent: true,
    symbol: 'none' as const,
    lineStyle: { color: C.ref, type: 'dashed' as const, width: 1.5 },
    label: { formatter: REF_LABEL, position: 'insideEndTop' as const, color: C.ref, fontSize: 11 },
    data: [{ yAxis: REF }],
  };

  if (mode === 'raw') {
    const points = (key: 'sys' | 'dia') =>
      raw.map((m) => ({
        value: [m.t, m[key]],
        id: m.id,
        part: m.part,
        dia: m.dia,
        sys: m.sys,
        hr: m.hr,
        // утро = круг, вечер = ромб: symbol переопределяется на уровне точки данных
        symbol: m.part === 'morning' ? ('circle' as const) : ('diamond' as const),
        symbolSize: 5,
      }));
    return {
      animation: false,
      grid: { left: 46, right: 56, top: 24, bottom: 30 },
      xAxis: {
        type: 'time',
        axisLabel: { formatter: (v: number) => fmtDay.format(v), color: C.text, fontSize: 11 },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'value',
          name: 'мм рт. ст.',
          min: 60,
          max: 165,
          nameTextStyle: { color: C.text, fontSize: 11 },
          axisLabel: { color: C.text, fontSize: 11 },
          splitLine: { lineStyle: { color: C.grid } },
        },
        {
          type: 'value',
          name: 'уд/мин',
          min: 40,
          max: 120,
          position: 'right',
          nameTextStyle: { color: C.text, fontSize: 11 },
          axisLabel: { color: C.text, fontSize: 11 },
          splitLine: { show: false },
        },
      ],
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const first = (Array.isArray(params) ? params : [params])[0] as { axisValue: number };
          const m = byTime.get(Number(first.axisValue));
          if (!m) return '';
          return (
            `${fmtFull.format(m.t)} · ${PART_RU[m.part]}<br/>` +
            `СДА ${m.sys} · ДДА ${m.dia} · ЧСС ${m.hr}<br/>` +
            '<span style="color:#6b7280;font-size:12px">клик — открыть запись</span>'
          );
        },
      },
      series: [
        {
          name: 'СДА',
          type: 'line',
          data: points('sys'),
          itemStyle: { color: C.sys },
          lineStyle: { color: C.sys, width: 1.5 },
          markLine,
        },
        {
          name: 'ДДА',
          type: 'line',
          data: points('dia'),
          itemStyle: { color: C.dia },
          lineStyle: { color: C.dia, width: 1.5 },
        },
        {
          name: 'ЧСС',
          type: 'line',
          yAxisIndex: 1,
          data: raw.map((m) => [m.t, m.hr]),
          symbol: 'none',
          itemStyle: { color: C.hr },
          lineStyle: { color: C.hr, width: 1.5 },
        },
      ],
    };
  }

  // день = avg + range: коридор min–max строится stack-трюком (§23: «дорисовать руками»)
  const band = (name: string, minKey: keyof DayAgg, maxKey: keyof DayAgg, color: string) => [
    {
      name: `${name}-base`,
      type: 'line',
      stack: `band-${name}`,
      data: agg.map((d) => [dayTime(d.day), d[minKey]]),
      symbol: 'none',
      lineStyle: { opacity: 0 },
      silent: true,
      tooltip: { show: false },
    },
    {
      name: `${name}-range`,
      type: 'line',
      stack: `band-${name}`,
      data: agg.map((d) => +(d[maxKey] - d[minKey]).toFixed(2)),
      symbol: 'none',
      lineStyle: { opacity: 0 },
      areaStyle: { color, opacity: 0.35 },
      silent: true,
      tooltip: { show: false },
    },
  ];
  return {
    animation: false,
    grid: { left: 46, right: 56, top: 24, bottom: 30 },
    xAxis: {
      type: 'time',
      axisLabel: { formatter: (v: number) => fmtDay.format(v), color: C.text, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: 'мм рт. ст.',
        min: 60,
        max: 165,
        nameTextStyle: { color: C.text, fontSize: 11 },
        axisLabel: { color: C.text, fontSize: 11 },
        splitLine: { lineStyle: { color: C.grid } },
      },
      {
        type: 'value',
        name: 'уд/мин',
        min: 40,
        max: 120,
        position: 'right',
        nameTextStyle: { color: C.text, fontSize: 11 },
        axisLabel: { color: C.text, fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const first = (Array.isArray(params) ? params : [params])[0] as { axisValue: number };
        const d = byDay.get(Number(first.axisValue));
        if (!d) return '';
        return (
          `${fmtDay.format(dayTime(d.day))} — за день<br/>` +
          `СДА ${d.sysMin}–${d.sysMax} (ср. ${Math.round(d.sysAvg)}) · ` +
          `ДДА ${d.diaMin}–${d.diaMax} · ЧСС ≈ ${Math.round(d.hrAvg)}`
        );
      },
    },
    series: [
      ...band('sys', 'sysMin', 'sysMax', C.band),
      ...band('dia', 'diaMin', 'diaMax', C.bandDia),
      {
        name: 'СДА (ср.)',
        type: 'line',
        data: agg.map((d) => [dayTime(d.day), d.sysAvg]),
        symbol: 'none',
        itemStyle: { color: C.sys },
        lineStyle: { color: C.sys, width: 2.5 },
        markLine,
      },
      {
        name: 'ДДА (ср.)',
        type: 'line',
        data: agg.map((d) => [dayTime(d.day), d.diaAvg]),
        symbol: 'none',
        itemStyle: { color: C.dia },
        lineStyle: { color: C.dia, width: 2.5 },
      },
      {
        name: 'ЧСС (ср.)',
        type: 'line',
        yAxisIndex: 1,
        data: agg.map((d) => [dayTime(d.day), d.hrAvg]),
        symbol: 'none',
        itemStyle: { color: C.hr },
        lineStyle: { color: C.hr, width: 1.5 },
      },
    ],
  };
}

export function TrendChart({ n, mode, onOpenRecord }: TrendChartProps) {
  const holder = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const raw = useMemo(() => makeData(n), [n]);
  const agg = useMemo(() => aggregateByDay(raw), [raw]);

  useEffect(() => {
    chart.current = echarts.init(holder.current!, undefined, { renderer: 'svg' });
    return () => {
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.setOption(buildOption(mode, raw, agg), { notMerge: true });
    const onClick = (p: { data?: { id?: string } }) => {
      if (p.data?.id) onOpenRecord?.(p.data.id);
    };
    c.on('click', onClick as never);
    return () => {
      c.off('click', onClick as never);
    };
  }, [mode, raw, agg, onOpenRecord]);

  return (
    <div style={{ width: W }}>
      <div ref={holder} style={{ width: W, height: H }} role="img" aria-label="Динамика давления за 30 дней" />
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
        <path d={`M 6 1.5 L 10.5 6 L 6 10.5 L 1.5 6 Z`} fill="#6b7280" />
      </svg>{' '}
      вечер <span style={{ color: C.sys }}>— СДА</span>{' '}
      <span style={{ color: C.dia }}>— ДДА</span>{' '}
      <span style={{ color: C.hr }}>— ЧСС (правая ось)</span>{' '}
      <span style={{ color: C.ref }}>– – порог {REF}</span>
    </p>
  );
}
