/**
 * Внутренность «чужого модуля» для фикстуры bad-cross-module-internal.ts (§19):
 * реальный файл на диске, чтобы импорт в фикстуре разрешался, а правило
 * module-public-api проверялось на честном ребре графа.
 *
 * Сама обязана оставаться чистой: в test:depcruise-rules — ожидание «0 нарушений».
 */
export const betaInternal = 'beta-internal';
