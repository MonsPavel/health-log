/**
 * Хендлер канала `file/open-dialog` (TASK-073 §5/§9/§11) — файловый пикер
 * восстановления. Слой тонкий (прецедент report.ts): zod-валидацию делает каркас;
 * здесь — вызов диалога main (адаптер OpenFileDialog, ленивый electron) и маппинг:
 *  - путь → {path} (факт выбора пользователя — наружу можно, §14);
 *  - отмена (null) → {canceled: true} — конверт ok, НЕ ошибка (§7: ожидаемый исход,
 *    UI тихо; прецедент report/export-*).
 */
import type { FileOpenDialogRequest, FileOpenDialogResponse } from '@hl/contracts';

/** Структурный порт диалога открытия (адаптер контейнера; стаб в тестах, §19). */
export interface OpenFileDialogPort {
  /** Полный путь выбранного файла или null при отмене пользователя (§7). */
  open(options: FileOpenDialogRequest): Promise<string | null>;
}

/** Фабрика хендлера `file/open-dialog` (§9): {filters?} → {path} | {canceled: true}. */
export function createOpenDialogHandler(
  dialog: OpenFileDialogPort,
): (payload: FileOpenDialogRequest) => Promise<FileOpenDialogResponse> {
  return async (payload) => {
    const path = await dialog.open(payload);
    return path === null ? { canceled: true } : { path };
  };
}
