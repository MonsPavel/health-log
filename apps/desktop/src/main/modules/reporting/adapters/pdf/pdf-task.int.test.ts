// TASK-067 §9/§19/§20: интеграционные тесты задачи `pdf.render` в РЕАЛЬНОМ
// воркере пула (TASK-066: worker_threads, entry — исходник worker.ts под
// нативным type-stripping Node; tasksModule — pdf-tasks.ts, та же цепочка, что
// в проде после tsc-emit). Покрывает: регистрацию задачи, %PDF-результат с
// метриками §18, сортировку asc (§5), детерминизм байтов воркер↔main (§19/AC2),
// fail-fast повреждённого payload (§13/§14), замер 5k ≤30 с (§15/AC6).
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { renderToBuffer } from '@react-pdf/renderer';
import { describe, expect, it } from 'vitest';

import { WorkerPool } from '../../../../shared/workerpool/pool.js';
import { GOLDEN_PAYLOAD, GOLDEN_AI_TEXT } from './__fixtures__/golden-payload.ts';
import type { PdfRenderPayload, PdfRenderResult } from '../../application/report-spec.ts';
import { createReportDocument } from './report-document.ts';
import { PDF_TASKS_MODULE_URL } from './pdf-tasks-url.ts';

const WORKER_ENTRY_URL = new URL('../../../../shared/workerpool/worker.ts', import.meta.url);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Пул с боевой цепочкой задач (исходники .ts — нативный Node type-stripping). */
const pool = new WorkerPool({ entryUrl: WORKER_ENTRY_URL, tasksModule: PDF_TASKS_MODULE_URL.href });

const runRender = async (payload: PdfRenderPayload): Promise<PdfRenderResult> =>
  (await pool.run('pdf.render', payload)) as PdfRenderResult;

describe('pdf.render в воркере пула (TASK-067 §9)', () => {
  it(
    'golden через воркер: %PDF, метрики §18, байты = рендеру в main (детерминизм AC2)',
    { timeout: 30_000 },
    async () => {
      const result = await runRender(GOLDEN_PAYLOAD);
      expect(Buffer.from(result.pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
      expect(result.pages).toBeGreaterThanOrEqual(2);
      expect(result.pages).toBeLessThanOrEqual(6);
      expect(result.records).toBe(40);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Один и тот же payload → одинаковые байты в воркере и в main-процессе.
      const inProcess = new Uint8Array(await renderToBuffer(createReportDocument(GOLDEN_PAYLOAD)));
      expect(sha256(result.pdf)).toBe(sha256(inProcess));
    },
  );

  it('сортировка asc (§5): перемешанные строки → тот же PDF', { timeout: 30_000 }, async () => {
    const reversed: PdfRenderPayload = {
      ...GOLDEN_PAYLOAD,
      data: { ...GOLDEN_PAYLOAD.data, rows: [...GOLDEN_PAYLOAD.data.rows].reverse() },
    };
    const result = await runRender(reversed);
    const direct = await runRender(GOLDEN_PAYLOAD);
    expect(sha256(result.pdf)).toBe(sha256(direct.pdf));
    expect(result.records).toBe(40);
  });

  it(
    'AC3 через воркер: includeAiSection=false + aiText → байты как без aiText',
    { timeout: 30_000 },
    async () => {
      const ignored = await runRender({
        ...GOLDEN_PAYLOAD,
        spec: { ...GOLDEN_PAYLOAD.spec, includeAiSection: false, aiText: GOLDEN_AI_TEXT },
      });
      const withoutAi = await runRender(GOLDEN_PAYLOAD);
      expect(sha256(ignored.pdf)).toBe(sha256(withoutAi.pdf));
    },
  );

  it(
    'повреждённый payload → отказ ТОЛЬКО этой job, воркер жив (§13/§14)',
    { timeout: 30_000 },
    async () => {
      await expect(runRender({ foo: 'bar' } as unknown as PdfRenderPayload)).rejects.toThrow(
        /pdf\.render/,
      );
      await expect(
        runRender({ ...GOLDEN_PAYLOAD, data: undefined } as unknown as PdfRenderPayload),
      ).rejects.toThrow(/pdf\.render/);
      // Пул пережил отказ: следующая job выполняется штатно.
      const next = await runRender(GOLDEN_PAYLOAD);
      expect(Buffer.from(next.pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    },
  );

  it(
    '§15/AC6: 5000 записей на входе → рендер ≤ 30 с локально, таблица ограничена 2000 (§9)',
    { timeout: 90_000 },
    async () => {
      const rows = Array.from({ length: 5000 }, (_, i) => ({
        utcMs: Date.UTC(2024, 0, 1) + i * 3_600_000,
        tzOffsetMin: 180,
        sys: 110 + (i % 40),
        dia: 70 + (i % 20),
        pulse: 60 + (i % 15),
      }));
      const startedAtMs = performance.now();
      const result = await runRender({
        spec: {
          period: { fromUtcMs: rows[0]!.utcMs, toUtcMs: rows.at(-1)!.utcMs },
          includeAiSection: false,
        },
        data: {
          appVersion: '0.1.0-test',
          generatedAtUtcMs: Date.UTC(2026, 8, 29, 18, 7),
          periodTzOffsetMin: 180,
          rows,
          averages: {
            period: { count: rows.length, sysAvg: 129.4, diaAvg: 79.2, pulseAvg: 67.1 },
            morning: { count: 2500, sysAvg: 125, diaAvg: 78, pulseAvg: 65 },
            evening: { count: 2500, sysAvg: 133, diaAvg: 81, pulseAvg: 69 },
          },
          regularity: { daysWithMeasurements: 208, totalDays: 209, longestStreakDays: 209 },
        },
      });
      const wallMs = performance.now() - startedAtMs;
      expect(result.records).toBe(2000); // §9: последние 2000 из 5000
      // Страницы = чанки таблицы ceil(2000/30)=67: хвост (средние/регулярность/
      // график/приписка) помещается на последней странице — чанк неполный (20 строк).
      expect(result.pages).toBe(Math.ceil(2000 / 30));
      expect(result.durationMs).toBeLessThan(30_000);
      expect(wallMs).toBeLessThan(45_000);
      console.log(
        `pdf.render 5k: durationMs=${result.durationMs} pages=${result.pages} records=${result.records}`,
      );
    },
  );
});
