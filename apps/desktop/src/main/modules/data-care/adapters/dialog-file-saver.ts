/**
 * TASK-070 §5/§6 (арх. 02 §3.5: FileSaver — «save dialog — всегда выбор
 * пользователя»): боевой BackupFileSaver поверх dialog.showSaveDialog Electron.
 *
 * Electron импортируется ЛЕНИВО внутри save() (§20-прецедент SafeStorageKeyVault
 * и дефолтной фабрики vault контейнера): в node-окружении vitest save() не
 * вызывается (тесты подставляют порт-подделку в use case), а статического
 * импорта electron в графе data-care нет.
 *
 * Контракт (§13): отказ пользователя (canceled) → null — use case маппит в
 * BACKUP/CANCELED (ожидаемый исход, не сбой). Расширение `.hlbackup` добирает
 * use case (фильтр диалога лишь предлагает его).
 */
/** Минимальная поверхность dialog.showSaveDialog (structural, §19-прецедент VaultSafeStorage). */
export interface SaveDialogApi {
  showSaveDialog(options: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePath?: string }>;
}

/** Боевой диалог сохранения копии (§5: ask → диалог). */
export class DialogFileSaver {
  /** §5: диалог сохранения — null при отмене пользователя (§13). */
  async save(options: { defaultPath: string }): Promise<string | null> {
    const electron = await import('electron');
    const dialog = (electron as { dialog?: SaveDialogApi }).dialog;
    if (dialog === undefined) {
      // Вне Electron-рантайма диалог недоступен — честная ошибка (не тихий сбой);
      // use case маппит в BACKUP/FAILED с исходом в cause (§5).
      throw new Error('DialogFileSaver: dialog.showSaveDialog недоступен (запуск вне Electron?)');
    }
    const result = await dialog.showSaveDialog({
      title: 'Health Log',
      defaultPath: options.defaultPath,
      filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }],
    });
    if (result.canceled || result.filePath === undefined || result.filePath === '') {
      return null;
    }
    return result.filePath;
  }
}
