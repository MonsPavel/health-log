/**
 * TASK-089 §19/§20: тест-контракт каналов чата `ai/chat/*` (прецедент
 * summary-channels.test.ts TASK-087): strict-схемы (§14), период —
 * переиспользование STATS_PERIOD_PARAM_SCHEMA (§23 054), вопрос — валидация
 * zod ≥2 ≤500 (§13/§14: пустой вопрос → VALIDATION), refusalClass — машинный
 * класс отказа (политика 082) для пометки refusal-ответов в истории (§7).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AI_CHAT_CLEAR_REQUEST_SCHEMA,
  AI_CHAT_CLEAR_RESPONSE_SCHEMA,
  AI_CHAT_LIST_REQUEST_SCHEMA,
  AI_CHAT_LIST_RESPONSE_SCHEMA,
  AI_CHAT_SEND_REQUEST_SCHEMA,
  AI_CHAT_SEND_RESPONSE_SCHEMA,
  CHAT_MESSAGE_DTO_SCHEMA,
  type AiChatClearRequest,
  type AiChatClearResponse,
  type AiChatListRequest,
  type AiChatListResponse,
  type AiChatSendRequest,
  type AiChatSendResponse,
  type ChatMessageDto,
} from './chat-channels.js';

describe('ai/chat/send — контракт канала (TASK-089 §11)', () => {
  it('запрос {profileId, question, period} — strict, период переиспользует схему 054', () => {
    const ok = { profileId: 'p1', question: 'Почему вечером выше?', period: '30d' as const };
    expect(AI_CHAT_SEND_REQUEST_SCHEMA.parse(ok)).toEqual(ok);
    // custom-период — та же форма, что stats/trend/summary (§23).
    expect(
      AI_CHAT_SEND_REQUEST_SCHEMA.parse({
        profileId: 'p1',
        question: 'Как дела?',
        period: { fromUtcMs: 0, toUtcMs: 10 },
      }),
    ).toEqual({ profileId: 'p1', question: 'Как дела?', period: { fromUtcMs: 0, toUtcMs: 10 } });
    // strict: лишние поля отбраковываются (§14).
    expect(AI_CHAT_SEND_REQUEST_SCHEMA.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    // чужой период — отказ.
    expect(AI_CHAT_SEND_REQUEST_SCHEMA.safeParse({ ...ok, period: 'week' }).success).toBe(false);
  });

  it('вопрос — zod-валидация §13/§14: trim, ≥2 символа, ≤500', () => {
    const base = { profileId: 'p1', period: '7d' as const };
    // Пустой/пробельный вопрос → VALIDATION (каркас конвертирует отказ схемы).
    expect(AI_CHAT_SEND_REQUEST_SCHEMA.safeParse({ ...base, question: '' }).success).toBe(false);
    expect(AI_CHAT_SEND_REQUEST_SCHEMA.safeParse({ ...base, question: '  ' }).success).toBe(false);
    expect(AI_CHAT_SEND_REQUEST_SCHEMA.safeParse({ ...base, question: ' а ' }).success).toBe(false);
    // Границы: 2 символа ок, 500 ок, 501 — отказ.
    expect(AI_CHAT_SEND_REQUEST_SCHEMA.safeParse({ ...base, question: 'ок' }).success).toBe(true);
    expect(
      AI_CHAT_SEND_REQUEST_SCHEMA.safeParse({ ...base, question: 'б'.repeat(500) }).success,
    ).toBe(true);
    expect(
      AI_CHAT_SEND_REQUEST_SCHEMA.safeParse({ ...base, question: 'б'.repeat(501) }).success,
    ).toBe(false);
    // trim — часть схемы: пробелы по краям снимаются ДО парсинга (значение нормализовано).
    expect(AI_CHAT_SEND_REQUEST_SCHEMA.parse({ ...base, question: '  вопрос  ' }).question).toBe(
      'вопрос',
    );
  });

  it('ответ {requestId} — strict (стрим/финал — событиями, арх. 05 §3)', () => {
    expect(AI_CHAT_SEND_RESPONSE_SCHEMA.parse({ requestId: 'r-1' })).toEqual({ requestId: 'r-1' });
    expect(AI_CHAT_SEND_RESPONSE_SCHEMA.safeParse({ requestId: '' }).success).toBe(false);
    expect(AI_CHAT_SEND_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
  });

  it('типы выводятся из схем (z.infer, §23)', () => {
    expectTypeOf<AiChatSendRequest>().toEqualTypeOf<{
      profileId: string;
      question: string;
      period: '7d' | '30d' | '90d' | 'all' | { fromUtcMs: number; toUtcMs: number };
    }>();
    expectTypeOf<AiChatSendResponse>().toEqualTypeOf<{ requestId: string }>();
  });
});

describe('ChatMessageDto — проводная форма сообщения истории (TASK-089 §7)', () => {
  it('форма {id, role, content, refusalClass?, createdAtUtc} — strict; refusalClass опционален', () => {
    const user = {
      id: 'm-1',
      role: 'user' as const,
      content: 'Почему вечером выше?',
      createdAtUtc: 1000,
    };
    expect(CHAT_MESSAGE_DTO_SCHEMA.parse(user)).toEqual(user);
    const assistant = {
      id: 'm-2',
      role: 'assistant' as const,
      content: 'Вечерние значения выше утренних.',
      refusalClass: 'diagnosis' as const,
      createdAtUtc: 2000,
    };
    expect(CHAT_MESSAGE_DTO_SCHEMA.parse(assistant)).toEqual(assistant);
    // Чужая роль/класс — отказ; лишние поля — отказ (§14).
    expect(CHAT_MESSAGE_DTO_SCHEMA.safeParse({ ...user, role: 'system' }).success).toBe(false);
    expect(
      CHAT_MESSAGE_DTO_SCHEMA.safeParse({ ...user, refusalClass: 'medication' }).success,
    ).toBe(false);
    expect(CHAT_MESSAGE_DTO_SCHEMA.safeParse({ ...user, extra: 1 }).success).toBe(false);
  });

  it('типы выводятся из схем (z.infer, §23)', () => {
    expectTypeOf<ChatMessageDto>().toEqualTypeOf<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      refusalClass?: 'treatment' | 'dosage' | 'diagnosis' | 'emergency' | 'insufficientData';
      createdAtUtc: number;
    }>();
  });
});

describe('ai/chat/list — контракт канала инициализации UI (TASK-089 §11/§12)', () => {
  it('запрос {profileId, limit} — strict, limit — целое 1..200 (гигиена §14)', () => {
    expect(AI_CHAT_LIST_REQUEST_SCHEMA.parse({ profileId: 'p1', limit: 6 })).toEqual({
      profileId: 'p1',
      limit: 6,
    });
    expect(AI_CHAT_LIST_REQUEST_SCHEMA.safeParse({ profileId: 'p1', limit: 0 }).success).toBe(
      false,
    );
    expect(AI_CHAT_LIST_REQUEST_SCHEMA.safeParse({ profileId: 'p1', limit: 201 }).success).toBe(
      false,
    );
    expect(AI_CHAT_LIST_REQUEST_SCHEMA.safeParse({ profileId: 'p1', limit: 1.5 }).success).toBe(
      false,
    );
    expect(AI_CHAT_LIST_REQUEST_SCHEMA.safeParse({ profileId: 'p1' }).success).toBe(false);
  });

  it('ответ {messages} — массив DTO (пустая история — валидный ответ)', () => {
    expect(AI_CHAT_LIST_RESPONSE_SCHEMA.parse({ messages: [] })).toEqual({ messages: [] });
    const message = {
      id: 'm-1',
      role: 'assistant' as const,
      content: 'Ответ.',
      refusalClass: 'emergency' as const,
      createdAtUtc: 1,
    };
    expect(AI_CHAT_LIST_RESPONSE_SCHEMA.parse({ messages: [message] })).toEqual({
      messages: [message],
    });
    expect(AI_CHAT_LIST_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
  });

  it('типы выводятся из схем (z.infer, §23)', () => {
    expectTypeOf<AiChatListRequest>().toEqualTypeOf<{ profileId: string; limit: number }>();
    expectTypeOf<AiChatListResponse>().toEqualTypeOf<{ messages: ChatMessageDto[] }>();
  });
});

describe('ai/chat/clear — контракт канала очистки (TASK-089 §11/§13)', () => {
  it('запрос {} — strict; ответ {cleared: true} (идемпотентность §13 — всегда успех)', () => {
    expect(AI_CHAT_CLEAR_REQUEST_SCHEMA.parse({})).toEqual({});
    expect(AI_CHAT_CLEAR_REQUEST_SCHEMA.safeParse({ force: true }).success).toBe(false);
    expect(AI_CHAT_CLEAR_RESPONSE_SCHEMA.parse({ cleared: true })).toEqual({ cleared: true });
    expect(AI_CHAT_CLEAR_RESPONSE_SCHEMA.safeParse({ cleared: false }).success).toBe(false);
  });

  it('типы выводятся из схем (z.infer, §23)', () => {
    expectTypeOf<AiChatClearRequest>().toEqualTypeOf<{}>();
    expectTypeOf<AiChatClearResponse>().toEqualTypeOf<{ cleared: true }>();
  });
});
