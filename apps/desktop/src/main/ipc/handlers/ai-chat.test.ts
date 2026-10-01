/**
 * TASK-089 §5/§11: юнит-тесты хендлеров ai/chat/* (слой тонкий, прецедент
 * ai-summary.test.ts TASK-087/088; §19 подмены):
 *  1. send: мгновенный ответ {requestId} — фоновый запуск use case не держит
 *     вызов IPC (арх. 05 §3 «стриминг»); requestId уникален и совпадает с командой;
 *  2. send: BUSY — если use case занят (isBusy), отказ AI/BUSY ДО ответа
 *     {requestId} (серверная защита §9: второй send → ApiFailure);
 *  3. send: сбой фонового execute не роняет main (лог с кодом, без текста §14);
 *  4. clear: делегирование ClearChat → {cleared: true} (§13 идемпотентность —
 *     забота use case);
 *  5. list: {profileId, limit} → {messages} в форме ChatMessageDto; refusalClass
 *     присутствует ТОЛЬКО у refusal-ответов (§7), пустая история — {messages: []}.
 * Отмена хода — общий с резюме реестр (createAiSummaryCancelHandler, §5 087:
 * «ai/cancel … чат 089 — тот же») — проверен тестами 087; здесь — реестр в проводке.
 */
import { describe, expect, it } from 'vitest';

import { AppError } from '@hl/kernel';

import { createAiChatClearHandler, createAiChatListHandler, createAiChatSendHandler } from './ai-chat.js';
import { AiSummaryRequestRegistry } from './ai-summary.js';
import type {
  AskChat,
  AskChatCommand,
  AskChatOutcome,
} from '../../modules/ai-insight/application/ask-chat.js';
import type { ClearChat } from '../../modules/ai-insight/application/clear-chat.js';
import type { ChatMessageRecord, ChatRepository } from '../../modules/ai-insight/application/ports/chat-repository.js';

const NOW_MS = 1_758_816_000_000;
const PROFILE = 'seed-profile-0001';

/** Stub use case: управляемый execute + isBusy (§19, прецедент StubGenerateSummary). */
class StubAskChat implements Partial<AskChat> {
  busy = false;
  commands: AskChatCommand[] = [];
  private readonly resolvers: Array<(outcome: AskChatOutcome) => void> = [];
  /** Сбой следующего execute (§19: отказ фонового пути). */
  failure: Error | undefined;

  isBusy(): boolean {
    return this.busy;
  }

  execute(command: AskChatCommand): Promise<AskChatOutcome> {
    this.commands.push(command);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /** Сколько execute ещё подвисших (фон не завершился). */
  pendingCount(): number {
    return this.resolvers.length;
  }

  /** Завершить все подвисшие execute успешным исходом. */
  settleAll(messageId = 'm-1'): void {
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ requestId: 'x', messageId });
    }
  }
}

/** Stub ClearChat: счётчик вызовов (хендлер обязан делегировать use case). */
class StubClearChat implements Partial<ClearChat> {
  calls = 0;

  execute(): Promise<{ cleared: true }> {
    this.calls += 1;
    return Promise.resolve({ cleared: true });
  }
}

/** Fake-репозиторий истории с сеяными строками (§19). */
class FakeChatRepository implements ChatRepository {
  rows: ChatMessageRecord[] = [];

  append(record: ChatMessageRecord): Promise<void> {
    this.rows.push(record);
    return Promise.resolve();
  }

  listRecent(profileId: string, limit: number): Promise<ChatMessageRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.profileId === profileId).slice(-limit));
  }

  clearAll(): Promise<void> {
    this.rows.length = 0;
    return Promise.resolve();
  }
}

interface LogLine {
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

function recordingLogger(): {
  lines: LogLine[];
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
} {
  const lines: LogLine[] = [];
  return { lines, logger: { warn: (message, meta) => void lines.push({ message, meta }) } };
}

describe('ai/chat/send — хендлер (TASK-089 §11)', () => {
  it('(1) мгновенный {requestId}: фоновый запуск не держит вызов; requestId совпадает с командой', async () => {
    const useCase = new StubAskChat();
    const registry = new AiSummaryRequestRegistry();
    const handler = createAiChatSendHandler(useCase as unknown as AskChat, registry);

    const response = await handler({
      profileId: PROFILE,
      question: 'Почему вечером выше?',
      period: '30d',
    });

    // Ответ пришёл ДО завершения фонового execute (use case ещё подвис).
    expect(useCase.pendingCount()).toBe(1);
    expect(typeof response.requestId).toBe('string');
    expect(response.requestId.length).toBeGreaterThan(0);
    expect(useCase.commands).toHaveLength(1);
    expect(useCase.commands[0]).toMatchObject({
      profileId: PROFILE,
      question: 'Почему вечером выше?',
      period: '30d',
      requestId: response.requestId,
    });
    // Повторный вызов — НОВЫЙ requestId (корреляция стрима/финала §11).
    const second = await handler({
      profileId: PROFILE,
      question: 'А утром?',
      period: '7d',
    });
    expect(second.requestId).not.toBe(response.requestId);
    useCase.settleAll();
  });

  it('(2) BUSY: занятый use case → AppError AI/BUSY до ответа {requestId} (§9)', async () => {
    const useCase = new StubAskChat();
    useCase.busy = true;
    const handler = createAiChatSendHandler(useCase as unknown as AskChat, new AiSummaryRequestRegistry());

    // Хендлер бросает СИНХРОННО (каркас ловит тем же try/catch → ApiFailure §13).
    let caught: unknown;
    try {
      await handler({ profileId: PROFILE, question: 'вопрос?', period: '7d' });
      expect.unreachable('хендлер обязан отказать AI/BUSY');
    } catch (error) {
      caught = error;
    }
    expect((caught as AppError).code).toBe('AI/BUSY');
    expect(useCase.commands).toHaveLength(0);
  });

  it('(3) сбой фонового execute — хендлер не роняет main, код в логе без текста (§14)', async () => {
    const useCase = new StubAskChat();
    // Контракт ошибок TASK-006: наружу из use case — только AppError.
    useCase.failure = AppError.of('AI/WORKER_CRASHED', 'errors.AI_WORKER_CRASHED', {
      reason: 'test',
    });
    const { lines, logger } = recordingLogger();
    const handler = createAiChatSendHandler(
      useCase as unknown as AskChat,
      new AiSummaryRequestRegistry(),
      logger,
    );

    const response = await handler({ profileId: PROFILE, question: 'вопрос?', period: '7d' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // микрофоны фонового отказа

    expect(typeof response.requestId).toBe('string');
    const errorLine = lines.find((line) => line.message === 'ai/chat/send failed');
    expect(errorLine?.meta?.['code']).toBe('AI/WORKER_CRASHED');
    // PHI (§14): текст вопроса в лог не попадает.
    expect(JSON.stringify(errorLine)).not.toContain('вопрос');
  });

  it('(4) cancel: сигнал реестра доходит до команды use case (общий реестр с резюме, §5 087)', async () => {
    const useCase = new StubAskChat();
    const registry = new AiSummaryRequestRegistry();
    const { createAiSummaryCancelHandler } = await import('./ai-summary.js');
    const send = createAiChatSendHandler(useCase as unknown as AskChat, registry);
    const cancel = createAiSummaryCancelHandler(registry);

    const { requestId } = await send({ profileId: PROFILE, question: 'вопрос?', period: '7d' });
    expect(await cancel({ requestId })).toEqual({ cancelled: true });
    // Сигнал дошёл: команда use case несёт aborted signal.
    const signal = useCase.commands[0]?.signal;
    expect(signal?.aborted).toBe(true);
    useCase.settleAll();
  });
});

describe('ai/chat/clear — хендлер (TASK-089 §11)', () => {
  it('(5) делегирование ClearChat → {cleared: true}', async () => {
    const clearChat = new StubClearChat();
    const handler = createAiChatClearHandler(clearChat as unknown as ClearChat);

    expect(await handler({})).toEqual({ cleared: true });
    expect(clearChat.calls).toBe(1);
  });
});

describe('ai/chat/list — хендлер (TASK-089 §11/§12)', () => {
  it('(6) {profileId, limit} → {messages}: DTO без refusalClass у обычных ответов', async () => {
    const repo = new FakeChatRepository();
    await repo.append({
      id: 'm-1',
      profileId: PROFILE,
      role: 'user',
      content: 'Почему вечером выше?',
      createdAtUtc: 1000,
    });
    await repo.append({
      id: 'm-2',
      profileId: PROFILE,
      role: 'assistant',
      content: 'Вечером выше.',
      refusalClass: 'diagnosis',
      createdAtUtc: 1001,
    });
    const handler = createAiChatListHandler(repo);

    const response = await handler({ profileId: PROFILE, limit: 10 });

    expect(response).toEqual({
      messages: [
        { id: 'm-1', role: 'user', content: 'Почему вечером выше?', createdAtUtc: 1000 },
        {
          id: 'm-2',
          role: 'assistant',
          content: 'Вечером выше.',
          refusalClass: 'diagnosis',
          createdAtUtc: 1001,
        },
      ],
    });
  });

  it('(7) скоуп профиля и пустая история — {messages: []} (не ошибка, §13)', async () => {
    const repo = new FakeChatRepository();
    await repo.append({
      id: 'm-1',
      profileId: PROFILE,
      role: 'user',
      content: 'вопрос',
      createdAtUtc: 1,
    });
    const handler = createAiChatListHandler(repo);

    expect(await handler({ profileId: 'ghost', limit: 10 })).toEqual({ messages: [] });
  });
});
