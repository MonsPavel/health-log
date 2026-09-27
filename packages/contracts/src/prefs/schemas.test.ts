/**
 * TASK-047 §11/§19: тесты zod-схем каналов `prefs/get|set` и документа Prefs.
 *
 * Матрица:
 *  - PREFS_SCHEMA парсит полный документ (значения-enum по §5);
 *  - мусор отклоняется: неизвестная тема/масштаб/формат, не-boolean, чужое поле
 *    (strict — §14);
 *  - PREFS_PATCH_SCHEMA: пустой patch валиден; неизвестное поле ОТБРАСЫВАЕТСЯ, а
 *    не ошибка (§7 strict-merge: «отброшено, валидные применены» — AC5); неверный
 *    ТИП значения → ошибка (VALIDATION/FAILED каркаса, §11);
 *  - запрос get — строго пустой объект; ответ — полный документ.
 */
import { describe, expect, it } from 'vitest';

import {
  PREFS_GET_REQUEST_SCHEMA,
  PREFS_PATCH_SCHEMA,
  PREFS_SCHEMA,
  PREFS_SET_REQUEST_SCHEMA,
} from './schemas.js';

const VALID_PREFS = {
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false },
} as const;

describe('PREFS_SCHEMA — документ настроек (§5)', () => {
  it('парсит полный валидный документ', () => {
    expect(PREFS_SCHEMA.parse(VALID_PREFS)).toEqual(VALID_PREFS);
  });

  it('zod-дефолты: пустой/усечённый документ парсится с заполнением недостающего (§22)', () => {
    expect(PREFS_SCHEMA.parse({})).toEqual(VALID_PREFS);
    expect(PREFS_SCHEMA.parse({ theme: 'dark' })).toEqual({ ...VALID_PREFS, theme: 'dark' });
  });

  it('все значения-enum принимаются по списку §5', () => {
    for (const theme of ['system', 'light', 'dark']) {
      expect(PREFS_SCHEMA.parse({ ...VALID_PREFS, theme })).toMatchObject({ theme });
    }
    for (const textScale of ['100', '112.5', '125']) {
      expect(PREFS_SCHEMA.parse({ ...VALID_PREFS, textScale })).toMatchObject({ textScale });
    }
    for (const dateFormat of ['auto', 'dmy', 'mdy']) {
      expect(PREFS_SCHEMA.parse({ ...VALID_PREFS, dateFormat })).toMatchObject({ dateFormat });
    }
  });

  it('мусор отклоняется: чужая тема, чужой масштаб, не-boolean, лишнее поле (strict)', () => {
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, theme: 'sepia' }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, textScale: 150 }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, dateFormat: 'ymd' }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, advancedMode: 'yes' }).success).toBe(false);
    expect(PREFS_SCHEMA.safeParse({ ...VALID_PREFS, stranger: 1 }).success).toBe(false);
    expect(
      PREFS_SCHEMA.safeParse({ ...VALID_PREFS, netConsents: { updatesCheck: 'yes' } }).success,
    ).toBe(false);
  });
});

describe('PREFS_PATCH_SCHEMA — patch set (§7/§11)', () => {
  it('пустой patch валиден (частичное обновление)', () => {
    expect(PREFS_PATCH_SCHEMA.parse({})).toEqual({});
  });

  it('неизвестное поле отброшено, валидные применены (AC5 strict-merge)', () => {
    const parsed = PREFS_PATCH_SCHEMA.parse({ theme: 'dark', hackerField: true });
    expect(parsed).toEqual({ theme: 'dark' });
  });

  it('неверный ТИП значения — ошибка (VALIDATION/FAILED каркаса, §11)', () => {
    expect(PREFS_PATCH_SCHEMA.safeParse({ theme: 123 }).success).toBe(false);
    expect(PREFS_PATCH_SCHEMA.safeParse({ textScale: '150' }).success).toBe(false);
    expect(PREFS_PATCH_SCHEMA.safeParse({ advancedMode: null }).success).toBe(false);
  });

  it('вложенные netConsents — объектом целиком (без deep-merge: один consent, §5)', () => {
    expect(PREFS_PATCH_SCHEMA.parse({ netConsents: { updatesCheck: true } })).toEqual({
      netConsents: { updatesCheck: true },
    });
    expect(PREFS_PATCH_SCHEMA.safeParse({ netConsents: {} }).success).toBe(false);
  });
});

describe('схемы каналов prefs/get|set (§11)', () => {
  it('prefs/get: запрос — строго пустой объект', () => {
    expect(PREFS_GET_REQUEST_SCHEMA.parse({})).toEqual({});
    expect(PREFS_GET_REQUEST_SCHEMA.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('prefs/set: запрос — {patch}, строго; ответ — полный документ', () => {
    const request = PREFS_SET_REQUEST_SCHEMA.parse({ patch: { theme: 'dark' } });
    expect(request.patch).toEqual({ theme: 'dark' });
    expect(PREFS_SET_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(PREFS_SET_REQUEST_SCHEMA.safeParse({ patch: { theme: 'dark' }, extra: 1 }).success).toBe(
      false,
    );

    expect(PREFS_SCHEMA.parse(VALID_PREFS)).toEqual(VALID_PREFS);
  });
});
