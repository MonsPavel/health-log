/**
 * Хендлер канала `file/open-dialog` (TASK-073 §5/§9/§11) — выбор файла копии для
 * восстановления. Слой тонкий, прецедент reveal.ts: zod-валидацию {filters} делает
 * каркас TASK-008 до вызова хендлера; здесь — вызов внедрённого адаптера open-диалога
 * и ответ как есть: {path} | {canceled: true} (§7: отмена — не ошибка, конверт ok).
 *
 * Боевой адаптер (electron dialog.showOpenDialog, main/platform/file-open.ts)
 * инъекцируется контейнером (TASK-027) — renderer путь не присылает (§14), путь
 * возникает только в main как выбор пользователя.
 */
import type { FileOpenDialogRequest, FileOpenDialogResponse } from '@hl/contracts';

/** Порт open-диалога (боевой — electron dialog, main/platform/file-open.ts). */
export type FileOpenFn = (
  filters: FileOpenDialogRequest['filters'],
) => Promise<FileOpenDialogResponse>;

/** Фабрика хендлера `file/open-dialog`: {filters} → {path} | {canceled: true} (§9). */
export function createFileOpenDialogHandler(
  openFile: FileOpenFn,
): (payload: FileOpenDialogRequest) => Promise<FileOpenDialogResponse> {
  return (payload) => openFile(payload.filters);
}
