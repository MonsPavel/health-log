/**
 * TASK-070 §5/§6 (арх. 02 §3.5: FileSaver — порт Reporting/Data Care): выбор места
 * сохранения копии. `ask` → диалог main-процесса (реализация — adapters, electron
 * dialog лениво, прецедент SafeStorageKeyVault); `auto` (hook миграций) — порт не
 * используется (§5/§9: путь авто, без диалога).
 *
 * Контракт: null — пользователь отменил диалог (§13 → BACKUP/CANCELED, ожидаемый
 * исход, не сбой). Диалог ВСЕГДА выбор пользователя (арх. 02 §3.4/§3.5).
 */

/** Опции диалога сохранения (main знает контекст, renderer не участвует). */
export interface BackupSaveOptions {
  /** Предлагаемое имя файла (метка времени от Clock, детерминизм тестов). */
  readonly defaultPath: string;
}

/** Порт выбора места сохранения копии. Реализация — DialogFileSaver (adapters). */
export interface BackupFileSaver {
  /** Возвращает выбранный путь или null при отмене (§13 → BACKUP/CANCELED). */
  save(options: BackupSaveOptions): Promise<string | null>;
}
