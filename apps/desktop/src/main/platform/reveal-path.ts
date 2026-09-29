/**
 * TASK-068 §5/§11 (арх. 02 §3.4): боевой reveal поверх Electron —
 * shell.showItemInFolder (подсветить файл в папке). Electron импортируется ЛЕНИВО
 * внутри функции (§20-прецедент ElectronFileSaver): в node-окружении vitest
 * функция не вызывается (боевая обвязка контейнера глушит отказ — канал
 * fire-and-forget §9), статического импорта electron в графе модулей нет.
 *
 * БЕЗОПАСНОСТЬ (§11 РЕШЕНИЕ): путь — тот, что вернул наш же save-диалог; reveal
 * принимает произвольный путь как UX-удобство на своей машине (open в explorer,
 * риск нулевой локально) — санитизация не требуется, решение задокументировано
 * в контракте канала (packages/contracts report/schemas.ts).
 */

/** Минимальная поверхность shell.showItemInFolder (structural, §19-прецедент). */
export interface RevealShellApi {
  showItemInFolder(fullPath: string): void;
}

/** Боевой reveal (§5): подсветить файл в системном проводнике. */
export async function electronRevealPath(path: string): Promise<void> {
  const electron = await import('electron');
  const shell = (electron as { shell?: RevealShellApi }).shell;
  if (shell === undefined) {
    throw new Error('electronRevealPath: shell.showItemInFolder недоступен (запуск вне Electron?)');
  }
  shell.showItemInFolder(path);
}
