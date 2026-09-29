/**
 * TASK-073 §5/§9/§11: zod-схемы канала `file/open-dialog` — минимальный файловый
 * пикер (выбор файла копии для восстановления). Слой «файлы» (прецедент report/):
 * запрос — ТОЛЬКО фильтры диалога; путь файла выбирает main-диалог ОС и возвращается
 * renderer'у как факт выбора пользователя (§14: «renderer просит записать/прочесть
 * произвольный путь» архитектурно исключено — путь renderer не присылает, тот же
 * принцип, что save-каналы report/export-* TASK-065 и DialogFileSaver TASK-070;
 * полный путь выбранного файла наружу можно — пользователь выбрал его сам, §14).
 *
 * Ответ — union по ключам (§7: `ExportFileResult`-прецедент): {path} | {canceled: true}
 * — отмена диалога НЕ ошибка (§7: ожидаемый исход, UI тихо). Обе ветки .strict()
 * (§14 IPC-гигиена); максимум длины пути 1024 — гигиена, паритет file-полю
 * backup/restore (TASK-071).
 */
import { z } from 'zod';

/**
 * Запрос выбора файла (§9): фильтры диалога опциональны (диалог без фильтра
 * допустим — форма минимальна, §9). Расширения — без точки, безопасный набор
 * символов (IPC-гигиена §14: строки уходят в опции dialog.showOpenDialog).
 */
export const FILE_OPEN_DIALOG_REQUEST_SCHEMA = z
  .object({
    filters: z
      .array(
        z
          .object({
            /** Показное имя фильтра в диалоге ОС (например, «Health Log Backup»). */
            name: z.string().min(1).max(64),
            /** Расширения без точки (например, ['hlbackup']); латиница/цифры — гигиена §14. */
            extensions: z
              .array(z.string().regex(/^[A-Za-z0-9]{1,16}$/))
              .min(1)
              .max(8),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();

export type FileOpenDialogRequest = z.output<typeof FILE_OPEN_DIALOG_REQUEST_SCHEMA>;

/** Ответ выбора файла (§9/§7): union {path} | {canceled: true} — формы различны по ключам. */
export const FILE_OPEN_DIALOG_RESPONSE_SCHEMA = z.union([
  z
    .object({
      /** Полный путь выбранного файла (результат диалога ОС, §14). */
      path: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      /** Отмена пользователя в диалоге — ожидаемый исход, не ошибка (§7). */
      canceled: z.literal(true),
    })
    .strict(),
]);

export type FileOpenDialogResponse = z.output<typeof FILE_OPEN_DIALOG_RESPONSE_SCHEMA>;
