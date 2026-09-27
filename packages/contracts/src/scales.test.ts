/**
 * TASK-051 §11/§19: тесты zod-схем канала `scales/active` и контракта файла данных
 * справочной шкалы SCALE_DATA_SCHEMA (§7: сервис валидирует data_json zod-схемой
 * «пакета» — зеркало живёт здесь, рядом с формой канала; совместимость с типами
 * пакета @hl/scales-data проверяет интеграционный тест потребителя — desktop
 * зависит от пакета, contracts — нет).
 *
 * Матрица:
 *  - запрос scales/active — строго пустой объект (§11: {} → полная форма);
 *  - ответ — форма ActiveScale §7 {code, version, sourceLabel, categories,
 *    homeBPNote, specialGroupsNote}: мусор отклоняется (strict, §14), открытые
 *    края null допустимы, семвер версии обязателен (FR-4.5);
 *  - SCALE_DATA_SCHEMA — полный файл данных (язык ru §17, 6 категорий, $comment
 *    опциональны — OQ-6).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  BP_RANGE_SCHEMA,
  SCALES_ACTIVE_REQUEST_SCHEMA,
  SCALES_ACTIVE_RESPONSE_SCHEMA,
  SCALE_CATEGORY_SCHEMA,
  SCALE_DATA_SCHEMA,
  type ActiveScale,
  type ScalesActiveResponse,
} from './scales.js';

/** Категории ESC/ESH 2018 (SRS 04 табл. 4.1) — компактный литерал фикстуры. */
const ESC2018_CATEGORIES = [
  { code: 'optimal', label: 'Оптимальное', sysRange: { min: null, max: 119 }, diaRange: { min: null, max: 79 } },
  { code: 'normal', label: 'Нормальное', sysRange: { min: 120, max: 129 }, diaRange: { min: 80, max: 84 } },
  { code: 'high_normal', label: 'Высокое нормальное', sysRange: { min: 130, max: 139 }, diaRange: { min: 85, max: 89 } },
  { code: 'hypertension1', label: 'АГ 1 степени', sysRange: { min: 140, max: 159 }, diaRange: { min: 90, max: 99 } },
  { code: 'hypertension2', label: 'АГ 2 степени', sysRange: { min: 160, max: 179 }, diaRange: { min: 100, max: 109 } },
  { code: 'hypertension3', label: 'АГ 3 степени', sysRange: { min: 180, max: null }, diaRange: { min: 110, max: null } },
] as const;

const VALID_ACTIVE_SCALE = {
  code: 'bp_office_esc2018',
  version: '1.0.0',
  sourceLabel: 'ESC/ESH 2018',
  categories: ESC2018_CATEGORIES,
  homeBPNote: 'Домашние пороги: ≥135/85 (офисные ≥140/90).',
  specialGroupsNote: 'Пороги неприменимы особым группам.',
} as const;

const VALID_SCALE_DATA = {
  ...VALID_ACTIVE_SCALE,
  language: 'ru',
  $comment: 'Пороги верифицировать по первоисточнику (OQ-6).',
} as const;

describe('SCALES_ACTIVE_REQUEST_SCHEMA — запрос scales/active (§11: {})', () => {
  it('принимает пустой объект', () => {
    expect(SCALES_ACTIVE_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
  });

  it('strict: отклоняет неизвестные поля и не-объекты (§14: недоверенный рендерер)', () => {
    expect(SCALES_ACTIVE_REQUEST_SCHEMA.safeParse({ code: 'bp_office_esc2018' }).success).toBe(
      false,
    );
    expect(SCALES_ACTIVE_REQUEST_SCHEMA.safeParse('active').success).toBe(false);
    expect(SCALES_ACTIVE_REQUEST_SCHEMA.safeParse(null).success).toBe(false);
  });
});

describe('SCALES_ACTIVE_RESPONSE_SCHEMA — форма ActiveScale (§7)', () => {
  it('парсит полную форму (категории + обе заметки, открытые края null)', () => {
    expect(SCALES_ACTIVE_RESPONSE_SCHEMA.parse(VALID_ACTIVE_SCALE)).toEqual(VALID_ACTIVE_SCALE);
  });

  it('категорий минимум одна; неполная форма отклоняется', () => {
    expect(
      SCALES_ACTIVE_RESPONSE_SCHEMA.safeParse({ ...VALID_ACTIVE_SCALE, categories: [] }).success,
    ).toBe(false);
    expect(
      SCALES_ACTIVE_RESPONSE_SCHEMA.safeParse({ ...VALID_ACTIVE_SCALE, homeBPNote: undefined })
        .success,
    ).toBe(false);
    expect(
      SCALES_ACTIVE_RESPONSE_SCHEMA.safeParse({ ...VALID_ACTIVE_SCALE, specialGroupsNote: '' })
        .success,
    ).toBe(false);
  });

  it('версия — семвер (FR-4.5: обновление шкалы = новая версия данных, §3)', () => {
    expect(
      SCALES_ACTIVE_RESPONSE_SCHEMA.safeParse({ ...VALID_ACTIVE_SCALE, version: '1.0' }).success,
    ).toBe(false);
    expect(
      SCALES_ACTIVE_RESPONSE_SCHEMA.safeParse({ ...VALID_ACTIVE_SCALE, version: '1.1.0' }).success,
    ).toBe(true);
  });

  it.each([
    ['чужой код категории', { ...VALID_ACTIVE_SCALE, categories: [{ ...ESC2018_CATEGORIES[0], code: 'ideal' }] }],
    ['пустая метка', { ...VALID_ACTIVE_SCALE, categories: [{ ...ESC2018_CATEGORIES[0], label: '' }] }],
    [
      'нецелая граница',
      {
        ...VALID_ACTIVE_SCALE,
        categories: [{ ...ESC2018_CATEGORIES[0], sysRange: { min: null, max: 119.5 } }],
      },
    ],
    [
      'не-null вместо границы',
      {
        ...VALID_ACTIVE_SCALE,
        categories: [{ ...ESC2018_CATEGORIES[0], diaRange: { min: null, max: undefined } }],
      },
    ],
  ])('мусор в категориях отклоняется: %s', (_name, variant) => {
    expect(SCALES_ACTIVE_RESPONSE_SCHEMA.safeParse(variant).success).toBe(false);
  });

  it('strict: неизвестное поле формы отклоняется (§14)', () => {
    expect(
      SCALES_ACTIVE_RESPONSE_SCHEMA.safeParse({ ...VALID_ACTIVE_SCALE, language: 'ru' }).success,
    ).toBe(false);
  });

  it('типы выведены из схем: ActiveScale ≡ ScalesActiveResponse (§23: без ручной синхронизации)', () => {
    expectTypeOf<ActiveScale>().toEqualTypeOf<ScalesActiveResponse>();
    const parsed: ActiveScale = SCALES_ACTIVE_RESPONSE_SCHEMA.parse(VALID_ACTIVE_SCALE);
    expect(parsed.code).toBe('bp_office_esc2018');
  });
});

describe('SCALE_DATA_SCHEMA — полный файл данных (зеркало пакета TASK-050, §7)', () => {
  it('парсит полный файл: language=ru, 6 категорий, $comment опциональны', () => {
    expect(SCALE_DATA_SCHEMA.parse(VALID_SCALE_DATA)).toEqual(VALID_SCALE_DATA);
    const { $comment: _comment, ...withoutComment } = VALID_SCALE_DATA;
    expect(SCALE_DATA_SCHEMA.parse(withoutComment)).toEqual(withoutComment);
  });

  it.each([
    ['язык не ru (§17: данные v1.0.0 только русские)', { ...VALID_SCALE_DATA, language: 'en' }],
    ['не 6 категорий', { ...VALID_SCALE_DATA, categories: ESC2018_CATEGORIES.slice(0, 5) }],
    ['не-семверная версия', { ...VALID_SCALE_DATA, version: '1.0' }],
    ['пустой sourceLabel', { ...VALID_SCALE_DATA, sourceLabel: '' }],
  ])('повреждённый файл данных отклоняется: %s', (_name, variant) => {
    expect(SCALE_DATA_SCHEMA.safeParse(variant).success).toBe(false);
  });

  it('строгие под-схемы экспортированы и переиспользуются (граница — целые с null-краями)', () => {
    expect(BP_RANGE_SCHEMA.safeParse({ min: null, max: 119 }).success).toBe(true);
    expect(BP_RANGE_SCHEMA.safeParse({ min: '120', max: 129 }).success).toBe(false);
    expect(SCALE_CATEGORY_SCHEMA.safeParse(ESC2018_CATEGORIES[0]).success).toBe(true);
  });
});
