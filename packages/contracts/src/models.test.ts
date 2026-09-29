/**
 * TASK-079 §19/§20: тесты zod-схемы модели ModelDescriptor и манифеста
 * MODELS_MANIFEST_SCHEMA — единственного источника «что можно поставить» (§3).
 *
 * Матрица:
 *  - валидная запись проходит (все поля формы §7);
 *  - КАЖДЫЙ инвариант §13 отвергает нарушение (тест-таблица AC1): url https-only
 *    (http и не-URL), sha256 — ровно 64 hex (короткий/не-hex), sizeBytes > 0
 *    (0/отрицательный/дробный), languages непустой и без пустых строк,
 *    minRamGb > 0, обязательные строки непустые, неизвестные поля запрещены
 *    (strict, §14);
 *  - манифест-уровень: дубликаты id → отказ (§13), уникальные — проходят,
 *    пустой список валиден (форма, не отбор — отбор моделей внешний процесс, §2);
 *  - тип ModelDescriptor выводится из схемы (z.infer, §23).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MODELS_MANIFEST_SCHEMA,
  MODEL_DESCRIPTOR_SCHEMA,
  type ModelDescriptor,
} from './models.js';

/** Валидная запись-кандидат (форма §7) — база мутаций тест-таблицы. */
const VALID_MODEL = {
  id: 'dev-placeholder-ru',
  name: 'Dev Placeholder Model',
  version: '0.0.0-dev',
  file: 'dev-placeholder.gguf',
  url: 'https://cdn.example.com/models/dev-placeholder.gguf',
  sha256: 'a'.repeat(64),
  sizeBytes: 986_000_000,
  languages: ['ru', 'en'],
  minRamGb: 8,
  license: 'apache-2.0',
} as const;

describe('MODEL_DESCRIPTOR_SCHEMA — валидная запись (§19)', () => {
  it('валидная запись проходит и сохраняет поля формы §7', () => {
    const parsed = MODEL_DESCRIPTOR_SCHEMA.parse({ ...VALID_MODEL });
    expect(parsed).toEqual({ ...VALID_MODEL });
    expect(parsed.languages).toEqual(['ru', 'en']);
  });

  it('notesKey опционален: без него запись валидна, с непустым — тоже', () => {
    expect(MODEL_DESCRIPTOR_SCHEMA.safeParse({ ...VALID_MODEL }).success).toBe(true);
    expect(
      MODEL_DESCRIPTOR_SCHEMA.safeParse({ ...VALID_MODEL, notesKey: 'models.notes.ram16' })
        .success,
    ).toBe(true);
  });
});

describe('MODEL_DESCRIPTOR_SCHEMA — инварианты §13 (тест-таблица, AC1/AC4)', () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly patch: Record<string, unknown> }> = [
    { name: 'url http — запрещён (https-only, §14)', patch: { url: 'http://cdn.example.com/m.gguf' } },
    { name: 'url не-URL — запрещён', patch: { url: 'PLACEHOLDER' } },
    { name: 'url без схемы — запрещён', patch: { url: 'cdn.example.com/m.gguf' } },
    { name: 'sha256 короче 64 — запрещён', patch: { sha256: 'a'.repeat(63) } },
    { name: 'sha256 не-hex — запрещён', patch: { sha256: 'z'.repeat(64) } },
    { name: 'sha256 0 — обязательность целостности (§14)', patch: { sha256: '' } },
    { name: 'sizeBytes 0 — запрещён (> 0)', patch: { sizeBytes: 0 } },
    { name: 'sizeBytes отрицательный — запрещён', patch: { sizeBytes: -1 } },
    { name: 'sizeBytes дробный — запрещён', patch: { sizeBytes: 1.5 } },
    { name: 'languages пустой — запрещён', patch: { languages: [] } },
    { name: 'languages с пустой строкой — запрещён', patch: { languages: ['ru', ''] } },
    { name: 'minRamGb 0 — запрещён', patch: { minRamGb: 0 } },
    { name: 'minRamGb отрицательный — запрещён', patch: { minRamGb: -8 } },
    { name: 'id пустой — запрещён', patch: { id: '' } },
    { name: 'name пустой — запрещён (§16–17: продуктовое имя)', patch: { name: '' } },
    { name: 'file пустой — запрещён', patch: { file: '' } },
    { name: 'version пустой — запрещён', patch: { version: '' } },
    { name: 'license пустая — запрещена (юр. чистота дистрибуции, §14)', patch: { license: '' } },
    { name: 'notesKey пустой — запрещён (i18n-ключ)', patch: { notesKey: '' } },
    { name: 'неизвестное поле — запрещено (strict, §14)', patch: { mirror: 'https://x.example.com' } },
  ];

  it.each(cases)('$name', ({ patch }) => {
    const broken = { ...VALID_MODEL, ...patch };
    expect(MODEL_DESCRIPTOR_SCHEMA.safeParse(broken).success).toBe(false);
  });
});

describe('MODELS_MANIFEST_SCHEMA — манифест-уровень (§13: дубли id → отказ)', () => {
  it('список уникальных записей проходит', () => {
    const second = { ...VALID_MODEL, id: 'dev-placeholder-en' };
    expect(MODELS_MANIFEST_SCHEMA.safeParse([{ ...VALID_MODEL }, second]).success).toBe(true);
  });

  it('дубликат id → отказ', () => {
    const duplicate = { ...VALID_MODEL, name: 'Same id' };
    expect(
      MODELS_MANIFEST_SCHEMA.safeParse([{ ...VALID_MODEL }, duplicate]).success,
    ).toBe(false);
  });

  it('пустой список валиден (форма ≠ отбор: отбор — внешний процесс, §2)', () => {
    expect(MODELS_MANIFEST_SCHEMA.safeParse([]).success).toBe(true);
  });

  it('не-массив (объект) — запрещён', () => {
    expect(MODELS_MANIFEST_SCHEMA.safeParse({ models: [{ ...VALID_MODEL }] }).success).toBe(
      false,
    );
  });
});

describe('ModelDescriptor — тип выводится из схемы (§23)', () => {
  it('notesKey опционален в типе', () => {
    const parsed: ModelDescriptor = MODEL_DESCRIPTOR_SCHEMA.parse({ ...VALID_MODEL });
    expectTypeOf(parsed.notesKey).toEqualTypeOf<string | undefined>();
  });
});
