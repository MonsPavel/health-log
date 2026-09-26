// TASK-028 §19: schema-тесты каналов измерений — валидные payload проходят; каждое
// нарушение (границы, sys≤dia, длинная note, лишнее поле strict, плохой arm) даёт
// конкретную ошибку zod; message схем — ключи i18n-каталога, не тексты (§10/§16–17).
// Числа границ дублируют домен (apps/desktop …/domain/constants.ts) с комментарием-
// синхронизацией — дрейф ловит синхронизационный контракт-тест (§19, apps/desktop).
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ChannelRequest, ChannelResponse } from '../channels.js';
import {
  MEASUREMENT_ADD_REQUEST_SCHEMA,
  MEASUREMENT_ADD_RESPONSE_SCHEMA,
  MEASUREMENT_DELETE_REQUEST_SCHEMA,
  MEASUREMENT_DELETE_RESPONSE_SCHEMA,
  MEASUREMENT_DTO_SCHEMA,
  MEASUREMENT_LIST_REQUEST_SCHEMA,
  MEASUREMENT_LIST_RESPONSE_SCHEMA,
  MEASUREMENT_TYPO_FLAG_SCHEMA,
  MEASUREMENT_UPDATE_REQUEST_SCHEMA,
  MEASUREMENT_UPDATE_RESPONSE_SCHEMA,
} from './schemas.js';
import type {
  MeasurementAddRequest,
  MeasurementAddResponse,
  MeasurementDto,
  MeasurementListRequest,
  TypoFlagDto,
} from './types.js';

/** Фиксированный момент (2025-09-25T16:00:00Z) — синхронно с доменными тестами TASK-017. */
const NOW_MS = 1_758_816_000_000;

/** Валидный запрос add: все поля, включая опциональные (§11). */
const VALID_ADD = {
  profileId: 'seed-profile-0001',
  sys: 120,
  dia: 80,
  pulse: 70,
  irregularPulse: false,
  arm: 'left',
  note: 'после пробежки',
  takenAt: { utcMs: NOW_MS - 60_000, tzOffsetMin: 180 },
} satisfies MeasurementAddRequest;

/** Валидный MeasurementDto: мгновенно-читаемая плоская форма агрегата (§7). */
const VALID_DTO = {
  id: '0195e0a5-8c7b-7000-8000-000000000001',
  profileId: 'seed-profile-0001',
  sys: 120,
  dia: 80,
  pulse: 70,
  irregularPulse: false,
  arm: 'left',
  note: 'после пробежки',
  takenAtUtcMs: NOW_MS - 60_000,
  tzOffsetMin: 180,
  source: 'manual',
  createdAtUtcMs: NOW_MS,
  updatedAtUtcMs: NOW_MS,
} satisfies MeasurementDto;

/** Первый issue неудачного парса — для проверки «message = ключ i18n» (§10). */
function firstMessage(
  schema: { safeParse(p: unknown): { success: boolean; error?: { issues: { message: string }[] } } },
  payload: unknown,
): string {
  const result = schema.safeParse(payload);
  expect(result.success).toBe(false);
  return result.error!.issues[0]!.message;
}

describe('MEASUREMENT_ADD_REQUEST_SCHEMA — валидные payload (§11)', () => {
  it('принимает полный payload со всеми полями', () => {
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse(VALID_ADD).success).toBe(true);
  });

  it('принимает payload без опциональных pulse и note (FR-1.1: ЧСС опциональна)', () => {
    const { pulse: _pulse, note: _note, ...minimal } = VALID_ADD;
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse(minimal).success).toBe(true);
  });

  it('границы СДА/ДДА/ЧСС — включительно (SRS FR-1.2: 50–300, 20–200, 20–300)', () => {
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, sys: 50, dia: 20, pulse: 20 }).success).toBe(true);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, sys: 300, dia: 200, pulse: 300 }).success).toBe(true);
  });

  it('границы tzOffsetMin [-720, +840] включительно (§13: UTC−12…+14)', () => {
    expect(
      MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, takenAt: { utcMs: NOW_MS, tzOffsetMin: -720 } })
        .success,
    ).toBe(true);
    expect(
      MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, takenAt: { utcMs: NOW_MS, tzOffsetMin: 840 } }).success,
    ).toBe(true);
  });

  it('заметка ровно 500 символов — ок (§13: 500 ок, 501 — NOTE_TOO_LONG)', () => {
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, note: 'а'.repeat(500) }).success).toBe(true);
  });

  it('seed-profile-0001 — валидный profileId (§14: длина, не uuid-regex)', () => {
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse(VALID_ADD).success).toBe(true);
  });
});

describe('MEASUREMENT_ADD_REQUEST_SCHEMA — нарушения дают конкретные ошибки (§19)', () => {
  it('СДА вне [50, 300] → message errors.rangeSys (границы 49/301)', () => {
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, sys: 49 })).toBe('errors.rangeSys');
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, sys: 301 })).toBe('errors.rangeSys');
  });

  it('нецелое СДА → errors.rangeSys (порядок домена §7: «целые → диапазоны»); не-число — просто отказ', () => {
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, sys: 120.5 })).toBe('errors.rangeSys');
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, sys: '120' }).success).toBe(false);
  });

  it('ДДА вне [20, 200] → errors.rangeDia (границы 19/201)', () => {
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, dia: 19 })).toBe('errors.rangeDia');
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, dia: 201 })).toBe('errors.rangeDia');
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, dia: 80.5 })).toBe('errors.rangeDia');
  });

  it('ЧСС вне [20, 300] → errors.rangePulse (границы 19/301, нецелое)', () => {
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, pulse: 19 })).toBe('errors.rangePulse');
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, pulse: 301 })).toBe('errors.rangePulse');
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, pulse: 70.5 })).toBe('errors.rangePulse');
  });

  it('sys ≤ dia → errors.sysLeDia (инвариант VO BloodPressure, TASK-016)', () => {
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, sys: 120, dia: 120 })).toBe('errors.sysLeDia');
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, sys: 80, dia: 120 })).toBe('errors.sysLeDia');
  });

  it('заметка 501 символ → errors.noteTooLong (§16–17)', () => {
    expect(firstMessage(MEASUREMENT_ADD_REQUEST_SCHEMA, { ...VALID_ADD, note: 'а'.repeat(501) })).toBe(
      'errors.noteTooLong',
    );
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, note: 42 }).success).toBe(false);
  });

  it(`плохой arm → отказ; 'left'/'right' проходят (синхронизация с ARM_VALUES, TASK-016)`, () => {
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, arm: 'center' }).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, arm: 'LEFT' }).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, arm: 1 }).success).toBe(false);
  });

  it('irregularPulse — только boolean (§13: флаг без ограничений-валидации)', () => {
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, irregularPulse: 'no' }).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, irregularPulse: true }).success).toBe(true);
  });

  it('takenAt.utcMs — только целое; «не будущее» схемой НЕ проверяется (§13: вердикт домена)', () => {
    expect(
      MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, takenAt: { utcMs: NOW_MS + 0.5, tzOffsetMin: 180 } })
        .success,
    ).toBe(false);
    // Будущее время (на год вперёд) схема пропускает — осознанно (§13).
    expect(
      MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, takenAt: { utcMs: NOW_MS + 365 * 86_400_000, tzOffsetMin: 180 } })
        .success,
    ).toBe(true);
  });

  it('tzOffsetMin вне [-720, 840] → отказ (границы −721/841)', () => {
    expect(
      MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, takenAt: { utcMs: NOW_MS, tzOffsetMin: -721 } }).success,
    ).toBe(false);
    expect(
      MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, takenAt: { utcMs: NOW_MS, tzOffsetMin: 841 } }).success,
    ).toBe(false);
  });

  it(`profileId — непустая строка ≤64 (§14); '' и 65 символов отклоняются`, () => {
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, profileId: '' }).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, profileId: 'п'.repeat(65) }).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, profileId: 'п'.repeat(64) }).success).toBe(true);
  });

  it('strict: лишнее поле на верхнем уровне и внутри takenAt отклоняется (§14: IPC-гигиена)', () => {
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, source: 'manual' }).success).toBe(false);
    expect(
      MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse({ ...VALID_ADD, takenAt: { ...VALID_ADD.takenAt, wall: 'x' } }).success,
    ).toBe(false);
  });

  it('обязательные поля отсутствуют → отказ; не-объекты отклоняются', () => {
    const { profileId: _p, ...noProfile } = VALID_ADD;
    const { sys: _s, ...noSys } = VALID_ADD;
    const { irregularPulse: _i, ...noIrregular } = VALID_ADD;
    const { takenAt: _t, ...noTakenAt } = VALID_ADD;
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse(noProfile).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse(noSys).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse(noIrregular).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse(noTakenAt).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse(null).success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse('add').success).toBe(false);
    expect(MEASUREMENT_ADD_REQUEST_SCHEMA.safeParse([]).success).toBe(false);
  });
});

describe('MEASUREMENT_LIST_REQUEST_SCHEMA — query из TASK-021-порта (§5/§11)', () => {
  it('минимальный {profileId} получает дефолты limit=200, offset=0 (§11)', () => {
    const parsed = MEASUREMENT_LIST_REQUEST_SCHEMA.parse({ profileId: 'seed-profile-0001' });
    expect(parsed).toEqual({ profileId: 'seed-profile-0001', limit: 200, offset: 0 });
  });

  it('полный query со всеми фильтрами проходит (порт: from/to включительно, §13)', () => {
    expect(
      MEASUREMENT_LIST_REQUEST_SCHEMA.safeParse({
        profileId: 'seed-profile-0001',
        fromUtcMs: NOW_MS - 86_400_000,
        toUtcMs: NOW_MS,
        arm: 'right',
        hasNote: true,
        limit: 50,
        offset: 100,
      }).success,
    ).toBe(true);
  });

  it('лимит/смещение — целые неотрицательные; нецелое/отрицательное отклоняется', () => {
    expect(MEASUREMENT_LIST_REQUEST_SCHEMA.safeParse({ profileId: 'p', limit: -1 }).success).toBe(false);
    expect(MEASUREMENT_LIST_REQUEST_SCHEMA.safeParse({ profileId: 'p', limit: 10.5 }).success).toBe(false);
    expect(MEASUREMENT_LIST_REQUEST_SCHEMA.safeParse({ profileId: 'p', offset: -1 }).success).toBe(false);
  });

  it('плохой arm и лишние поля отклоняются; profileId обязателен', () => {
    expect(MEASUREMENT_LIST_REQUEST_SCHEMA.safeParse({ profileId: 'p', arm: 'both' }).success).toBe(false);
    expect(MEASUREMENT_LIST_REQUEST_SCHEMA.safeParse({ profileId: 'p', order: 'desc' }).success).toBe(false);
    expect(MEASUREMENT_LIST_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
  });
});

describe('MEASUREMENT_UPDATE_REQUEST_SCHEMA — dto+id (§5/§11)', () => {
  /** Update = id + измеримые поля; profileId НЕ входит: наследуется записью (TASK-017 edit), перенос между профилями не выражается. */
  const VALID_UPDATE = { id: VALID_DTO.id, ...VALID_ADD } as { [k: string]: unknown };
  delete VALID_UPDATE.profileId;

  it('принимает {id, …измеримые поля add}', () => {
    expect(MEASUREMENT_UPDATE_REQUEST_SCHEMA.safeParse(VALID_UPDATE).success).toBe(true);
  });

  it('sys ≤ dia и границы проверяются так же, как в add', () => {
    expect(firstMessage(MEASUREMENT_UPDATE_REQUEST_SCHEMA, { ...VALID_UPDATE, sys: 49 })).toBe('errors.rangeSys');
    expect(firstMessage(MEASUREMENT_UPDATE_REQUEST_SCHEMA, { ...VALID_UPDATE, sys: 120, dia: 120 })).toBe(
      'errors.sysLeDia',
    );
  });

  it('без id → отказ; profileId лишний (strict, §14; перенос между профилями не выражается)', () => {
    const { id: _id, ...noId } = VALID_UPDATE;
    expect(MEASUREMENT_UPDATE_REQUEST_SCHEMA.safeParse(noId).success).toBe(false);
    expect(MEASUREMENT_UPDATE_REQUEST_SCHEMA.safeParse({ ...VALID_UPDATE, profileId: 'p' }).success).toBe(false);
  });
});

describe('MEASUREMENT_DELETE_REQUEST_SCHEMA — {id} (§5/§11)', () => {
  it('принимает {id}; без id и с лишним полем — отказ', () => {
    expect(MEASUREMENT_DELETE_REQUEST_SCHEMA.safeParse({ id: VALID_DTO.id }).success).toBe(true);
    expect(MEASUREMENT_DELETE_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(MEASUREMENT_DELETE_REQUEST_SCHEMA.safeParse({ id: VALID_DTO.id, profileId: 'p' }).success).toBe(false);
  });
});

describe('MEASUREMENT_DTO_SCHEMA — плоская форма агрегата (§7)', () => {
  it('принимает полный DTO; source manual/import — оба валидны', () => {
    expect(MEASUREMENT_DTO_SCHEMA.safeParse(VALID_DTO).success).toBe(true);
    expect(MEASUREMENT_DTO_SCHEMA.safeParse({ ...VALID_DTO, source: 'import' }).success).toBe(true);
    expect(MEASUREMENT_DTO_SCHEMA.safeParse({ ...VALID_DTO, source: 'sync' }).success).toBe(false);
  });

  it('pulse/note — опциональны; обязательные поля отсутствуют → отказ', () => {
    const { pulse: _p, note: _n, ...noOptionals } = VALID_DTO;
    expect(MEASUREMENT_DTO_SCHEMA.safeParse(noOptionals).success).toBe(true);
    const { id: _id, ...noId } = VALID_DTO;
    expect(MEASUREMENT_DTO_SCHEMA.safeParse(noId).success).toBe(false);
    const { takenAtUtcMs: _t, ...noTaken } = VALID_DTO;
    expect(MEASUREMENT_DTO_SCHEMA.safeParse(noTaken).success).toBe(false);
  });

  it('strict: лишнее поле DTO отклоняется', () => {
    expect(MEASUREMENT_DTO_SCHEMA.safeParse({ ...VALID_DTO, flags: {} }).success).toBe(false);
  });
});

describe('флаги эвристик в ответе add (§5/§11)', () => {
  it('TypoFlagDto: {field, median, value, deviation}; поле — только sys|dia (TASK-018)', () => {
    const typo: TypoFlagDto = { field: 'sys', median: 125.5, value: 215, deviation: 89.5 };
    expect(MEASUREMENT_TYPO_FLAG_SCHEMA.safeParse(typo).success).toBe(true);
    expect(MEASUREMENT_TYPO_FLAG_SCHEMA.safeParse({ ...typo, field: 'pulse' }).success).toBe(false);
    expect(MEASUREMENT_TYPO_FLAG_SCHEMA.safeParse({ ...typo, extra: 1 }).success).toBe(false);
    expect(MEASUREMENT_TYPO_FLAG_SCHEMA.safeParse({ field: 'sys', median: 125 }).success).toBe(false);
  });

  it('ответ add: {measurement, flags} — пустые флаги валидны, неизвестные значения отклоняются', () => {
    expect(
      MEASUREMENT_ADD_RESPONSE_SCHEMA.safeParse({ measurement: VALID_DTO, flags: {} }).success,
    ).toBe(true);
    expect(
      MEASUREMENT_ADD_RESPONSE_SCHEMA.safeParse({
        measurement: VALID_DTO,
        flags: { typo: { field: 'dia', median: 80, value: 130, deviation: 50 }, duplicate: true, criticalValue: 'low' },
      }).success,
    ).toBe(true);
    expect(
      MEASUREMENT_ADD_RESPONSE_SCHEMA.safeParse({ measurement: VALID_DTO, flags: { criticalValue: 'medium' } }).success,
    ).toBe(false);
    expect(
      MEASUREMENT_ADD_RESPONSE_SCHEMA.safeParse({ measurement: VALID_DTO, flags: { duplicate: 'yes' } }).success,
    ).toBe(false);
    expect(
      MEASUREMENT_ADD_RESPONSE_SCHEMA.safeParse({ measurement: VALID_DTO, flags: { typo: undefined, extra: 1 } })
        .success,
    ).toBe(false);
  });

  it('без flags или без measurement → отказ (flags — обязательная часть ответа add)', () => {
    expect(MEASUREMENT_ADD_RESPONSE_SCHEMA.safeParse({ measurement: VALID_DTO }).success).toBe(false);
    expect(MEASUREMENT_ADD_RESPONSE_SCHEMA.safeParse({ flags: {} }).success).toBe(false);
  });
});

describe('ответы list/update/delete (§11)', () => {
  it('list: {items: MeasurementDto[], total} — пустой список и наполненный проходят', () => {
    expect(MEASUREMENT_LIST_RESPONSE_SCHEMA.safeParse({ items: [], total: 0 }).success).toBe(true);
    expect(MEASUREMENT_LIST_RESPONSE_SCHEMA.safeParse({ items: [VALID_DTO], total: 1 }).success).toBe(true);
    expect(MEASUREMENT_LIST_RESPONSE_SCHEMA.safeParse({ items: [VALID_DTO], total: '1' }).success).toBe(false);
    expect(MEASUREMENT_LIST_RESPONSE_SCHEMA.safeParse({ items: [], total: 0, next: 2 }).success).toBe(false);
  });

  it('update: {measurement} — только DTO', () => {
    expect(MEASUREMENT_UPDATE_RESPONSE_SCHEMA.safeParse({ measurement: VALID_DTO }).success).toBe(true);
    expect(MEASUREMENT_UPDATE_RESPONSE_SCHEMA.safeParse({ measurement: VALID_DTO, flags: {} }).success).toBe(false);
  });

  it('delete: {deleted: true} — литерал true', () => {
    expect(MEASUREMENT_DELETE_RESPONSE_SCHEMA.safeParse({ deleted: true }).success).toBe(true);
    expect(MEASUREMENT_DELETE_RESPONSE_SCHEMA.safeParse({ deleted: false }).success).toBe(false);
    expect(MEASUREMENT_DELETE_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
  });
});

describe('типы выводятся из схем (§23: без ручной синхронизации)', () => {
  it('MeasurementAddRequest — форма запроса add', () => {
    expectTypeOf<MeasurementAddRequest>().toEqualTypeOf<{
      profileId: string;
      sys: number;
      dia: number;
      pulse?: number;
      irregularPulse: boolean;
      arm: 'left' | 'right';
      note?: string;
      takenAt: { utcMs: number; tzOffsetMin: number };
    }>();
  });

  it('MeasurementDto — плоская форма агрегата (§7)', () => {
    expectTypeOf<MeasurementDto>().toEqualTypeOf<{
      id: string;
      profileId: string;
      sys: number;
      dia: number;
      pulse?: number;
      irregularPulse: boolean;
      arm: 'left' | 'right';
      note?: string;
      takenAtUtcMs: number;
      tzOffsetMin: number;
      source: 'manual' | 'import';
      createdAtUtcMs: number;
      updatedAtUtcMs: number;
    }>();
  });

  it('ChannelRequest/ChannelResponse для 4 каналов выводятся из реестра', () => {
    expectTypeOf<ChannelRequest<'measurements/add'>>().toEqualTypeOf<MeasurementAddRequest>();
    expectTypeOf<ChannelResponse<'measurements/add'>>().toEqualTypeOf<MeasurementAddResponse>();
    expectTypeOf<ChannelRequest<'measurements/list'>>().toEqualTypeOf<MeasurementListRequest>();
    // Дефолты limit/offset в выходном типе обязательны (z.output).
    expectTypeOf<MeasurementListRequest>().toEqualTypeOf<{
      profileId: string;
      fromUtcMs?: number;
      toUtcMs?: number;
      arm?: 'left' | 'right';
      hasNote?: boolean;
      limit: number;
      offset: number;
    }>();
  });
});
