/**
 * Публичный API секции report (TASK-065 §6): каналы экспорта CSV/JSON — запрос
 * {profileId}, ответ union {path} | {canceled: true} (§7 — отмена не ошибка).
 * PDF-канал появится с TASK-068 (§23) — та же форма ответа.
 */
export * from './schemas.js';
