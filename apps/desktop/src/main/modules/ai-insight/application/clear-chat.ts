/**
 * TASK-089 §2/§5/§13: ClearChat — необратимая очистка истории чата (UC-04
 * «история локальна и очищаема»): делегирование порту clearAll (DELETE FROM
 * chat_message — таблица в общей БД, §8; wipe покрывает всё).
 *
 * Идемпотентность (§13): повторный clear на пустой таблице — успех; порт
 * clearAll не различает «были строки / не было». Подтверждение — забота UI
 * (диалог 090 перед вызовом). Слот генерации не затрагивается (очистка истории
 * не трогает движок; пара идущего хода сохранится после clear — тот же компромисс,
 * что у ai/summary/delete-all 088).
 *
 * Ошибки: наружу только AppError (STORAGE/* порта — каркас вернёт ApiFailure, §9).
 */
import type { ChatRepository } from './ports/chat-repository.js';

/** Исход очистки (§5/§11): форма ответа канала ai/chat/clear — всегда успех. */
export interface ClearChatOutcome {
  readonly cleared: true;
}

/** Зависимости (§5): внедряет контейнер, тесты — fake-repo (§19). */
export interface ClearChatDeps {
  /** Хранилище истории (порт ниже, адаптер v7). */
  readonly repo: ChatRepository;
}

/** ClearChat (§2): execute() → {cleared: true}; идемпотентен (§13). */
export class ClearChat {
  private readonly deps: ClearChatDeps;

  constructor(deps: ClearChatDeps) {
    this.deps = deps;
  }

  /** Очистить ВСЮ историю (§5/§8): необратимо, данные дневника не трогаются. */
  async execute(): Promise<ClearChatOutcome> {
    await this.deps.repo.clearAll();
    return { cleared: true };
  }
}
