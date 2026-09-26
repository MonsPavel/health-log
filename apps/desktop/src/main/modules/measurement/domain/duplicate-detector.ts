/**
 * TASK-019 §2/§7: DuplicateDetector — чистая функция «вероятного дубля» (EC-04,
 * SRS 07: двойное сохранение размывает статистику без пользы). Правило (§7):
 * существует запись r из recent, где r.bp.sys === candidate.sys &&
 * r.bp.dia === candidate.dia && abs(r.takenAt.utcMs − candidate.utcMs) ≤
 * DUPLICATE_WINDOW_MS — граница включительно (ровно 120 000 мс → дубль, 120 001 —
 * нет, §13). Совпадать должны ОБА значения: только sys или только dia — не дубль
 * (§19). Пульс не сравнивается — сознательное решение (§4: часто отличается между
 * измерениями подряд).
 *
 * Рука (arm) сознательно игнорируется (§13, задокументированное решение): правило
 * по значениям, «та же пара у другой руки» — всё равно кандидат на дубль; финальное
 * решение за пользователем.
 *
 * Pure (§7): функция НЕ фильтрует историю по времени сама — use case (TASK-029)
 * передаёт последние ~10 записей, отсекая их Instant-сравнением относительно момента
 * кандидата; окно здесь — только расстояние «кандидат ↔ запись» (abs, в обе стороны:
 * двойной Enter возможен и «назад», и «вперёд»). Флаг — ПОДСКАЗКА, а не запрет (§3):
 * слияние/автоудаление никогда (§5 — данные пользователя священны), решает диалог
 * TASK-032. Без чтения времени и побочных эффектов: O(n), n ≤ 10 (§15), вызывается
 * только при добавлении записи.
 */
import type { BpMeasurement } from './bp-measurement.js';
import { DUPLICATE_WINDOW_MS } from './constants.js';

/**
 * Кандидат на сохранение (§5): сырые значения формы до создания агрегата —
 * момент передаётся числом utcMs (агрегат ещё не собран, Instant не нужен).
 */
export interface DuplicateCandidate {
  readonly sys: number;
  readonly dia: number;
  readonly utcMs: number;
}

/**
 * Детектор вероятного дубля (§2): true — в recent есть запись с теми же sys/dia в
 * пределах DUPLICATE_WINDOW_MS от кандидата (включительно, §13); false — иначе
 * (включая пустой recent). recent — последние ~10 записей, порядок не важен (§15).
 */
export function detectDuplicate(
  recent: ReadonlyArray<BpMeasurement>,
  candidate: DuplicateCandidate,
): boolean {
  return recent.some(
    (r) =>
      r.bp.sys === candidate.sys &&
      r.bp.dia === candidate.dia &&
      Math.abs(r.takenAt.utcMs - candidate.utcMs) <= DUPLICATE_WINDOW_MS,
  );
}
