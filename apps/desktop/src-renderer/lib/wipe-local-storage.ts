/**
 * TASK-072 §10/AC-5: очистка localStorage при полном удалении данных. Вызывается
 * рендерером ПОСЛЕ подтверждённого execute канала `data/wipe` (ответ
 * {restarting: true}) и ПЕРЕД фактическим relaunch (отложенный — §9; подключение
 * к UI — TASK-073). main localStorage рендерера не видит — чистит сам renderer.
 *
 * «Всё» (§10) трактовано как все ключи ПРЕФИКСА `hl.` — текущий состав приложения
 * (`hl.formDraft`, `hl.formPrefs` — TASK-039; `hl.theme`, `hl.textScale` —
 * TASK-013) и будущие: состояние «как после установки» (§2) не должно зависеть от
 * полноты перечня. Чужие ключи (не `hl.*`) не трогаются. Черновики — временное
 * UI-состояние без PHI в резервных копиях (§14 form-store), но при полном удалении
 * данных удаляются наравне с БД — право на исчезновение (принцип 3, FR-6.5).
 */

/** Префикс ключей localStorage приложения (всё, что им создано, стирается). */
export const WIPE_LOCAL_STORAGE_PREFIX = 'hl.';

/**
 * Удаляет все ключи префикса `hl.` (§10). Возвращает список удалённых ключей —
 * факт для лога/тестов (значения не возвращаются — §14). Storage вводится
 * параметром (по умолчанию — глобальный localStorage): юнит-тест без jsdom-мока
 * глобала и переиспользование в будущем.
 */
export function clearWipeLocalStorage(storage: Storage = localStorage): string[] {
  const removed: string[] = [];
  // Снимок имён до удаления: removeItem во время итерации live-коллекции
  // (localStorage.length) сдвигает индексы — классический пропуск элементов.
  const names: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) {
      names.push(key);
    }
  }
  for (const key of names) {
    if (key.startsWith(WIPE_LOCAL_STORAGE_PREFIX)) {
      storage.removeItem(key);
      removed.push(key);
    }
  }
  return removed;
}
