/**
 * TASK-087 §5/§8: миграция v6 — кэш ИИ-резюме ai_summary (FR-5.7, UC-03):
 *  - `ai_summary (id TEXT PK, profile_id TEXT NOT NULL REFERENCES profile(id),
 *    kind TEXT NOT NULL CHECK (kind IN ('summary')), period_param TEXT NOT NULL,
 *    period_start_utc INTEGER NOT NULL, period_end_utc INTEGER NOT NULL,
 *    context_hash TEXT NOT NULL, model_id TEXT NOT NULL, model_version TEXT NOT NULL,
 *    data_version INTEGER NOT NULL, content_md TEXT NOT NULL, disclaimer_text TEXT NOT NULL,
 *    period_text TEXT NOT NULL, created_at_utc INTEGER NOT NULL)`
 *    + индекс (profile_id, created_at_utc DESC) — DDL арх. 04 §3; запись = решение §5
 *    («сохранение только при done(ok)», data_version — счётчик на момент генерации).
 *
 * PERIOD_PARAM — канонический идентификатор периода ('7d'|'30d'|'90d'|'all'|'custom'),
 * ключ сопоставления latest (§12/ревью TASK-087): пресетные границы «двигаются» вместе
 * с now момента генерации (from = now − N·24ч, to = now; 'all' — 0..now), поэтому
 * точное равенство границ между generate и latest недостижимо при любом реальном
 * сдвиге часов — бейдж FR-5.7 был бы мёртв для основного вида периодов. Сопоставление:
 * пресет/'all' — по period_param; custom — границы явные и стабильные, по точному
 * равенству period_start_utc/period_end_utc (+ period_param='custom'). Границы в
 * записи остаются метаданными отображения («что реально запрашивалось»).
 *
 * СЛУЖЕБНЫЕ ПОЛЯ disclaimer_text/period_text (толкование §5/§7): в перечне колонок §5
 * их нет (список повторяет арх. 04 §3, написанный ДО решения 087 о пост-обработке),
 * но само решение §5 («дисклеймер — несъёмный, ОТДЕЛЬНО от content_md; рендер всегда
 * показывает оба») + модель записи §7 (disclaimerText/periodText — поля SummaryRecord)
 * + инвариант §20 п.6 («заполнены всегда») требуют персистентности: восстановить
 * подпись периода при чтении кэша из одних границ нельзя (пресет/«весь журнал» не
 * различимы). Колонки NOT NULL — пустое служебное поле запрещено схемой (§20 п.6).
 *
 * kind с CHECK (kind IN ('summary')) — арх. 04 §3 дословно (прецедент состава DDL;
 * в v4/v5 CHECK не ставился, т.к. их DDL его не декларировал). FK на profile(id) —
 * как в арх. 04 §3; внешние ключи SQLite по умолчанию выключены — constraint
 * декларативен, скоуп профиля валидируют порты (прецедент bp_measurement v1).
 *
 * Нумерация (§4, лиджер v5): v6 ai_summary — эта задача; v7 chat_message — TASK-089.
 * Кэш-ключ — context_hash (SHA-256 083, уникальность обеспечивает use case: до save
 * findByContextHash); отдельного UNIQUE на context_hash нет — повторная генерация
 * после deleteAll/будущей очистки валидна.
 *
 * Удаление резюме (§8): wipe покрывает (таблица в БД); кнопка «Очистить разборы» —
 * deleteAll порта (UI — TASK-088).
 *
 * ИНВАРИАНТ НЕИЗМЕНЯЕМОСТИ v1–v5 (§22 TASK-025) соблюдён: схема расширяется НОВОЙ
 * миграцией, существующие таблицы не трогаются. Сама v6 создана этой же задачей
 * (в релиз не выходила) — правка состава её DDL до мерджа валидна.
 *
 * Безопасность (§14): таблица — внутри шифрованной БД; content_md — PHI пользователя,
 * наружу уходит только через канал владельцу профиля, в лог не пишется.
 */
import type { Migration } from '../migration-runner.js';

/**
 * DDL v6 (§5/§8, сверка с арх. 04 §3 + period_param/служебные поля — см. шапку).
 * Выполняется одним exec внутри транзакции runner'а (DDL в SQLite транзакционен,
 * TASK-024 §13).
 */
const V6_AI_SUMMARY_DDL_SQL = `
  CREATE TABLE ai_summary (
    id               TEXT PRIMARY KEY,
    profile_id       TEXT NOT NULL REFERENCES profile(id),
    kind             TEXT NOT NULL CHECK (kind IN ('summary')),
    period_param     TEXT NOT NULL,     -- канонический период: '7d'|'30d'|'90d'|'all'|'custom'
    period_start_utc INTEGER NOT NULL,
    period_end_utc   INTEGER NOT NULL,
    context_hash     TEXT NOT NULL,     -- SHA-256 canonical-строки 083 (кэш-ключ FR-5.7)
    model_id         TEXT NOT NULL,
    model_version    TEXT NOT NULL,
    data_version     INTEGER NOT NULL,  -- счётчик meta на момент генерации (стейлс §7)
    content_md       TEXT NOT NULL,     -- ответ модели после ResponseGuard (без дисклеймера!)
    disclaimer_text  TEXT NOT NULL,     -- несъёмный дисклеймер: отдельное поле (§5/§20 п.6)
    period_text      TEXT NOT NULL,     -- подпись периода: отдельное поле (§5/§20 п.6)
    created_at_utc   INTEGER NOT NULL
  );

  CREATE INDEX ai_summary_profile_created_idx ON ai_summary (profile_id, created_at_utc DESC);
`;

/** Миграция v6 (§2): чистая функция над Database — никаких чтений ФС/сети (§7 TASK-024). */
export const V6_AI_SUMMARY: Migration = {
  version: 6,
  up: (db) => {
    db.exec(V6_AI_SUMMARY_DDL_SQL);
  },
};
