// TASK-083 §6/§19/§20: golden-контекст — фикстурный период (b) onlyMorning из
// TASK-052 → точный текст-файл __fixtures__/context-golden.md (снапшот-тест).
// Любое изменение формата проекции ломает этот тест НАМЕРЕННО (§20: обновление
// снапшота — осознанный коммит с обоснованием: формат входит в contextHash, его
// смена честно помечает кэш резюме устаревшим — §22). Файл читается as-is
// (байт-сравнение); .gitattributes фиксирует LF.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FixedClock, Instant } from '@hl/kernel';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';
import {
  buildPeriodStatistics,
  buildTrendResponse,
} from '../../analytics/index.js';
import { GOLDEN_FIXTURES } from '../../analytics/application/__fixtures__/periods.js';

import type { ContextPoint, ContextPointsPort, ContextPointsQuery } from './ports/ai-context.js';
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

/** Фикстура (b) по префиксу имени (без non-null assertion — явный throw). */
function onlyMorningFixture() {
  const found = GOLDEN_FIXTURES.find((f) => f.name.startsWith('onlyMorning'));
  if (found === undefined) {
    throw new Error('golden-фикстура onlyMorning не найдена');
  }
  return found;
}

/** Точки фикстуры 052 → точки контекста (без заметок — как из журнала без них). */
function toContextPoints(): ContextPoint[] {
  return onlyMorningFixture()
    .points()
    .map((point, i) => ({
      id: `golden-${i}`,
      sys: point.sys,
      dia: point.dia,
      pulse: point.pulse,
      takenAt: point.takenAt,
      critical: point.critical,
    }));
}

/** Подстановочный порт точек (§19). */
class FixturePoints implements ContextPointsPort {
  listByPeriod(q: ContextPointsQuery): Promise<ContextPoint[]> {
    return Promise.resolve(
      toContextPoints().filter(
        (p) =>
          (q.fromUtcMs === undefined || p.takenAt.utcMs >= q.fromUtcMs) &&
          (q.toUtcMs === undefined || p.takenAt.utcMs <= q.toUtcMs),
      ),
    );
  }
}

function makeDeps(): AiContextBuilderDeps {
  return {
    points: new FixturePoints(),
    stats: {
      getStatistics: async (q) => {
        const selected = toContextPoints().filter(
          (p) =>
            (q.fromUtcMs === undefined || p.takenAt.utcMs >= q.fromUtcMs) &&
            (q.toUtcMs === undefined || p.takenAt.utcMs <= q.toUtcMs),
        );
        return JSON.parse(JSON.stringify(buildPeriodStatistics(selected, BP_OFFICE_ESC2018)));
      },
    },
    series: {
      getSeries: async (q, mode) => {
        const selected = toContextPoints().filter(
          (p) =>
            (q.fromUtcMs === undefined || p.takenAt.utcMs >= q.fromUtcMs) &&
            (q.toUtcMs === undefined || p.takenAt.utcMs <= q.toUtcMs),
        );
        return buildTrendResponse(selected, mode);
      },
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
