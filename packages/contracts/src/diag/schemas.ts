/**
 * TASK-103 §5/§7/§11: контракты диагностического пакета (zip без PHI, NFR-12).
 *
 *  - `DiagContent` (§7) — структура пакета для ПРЕДПРОСМОТРА ДО сохранения:
 *    files — записи {name (логическое имя в пакете, напр. 'logs/hl.1.log'),
 *    sizeBytes, preview? (первые 20 строк текстового файла; защитная ветка
 *    main §9 — пакеты логов >25 МБ уходят без preview-текстов)}, totals —
 *    агрегаты app_event по kind за 90 дней (счётчик записей UI, §10);
 *  - `diag/preview {} → DiagContent` — сборка содержимого в main (в памяти,
 *    кэш до сохранения) и предпросмотр; secure: чтение БД (app_event,
 *    network_event) и каталога логов (§14);
 *  - `diag/save {} → {path} | {canceled: true}` — zip собранного (манифест
 *    diag-manifest.json: версия формата, дата) → save-диалог ОС в main
 *    (паттерн 065: renderer путь не присылает, §14); отмена — не ошибка (§7);
 *    secure: файловая операция поверх собранного из БД.
 *
 * Все схемы strict (§14 IPC-гигиены). Пакет НЕ содержит измерений/заметок/чата
 * (PHI-инвариант §13 — скан-тест main-тестов главной гарантией).
 */
import { z } from 'zod';

/** Версия формата пакета (diag-manifest.json, §5): единственный источник строки. */
export const DIAG_BUNDLE_FORMAT_VERSION = 1;

/** §7: запись предпросмотра — имя файла в пакете, размер, опциональный превью-текст. */
export const DIAG_FILE_ENTRY_SCHEMA = z
  .object({
    /** Логическое имя в пакете (включая подкаталог, напр. 'logs/hl.1.log'). */
    name: z.string().min(1).max(512),
    /** Размер файла, байты. */
    sizeBytes: z.number().int().min(0),
    /** Первые 20 строк текстового файла (§7); нет — у бинарных/защитной ветки §9. */
    preview: z.string().optional(),
  })
  .strict();

/** §7: содержимое пакета — файлы + агрегаты app_event по kind (за 90 дней, §5). */
export const DIAG_CONTENT_SCHEMA = z
  .object({
    files: z.array(DIAG_FILE_ENTRY_SCHEMA),
    totals: z
      .object({
        /** kind → число записей app_event за окно ротации 90 дней (§5/§8). */
        eventsByKind: z.record(z.string(), z.number().int().min(0)),
      })
      .strict(),
  })
  .strict();

/** §11: запрос diag/preview — {} (сборка целиком в main; renderer параметры не шлёт). */
export const DIAG_PREVIEW_REQUEST_SCHEMA = z.object({}).strict();

/** §11: ответ diag/preview — DiagContent (предпросмотр ДО сохранения — AC §20-3). */
export const DIAG_PREVIEW_RESPONSE_SCHEMA = DIAG_CONTENT_SCHEMA;

/** §11: запрос diag/save — {} (путь выбирает save-диалог main, §14). */
export const DIAG_SAVE_REQUEST_SCHEMA = z.object({}).strict();

/**
 * §11: ответ diag/save — union {path} | {canceled: true} (отмена диалога — не
 * ошибка, §7; переиспользование формы экспорта 065, §23).
 */
export const DIAG_SAVE_RESPONSE_SCHEMA = z.union([
  z
    .object({
      /** Полный путь записанного zip-пакета (результат диалога ОС, §14). */
      path: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      canceled: z.literal(true),
    })
    .strict(),
]);

/** Запись предпросмотра файла пакета (§7). */
export type DiagFileEntry = z.infer<typeof DIAG_FILE_ENTRY_SCHEMA>;

/** Содержимое диагностического пакета для предпросмотра (§7). */
export type DiagContent = z.infer<typeof DIAG_CONTENT_SCHEMA>;

/** Запрос diag/preview. */
export type DiagPreviewRequest = z.infer<typeof DIAG_PREVIEW_REQUEST_SCHEMA>;

/** Ответ diag/preview. */
export type DiagPreviewResponse = z.infer<typeof DIAG_PREVIEW_RESPONSE_SCHEMA>;

/** Запрос diag/save. */
export type DiagSaveRequest = z.infer<typeof DIAG_SAVE_REQUEST_SCHEMA>;

/** Ответ diag/save — {path} | {canceled: true}. */
export type DiagSaveResponse = z.infer<typeof DIAG_SAVE_RESPONSE_SCHEMA>;
