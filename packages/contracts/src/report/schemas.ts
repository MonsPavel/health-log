/**
 * TASK-065 §5/§11/§14: zod-схемы каналов экспорта `report/export-csv|export-json`
 * (US-27 — пользователь физически получает файл). Слой «отчёты» (арх. 05 §2):
 * один запрос на оба канала — renderer присылает ТОЛЬКО {profileId}; путь файла
 * выбирает main-диалог ОС (§14: «renderer просит записать в произвольный путь»
 * архитектурно исключено — пути от renderer не существует).
 *
 * Ответ — union по ключам (§7: `ExportFileResult = {path} | {canceled: true}`):
 *  - {path} — полный путь записанного файла (выбор пользователя из диалога ОС —
 *    наружу можно: это путь, который пользователь сам выбрал; в ЛОГ идёт только
 *    basename — userData содержит имя Windows-пользователя, TASK-065 §18);
 *  - {canceled: true} — отмена диалога — НЕ ошибка (§7: ожидаемый исход, UI тихо).
 *
 * Обе ветки .strict() (§14 IPC-гигиена); максимум длины пути 1024 — гигиена,
 * паритет file-полю backup/restore (TASK-071).
 */
import { z } from 'zod';

/** §11: запрос каналов report/export-csv|json — только скоуп профиля. */
export const REPORT_EXPORT_REQUEST_SCHEMA = z
  .object({
    /** Профиль-владелец журнала (единственный seed-профиль MVP, §14). */
    profileId: z.string().min(1).max(256),
  })
  .strict();

/** §11/§7: ответ каналов — union {path} | {canceled: true}; формы различны по ключам. */
export const REPORT_EXPORT_RESPONSE_SCHEMA = z.union([
  z
    .object({
      /** Полный путь записанного файла (результат диалога ОС, §14). */
      path: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      /** Отмена пользователя в save-диалоге — ожидаемый исход, не ошибка (§7). */
      canceled: z.literal(true),
    })
    .strict(),
]);

export type ReportExportRequest = z.output<typeof REPORT_EXPORT_REQUEST_SCHEMA>;
export type ReportExportResponse = z.output<typeof REPORT_EXPORT_RESPONSE_SCHEMA>;
