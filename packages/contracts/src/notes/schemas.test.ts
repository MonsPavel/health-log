// TASK-045 §5/§11/§19: схемы канала `notes/search` — FTS-поиск заметок (FR-2.2).
// Запрос: {query ≤100 (анти-DoS §7), limit? int ≤200, дефолт 50 — §2/§11}; ответ:
// {items: MeasurementDto[]} (§11). Мусорный/пустой запрос — НЕ ошибка схемы: строки
// любой непустой валидны, осмысленность решает use case (§11: ошибки только APP/INTERNAL).
import { describe, expect, expectTypeOf, it } from 'vitest';

import { type ChannelName } from '../channels.js';
import { CHANNEL_SCHEMAS } from '../schemas.js';
import type { MeasurementDto } from '../measurement/types.js';
import type { NotesSearchRequest, NotesSearchResponse } from './types.js';
import { NOTES_SEARCH_REQUEST_SCHEMA, NOTES_SEARCH_RESPONSE_SCHEMA } from './schemas.js';

const VALID_DTO = {
  id: '01234567-89ab-cdef-0123-456789abcdef',
  profileId: 'seed-profile-0001',
  sys: 120,
  dia: 80,
  irregularPulse: false,
  arm: 'left',
  note: 'после кофе',
  takenAtUtcMs: 1_700_000_000_000,
  tzOffsetMin: 180,
  source: 'manual',
  createdAtUtcMs: 1_700_000_000_000,
  updatedAtUtcMs: 1_700_000_000_000,
} as const;

describe('NOTES_SEARCH_REQUEST_SCHEMA — запрос notes/search (§11)', () => {
  it('принимает {query}; limit дефолтится карманом в 50 (§2)', () => {
    const parsed = NOTES_SEARCH_REQUEST_SCHEMA.parse({ query: 'болела голова' });
    expect(parsed).toEqual({ query: 'болела голова', limit: 50 });
  });

  it('принимает {query, limit}; пустая строка query — валидна (§20: empty → пустой результат ok)', () => {
    expect(NOTES_SEARCH_REQUEST_SCHEMA.parse({ query: 'кофе', limit: 10 })).toEqual({
      query: 'кофе',
      limit: 10,
    });
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: '' }).success).toBe(true);
  });

  it('query >100 символов отклоняется (§7: анти-DoS гигиена)', () => {
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: 'а'.repeat(100) }).success).toBe(true);
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: 'а'.repeat(101) }).success).toBe(false);
  });

  it('limit: только целое 1–200; 0/201/дробное отклоняются', () => {
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: 'q', limit: 1 }).success).toBe(true);
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: 'q', limit: 200 }).success).toBe(true);
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: 'q', limit: 0 }).success).toBe(false);
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: 'q', limit: 201 }).success).toBe(false);
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: 'q', limit: 1.5 }).success).toBe(false);
  });

  it('strict: лишние поля и не-строковый query отклоняются (§14 IPC-гигиена)', () => {
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: 'q', extra: 1 }).success).toBe(false);
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({ query: 42 }).success).toBe(false);
    expect(NOTES_SEARCH_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
  });
});

describe('NOTES_SEARCH_RESPONSE_SCHEMA — ответ notes/search (§11: {items})', () => {
  it('принимает {items: MeasurementDto[]} и отклоняет форму без items / с лишним полем', () => {
    expect(NOTES_SEARCH_RESPONSE_SCHEMA.parse({ items: [VALID_DTO] })).toEqual({
      items: [VALID_DTO],
    });
    expect(NOTES_SEARCH_RESPONSE_SCHEMA.safeParse({ items: [] }).success).toBe(true);
    expect(NOTES_SEARCH_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
    expect(
      NOTES_SEARCH_RESPONSE_SCHEMA.safeParse({ items: [], total: 0 }).success,
    ).toBe(false);
  });

  it('элемент items обязан быть полным MeasurementDto (строгая схема TASK-028)', () => {
    expect(NOTES_SEARCH_RESPONSE_SCHEMA.safeParse({ items: [{ id: 'x' }] }).success).toBe(false);
  });
});

describe('реестр каналов — notes/search (§11)', () => {
  it('CHANNEL_SCHEMAS содержит notes/search с этими схемами', () => {
    expect(CHANNEL_SCHEMAS['notes/search']?.request).toBe(NOTES_SEARCH_REQUEST_SCHEMA);
    expect(CHANNEL_SCHEMAS['notes/search']?.response).toBe(NOTES_SEARCH_RESPONSE_SCHEMA);
  });

  it("ChannelName включает 'notes/search'", () => {
    expectTypeOf<ChannelName>().toEqualTypeOf<
      | 'app/ping'
      | 'app/log-client-error'
      | 'measurements/add'
      | 'measurements/list'
      | 'measurements/update'
      | 'measurements/delete'
      | 'notes/search'
    >();
  });

  it('типы запроса/ответа выводятся из схем (§23: без ручной синхронизации)', () => {
    expectTypeOf<NotesSearchRequest>().toEqualTypeOf<{ query: string; limit: number }>();
    expectTypeOf<NotesSearchResponse>().toEqualTypeOf<{ items: MeasurementDto[] }>();
  });
});
