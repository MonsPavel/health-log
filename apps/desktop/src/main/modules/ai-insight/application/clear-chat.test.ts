/**
 * TASK-089 §19/§13: юнит-тесты use case ClearChat — необратимая очистка истории
 * (UC-04): делегирование порту clearAll, идемпотентность (повторный clear — ok,
 * §13), результат {cleared: true} — форма ответа канала ai/chat/clear.
 */
import { describe, expect, it } from 'vitest';

import { ClearChat, type ClearChatOutcome } from './clear-chat.js';
import type { ChatMessageRecord, ChatRepository } from './ports/chat-repository.js';

/** Fake-репозиторий истории в памяти (§19). */
class FakeChatRepository implements ChatRepository {
  readonly rows: ChatMessageRecord[] = [];
  clearCalls = 0;
  /** TASK-089 §19: отказ следующего clearAll (STORAGE/* адаптера). */
  clearFailure: Error | undefined;

  append(record: ChatMessageRecord): Promise<void> {
    this.rows.push(record);
    return Promise.resolve();
  }

  listRecent(profileId: string, limit: number): Promise<ChatMessageRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.profileId === profileId).slice(-limit));
  }

  clearAll(): Promise<void> {
    this.clearCalls += 1;
    if (this.clearFailure !== undefined) {
      return Promise.reject(this.clearFailure);
    }
    this.rows.length = 0;
    return Promise.resolve();
  }
}

const PROFILE = 'seed-profile-0001';

const message = (id: string): ChatMessageRecord => ({
  id,
  profileId: PROFILE,
  role: 'user',
  content: `вопрос ${id}`,
  createdAtUtc: 1,
});

describe('ClearChat — очистка истории (TASK-089 §5/§13)', () => {
  it('(1) execute → clearAll порта: история пуста (все профили)', async () => {
    const repo = new FakeChatRepository();
    await repo.append(message('m-1'));
    await repo.append(message('m-2'));
    const clearChat = new ClearChat({ repo });

    const outcome: ClearChatOutcome = await clearChat.execute();

    expect(outcome).toEqual({ cleared: true });
    expect(repo.clearCalls).toBe(1);
    expect(repo.rows).toHaveLength(0);
  });

  it('(2) повторный clear — ok, идемпотентность §13 (пустая история → успех)', async () => {
    const repo = new FakeChatRepository();
    const clearChat = new ClearChat({ repo });

    await expect(clearChat.execute()).resolves.toEqual({ cleared: true });
    await expect(clearChat.execute()).resolves.toEqual({ cleared: true });
    expect(repo.clearCalls).toBe(2);
  });

  it('(3) сбой порта STORAGE/* пробрасывается наружу (каркас вернёт ApiFailure, §9)', async () => {
    const repo = new FakeChatRepository();
    repo.clearFailure = Object.assign(new Error('closed'), { code: 'STORAGE/FAILED' });
    const clearChat = new ClearChat({ repo });

    await expect(clearChat.execute()).rejects.toMatchObject({ code: 'STORAGE/FAILED' });
  });
});
