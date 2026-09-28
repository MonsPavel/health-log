// Харнесс бенчмарка и ручной проверки — одинаков во всех трёх спайках.
// window.bench(n, mode, runs) — замер времени монтирования графика (медиана/min/max по runs
// прогонам после одного прогрева) + счётчики DOM-узлов.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TrendChart } from './prototype';

type Mode = 'raw' | 'day';

const benchEl = document.getElementById('bench')!;
const round = (x: number) => Math.round(x * 10) / 10;

function raf2(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

let root: ReturnType<typeof createRoot> | null = null;

async function runOnce(n: number, mode: Mode): Promise<number> {
  if (root) {
    const old = root;
    root = null;
    old.unmount();
    await raf2();
  }
  root = createRoot(benchEl);
  const t0 = performance.now();
  root.render(
    <TrendChart
      n={n}
      mode={mode}
      onOpenRecord={(id) => {
        const s = document.getElementById('bench-last-record');
        if (s) s.textContent = id;
      }}
    />,
  );
  await raf2(); // коммит + отрисовка кадра
  return performance.now() - t0;
}

declare global {
  interface Window {
    bench: (
      n: number,
      mode: Mode,
      runs?: number,
    ) => Promise<{
      n: number;
      mode: Mode;
      runs: number;
      min: number;
      median: number;
      max: number;
      nodes: number;
      svgNodes: number;
    }>;
  }
}

window.bench = async (n, mode, runs = 5) => {
  await runOnce(n, mode); // прогрев (JIT, ленивые модули)
  const times: number[] = [];
  let nodes = 0;
  let svgNodes = 0;
  for (let i = 0; i < runs; i++) {
    times.push(await runOnce(n, mode));
    nodes = benchEl.querySelectorAll('*').length;
    svgNodes = benchEl.querySelectorAll('svg *').length;
    await new Promise((r) => setTimeout(r, 30));
  }
  times.sort((a, b) => a - b);
  return {
    n,
    mode,
    runs,
    min: round(times[0]),
    median: round(times[Math.floor(times.length / 2)]),
    max: round(times[times.length - 1]),
    nodes,
    svgNodes,
  };
};

function Manual() {
  const [mode, setMode] = useState<Mode>('raw');
  return (
    <div>
      <p>
        <button id="btn-raw" onClick={() => setMode('raw')}>
          Точки (500)
        </button>{' '}
        <button id="btn-day" onClick={() => setMode('day')}>
          По дням (30)
        </button>{' '}
        <span>
          Открыта запись: <b id="last-record">—</b>
        </span>
      </p>
      <TrendChart
        n={500}
        mode={mode}
        onOpenRecord={(id) => {
          const s = document.getElementById('last-record');
          if (s) s.textContent = id;
        }}
      />
      <p>
        <span>
          Бенчмарк-корзина, последняя запись: <b id="bench-last-record">—</b>
        </span>
      </p>
    </div>
  );
}

createRoot(document.getElementById('manual')!).render(<Manual />);
