/**
 * TASK-073 §9/§6 (арх. 02 §3.5 — прецедент DialogFileSaver): боевой OpenFileDialog
 * поверх dialog.showOpenDialog Electron — файловый пикер восстановления (renderer
 * присылает только фильтры, путь выбирает main — §14).
 *
 * Electron импортируется ЛЕНИВО внутри open() (§20-прецедент DialogFileSaver):
 * в node-окружении vitest open() не вызывается с ожиданием успеха (контейнерный
 * тест проверяет честный отказ — APP/INTERNAL), статического импорта electron в
 * графе data-care нет.
 *
 * Контракт (§7): отказ пользователя (canceled / пустой выбор) → null — хендлер
 * маппит в {canceled: true} конвертом ok (ожидаемый исход, не сбой).
 */
/** Минимальная поверхность dialog.showOpenDialog (structural, §19-прецедент SaveDialogApi). */
export interface OpenDialogApi {
  showOpenDialog(options: {
    title?: string;
    filters?: { name: string; extensions: string[] }[];
    properties?: string[];
  }): Promise<{ canceled: boolean; filePaths?: string[] }>;
}

/** Боевой диалог открытия файла копии (§9: восстановление → выбор файла). */
export class OpenFileDialog {
  /** §9: путь выбранного файла — null при отмене пользователя (§7). */
  async open(options: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
    const electron = await import('electron');
    const dialog = (electron as { dialog?: OpenDialogApi }).dialog;
    const showOpenDialog = dialog?.showOpenDialog;
    if (showOpenDialog === undefined) {
      // Вне Electron-рантайма диалог недоступен — честная ошибка (не тихий сбой);
      // каркас конвертирует исключение в APP/INTERNAL (§13 п. 4).
      throw new Error('OpenFileDialog: dialog.showOpenDialog недоступен (запуск вне Electron?)');
    }
    const result = await showOpenDialog.call(dialog, {
      title: 'Health Log',
      filters: options.filters,
      properties: ['openFile'],
    });
    const path = result.canceled ? undefined : result.filePaths?.[0];
    if (path === undefined || path === '') {
      return null;
    }
    return path;
  }
}
