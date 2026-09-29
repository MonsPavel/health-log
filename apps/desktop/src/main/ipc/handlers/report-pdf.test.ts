// TASK-068 §5/§11: юниты хендлера `report/pdf` — тонкий слой (прецедент report.ts
// TASK-065): ok-конверт use case → ответ канала ({path} | {canceled: true}, file из
// значения use case); err → AppError бросается НАРУЖУ ровно на границе каркаса
// (register-channel §13 п. 3–4: каркас вернёт ApiFailure(toDto)).
import { describe, expect, it, vi } from 'vitest';

import { AppError, err, ok } from '@hl/kernel';

import { createBuildPdfReportHandler } from './report-pdf.js';
import type { BuildPdfReportValue } from '../../modules/reporting/application/build-pdf-report.js';

const useCaseOf = (
  result: Promise<{ ok: true; value: BuildPdfReportValue } | { ok: false; error: AppError }>,
) =>
  ({ execute: vi.fn(() => result) }) as unknown as Parameters<
    typeof createBuildPdfReportHandler
  >[0];

const REQUEST = {
  profileId: 'seed-profile-0001',
  period: { fromUtcMs: 1_758_000_000_000, toUtcMs: 1_758_816_000_000 },
  includeAiSection: false,
} as const;

describe('createBuildPdfReportHandler — Result → контракт канала (§5/§11)', () => {
  it('ok {file: {path}} → {path} (путь — выбор пользователя из диалога, §14)', async () => {
    const handler = createBuildPdfReportHandler(
      useCaseOf(
        Promise.resolve(
          ok({
            pages: 2,
            durationMs: 40,
            file: { path: 'C:\\out\\health-log-export-20250925-1900.pdf' },
          }),
        ),
      ),
    );

    await expect(handler(REQUEST)).resolves.toEqual({
      path: 'C:\\out\\health-log-export-20250925-1900.pdf',
    });
  });

  it('ok {file: {canceled: true}} → {canceled: true} (отмена — не ошибка, §7)', async () => {
    const handler = createBuildPdfReportHandler(
      useCaseOf(Promise.resolve(ok({ pages: 1, durationMs: 10, file: { canceled: true } }))),
    );

    await expect(handler(REQUEST)).resolves.toEqual({ canceled: true });
  });

  it('err REPORT/EMPTY_PERIOD → AppError наружу (каркас вернёт ApiFailure(toDto), §13)', async () => {
    const error = AppError.of('REPORT/EMPTY_PERIOD', 'errors.REPORT_EMPTY_PERIOD');
    const handler = createBuildPdfReportHandler(useCaseOf(Promise.resolve(err(error))));

    await expect(handler(REQUEST)).rejects.toBe(error);
  });
});
