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

/**
 * TASK-068 §5/§11: запрос канала `report/pdf` (UC-05 — сборка и сохранение
 * PDF-отчёта врачу). {profileId, period, includeAiSection, aiText?}:
 *  - period — ГОТОВЫЕ utcMs-границы (обе включительно, форма ReportPeriod 067):
 *    renderer считает их из период-контрола TASK-046 (пресет/custom — lib/period);
 *  - includeAiSection — явное включение ИИ-раздела; aiText — ПАРАМЕТР ВЫЗЫВАЮЩЕГО
 *    (§5 РЕШЕНИЕ: use case агностичен к ИИ-хранилищу, renderer передаёт выбранное
 *    резюме; в P4 чекбокс всегда disabled — §12, поле остаётся в контракте);
 *    форма aiText зеркалит ReportAiText 067 (contentMd/generatedAt/modelId).
 *
 * Путь файла renderer НЕ присылает (§14 — как у экспорта): место выбирает
 * save-диалог main. При includeAiSection=false переданный aiText игнорируется
 * use case'ом (§13 067 — защита от случайного включения).
 */
export const REPORT_PDF_REQUEST_SCHEMA = z
  .object({
    /** Профиль-владелец журнала — та же гигиена, что у экспорта (§14). */
    profileId: z.string().min(1).max(256),
    /** Границы периода по takenAt.utcMs, обе включительно (ReportPeriod 067). */
    period: z
      .object({ fromUtcMs: z.number().int(), toUtcMs: z.number().int() })
      .strict(),
    /** Явное включение ИИ-раздела (по умолчанию выключен — §3/US-26). */
    includeAiSection: z.boolean(),
    /** Текст ИИ-раздела (ReportAiText 067); только по явному includeAiSection. */
    aiText: z
      .object({
        /** Markdown-текст резюме; шаблон печатает как текст (067 §5). */
        contentMd: z.string().min(1),
        /** Момент генерации (utc мс) — в маркировке раздела. */
        generatedAt: z.number().int(),
        /** Идентификатор модели — в маркировке раздела. */
        modelId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ReportPdfRequest = z.output<typeof REPORT_PDF_REQUEST_SCHEMA>;

/**
 * TASK-068 §5/§11: ответ канала `report/pdf` — ТА ЖЕ union {path} | {canceled: true},
 * что у экспорта (переиспользование схемы, §23): save-диалог тот же (путь — выбор
 * пользователя, отмена — не ошибка §7). Схема ответа НЕ дублируется.
 */
export const REPORT_PDF_RESPONSE_SCHEMA = REPORT_EXPORT_RESPONSE_SCHEMA;

export type ReportPdfResponse = z.output<typeof REPORT_PDF_RESPONSE_SCHEMA>;

/**
 * TASK-068 §5/§11: запрос канала `app/reveal-path` — «открыть папку» после
 * сохранения (shell.showItemInFolder). Путь — тот, что вернул наш же экспорт/отчёт
 * (§11 РЕШЕНИЕ: reveal принимает произвольный путь как UX-удобство на своей машине —
 * open в explorer, риск нулевой локально; санитизация не требуется, решение
 * документировано). Гигиена длины 1024 — паритет file-полю экспорта/backup (§14).
 */
export const REVEAL_PATH_REQUEST_SCHEMA = z
  .object({
    /** Полный путь подсвечиваемого файла (результат save-диалога, §5). */
    path: z.string().min(1).max(1024),
  })
  .strict();

export type RevealPathRequest = z.output<typeof REVEAL_PATH_REQUEST_SCHEMA>;
