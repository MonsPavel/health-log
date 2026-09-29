/**
 * TASK-073 §5/§9 (прецедент restore-backup.ts §9 — «боевая реализация контейнера»):
 * боевой планировщик перезапуска для use case'ов Data Care (RestoreBackup 071,
 * WipeAllData 072) — ОТЛОЖЕННО (500 мс), чтобы ответ канала ушёл рендереру до
 * выхода (деталь §9 071, зафиксирована), затем app.relaunch() + app.exit(0).
 *
 * Electron импортируется ЛЕНИВО внутри колбэка таймера (§20-прецедент
 * SafeStorageKeyVault): статического импорта electron в графе data-care нет.
 *
 * Вне Electron-рантайма (node/vitest) перезапуск невозможен физически — но и не
 * требуется: relaunch вызывается ТОЛЬКО после успешного execute (замена/удаление
 * данных уже выполнены, соединение закрыто). Бросок здесь ничего не чинит и роняет
 * приложение на финальном шаге — honest console.error и выход без relaunch
 * (документированное отклонение от «бросать честную ошибку»: точка вызова — после
 * необратимой фазы, прецедент best-effort cleanupRestoreSafetyCopy §14).
 */
/** Минимальная поверхность app для перезапуска (structural, §19-прецедент SaveDialogApi). */
export interface RelaunchApp {
  relaunch(): void;
  exit(exitCode: number): void;
}

/** Задержка перед выходом, мс (§9 071: ответ канала должен успеть уйти рендереру). */
export const RELAUNCH_DELAY_MS = 500;

/** Боевой планировщик перезапуска (§9): relaunch + exit(0) через 500 мс. */
export function createDeferredRelaunch(): () => void {
  return () => {
    setTimeout(() => {
      void import('electron')
        .then((electron) => {
          const app = (electron as { app?: RelaunchApp }).app;
          if (app === undefined) {
            console.error(
              '[data-care] перезапуск недоступен: app Electron не найден (запуск вне Electron?)',
            );
            return;
          }
          app.relaunch();
          app.exit(0);
        })
        .catch((cause: unknown) => {
          console.error('[data-care] перезапуск не удался: import electron упал', cause);
        });
    }, RELAUNCH_DELAY_MS);
  };
}
