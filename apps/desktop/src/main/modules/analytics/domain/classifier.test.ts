// TASK-053 §19: Classifier — реперные кейсы §13 (из SRS AC-3.3) с правилом «худшая
// из двух» (SRS 04 табл. 4.1: «по более высокой категории из двух измерений»);
// exhaustive по краям категорий §19 (120 ровно → normal, 119 → optimal, 180 ровно →
// hypertension3); обе заметки (homeBP + specialGroups) присутствуют ВСЕГДА при
// категории и их тексты — из данных шкалы, не генерируются (§14); insufficientData
// → категория undefined + note (пороги kernel — в сборщике, сюда приходят уже
// undefined-средние, §13). Шкала — боевые данные BP_OFFICE_ESC2018: типы домена —
// структурное зеркало @hl/scales-data (domain-purity, арх. 03 §4), дрейф ловит
// тип-тест.
import { describe, expect, expectTypeOf, it } from 'vitest';

import { BP_OFFICE_ESC2018, type ScaleData } from '@hl/scales-data';

import {
  INSUFFICIENT_DATA_NOTE_TEXT,
  classify,
  type Classification,
  type ClassificationNote,
  type ScaleCategory,
} from './classifier.js';

/** Боевые данные шкалы (§14: классификатор не содержит порогов — только данные). */
const SCALE = BP_OFFICE_ESC2018;

/** Заметки, обязательные при категории: точная пара kind→text из данных шкалы (§5/§14). */
const MANDATORY_NOTES = [
  { kind: 'homeBP', text: SCALE.homeBPNote },
  { kind: 'specialGroups', text: SCALE.specialGroupsNote },
] as const satisfies readonly ClassificationNote[];

describe('classify — реперные кейсы §13 (SRS AC-3.3)', () => {
  const cases: readonly {
    readonly avgSys: number;
    readonly avgDia: number;
    readonly expected: ScaleCategory['code'];
    readonly why: string;
  }[] = [
    { avgSys: 138, avgDia: 86, expected: 'high_normal', why: 'SRS AC-3.3: обе в high_normal' },
    {
      avgSys: 145,
      avgDia: 85,
      expected: 'hypertension1',
      why: '§13: sys решает (dia в high_normal, берём тяжёлую)',
    },
    {
      avgSys: 120,
      avgDia: 95,
      expected: 'hypertension1',
      why: '§13: dia решает (sys в normal, берём тяжёлую)',
    },
    { avgSys: 119, avgDia: 79, expected: 'optimal', why: '§13: обе на верхней границе optimal' },
    {
      avgSys: 181,
      avgDia: 70,
      expected: 'hypertension3',
      why: '§13: sys решает (dia в optimal, берём тяжёлую)',
    },
    {
      // §13 пишет «136/84 → normal», но норма SRS 04 табл. 4.1 («по более высокой
      // категории из двух») даёт high_normal: 136 ∈ [130–139], 84 ∈ [80–84].
      // Erratum ввода против нормы зафиксирован в summary задачи; первоисточник
      // (roadmap T-3.2.2) для 136/84 требует лишь «тоже с примечанием».
      avgSys: 136,
      avgDia: 84,
      expected: 'high_normal',
      why: '§13 (кейс 136/84): sys решает + ОБЕ заметки (см. комментарий выше)',
    },
    {
      avgSys: 126,
      avgDia: 84,
      expected: 'normal',
      why: '§13 (смысла кейса «normal + ОБЕ заметки»): обе в normal',
    },
  ];

  for (const c of cases) {
    it(`${c.avgSys}/${c.avgDia} → ${c.expected} (${c.why})`, () => {
      const result = classify(c.avgSys, c.avgDia, SCALE);
      expect(result.category?.code).toBe(c.expected);
      // Примечания неотделимы от результата (§3): обе заметки при любой категории.
      expect(result.notes).toEqual(MANDATORY_NOTES);
    });
  }
});

describe('classify — границы категорий §19 (exhaustive по краям диапазонов)', () => {
  const cases: readonly {
    readonly avgSys: number;
    readonly avgDia: number;
    readonly expected: ScaleCategory['code'];
    readonly why: string;
  }[] = [
    { avgSys: 119, avgDia: 60, expected: 'optimal', why: 'sys 119 ровно — верх optimal' },
    { avgSys: 120, avgDia: 60, expected: 'normal', why: 'sys 120 ровно — низ normal (§19)' },
    { avgSys: 129, avgDia: 60, expected: 'normal', why: 'sys 129 — верх normal' },
    { avgSys: 130, avgDia: 60, expected: 'high_normal', why: 'sys 130 — низ high_normal' },
    { avgSys: 139, avgDia: 60, expected: 'high_normal', why: 'sys 139 — верх high_normal' },
    { avgSys: 140, avgDia: 60, expected: 'hypertension1', why: 'sys 140 — низ АГ1' },
    { avgSys: 159, avgDia: 60, expected: 'hypertension1', why: 'sys 159 — верх АГ1' },
    { avgSys: 160, avgDia: 60, expected: 'hypertension2', why: 'sys 160 — низ АГ2' },
    { avgSys: 179, avgDia: 60, expected: 'hypertension2', why: 'sys 179 — верх АГ2' },
    { avgSys: 180, avgDia: 60, expected: 'hypertension3', why: 'sys 180 ровно — АГ3 (§19)' },
    { avgSys: 60, avgDia: 79, expected: 'optimal', why: 'dia 79 ровно — верх optimal' },
    { avgSys: 60, avgDia: 80, expected: 'normal', why: 'dia 80 ровно — низ normal' },
    { avgSys: 60, avgDia: 84, expected: 'normal', why: 'dia 84 — верх normal' },
    { avgSys: 60, avgDia: 85, expected: 'high_normal', why: 'dia 85 ровно — низ high_normal' },
    { avgSys: 60, avgDia: 89, expected: 'high_normal', why: 'dia 89 — верх high_normal' },
    { avgSys: 60, avgDia: 90, expected: 'hypertension1', why: 'dia 90 ровно — низ АГ1' },
    { avgSys: 60, avgDia: 99, expected: 'hypertension1', why: 'dia 99 — верх АГ1' },
    { avgSys: 60, avgDia: 100, expected: 'hypertension2', why: 'dia 100 ровно — низ АГ2' },
    { avgSys: 60, avgDia: 109, expected: 'hypertension2', why: 'dia 109 — верх АГ2' },
    { avgSys: 60, avgDia: 110, expected: 'hypertension3', why: 'dia 110 ровно — низ АГ3' },
    // Дробные средние из 052 (§13: подаются как есть): щель (119;120) между
    // целыми диапазонами — «первая по стороне выхода» = optimal (§7).
    { avgSys: 119.5, avgDia: 79.5, expected: 'optimal', why: 'дробные 119.5/79.5 — ниже normal' },
  ];

  for (const c of cases) {
    it(`${c.avgSys}/${c.avgDia} → ${c.expected} (${c.why})`, () => {
      expect(classify(c.avgSys, c.avgDia, SCALE).category?.code).toBe(c.expected);
    });
  }
});

describe('classify — обе заметки обязательны при категории (AC §20, §14)', () => {
  /** Представитель каждой из 6 категорий (внутри диапазонов). */
  const categoryCases: readonly {
    readonly avgSys: number;
    readonly avgDia: number;
    readonly expected: ScaleCategory['code'];
  }[] = [
    { avgSys: 110, avgDia: 70, expected: 'optimal' },
    { avgSys: 125, avgDia: 82, expected: 'normal' },
    { avgSys: 135, avgDia: 87, expected: 'high_normal' },
    { avgSys: 150, avgDia: 95, expected: 'hypertension1' },
    { avgSys: 170, avgDia: 105, expected: 'hypertension2' },
    { avgSys: 185, avgDia: 115, expected: 'hypertension3' },
  ];

  for (const c of categoryCases) {
    it(`${c.expected}: notes = [homeBP, specialGroups] с текстами ДАННЫХ шкалы`, () => {
      const result = classify(c.avgSys, c.avgDia, SCALE);
      expect(result.category?.code).toBe(c.expected);
      expect(result.notes).toEqual(MANDATORY_NOTES);
    });
  }

  it('тексты заметок совпадают с данными шкалы, а не сгенерированы (§14, юр. контроль R-1)', () => {
    const result = classify(138, 86, SCALE);
    expect(result.notes[0]).toEqual({ kind: 'homeBP', text: SCALE.homeBPNote });
    expect(result.notes[1]).toEqual({ kind: 'specialGroups', text: SCALE.specialGroupsNote });
  });
});

describe('classify — insufficientData (§5/§13: пороги kernel — в сборщике)', () => {
  it('оба средних undefined → категория undefined + одна note insufficientData', () => {
    expect(classify(undefined, undefined, SCALE)).toEqual({
      category: undefined,
      notes: [{ kind: 'insufficientData', text: INSUFFICIENT_DATA_NOTE_TEXT }],
    });
  });

  it('частично undefined (одно из двух) → тоже insufficientData (защита)', () => {
    expect(classify(undefined, 80, SCALE).category).toBeUndefined();
    expect(classify(120, undefined, SCALE).category).toBeUndefined();
    expect(classify(undefined, 80, SCALE).notes).toEqual([
      { kind: 'insufficientData', text: INSUFFICIENT_DATA_NOTE_TEXT },
    ]);
  });

  it('при insufficientData заметок homeBP/specialGroups НЕТ (они — пара к категории, §5)', () => {
    const result = classify(undefined, undefined, SCALE);
    expect(result.notes.some((note) => note.kind !== 'insufficientData')).toBe(false);
  });
});

describe('classify — открытые границы и защита «вне всех диапазонов» (§7)', () => {
  it('avgSys 110 ниже sysMin нормальной (120) → optimal (open-граница null-min, §7)', () => {
    expect(classify(110, 70, SCALE).category?.code).toBe('optimal');
  });

  it('avgSys 250 выше sysMax АГ2 → hypertension3 (open-граница null-max)', () => {
    expect(classify(250, 70, SCALE).category?.code).toBe('hypertension3');
  });

  it('шкала без открытых сторон: выше всех диапазонов → последняя категория (§7)', () => {
    const capped = {
      categories: [
        {
          code: 'optimal',
          label: 'A',
          sysRange: { min: 90, max: 100 },
          diaRange: { min: 50, max: 60 },
        },
        {
          code: 'normal',
          label: 'B',
          sysRange: { min: 110, max: 120 },
          diaRange: { min: 70, max: 80 },
        },
      ],
      homeBPNote: 'home',
      specialGroupsNote: 'groups',
    } as const;
    expect(classify(130, 75, capped).category?.code).toBe('normal');
    expect(classify(130, 55, capped).category?.code).toBe('normal');
  });

  it('шкала без открытых сторон: ниже всех диапазонов → первая категория (§7)', () => {
    const capped = {
      categories: [
        {
          code: 'optimal',
          label: 'A',
          sysRange: { min: 90, max: 100 },
          diaRange: { min: 50, max: 60 },
        },
        {
          code: 'normal',
          label: 'B',
          sysRange: { min: 110, max: 120 },
          diaRange: { min: 70, max: 80 },
        },
      ],
      homeBPNote: 'home',
      specialGroupsNote: 'groups',
    } as const;
    expect(classify(80, 55, capped).category?.code).toBe('optimal');
  });

  it('пустой список категорий (невозможно по форме канала) → без категории и без заметок', () => {
    const empty = { categories: [], homeBPNote: 'home', specialGroupsNote: 'groups' } as const;
    const result = classify(120, 80, empty);
    expect(result.category).toBeUndefined();
    expect(result.notes).toEqual([]);
  });
});

describe('classify — контракт типов (§5) и зеркала @hl/scales-data (domain-purity)', () => {
  it('Classification: {category: ScaleCategory|undefined; notes: ClassificationNote[]}', () => {
    expectTypeOf<Classification['category']>().toEqualTypeOf<ScaleCategory | undefined>();
    expectTypeOf<Classification['notes']>().toEqualTypeOf<readonly ClassificationNote[]>();
    expectTypeOf<ClassificationNote['kind']>().toEqualTypeOf<
      'homeBP' | 'specialGroups' | 'insufficientData'
    >();
  });

  it('типы домена — точное структурное зеркало типов пакета (дрейф ловит компилятор)', () => {
    expectTypeOf<ScaleData['categories'][number]>().toEqualTypeOf<ScaleCategory>();
    expectTypeOf<ScaleData['homeBPNote']>().toEqualTypeOf<string>();
    expectTypeOf<ScaleData['specialGroupsNote']>().toEqualTypeOf<string>();
  });

  it('боевые данные пакета удовлетворяют поверхности классификатора (структурно)', () => {
    const scale = {
      categories: SCALE.categories,
      homeBPNote: SCALE.homeBPNote,
      specialGroupsNote: SCALE.specialGroupsNote,
    };
    expect(classify(138, 86, scale).category?.label).toBe('Высокое нормальное');
  });
});
