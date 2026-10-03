// TASK-068 §20-1 (автоматический эквивалент): «состав соответствует чек-листу» —
// мост между двумя уже покрытыми сторонами: UI-чеклист «Состав отчёта» (тест
// ReportBuilder.test.ts — таблица/средние/график/регулярность) и шаблоном 067
// (report-document.test.ts — golden-рендер). Здесь payload, СОБРАННЫЙ use case
// BuildPdfReport из портов (fake-точки/stats, как в его юнитах), отдаётся в
// createReportDocument, из дерева документа собираются все тексты Text-узлов — и
// проверяется, что все четыре раздела чек-листа в документе ЕСТЬ, титула нет в
// ИИ-варианте при includeAiSection=false (§13/§14), а при явном включении —
// ИИ-раздел промаркирован дисклеймером (§14, шаблон 067).
//
// TDD-заметка: цепочка use case → payload → документ реализована (коммиты
// 0bd9ea8, шаблон 067) — тест GREEN с первого прогона; RED невозможен без
// поломки боевого кода (прецедент TASK-065 file-op-queue). Попиксельная
// визуальная сверка — ручная приёмка §24 (headless-среда её не воспроизводит).
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FixedClock } from '@hl/kernel';

import {
  BuildPdfReportUseCase,
  type PdfRenderRunner,
  type ReportPointsSource,
  type ReportStatsSource,
} from '../../application/build-pdf-report.js';
import type { PdfRenderPayload } from '../../application/report-spec.js';
import { createReportDocument } from './report-document.ts';
import { REPORT_RU } from './report-strings.ts';

const NOW_MS = 1_758_816_000_000;
const TZ = 180;
const PROFILE = 'seed-profile-0001';
const PERIOD = { fromUtcMs: NOW_MS - 86_400_000 * 31, toUtcMs: NOW_MS };

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  utcMs: PERIOD.fromUtcMs + i * 43_200_000,
  tzOffsetMin: TZ,
  sys: 118 + (i % 20),
  dia: 76 + (i % 12),
  ...(i % 2 === 0 ? { pulse: 60 + (i % 25) } : {}),
  arm: i % 2 === 0 ? ('left' as const) : ('right' as const),
  ...(i % 5 === 0 ? { note: 'после прогулки' } : {}),
}));

const STATS = {
  count: 40,
  sysAvg: 127,
  diaAvg: 81,
  pulseAvg: 71,
  morning: { count: 20, sysAvg: 125, diaAvg: 79, pulseAvg: 70 },
  evening: { count: 20, sysAvg: 129, diaAvg: 83, pulseAvg: 72 },
  daysWithMeasurements: 20,
  longestStreakDays: 20,
};

/** Payload из use case (порты — fake, как в юнитах use case §19). */
const buildPayload = async (includeAiSection: boolean): Promise<PdfRenderPayload> => {
  const points: ReportPointsSource = {
    countByPeriod: () => Promise.resolve(ROWS.length),
    listByPeriod: () => Promise.resolve([...ROWS].reverse()), // desc репозитория
  };
  const stats: ReportStatsSource = { getStatistics: () => Promise.resolve(STATS) };
  let captured: PdfRenderPayload | undefined;
  const pool: PdfRenderRunner = {
    run: vi.fn((_name: 'pdf.render', payload: PdfRenderPayload) => {
      captured = payload;
      return Promise.resolve({ pdf: new Uint8Array([1]), pages: 1, records: 40, durationMs: 1 });
    }),
  };
  const useCase = new BuildPdfReportUseCase({
    points,
    stats,
    pool,
    saver: {
      saveCsv: () => Promise.reject(new Error('не зовётся')),
      saveJson: () => Promise.reject(new Error('не зовётся')),
      // Happy path зовёт savePdf (после рендера) — resolve, файл в тесте не нужен.
      savePdf: () => Promise.resolve({ path: 'C:\\out\\health-log-export-20250925-1900.pdf' }),
    },
    queue: { run: (operation) => operation() },
    clock: new FixedClock(NOW_MS, TZ),
    appVersion: '1.2.3',
    logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  });
  const result = await useCase.execute({
    profileId: PROFILE,
    period: PERIOD,
    includeAiSection,
    ...(includeAiSection
      ? {
          aiText: {
            contentMd: 'Резюме за период',
            generatedAt: NOW_MS - 1000,
            modelId: 'test-model',
          },
        }
      : {}),
  });
  expect(result.ok).toBe(true);
  expect(captured).toBeDefined();
  return captured as PdfRenderPayload;
};

/** Все строки Text-узлов дерева react-pdf документа (секция = текст заголовка). */
function collectTexts(node: ReactNode, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node as readonly ReactNode[]) {
      collectTexts(child, out);
    }
    return out;
  }
  if (isValidElement(node)) {
    collectTexts((node as ReactElement<{ children?: ReactNode }>).props.children, out);
  }
  return out;
}

describe('состав PDF == чек-листу «Состав отчёта» (TASK-068 §20-1, автоматический эквивалент)', () => {
  it('документ из payload use case содержит все 4 раздела чек-листа + титул; ИИ-раздела нет при includeAiSection=false', async () => {
    const payload = await buildPayload(false);
    const texts = collectTexts(createReportDocument(payload));

    // Чек-лист UI ↔ разделы PDF: таблица/средние/график/регулярность (§4/§5).
    expect(texts).toContain(REPORT_RU.title); // титул (период/версия — §5)
    expect(texts).toContain(REPORT_RU.measurementsTitle); // report.compose.table
    expect(texts).toContain(REPORT_RU.averages.title); // report.compose.averages
    expect(texts).toContain(REPORT_RU.chart.title); // report.compose.chart
    expect(texts).toContain(REPORT_RU.regularity.title); // report.compose.regularity

    // §13/§14: includeAiSection=false — ИИ-текста в документе нет вовсе.
    expect(texts).not.toContain(REPORT_RU.ai.title);
    expect(texts).not.toContain(REPORT_RU.ai.disclaimer);
  });

  it('включённый ИИ-раздел промаркирован дисклеймером (§14: «не является медицинской консультацией»)', async () => {
    const payload = await buildPayload(true);
    const texts = collectTexts(createReportDocument(payload));

    expect(texts).toContain(REPORT_RU.ai.title);
    expect(texts).toContain(REPORT_RU.ai.disclaimer);
    expect(texts).toContain('Резюме за период');
    // Четыре базовых раздела на месте вместе с ИИ-разделом.
    expect(texts).toContain(REPORT_RU.measurementsTitle);
    expect(texts).toContain(REPORT_RU.regularity.title);
  });
});
