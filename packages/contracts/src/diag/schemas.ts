/**
 * TASK-103 §5/§7/§11: контракты диагностического пакета (DiagBundle — zip без PHI,
 * предпросмотр до публикации, NFR-12).
 *
 *  - `DiagContent` — предпросмотр содержимого пакета ДО сохранения (§7):
 *    `files[] {name, sizeBytes, preview?}` + агрегаты `totals.eventsByKind`
 *    (count app_event по kind за 90 дней). `preview` — первые 20 строк текстовых
 *    файлов; на объёме логов >25 МБ (§9 — защитная ветка) previews опускаются —
 *    остаются только списки (имя+размер). Полные тексты файлов наружу (в канал
 *    предпросмотра) не идут принципиально — меньше поверхности случайной
 *    публикации (§14: предпросмотр обязателен, пользователь контролирует).
 *  - `diag/preview {} → DiagContent` — сборка в памяти main (§9);
 *  - `diag/save {} → {path} | {canceled: true}` — та же union-форма, что у
 *    экспорта 065 (переиспользование схемы, §23): путь выбирает save-диалог main
 *    (§14: renderer путь не присылает), отмена диалога — ожидаемый исход (§7).
 *  - `DiagManifest` — запись diag-manifest.json внутри zip (§5: версия формата,
 *    дата сборки) — контракт содержимого архива.
 *
 * Все схемы strict (§14 IPC-гигиены). Каналы — secure (чтение network_event/
 * app_event — БД; §7/§11): при locked отклоняются гвардией каркаса VAULT/LOCKED.
 */
import { z } from 'zod';

import { REPORT_EXPORT_RESPONSE_SCHEMA } from '../report/schemas.js';

/**
 * §7: запись предпросмотра файла пакета. name — имя ВНУТРИ zip (без путей машины —
 * §14); sizeBytes — исходный размер (до сжатия); preview — первые 20 строк (§7),
 * опционален: бинарных текстов в пакете нет, на >25 МБ логов previews опускаются (§9).
 */
export const DIAG_FILE_SCHEMA = z
  .object({
    /** Имя файла внутри пакета (плоский zip, прецедент манифеста копии 070). */
    name: z.string().min(1).max(256),
    /** Размер содержимого файла, байт (до сжатия). */
    sizeBytes: z.number().int().min(0),
    /** Первые 20 строк текста (§7); отсутствует у сгенерированных малых json и на >25 МБ (§9). */
    preview: z.string().optional(),
  })
  .strict();

/**
 * §7: содержимое пакета для окна предпросмотра — список файлов с размерами и
 * агрегаты app_event по kind за 90 дней (счётчики записей — метаданные, без PHI).
 */
export const DIAG_CONTENT_SCHEMA = z
  .object({
    files: z.array(DIAG_FILE_SCHEMA),
    totals: z
      .object({
        eventsByKind: z.record(z.string(), z.number().int().min(0)),
      })
      .strict(),
  })
  .strict();

/**
 * §5: манифест diag-manifest.json внутри zip — версия формата (эволюция структуры
 * пакета) и момент сборки (epoch ms UTC). Значения — факты без PHI (§13).
 */
export const DIAG_MANIFEST_SCHEMA = z
  .object({
    /** Версия формата пакета (первая — 1). */
    formatVersion: z.number().int().min(1),
    /** Момент сборки пакета, epoch ms UTC. */
    createdAtUtc: z.number().int().min(0),
  })
  .strict();

/** §11: запрос diag/preview — {} (сборка целиком решает main). */
export const DIAG_PREVIEW_REQUEST_SCHEMA = z.object({}).strict();

/** §11: ответ diag/preview — предпросмотр содержимого пакета. */
export const DIAG_PREVIEW_RESPONSE_SCHEMA = DIAG_CONTENT_SCHEMA;

/** §11: запрос diag/save — {} (путь выбирает save-диалог main, §14). */
export const DIAG_SAVE_REQUEST_SCHEMA = z.object({}).strict();

/**
 * §11: ответ diag/save — переиспользование union экспорта 065 (§23: та же форма
 * {path} | {canceled: true}; save-диалог тот же, отмена — не ошибка §7).
 */
export const DIAG_SAVE_RESPONSE_SCHEMA = REPORT_EXPORT_RESPONSE_SCHEMA;

/** Файл пакета (§7). */
export type DiagFile = z.infer<typeof DIAG_FILE_SCHEMA>;

/** Содержимое пакета — предпросмотр (§7). */
export type DiagContent = z.infer<typeof DIAG_CONTENT_SCHEMA>;

/** Манифест пакета diag-manifest.json (§5). */
export type DiagManifest = z.infer<typeof DIAG_MANIFEST_SCHEMA>;

/** Запрос diag/preview. */
export type DiagPreviewRequest = z.output<typeof DIAG_PREVIEW_REQUEST_SCHEMA>;

/** Ответ diag/preview — DiagContent. */
export type DiagPreviewResponse = z.output<typeof DIAG_PREVIEW_RESPONSE_SCHEMA>;

/** Запрос diag/save. */
export type DiagSaveRequest = z.output<typeof DIAG_SAVE_REQUEST_SCHEMA>;

/** Ответ diag/save — {path} | {canceled: true} (форма экспорта 065, §23). */
export type DiagSaveResponse = z.output<typeof DIAG_SAVE_RESPONSE_SCHEMA>;
