/**
 * TASK-076 §19: тест-контракт MessagePort-протокола llm-worker (contracts —
 * единый источник форм сообщений для main-клиента и воркера).
 *
 * Проверки:
 *  1. Типы сообщений обеих сторон (§5): запросы {load|unload|complete|cancel},
 *     ответы {ready|unloaded|token|done|error} — expectTypeOf фиксирует форму;
 *  2. Runtime-guard'ы (§14, защита в глубине — прецедент workerpool/protocol.ts):
 *     валидные сообщения проходят, мусор канала/повреждённые формы — нет;
 *  3. Ошибки ответа (§5): {type:'error'} несёт code и ОПЦИОНАЛЬНЫЙ requestId
 *     (глобальная ошибка — без requestId; адресная — с ним).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  isWorkerRequest,
  isWorkerResponse,
  type ChatMessage,
  type LlmFinishReason,
  type WorkerRequest,
  type WorkerResponse,
} from './worker-protocol.js';

describe('WorkerRequest — формы запросов main → worker (§5)', () => {
  it('load несёт modelPath', () => {
    expectTypeOf<Extract<WorkerRequest, { type: 'load' }>>().toEqualTypeOf<{
      readonly type: 'load';
      readonly modelPath: string;
    }>();
  });

  it('complete несёт requestId, messages, params, maxTokens', () => {
    expectTypeOf<Extract<WorkerRequest, { type: 'complete' }>['messages']>().toEqualTypeOf<
      readonly ChatMessage[]
    >();
    expectTypeOf<
      Extract<WorkerRequest, { type: 'complete' }>['maxTokens']
    >().toEqualTypeOf<number>();
  });

  it('guard пропускает все четыре формы и отклоняет мусор', () => {
    expect(isWorkerRequest({ type: 'load', modelPath: 'C:/m/gguf' })).toBe(true);
    expect(isWorkerRequest({ type: 'unload' })).toBe(true);
    expect(
      isWorkerRequest({
        type: 'complete',
        requestId: 'r1',
        messages: [{ role: 'user', content: 'привет' }],
        params: { temperature: 0.2 },
        maxTokens: 256,
      }),
    ).toBe(true);
    expect(isWorkerRequest({ type: 'cancel', requestId: 'r1' })).toBe(true);

    expect(isWorkerRequest(null)).toBe(false);
    expect(isWorkerRequest('load')).toBe(false);
    expect(isWorkerRequest({ type: 'unknown' })).toBe(false);
    expect(isWorkerRequest({ type: 'load' })).toBe(false); // нет modelPath
    expect(isWorkerRequest({ type: 'cancel' })).toBe(false); // нет requestId
    expect(
      isWorkerRequest({ type: 'complete', requestId: 'r1', messages: 'текст', maxTokens: 4 }),
    ).toBe(false); // messages — не массив
    expect(
      isWorkerRequest({
        type: 'complete',
        requestId: 'r1',
        messages: [{ role: 'widget', content: 'x' }],
        maxTokens: 4,
      }),
    ).toBe(false); // неизвестная роль
  });
});

describe('WorkerResponse — формы ответов worker → main (§5)', () => {
  it('done несёт requestId и finishReason stop|cancelled (§7)', () => {
    expectTypeOf<Extract<WorkerResponse, { type: 'done' }>>().toEqualTypeOf<{
      readonly type: 'done';
      readonly requestId: string;
      readonly finishReason: LlmFinishReason;
    }>();
    expectTypeOf<LlmFinishReason>().toEqualTypeOf<'stop' | 'cancelled'>();
  });

  it('token несёт requestId и delta', () => {
    expectTypeOf<Extract<WorkerResponse, { type: 'token' }>>().toEqualTypeOf<{
      readonly type: 'token';
      readonly requestId: string;
      readonly delta: string;
    }>();
  });

  it('error несёт code; requestId опционален — глобальная ошибка адресата не имеет (§5)', () => {
    expect(isWorkerResponse({ type: 'error', code: 'ENGINE_NOT_CONFIGURED' })).toBe(true);
    expect(isWorkerResponse({ type: 'error', requestId: 'r1', code: 'BUSY' })).toBe(true);
    expect(isWorkerResponse({ type: 'error' })).toBe(false); // нет code
  });

  it('guard пропускает все пять форм и отклоняет мусор', () => {
    expect(isWorkerResponse({ type: 'ready' })).toBe(true);
    expect(isWorkerResponse({ type: 'unloaded' })).toBe(true);
    expect(isWorkerResponse({ type: 'token', requestId: 'r1', delta: 'т' })).toBe(true);
    expect(isWorkerResponse({ type: 'done', requestId: 'r1', finishReason: 'stop' })).toBe(true);

    expect(isWorkerResponse(undefined)).toBe(false);
    expect(isWorkerResponse({})).toBe(false);
    expect(isWorkerResponse({ type: 'status' })).toBe(false);
    expect(isWorkerResponse({ type: 'token', requestId: 'r1' })).toBe(false); // нет delta
    expect(isWorkerResponse({ type: 'done', requestId: 'r1', finishReason: 'чудо' })).toBe(false);
    expect(isWorkerResponse({ type: 'ready', extra: true })).toBe(false); // посторонние поля
  });

  it('ответы не содержат полей содержимого генерации, кроме delta (§14: payload-гигиена)', () => {
    // Единственное текстовое поле воркер → main — delta стрима; prompts/контекст
    // через протокол воркера наружу (renderer) не идут вовсе.
    expect(
      isWorkerResponse({ type: 'done', requestId: 'r1', finishReason: 'stop', text: 'x' }),
    ).toBe(false);
  });
});
