/**
 * TASK-073 §5/§9/§14 (арх. 02 §3.4): боевой адаптер file/open — dialog.showOpenDialog
 * Electron для выбора файла копии при восстановлении. Путь файла появляется ТОЛЬКО
 * как результат диалога ОС (renderer присылает лишь фильтры — §14, тот же принцип,
 * что у save-диалога экспорта 065); выбор пользователя наружу разрешён (§14: это
 * путь его собственного файла).
 *
 * Electron импортируется ЛЕНИВО внутри openFile() (§20-прецедент ElectronFileSaver/
 * DialogFileSaver): в node-окружении vitest openFile() с мок-электроном не вызывается
 * (тесты подставляют функцию-порт в хендлер), а статического импорта electron в графе
 * main нет.
 *
 * ОТМЕНА (§7): canceled/пустой список → {canceled: true} — не ошибка; вне
 * Electron-рантайма диалог недоступен — честное исключение (не тихий сбой), каркас
 * доставит его как APP/INTERNAL.
 */
/** Минимальная поверхность dialog.showOpenDialog (structural, §19-прецедент SaveDialogApi). */
export interface OpenDialogApi {
  showOpenDialog(options: {
    filters?: { name: string; extensions: string[] }[];
    properties?: string[];
  }): Promise<{ canceled: boolean; filePaths?: string[] }>;
}

/** Диалог выбора файла (§9): фильтры payload'а → {path} | {canceled: true}. */
export async function electronFileOpenDialog(
  filters: readonly { name: string; extensions: readonly string[] }[],
): Promise<{ path: string } | { canceled: true }> {
  const electron = await import('electron');
  const dialog = (electron as { dialog?: OpenDialogApi }).dialog;
  if (dialog === undefined) {
    throw new Error(
      'electronFileOpenDialog: dialog.showOpenDialog недоступен (запуск вне Electron?)',
    );
  }
  const result = await dialog.showOpenDialog({
    filters: filters.map((filter) => ({ name: filter.name, extensions: [...filter.extensions] })),
    properties: ['openFile'],
  });
  const picked = result.filePaths?.[0];
  if (result.canceled || picked === undefined || picked === '') {
    return { canceled: true };
  }
  return { path: picked };
}
