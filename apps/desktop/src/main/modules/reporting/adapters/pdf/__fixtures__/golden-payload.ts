/**
 * TASK-067 §19: фикстура golden-рендера — 40 детерминированных записей за
 * сентябрь 2026 (утро/вечер, +03:00), смешанные пульсы/руки/примечания.
 * Никакого randomness: все значения — фиксированные арифметические паттерны
 * (детерминизм NFR-10 — одинаковый вход → одинаковый sha256).
 *
 * Фикстуру импортируют ТОЛЬКО тесты (vitest-контекст): в воркер она уходит
 * structured clone'ом payload'а — нативный Node этот файл не грузит.
 */
import type { PdfRenderPayload, ReportRow } from '../../../application/report-spec.ts';

const TZ_OFFSET_MIN = 180;
const ROWS_COUNT = 40;

/** Утро 07:15 / вечер 19:45 настенного (+03:00) времени каждого из 20 дней. */
function buildRows(): ReportRow[] {
  return Array.from({ length: ROWS_COUNT }, (_, i) => {
    const day = Math.floor(i / 2);
    const isMorning = i % 2 === 0;
    const utcMs = Date.UTC(2026, 8, 1 + day, isMorning ? 4 : 16, isMorning ? 15 : 45);
    return {
      utcMs,
      tzOffsetMin: TZ_OFFSET_MIN,
      sys: 118 + ((i * 7) % 42),
      dia: 72 + ((i * 5) % 18),
      ...(i % 5 === 3 ? { pulse: undefined } : { pulse: 58 + ((i * 3) % 22) }),
      ...(i % 7 === 6
        ? { arm: undefined }
        : { arm: isMorning ? ('left' as const) : ('right' as const) }),
      ...(i === 5
        ? { note: 'После пробежки; самочувствие хорошее' }
        : i === 13
          ? { note: '«Неровный пульс» — повторить измерение утром' }
          : {}),
    };
  });
}

const rows = buildRows();

/** Средние, согласованные с rows (считает фикстура, не прод-код). */
function partAverages(selected: readonly ReportRow[]) {
  const pulses = selected.flatMap((row) => (row.pulse === undefined ? [] : [row.pulse]));
  const avg = (values: number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    count: selected.length,
    sysAvg: avg(selected.map((row) => row.sys)),
    diaAvg: avg(selected.map((row) => row.dia)),
    ...(pulses.length > 0 ? { pulseAvg: avg(pulses) } : {}),
  };
}

const morning = rows.filter((_, i) => i % 2 === 0);
const evening = rows.filter((_, i) => i % 2 === 1);

/**
 * Golden-payload (§19): период сентябрь 2026, ИИ-раздел — по явному включению
 * (в golden-спеке ВЫКЛЮЧЕН; тесты ИИ-раздела переопределяют spec поверх этого).
 */
export const GOLDEN_PAYLOAD: PdfRenderPayload = {
  spec: {
    period: { fromUtcMs: Date.UTC(2026, 8, 1, 0, 0), toUtcMs: Date.UTC(2026, 8, 30, 20, 59) },
    includeAiSection: false,
  },
  data: {
    appVersion: '0.1.0-test',
    generatedAtUtcMs: Date.UTC(2026, 8, 29, 18, 7),
    periodTzOffsetMin: TZ_OFFSET_MIN,
    rows,
    averages: {
      period: partAverages(rows),
      morning: partAverages(morning),
      evening: partAverages(evening),
    },
    regularity: { daysWithMeasurements: 20, totalDays: 30, longestStreakDays: 20 },
  },
};

/** Текст ИИ-раздела для тестов включённого режима (§5: contentMd/generatedAt/modelId). */
export const GOLDEN_AI_TEXT = {
  contentMd:
    'За период отмечается умеренное повышение систолического АД в вечерние часы.\n\nРекомендуется продолжить ведение дневника и обсудить динамику с врачом.',
  generatedAt: Date.UTC(2026, 8, 29, 18, 0),
  modelId: 'test-model-v1',
};
