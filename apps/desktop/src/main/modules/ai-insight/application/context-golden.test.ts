// TASK-083 §6/§19/§20: golden-контекст — фикстурный период (b) onlyMorning из
// TASK-052 → точный текст-файл __fixtures__/context-golden.md (снапшот-тест).
// Любое изменение формата проекции ломает этот тест НАМЕРЕННО (§20: обновление
// снапшота — осознанный коммит с обоснованием: формат входит в contextHash, его
// смена честно помечает кэш резюме устаревшим — §22). Файл читается as-is
// (байт-сравнение); .gitattributes фиксирует LF, .prettierignore исключает файл
// из форматтера (markdown-форматирование меняло бы байты снапшота).
//
// Вход зафиксирован ИНЛАЙН (те же значения, что фикстура (b) 052): чужие
// __fixtures__ — не публичный API модуля (module-public-api TASK-005), а
// снапшот-дисциплина и требует собственного входа — правка фикстур 052 не должна
// молча менять golden-контекст (это осознанный коммит, §20).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PeriodStatisticsDto } from '@hl/contracts';
import { FixedClock, Instant } from '@hl/kernel';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';
import { buildPeriodStatistics, buildTrendResponse } from '../../analytics/index.js';

import type { ContextPoint, ContextPointsQuery } from './ports/ai-context.js';
import { AiContextBuilder, type AiContextBuilderDeps } from './ai-context-builder.js';

/** «Сейчас» FixedClock — после фикстурных дат (детерминизм, NFR-10). */
const NOW_MS = Instant.fromIso('2026-03-31T12:00:00.000+03:00').utcMs;
/** Пояс фикстур +03:00 → 180 минут. */
const TZ = 180;

/** Границы golden-периода: неделя, накрывающая фикстуру (b) (2026-03-02..06). */
const PERIOD = {
  fromUtcMs: Instant.fromIso('2026-03-01T00:00:00.000+03:00').utcMs,
  toUtcMs: Instant.fromIso('2026-03-08T23:59:00.000+03:00').utcMs,
} as const;

/**
 * Фикстура (b) onlyMorning — 5 утренних записей (2026-03-02..06, 07:30, UTC+03):
 * те же значения, что в golden-фикстурах TASK-052 §19 (sys/dia — прогрессия с
 * шагом 2, пульс 58/«нет»/64/«нет»/68, критических нет).
 */
function toContextPoints(): ContextPoint[] {
  const days = [
    { day: '2026-03-02', sys: 118, dia: 76, pulse: 58 as number | undefined },
    { day: '2026-03-03', sys: 120, dia: 78, pulse: undefined },
    { day: '2026-03-04', sys: 122, dia: 80, pulse: 64 as number | undefined },
    { day: '2026-03-05', sys: 124, dia: 82, pulse: undefined },
    { day: '2026-03-06', sys: 126, dia: 84, pulse: 68 as number | undefined },
  ];
  return days.map((row, i) => ({
    id: `golden-${i}`,
    sys: row.sys,
    dia: row.dia,
    pulse: row.pulse,
    takenAt: Instant.fromIso(`${row.day}T07:30:00.000+03:00`),
    critical: undefined,
  }));
}

function makeDeps(): AiContextBuilderDeps {
  const filter = (q: ContextPointsQuery): ContextPoint[] =>
    toContextPoints().filter(
      (p) =>
        (q.fromUtcMs === undefined || p.takenAt.utcMs >= q.fromUtcMs) &&
        (q.toUtcMs === undefined || p.takenAt.utcMs <= q.toUtcMs),
    );
  return {
    points: {
      listByPeriod: (q) => Promise.resolve(filter(q)),
    },
    stats: {
      getStatistics: (q) => {
        // toDto 054: JSON round-trip — undefined-части исчезают, форма = провод.
        const stats = JSON.parse(
          JSON.stringify(buildPeriodStatistics(filter(q), BP_OFFICE_ESC2018)),
        ) as PeriodStatisticsDto;
        return Promise.resolve(stats);
      },
    },
    series: {
      getSeries: (q, mode) => Promise.resolve(buildTrendResponse(filter(q), mode)),
    },
    scales: { getActiveScale: () => Promise.resolve(BP_OFFICE_ESC2018) },
    clock: new FixedClock(NOW_MS, TZ),
  };
}

describe('golden-контекст (§6/§19/§20 — снапшот)', () => {
  it('фикстура (b) onlyMorning → байт-равен __fixtures__/context-golden.md', async () => {
    const goldenPath = join(import.meta.dirname, '__fixtures__', 'context-golden.md');
    const golden = readFileSync(goldenPath, 'utf8');

    const ctx = await new AiContextBuilder(makeDeps()).build({
      profileId: 'profile-1',
      period: PERIOD,
      includeNotes: true,
      modelId: 'test-model',
    });

    expect(ctx.text).toBe(golden);
  });
});
