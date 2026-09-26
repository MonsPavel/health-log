// TASK-020 §19: таблица граничных кейсов — exhaustive по всем четырём порогам ±1.
// Блок 1 — дословные кейсы §13 (смешанные пары: 180/119, 179/120, 180/120, 91/61,
// 90/60, 89/80, 120/61). Блок 2 — каждый порог (high 180/120, low 90/60) обходится
// значениями −1 / порог / +1 при нейтральной второй координате (sys=120, dia=80 —
// ни одно правило не срабатывает). Блок 3 — приоритет high при одновременном
// срабатывании обоих правил (невозможно численно, задокументировано в §7: high
// проверяется первым). Пульс не участвует — сигнатура принимает только (sys, dia)
// (§13): арность 2 фиксирует это на уровне рантайма. Функция чистая (§20): результат
// зависит только от аргументов — ни времени, ни профиля в сигнатуре нет.
import { describe, expect, it } from 'vitest';

import { assessCritical, type CriticalFlag } from './critical-value-policy.js';

/** Кейс таблицы: пара (sys, dia) → ожидаемый флаг + причина для имени теста. */
interface Row {
  readonly sys: number;
  readonly dia: number;
  readonly expected: CriticalFlag;
  readonly why: string;
}

/** Нейтральная вторая координата для ±1-обхода отдельного порога (§19). */
const NEUTRAL_SYS = 120;
const NEUTRAL_DIA = 80;

describe('assessCritical — дословные кейсы §13', () => {
  const cases: readonly Row[] = [
    { sys: 180, dia: 119, expected: 'high', why: 'sys=180 на высоком пороге' },
    { sys: 179, dia: 120, expected: 'high', why: 'dia=120 на высоком пороге' },
    { sys: 180, dia: 120, expected: 'high', why: 'оба на высоком пороге' },
    { sys: 91, dia: 61, expected: undefined, why: 'оба на 1 выше низких порогов' },
    { sys: 90, dia: 60, expected: 'low', why: 'оба на низких порогах' },
    { sys: 89, dia: 80, expected: 'low', why: 'sys=89 ниже низкого порога' },
    { sys: 120, dia: 61, expected: undefined, why: 'dia=61 не low' },
    {
      sys: 120,
      dia: 80,
      expected: undefined,
      why: 'норма — флага нет (§5: средняя тяжесть не здесь)',
    },
  ];

  for (const c of cases) {
    it(`${c.sys}/${c.dia} → ${String(c.expected)} (${c.why})`, () => {
      expect(assessCritical(c.sys, c.dia)).toBe(c.expected);
    });
  }
});

describe('assessCritical — exhaustive по четырём порогам ±1 (§19/§20)', () => {
  const cases: readonly Row[] = [
    // Высокий порог sys (180): граница включительно.
    { sys: 179, dia: NEUTRAL_DIA, expected: undefined, why: '179 < 180 — не high' },
    { sys: 180, dia: NEUTRAL_DIA, expected: 'high', why: 'sys = 180 → high' },
    { sys: 181, dia: NEUTRAL_DIA, expected: 'high', why: 'sys = 181 > 180 → high' },
    // Высокий порог dia (120): граница включительно.
    { sys: NEUTRAL_SYS, dia: 119, expected: undefined, why: '119 < 120 — не high' },
    { sys: NEUTRAL_SYS, dia: 120, expected: 'high', why: 'dia = 120 → high' },
    { sys: NEUTRAL_SYS, dia: 121, expected: 'high', why: 'dia = 121 > 120 → high' },
    // Низкий порог sys (90): граница включительно, high уже не сработал.
    { sys: 89, dia: NEUTRAL_DIA, expected: 'low', why: 'sys = 89 ≤ 90 → low' },
    { sys: 90, dia: NEUTRAL_DIA, expected: 'low', why: 'sys = 90 → low' },
    { sys: 91, dia: NEUTRAL_DIA, expected: undefined, why: '91 > 90 и dia нейтральна' },
    // Низкий порог dia (60): граница включительно, high уже не сработал.
    { sys: NEUTRAL_SYS, dia: 59, expected: 'low', why: 'dia = 59 ≤ 60 → low' },
    { sys: NEUTRAL_SYS, dia: 60, expected: 'low', why: 'dia = 60 → low' },
    { sys: NEUTRAL_SYS, dia: 61, expected: undefined, why: '61 > 60 и sys нейтрален' },
  ];

  for (const c of cases) {
    it(`${c.sys}/${c.dia} → ${String(c.expected)} (${c.why})`, () => {
      expect(assessCritical(c.sys, c.dia)).toBe(c.expected);
    });
  }
});

describe('assessCritical — приоритет high (§7, документировано)', () => {
  it('sys=180 (high) и dia=60 (low) одновременно → high', () => {
    expect(assessCritical(180, 60)).toBe('high');
  });

  it('sys=89 (low) и dia=120 (high) одновременно → high', () => {
    expect(assessCritical(89, 120)).toBe('high');
  });
});

describe('assessCritical — сигнатура (§13/§20)', () => {
  it('пульс не участвует: параметров ровно два (sys, dia)', () => {
    expect(assessCritical.length).toBe(2);
  });
});
