/**
 * TASK-080 §6: контракты витрины моделей — статусы жизненного цикла загрузки
 * (§7: машина not_installed→downloading⇄paused→verifying→installed; error —
 * терминальное с reset-возможностью), форма статуса и payload события
 * ai:progress (§11). Потребители: ModelStore (080, main), каналы ai/models/*
 * и list-ответ 081; renderer видит только эти формы через preload-мост.
 *
 * Payload — только сигналы (id модели, байты, статус), без PHI (§14);
 * errorKey — ключ i18n-каталога, не текст (§16–17, прецедент app:log).
 */

/**
 * Безопасное имя файла модели из манифеста (§14 path traversal): строго
 * строчные латиница/цифры/точка/дефис — путь строит main, файл из манифеста
 * валидируется ДО join с каталогом моделей. Класс §14 дополнен запретом
 * ведущей точки: иначе «..» проходит по классу и join уводит путь за каталог
 * моделей — а назначение паттерна (§14) именно запрет traversal. Экспорт —
 * единственный источник для ModelStore и тестов контракта.
 */
export const MODEL_FILE_PATTERN = /^(?!\.)[a-z0-9.-]+$/;

/** Статусы жизненного цикла загрузки модели (§6/§7). */
export const MODEL_STATUSES = [
  'not_installed',
  'downloading',
  'paused',
  'installed',
  'verifying',
  'error',
] as const;

/** Статус модели (§7): машина состояний загрузки; error — терминальное с reset. */
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/**
 * Форма статуса модели (§5) — ответ status()/list-канала 081. bytesLoaded —
 * размер .part (докачка); resumable=false — сервер без Range, докачка
 * невозможна (§5 «отмечаем в состоянии»); errorKey — ключ i18n терминальной
 * ошибки при state=error (§16–17: состояния — ключи текстов).
 */
export interface ModelStatusInfo {
  readonly state: ModelStatus;
  readonly bytesLoaded?: number;
  readonly totalBytes?: number;
  readonly resumable?: boolean;
  readonly errorKey?: string;
}

/** Payload события ai:progress (§11): прогресс + состояние, throttle 250 мс (§15). */
export interface ModelProgressPayload {
  readonly modelId: string;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly state: ModelStatus;
}
