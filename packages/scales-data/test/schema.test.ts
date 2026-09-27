// TASK-050 §19: schema-тесты пакета scales-data — zod-валидация данных, инварианты
// §13 (сортировка по тяжести, стыковка границ без дыр/пересечений, открытые края,
// непустые labels), property-тест стыковки (§20), smoke-выборка §19 (138 →
// high_normal по SYSTOLIC-диапазону; полная классификация «худшая из двух» —
// TASK-053) и построчная сверка порогов с SRS 04 табл. 4.1 (§24).
//
// Zod-схема живёт здесь, а не в src (§4, РЕШЕНИЕ: пакет публикует чистые данные+типы,
// depcruise packages-layering запрещает npm-импорты в production-коде пакета;
// валидация схемы — в тестах пакета и в потребителе TASK-051). Совместимость
// опубликованных типов (schema.ts) со схемой проверяется тип-тестом: расхождение
// схемы и типов — красный тест.
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { BP_OFFICE_ESC2018 } from '../src/index.js';
import type { BpRange, ScaleCategory, ScaleData } from '../src/schema.js';

/** Граница диапазона АД в мм рт. ст.; null — открытая сторона (§13). */
const BP_RANGE_SCHEMA = z
  .object({ min: z.number().int().nullable(), max: z.number().int().nullable() })
  .strict();

/** Категория шкалы: границы — пары по каждому измерению, включительно (§7). */
const SCALE_CATEGORY_SCHEMA = z
  .object({
    code: z.enum([
      'optimal',
      'normal',
      'high_normal',
      'hypertension1',
      'hypertension2',
      'hypertension3',
    ]),
    label: z.string().min(1),
    sysRange: BP_RANGE_SCHEMA,
    diaRange: BP_RANGE_SCHEMA,
  })
  .strict();

/**
 * Zod-контракт файла данных шкалы — точный JSON-скелет §7. '$comment' — файловые
 * метаданные вне контракта данных (OQ-6), необязательны.
 */
export const SCALE_DATA_SCHEMA = z
  .object({
    code: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sourceLabel: z.string().min(1),
    language: z.literal('ru'),
    categories: z.array(SCALE_CATEGORY_SCHEMA).length(6),
    homeBPNote: z.string().min(1),
    specialGroupsNote: z.string().min(1),
    $comment: z.string().min(1).optional(),
  })
  .strict();

describe('BP_OFFICE_ESC2018 — метаданные шкалы (FR-4.5: источник и версия видны пользователю)', () => {
  it('код, версия, источник и язык зафиксированы (v1.0.0, данные §17 — только RU)', () => {
    expect(BP_OFFICE_ESC2018.code).toBe('bp_office_esc2018');
    expect(BP_OFFICE_ESC2018.version).toBe('1.0.0');
    expect(BP_OFFICE_ESC2018.sourceLabel).toBe('ESC/ESH 2018');
    expect(BP_OFFICE_ESC2018.language).toBe('ru');
  });

  it('типы экспортированы: констант типизирован как ScaleData (§20)', () => {
    expectTypeOf(BP_OFFICE_ESC2018).toEqualTypeOf<ScaleData>();
  });
});

describe('zod-валидация данных (§20: zod-валидация зелёная)', () => {
  it('файл данных проходит SCALE_DATA_SCHEMA', () => {
    const result = SCALE_DATA_SCHEMA.safeParse(BP_OFFICE_ESC2018);
    expect(result.success).toBe(true);
  });

  it('z.infer схемы совместим с опубликованными типами schema.ts (без ручной синхронизации, §23)', () => {
    const parsed: ScaleData = SCALE_DATA_SCHEMA.parse(BP_OFFICE_ESC2018);
    expect(parsed.code).toBe(BP_OFFICE_ESC2018.code);
  });

  it.each([
    { ...BP_OFFICE_ESC2018, version: '1.0' }, // не-семверная версия
    { ...BP_OFFICE_ESC2018, language: 'en' }, // v1.0.0 — данные только на русском (§17)
    { ...BP_OFFICE_ESC2018, homeBPNote: '' }, // §20: примечание непустое
    { ...BP_OFFICE_ESC2018, specialGroupsNote: undefined }, // §20: примечание присутствует
    { ...BP_OFFICE_ESC2018, categories: BP_OFFICE_ESC2018.categories.slice(0, 5) }, // не 6 категорий
    { ...BP_OFFICE_ESC2018, unexpectedField: true }, // strict: неизвестные поля запрещены
  ])('повреждённые данные отклоняются: %j', (variant) => {
    expect(SCALE_DATA_SCHEMA.safeParse(variant).success).toBe(false);
  });
});

describe('Категории — порядок и границы (§13)', () => {
  const categories = BP_OFFICE_ESC2018.categories;

  /** Доступ к категории по индексу: noUncheckedIndexedAccess — явная проверка. */
  const at = (index: number): ScaleCategory => {
    const category = categories[index];
    if (category === undefined) throw new Error(`категории[${index}] нет в данных`);
    return category;
  };

  it('6 категорий в порядке от оптимальной к тяжёлой', () => {
    expect(categories.map((category) => category.code)).toEqual([
      'optimal',
      'normal',
      'high_normal',
      'hypertension1',
      'hypertension2',
      'hypertension3',
    ]);
  });

  it('labels непустые (§13)', () => {
    for (const category of categories) {
      expect(category.label.length).toBeGreaterThan(0);
    }
  });

  it('открытые края: у оптимальной нет нижней границы, у АГ 3 степени — верхней (§13)', () => {
    expect(at(0).sysRange.min).toBeNull();
    expect(at(0).diaRange.min).toBeNull();
    expect(at(categories.length - 1).sysRange.max).toBeNull();
    expect(at(categories.length - 1).diaRange.max).toBeNull();
  });

  it('стыковка соседних категорий: max(k)+1 = min(k+1), без дыр и пересечений (§13)', () => {
    for (let index = 1; index < categories.length; index++) {
      const previous = at(index - 1);
      const next = at(index);
      expect(previous.sysRange.max).not.toBeNull();
      expect(next.sysRange.min).toBe((previous.sysRange.max as number) + 1);
      expect(previous.diaRange.max).not.toBeNull();
      expect(next.diaRange.min).toBe((previous.diaRange.max as number) + 1);
    }
  });

  it('property: каждое значение из технического домена FR-1.2 (СДА 50–300, ДДА 20–200) лежит ровно в одной категории (§20, fast-check)', () => {
    const contains = (range: BpRange, value: number): boolean =>
      (range.min === null || value >= range.min) && (range.max === null || value <= range.max);
    const countBy = (dimension: 'sysRange' | 'diaRange', value: number): number =>
      categories.filter((category) => contains(category[dimension], value)).length;

    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 300 }),
        fc.integer({ min: 20, max: 200 }),
        (systolic, diastolic) => {
          expect(countBy('sysRange', systolic)).toBe(1);
          expect(countBy('diaRange', diastolic)).toBe(1);
        },
      ),
    );
  });
});

describe('Пороговые значения — построчная сверка с SRS 04 табл. 4.1 (§24, автоматизировано)', () => {
  it('каждая категория = строке таблицы 4.1 (пары границ по каждому измерению, §7)', () => {
    expect(
      BP_OFFICE_ESC2018.categories.map((category) => ({
        code: category.code,
        label: category.label,
        sysRange: category.sysRange,
        diaRange: category.diaRange,
      })),
    ).toEqual([
      {
        code: 'optimal',
        label: 'Оптимальное',
        sysRange: { min: null, max: 119 },
        diaRange: { min: null, max: 79 },
      },
      {
        code: 'normal',
        label: 'Нормальное',
        sysRange: { min: 120, max: 129 },
        diaRange: { min: 80, max: 84 },
      },
      {
        code: 'high_normal',
        label: 'Высокое нормальное',
        sysRange: { min: 130, max: 139 },
        diaRange: { min: 85, max: 89 },
      },
      {
        code: 'hypertension1',
        label: 'АГ 1 степени',
        sysRange: { min: 140, max: 159 },
        diaRange: { min: 90, max: 99 },
      },
      {
        code: 'hypertension2',
        label: 'АГ 2 степени',
        sysRange: { min: 160, max: 179 },
        diaRange: { min: 100, max: 109 },
      },
      {
        code: 'hypertension3',
        label: 'АГ 3 степени',
        sysRange: { min: 180, max: null },
        diaRange: { min: 110, max: null },
      },
    ]);
  });
});

describe('Smoke §19 — выборка категории по SYSTOLIC-диапазону (полная классификация — TASK-053)', () => {
  const categoryBySystolic = (systolic: number): ScaleCategory | undefined =>
    BP_OFFICE_ESC2018.categories.find(
      (category) =>
        (category.sysRange.min === null || systolic >= category.sysRange.min) &&
        (category.sysRange.max === null || systolic <= category.sysRange.max),
    );

  it('138 → high_normal по SYSTOLIC-диапазону', () => {
    expect(categoryBySystolic(138)?.code).toBe('high_normal');
  });

  it('края диапазонов: 119 → optimal, 120 → normal, 180 → hypertension3', () => {
    expect(categoryBySystolic(119)?.code).toBe('optimal');
    expect(categoryBySystolic(120)?.code).toBe('normal');
    expect(categoryBySystolic(180)?.code).toBe('hypertension3');
  });
});

describe('Примечания (FR-4.2, §20: присутствуют и непустые)', () => {
  it('homeBPNote называет смещение домашних порогов: ≥135/85 ↔ офисные ≥140/90', () => {
    expect(BP_OFFICE_ESC2018.homeBPNote.length).toBeGreaterThan(0);
    expect(BP_OFFICE_ESC2018.homeBPNote).toMatch(/135\s*\/\s*85/);
    expect(BP_OFFICE_ESC2018.homeBPNote).toMatch(/140\s*\/\s*90/);
  });

  it('specialGroupsNote предупреждает о неприменимости особым группам', () => {
    expect(BP_OFFICE_ESC2018.specialGroupsNote.length).toBeGreaterThan(0);
    expect(BP_OFFICE_ESC2018.specialGroupsNote).toMatch(/беременност/u);
  });
});

describe('Метаданные файла (OQ-6, §20: комментарий в файле данных)', () => {
  it("'$comment' требует верификации порогов по первоисточнику перед релизом", () => {
    expect(BP_OFFICE_ESC2018.$comment).toBeDefined();
    expect(BP_OFFICE_ESC2018.$comment).toMatch(/OQ-6/);
    expect(BP_OFFICE_ESC2018.$comment).toMatch(/верифиц/u);
  });
});
