/**
 * TASK-043 §5/§6/§19: helper сидинга истории измерений для e2e-сценариев
 * (arrange-фаза). Записи добавляются через РЕАЛЬНЫЙ мост рендерера
 * `window.hl.invoke('measurements/add', …)` в цикле (§5: «быстрее кликов —
 * допустимо для arrange-фазы»): полный стек main (домен TASK-017 → use case
 * TASK-029 → SQLCipher-репозиторий TASK-026) отрабатывает как в бою, моков main
 * нет (§19). Ассерты сценариев — всегда через UI (act/assert).
 *
 * takenAt передаётся числом utcMs: окна эвристик в use case add отсекаются
 * Instant-сравнением ОТ МОМЕНТА КАНДИДАТА (TypoHeuristic — 14 дней ДО него,
 * add-measurement.ts §9) — сидинг «k·24ч назад» не зависит от полуночи/зон.
 * Смещение зоны берётся из рантайма теста — то же, что форма кладёт в «сейчас»
 * (tzOffsetMinOf). Пульс/заметка сценариям эвристик не нужны — не задаются.
 */

import type { Page } from '@playwright/test';

/** Профиль-владелец (seed миграции v1; зеркало PROFILE_ID use-add-measurement.ts). */
const PROFILE_ID = 'seed-profile-0001';

/** Запись для сидинга: значения + момент измерения (utcMs). */
export interface SeedMeasurement {
  /** СДА. */
  readonly sys: number;
  /** ДДА. */
  readonly dia: number;
  /** Момент измерения (utcMs) — обычно «сейчас − k·24ч» для истории эвристик. */
  readonly takenAtUtcMs: number;
}

/**
 * Добавляет записи через мост `window.hl` страницы (§5). Каждое add проверяется
 * на ok-конверт: отказ add (диапазон/инвариант/STORAGE) громко роняет arrange —
 * сценарий не должен идти на тихо неверном раскладе.
 */
export async function seedMeasurements(
  page: Page,
  entries: readonly SeedMeasurement[],
): Promise<void> {
  const tzOffsetMin = -new Date().getTimezoneOffset();
  await page.evaluate(
    async ({ entries, tzOffsetMin, profileId }) => {
      // Рантайм страницы — браузер (мост из preload.cts); в node-типах tsconfig DOM-глобалов
      // нет — мост достаётся через globalThis с локальной структурой HlBridge.invoke.
      const bridge = (
        globalThis as {
          hl?: { invoke: (channel: string, payload: unknown) => Promise<unknown> };
        }
      ).hl;
      if (bridge === undefined) {
        throw new Error('seedMeasurements: preload-мост window.hl недоступен на странице');
      }
      for (const entry of entries) {
        const raw: unknown = await bridge.invoke('measurements/add', {
          profileId,
          sys: entry.sys,
          dia: entry.dia,
          irregularPulse: false,
          arm: 'right',
          takenAt: { utcMs: entry.takenAtUtcMs, tzOffsetMin },
        });
        // Конверт ApiEnvelope (арх. 05 §6): ok:false — отказ add (дубль/диапазон/домен).
        if ((raw as { ok?: unknown } | null)?.ok !== true) {
          throw new Error(`seedMeasurements: measurements/add отклонён (${JSON.stringify(raw)})`);
        }
      }
    },
    { entries, tzOffsetMin, profileId: PROFILE_ID },
  );
}
