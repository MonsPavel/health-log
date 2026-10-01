/**
 * TASK-089 §5/§8: миграция v7 — история чата chat_message (US-19, UC-19):
 *  - `chat_message (id TEXT PK, profile_id TEXT NOT NULL REFERENCES profile(id),
 *    role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL,
 *    refusal_class TEXT NULL, created_at_utc INTEGER NOT NULL)`
 *    + индекс (profile_id, created_at_utc DESC) — DDL по составу колонок §5 дословно;
 *  - role — CHECK по перечню §5 ('user'|'assistant'); refusal_class — БЕЗ CHECK:
 *    состав машинных классов живёт в политике 082, мусорное значение колонки
 *    трактуется адаптером как «обычный ответ» (NULL-семантика «нет пометки», §7);
 *  - пара ходов (вопрос + ответ) — ДВЕ строки с одинаковым профилем (§5: append
 *    обоих; порядок внутри одной миллисекунды восстанавливает listRecent по
 *    rowid — insertion order SQLite, см. адаптер).
 *
 * refusal_class NULL — пометка refusal-ответов (§7: «refusals в истории помечены,
 * UI стилем 088»): treatment/dosage/diagnosis/emergency/insufficientData; у
 * обычных ответов и у ВСЕХ user-сообщений — NULL.
 *
 * Очистка (§8): DELETE FROM (не unlink — таблица в общей БД; wipe покрывает всё);
 * кнопка «Очистить историю чата» — clearAll порта ChatRepository (UI — 090).
 *
 * Нумерация (§4/лиджер v6): v7 chat_message — эта задача.
 *
 * ИНВАРИАНТ НЕИЗМЕНЯЕМОСТИ v1–v5 (§22 TASK-025) соблюдён: схема расширяется НОВОЙ
 * миграцией, существующие таблицы не трогаются.
 *
 * Безопасность (§14): таблица — внутри шифрованной БД; content — PHI пользователя
 * (текст вопроса/ответа), наружу уходит только через канал владельцу профиля, в
 * лог не пишется.
 */
import type { Migration } from '../migration-runner.js';

/**
 * DDL v7 (§5/§8). Выполняется одним exec внутри транзакции runner'а (DDL в SQLite
 * транзакционен, TASK-024 §13). Индекс — профиль доступа listRecent (прецедент
 * ai_summary_profile_created_idx v6).
 */
const V7_CHAT_MESSAGE_DDL_SQL = `
  CREATE TABLE chat_message (
    id             TEXT PRIMARY KEY,
    profile_id     TEXT NOT NULL REFERENCES profile(id),
    role           TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content        TEXT NOT NULL,  -- текст хода: PHI, наружу только владельцу (§14)
    refusal_class  TEXT,           -- NULL | класс отказа 082: пометка refusal-ответа (§7)
    created_at_utc INTEGER NOT NULL
  );

  CREATE INDEX chat_message_profile_created_idx ON chat_message (profile_id, created_at_utc DESC);
`;

/** Миграция v7 (§2): чистая функция над Database — никаких чтений ФС/сети (§7 TASK-024). */
export const V7_CHAT_MESSAGE: Migration = {
  version: 7,
  up: (db) => {
    db.exec(V7_CHAT_MESSAGE_DDL_SQL);
  },
};
