/**
 * Хендлеры reveal (TASK-068 §5/§11, TASK-101 §5/§9): «открыть папку» после
 * сохранения отчёта/экспорта (`app/reveal-path`, shell.showItemInFolder) и
 * «Открыть папку с копиями» recovery-экрана (`app/reveal-backups`). Слой тонкий,
 * прецедент report-pdf.ts: zod-валидацию запроса делает каркас TASK-008; здесь —
 * вызов внедрённой функции reveal и ответ null (fire-and-forget, §9).
 *
 * Отказ reveal (файл удалён/проводник недоступен) — НЕ ошибка канала для UI
 * (§11: UX-удобство на своей машине); боевая обвязка контейнера глушит отказ
 * асинхронного адаптера с warn-логом — конверт ответа всегда ok null.
 */
import type { AppRevealBackupsRequest, RevealPathRequest } from '@hl/contracts';

/** Порт подсветки файла в папке (боевой — electron shell, main/platform). */
export type RevealPathFn = (path: string) => void;

/** Порт открытия каталога копий (боевой — обвязка контейнера; путь строит main, §14). */
export type RevealBackupsFn = () => void;

/** Фабрика хендлера `app/reveal-path`: {path} → null (§11). */
export function createRevealPathHandler(
  revealPath: RevealPathFn,
): (payload: RevealPathRequest) => null {
  return (payload) => {
    revealPath(payload.path);
    return null;
  };
}

/**
 * Фабрика хендлера `app/reveal-backups` (TASK-101 §5/§9): {} → null. Путь каталога
 * копий строит main (§14: renderer пути не знает) — порт без параметров; создание
 * каталога при отсутствии (первый запуск без копий) — тоже забота main-обвязки.
 */
export function createRevealBackupsHandler(
  revealBackups: RevealBackupsFn,
): (payload: AppRevealBackupsRequest) => null {
  return () => {
    revealBackups();
    return null;
  };
}
