/**
 * TASK-073 §6/§9/§11: контракт канала `file/open-dialog` — выбор файла копии
 * для восстановления (мастер-флоу RestoreFlow, §10).
 *
 * Запрос — ТОЛЬКО фильтры диалога ОС (§14: renderer путь не присылает — тот же
 * принцип, что save-диалог экспорта 065: путь появляется в main как результат
 * диалога, выбранного пользователем). Ответ — union `{path} | {canceled: true}`
 * (§7: отмена пользователя — ожидаемый исход, не ошибка); форма ТА ЖЕ, что у
 * экспорта/PDF — схема переиспользуется (§23: переиспользование обязательно).
 *
 * Гигиена форм (§14): strict-объекты; имя фильтра ≤64, расширение ≤16 символов,
 * фильтров ≤8 — разумные потолки формы (переполнение — VALIDATION/FAILED каркаса).
 */
import { z } from 'zod';

import { REPORT_EXPORT_RESPONSE_SCHEMA, type ReportExportResponse } from './report/schemas.js';

/** Запрос канала `file/open-dialog`: фильтры диалога выбора файла (§9). */
export const FILE_OPEN_DIALOG_REQUEST_SCHEMA = z
  .object({
    /** Фильтры диалога ОС (паритет Electron dialog.showOpenDialog); [] — все файлы. */
    filters: z
      .array(
        z
          .object({
            /** Отображаемое имя фильтра («Health Log Backup»). */
            name: z.string().min(1).max(64),
            /** Расширения без точки («hlbackup»). */
            extensions: z.array(z.string().min(1).max(16)).min(1).max(16),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

/**
 * Ответ канала — union {path} | {canceled: true}: тот же контракт, что у экспорта
 * (§23; path — полный путь выбранного пользователем файла, наружу можно — выбор
 * его собственного файла; canceled — отмена диалога, не ошибка §7).
 */
export const FILE_OPEN_DIALOG_RESPONSE_SCHEMA = REPORT_EXPORT_RESPONSE_SCHEMA;

export type FileOpenDialogRequest = z.output<typeof FILE_OPEN_DIALOG_REQUEST_SCHEMA>;
export type FileOpenDialogResponse = ReportExportResponse;
