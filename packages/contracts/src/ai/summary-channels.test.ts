/**
 * TASK-087 §19/§20: тест-контракт каналов резюме `ai/summary/*` — состав и формы
 * (прецедент models-channels.test.ts TASK-081): strict-схемы (§14), период —
 * переиспользование STATS_PERIOD_PARAM_SCHEMA (§23 054: копий периода не создавать),
 * PHI-гигиена payload'а (contentMd — только в DTO ответа владельцу, §14).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AI_SUMMARY_DTO_SCHEMA,
  AI_SUMMARY_GENERATE_REQUEST_SCHEMA,
  AI_SUMMARY_GENERATE_RESPONSE_SCHEMA,
  AI_SUMMARY_LATEST_REQUEST_SCHEMA,
  AI_SUMMARY_LATEST_RESPONSE_SCHEMA,
  type AiSummaryDto,
  type AiSummaryGenerateRequest,
  type AiSummaryGenerateResponse,
  type AiSummaryLatestRequest,
  type AiSummaryLatestResponse,
} from './summary-channels.js';

describe('ai/summary/generate — контракт канала (TASK-087 §11)', () => {
  it('запрос {profileId, period, includeNotes} — strict, период переиспользует схему 054', () => {
    const ok = {
      profileId: 'p1',
      period: '30d' as const,
      includeNotes: false,
    };
    expect(AI_SUMMARY_GENERATE_REQUEST_SCHEMA.parse(ok)).toEqual(ok);
    // custom-период — та же форма, что stats/trend (§23).
    expect(
      AI_SUMMARY_GENERATE_REQUEST_SCHEMA.parse({
        profileId: 'p1',
        period: { fromUtcMs: 0, toUtcMs: 10 },
        includeNotes: true,
      }),
    ).toEqual({ profileId: 'p1', period: { fromUtcMs: 0, toUtcMs: 10 }, includeNotes: true });
    // strict: лишние поля отбраковываются (§14).
    expect(
      AI_SUMMARY_GENERATE_REQUEST_SCHEMA.safeParse({ ...ok, extra: 1 }).success,
    ).toBe(false);
    // периода нет/чужой — отказ.
    expect(AI_SUMMARY_GENERATE_REQUEST_SCHEMA.safeParse({ ...ok, period: 'week' }).success).toBe(
      false,
    );
  });

  it('ответ {requestId} — strict', () => {
    expect(AI_SUMMARY_GENERATE_RESPONSE_SCHEMA.parse({ requestId: 'r-1' })).toEqual({
      requestId: 'r-1',
    });
    expect(AI_SUMMARY_GENERATE_RESPONSE_SCHEMA.safeParse({ requestId: '' }).success).toBe(false);
    expect(AI_SUMMARY_GENERATE_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
  });

  it('типы выводятся из схем (z.infer, §23)', () => {
    expectTypeOf<AiSummaryGenerateRequest>().toEqualTypeOf<{
      profileId: string;
      period: '7d' | '30d' | '90d' | 'all' | { fromUtcMs: number; toUtcMs: number };
      includeNotes: boolean;
    }>();
    expectTypeOf<AiSummaryGenerateResponse>().toEqualTypeOf<{ requestId: string }>();
  });
});

describe('ai/summary/latest — контракт мини-канала стейлс-бейджа (§12)', () => {
  it('запрос {profileId, period} — strict, без includeNotes (бейджу заметки не нужны)', () => {
    expect(AI_SUMMARY_LATEST_REQUEST_SCHEMA.parse({ profileId: 'p1', period: '7d' })).toEqual({
      profileId: 'p1',
      period: '7d',
    });
    expect(
      AI_SUMMARY_LATEST_REQUEST_SCHEMA.safeParse({
        profileId: 'p1',
        period: '7d',
        includeNotes: true,
      }).success,
    ).toBe(false);
  });

  it('DTO резюме — строгая форма: служебные поля отдельно от content_md (§5/§20 п.6)', () => {
    const dto = {
      id: 's-1',
      periodStartUtc: 1000,
      periodEndUtc: 2000,
      modelId: 'm',
      modelVersion: '1.0.0',
      dataVersion: 3,
      contentMd: 'Разбор',
      disclaimerText: 'Это не медицинская консультация.',
      periodText: 'последние 7 дней',
      createdAtUtc: 5000,
    };
    expect(AI_SUMMARY_DTO_SCHEMA.parse(dto)).toEqual(dto);
    // Пустое служебное поле запрещено контрактом (инвариант §20 п.6 — заполнены всегда).
    expect(AI_SUMMARY_DTO_SCHEMA.safeParse({ ...dto, disclaimerText: '' }).success).toBe(false);
    expect(AI_SUMMARY_DTO_SCHEMA.safeParse({ ...dto, periodText: '' }).success).toBe(false);
    expect(AI_SUMMARY_DTO_SCHEMA.safeParse({ ...dto, extra: 1 }).success).toBe(false);
  });

  it('ответ {summary, stale}|undefined — найдено и «ещё нет резюме» различимы', () => {
    const dto = {
      id: 's-1',
      periodStartUtc: 1,
      periodEndUtc: 2,
      modelId: 'm',
      modelVersion: '1',
      dataVersion: 1,
      contentMd: 'x',
      disclaimerText: 'd',
      periodText: 'p',
      createdAtUtc: 3,
    };
    expect(AI_SUMMARY_LATEST_RESPONSE_SCHEMA.parse({ summary: dto, stale: true })).toEqual({
      summary: dto,
      stale: true,
    });
    expect(AI_SUMMARY_LATEST_RESPONSE_SCHEMA.parse(undefined)).toBeUndefined();
    expect(AI_SUMMARY_LATEST_RESPONSE_SCHEMA.safeParse(null).success).toBe(false);
  });

  it('типы выводятся из схем (z.infer, §23)', () => {
    expectTypeOf<AiSummaryLatestRequest>().toEqualTypeOf<{
      profileId: string;
      period: '7d' | '30d' | '90d' | 'all' | { fromUtcMs: number; toUtcMs: number };
    }>();
    expectTypeOf<AiSummaryDto>().toEqualTypeOf<{
      id: string;
      periodStartUtc: number;
      periodEndUtc: number;
      modelId: string;
      modelVersion: string;
      dataVersion: number;
      contentMd: string;
      disclaimerText: string;
      periodText: string;
      createdAtUtc: number;
    }>();
    expectTypeOf<AiSummaryLatestResponse>().toEqualTypeOf<
      { summary: AiSummaryDto; stale: boolean } | undefined
    >();
  });
});
