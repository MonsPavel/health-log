/**
 * TASK-089 §5/§7: порт хранилища истории чата — application-слой модуля ai-insight
 * (арх. 03 §4: application не импортирует adapters/чужие модули — depcruise
 * application-ports; прецедент InsightRepository 087). Боевая реализация —
 * SqliteChatRepository (адаптер над таблицей chat_message миграции v7); юнит-тесты
 * use case 089 — fake в памяти (§19).
 *
 * Поверхность — дословно §5: append (ход), listRecent (окно истории; use case
 * зовёт с константой CHAT_HISTORY_DEPTH=6, канал ai/chat/list — с limit UI),
 * clearAll (необратимая очистка ВСЕЙ истории — UC-04 «история локальна и
 * очищаема»; идемпотентен). Сессий/тем нет — ОДНА плоская история на профиль
 * (решение §5 «не включено»). Пары вопрос/ответ — две записи (§5: «append обоих»).
 *
 * ChatMessageRecord — модель §7: refusals в истории помечены refusalClass
 * (UI стилем 088); у обычных ответов и user-сообщений поле отсутствует.
 *
 * Все методы асинхронные (прецедент порта 087/021: better-sqlite3 синхронный,
 * Promise-обёртка — единообразие порта). Ошибки — только STORAGE/* адаптера;
 * «пустая история» — валидный пустой массив, не throw (§13).
 */
import type { Instant } from '@hl/kernel';

import type { ChatRefusalClass } from '@hl/contracts';

/** Роль сообщения истории (§5 DDL: CHECK 'user'|'assistant'). */
export type ChatRole = 'user' | 'assistant';

/** Запись истории чата (§7 дословно + profileId скоупа). */
export interface ChatMessageRecord {
  /** uuid v7 (конвенция id агрегатов, §5). */
  readonly id: string;
  /** Профиль-владелец (принудительный скоуп, арх. 08 §3). */
  readonly profileId: string;
  /** Роль хода. */
  readonly role: ChatRole;
  /** Текст хода: у assistant — с дисклеймер-футером (решение §5, инвариант §20). */
  readonly content: string;
  /** Класс отказа (политика 082) — ТОЛЬКО у refusal-ответов assistant (§7). */
  readonly refusalClass?: ChatRefusalClass;
  /** Момент сохранения (epoch ms). */
  readonly createdAtUtc: number;
}

/**
 * Порт хранилища истории чата (§5 дословно: append, listRecent(6), clearAll).
 */
export interface ChatRepository {
  /** Добавить ход (use case зовёт при финале: пара user+assistant — два вызова). */
  append(record: ChatMessageRecord): Promise<void>;

  /**
   * Последние limit сообщений профиля в ХРОНОЛОГИЧЕСКОМ порядке (старые → новые —
   * форма готова для сборки промпта и рендера, §4). «Пустая история» — [].
   */
  listRecent(profileId: string, limit: number): Promise<ChatMessageRecord[]>;

  /** Очистить ВСЮ историю (все профили, §8: DELETE в общей БД); идемпотентен. */
  clearAll(): Promise<void>;
}

/** Re-export Instant для удобства потребителей порта (время — по UTC, §7). */
export type { Instant };
