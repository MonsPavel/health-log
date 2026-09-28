// Общий модуль данных спайка TASK-055 (байт-в-байт одинаков во всех трёх прототипах).
// Детерминированная генерация: 500 измерений за 30 дней, утро/вечер, СДА/ДДА/ЧСС.

export type Part = 'morning' | 'evening';

export interface Measurement {
  id: string;
  t: number; // epoch ms
  day: number; // 0..29
  hour: number;
  part: Part;
  sys: number; // СДА, мм рт. ст.
  dia: number; // ДДА, мм рт. ст.
  hr: number; // ЧСС, уд/мин
}

export interface DayAgg {
  day: number;
  sysAvg: number;
  sysMin: number;
  sysMax: number;
  diaAvg: number;
  diaMin: number;
  diaMax: number;
  hrAvg: number;
}

export const DAYS = 30;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function makeData(n: number): Measurement[] {
  const rnd = lcg(42);
  const out: Measurement[] = [];
  const perDay = Math.ceil(n / DAYS);
  let id = 0;
  for (let d = 0; d < DAYS; d++) {
    for (let i = 0; i < perDay && out.length < n; i++) {
      const hour = 7 + Math.floor(rnd() * 15); // 7..21
      const part: Part = hour < 12 ? 'morning' : 'evening';
      const seasonal = Math.sin((d / DAYS) * Math.PI * 2) * 6;
      const tod = part === 'morning' ? 3 : -2;
      const sys = Math.round(126 + seasonal + tod + (rnd() - 0.5) * 16);
      const dia = Math.round(78 + seasonal * 0.4 + tod * 0.4 + (rnd() - 0.5) * 10);
      const hr = Math.round(68 + tod + (rnd() - 0.5) * 14);
      out.push({
        id: `m-${id++}`,
        t: new Date(2026, 8, d + 1, hour).getTime(),
        day: d,
        hour,
        part,
        sys,
        dia,
        hr,
      });
    }
  }
  return out;
}

// «Расчёт series на main» (арх. 06 §8): здесь моделируем готовый результат read model.
export function aggregateByDay(data: Measurement[]): DayAgg[] {
  const byDay = new Map<number, Measurement[]>();
  for (const m of data) {
    const arr = byDay.get(m.day);
    if (arr) arr.push(m);
    else byDay.set(m.day, [m]);
  }
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const out: DayAgg[] = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const ms = byDay.get(day)!;
    const sys = ms.map((m) => m.sys);
    const dia = ms.map((m) => m.dia);
    out.push({
      day,
      sysAvg: avg(sys),
      sysMin: Math.min(...sys),
      sysMax: Math.max(...sys),
      diaAvg: avg(dia),
      diaMin: Math.min(...dia),
      diaMax: Math.max(...dia),
      hrAvg: avg(ms.map((m) => m.hr)),
    });
  }
  return out;
}

// Метка дня для агрегированных точек (полдень дня).
export function dayTime(day: number): number {
  return new Date(2026, 8, day + 1, 12).getTime();
}
