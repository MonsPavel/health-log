/**
 * TASK-089 §5: SQLite-адаптер порта ChatRepository над таблицей chat_message
 * миграции v7 (прецедент SqliteInsightRepository TASK-087). Read-методы — без
 * транзакций; append — один INSERT (строка атомарна сама по себе; chat_history —
 * не данные дневника: счётчик data_version НЕ двигается, арх. 04 §4 — счётчик
 * для мутаций измерений).
 *
 * listRecent (§5): последние limit сообщений профиля — ORDER BY created_at_utc
 * DESC, rowid DESC LIMIT ? с РАЗВОРОТОМ в хронологический порядок (старые →
 * новые — форма для промпта/рендера, §4). rowid — тай-брейк пары в одну
 * миллисекунду (use case пишет user и assistant одним ходом с одинаковым
 * createdAtUtc): SQLite rowid монотонен по вставке — порядок пары «вопрос до
 * ответа» сохраняется независимо от случайной части uuid v7.
 *
 * Скоуп профиля — в КАЖДОМ WHERE (принудительный скоуп, арх. 08 §3).
 *
 * refusal_class (§7/§8): NULL → undefined; мусорное значение (не входит в состав
 * классов политики 082) трактуется как «нет пометки» — колонка без CHECK
 * (решение миграции v7), адаптер — единственная точка отображения.
 *
 * clearAll (§8): DELETE FROM chat_message — таблица в общей БД (не unlink);
 * идемпотентен; wipe покрывает таблицу целиком.
 *
 * Ошибки (§7): наружу только AppError STORAGE/FAILED (прецедент sqlite.ts
 * TASK-022); «пустая история» — [], не throw (§13).
 */
import type { ChatRefusalClass } from '@hl/contracts';
import { AppError } from '@hl/kernel';

import type { EncryptedDatabase } from '../../../shared/db/sqlite.js';
import type {
  ChatMessageRecord,
  ChatRepository,
  ChatRole,
} from '../application/ports/chat-repository.js';

/**
 * Ключ i18n ошибки хранилища (конвенция арх. 05 §29; тексты — TASK-101). Код —
 * существующий-generic STORAGE/FAILED (TASK-026: наружу только код, детали —
 * в params.operation и cause, §14); строка дублирует константу адаптера инсайтов
 * (078: application не импортирует adapters, adapters не импортируют друг друга —
 * единство строки закреплено тестами кода ошибки).
 */
export const STORAGE_FAILED_MESSAGE_KEY = 'errors.STORAGE_FAILED';

const INSERT_SQL =
  'INSERT INTO chat_message (id, profile_id, role, content, refusal_class, created_at_utc) ' +
  'VALUES (?, ?, ?, ?, ?, ?)';

const RECENT_SQL =
  'SELECT id, profile_id, role, content, refusal_class, created_at_utc, rowid ' +
  'FROM chat_message WHERE profile_id = ? ' +
  'ORDER BY created_at_utc DESC, rowid DESC LIMIT ?';

/** Строка таблицы (сырая форма SQL; rowid — тай-брейк пары в одну мс, см. шапку). */
interface ChatMessageRow {
  id: string;
  profile_id: string;
  role: string;
  content: string;
  refusal_class: string | null;
  created_at_utc: number;
  rowid: number;
}

/** Защита от мусорной роли в БД (NOT NULL, но не факт 'user'/'assistant'). */
function toRole(raw: string): ChatRole {
  return raw === 'assistant' ? 'assistant' : 'user';
}

/**
 * Отображение refusal_class (§7): NULL/мусор → undefined («нет пометки»);
 * состав классов — CHAT_REFUSAL_CLASSES контракта (та же форма, что на проводе).
 */
function toRefusalClass(raw: string | null): ChatRefusalClass | undefined {
  if (
    raw === 'treatment' ||
    raw === 'dosage' ||
    raw === 'diagnosis' ||
    raw === 'emergency' ||
    raw === 'insufficientData'
  ) {
    return raw;
  }
  return undefined;
}

/** Маппинг строки → запись порта (плоская форма БД → VO §7). */
function toRecord(row: ChatMessageRow): ChatMessageRecord {
  const refusalClass = toRefusalClass(row.refusal_class);
  return {
    id: row.id,
    profileId: row.profile_id,
    role: toRole(row.role),
    content: row.content,
    ...(refusalClass === undefined ? {} : { refusalClass }),
    createdAtUtc: row.created_at_utc,
  };
}

/**
 * Адаптер хранилища истории чата (§5): вся память таблицы — внутри шифрованной
 * БД (§14); методы Promise-обёрнуты по контракту порта (§19 051).
 */
export class SqliteChatRepository implements ChatRepository {
  private readonly db: EncryptedDatabase;

  constructor(db: EncryptedDatabase) {
    this.db = db;
  }

  /** Добавить ход (§5): один INSERT (строка атомарна; data_version не двигается). */
  append(record: ChatMessageRecord): Promise<void> {
    try {
      this.db
        .prepare(INSERT_SQL)
        .run(
          record.id,
          record.profileId,
          record.role,
          record.content,
          record.refusalClass ?? null,
          record.createdAtUtc,
        );
      return Promise.resolve();
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006; прецедент llm-process-client)
      return Promise.reject(this.storageError('append', cause));
    }
  }

  /**
   * Последние limit сообщений профиля (§5): DESC-выборка по индексу v7 +
   * разворот — хронологический порядок (старые → новые, §4).
   */
  listRecent(profileId: string, limit: number): Promise<ChatMessageRecord[]> {
    try {
      const rows = this.db.prepare(RECENT_SQL).all(profileId, limit) as ChatMessageRow[];
      const records = rows.map(toRecord);
      records.reverse();
      return Promise.resolve(records);
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006; прецедент llm-process-client)
      return Promise.reject(this.storageError('listRecent', cause));
    }
  }

  /** Очистка всей истории (§8: DELETE в общей БД; wipe покрывает таблицу). */
  clearAll(): Promise<void> {
    try {
      this.db.prepare('DELETE FROM chat_message').run();
      return Promise.resolve();
    } catch (cause) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- отказ Promise — AppError (не Error по построению, TASK-006; прецедент llm-process-client)
      return Promise.reject(this.storageError('clearAll', cause));
    }
  }

  /** Единая фабрика STORAGE/FAILED адаптера (прецедент TASK-026; cause — память main). */
  private storageError(operation: string, cause: unknown): AppError {
    return AppError.of('STORAGE/FAILED', STORAGE_FAILED_MESSAGE_KEY, { operation }, cause);
  }
}
