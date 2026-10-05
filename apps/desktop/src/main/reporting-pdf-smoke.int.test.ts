// TASK-068 §19/§20: интеграционный smoke «e2e-мини» — tmp-БД с 50 записями →
// BuildPdfReportUseCase на БОЕВОЙ цепочке (реальный SQLite-репозиторий, боевые
// адаптеры точек/статистики, РЕАЛЬНЫЙ рендер в WorkerPool с дефолтным tasksModule
// reporting — задача pdf.render 067) → PDF-файл на диске существует и >10 КБ
// (§19: «tmp-БД 50 записей → PDF файл существует >10 КБ»).
//
// Единственная подстановка — saver: save-диалог Electron в node-окружении
// недоступен (§22 065: dialog API в тестах — мок-интерфейс порта); stub пишет
// байты воркера во временный каталог — ровно то, что сделал бы диалог+writeFile
// с путём, выбранным пользователем. Файл в src/main (не в modules/): тесту нужны
// адаптеры разных модулей и контейнер целиком.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, FixedClock, type Result, ok } from '@hl/kernel';

import { buildContainer } from './container.js';
import { silentLogger } from './shared/logger/silent-logger.js';
import type { PdfRenderResult } from './modules/reporting/application/report-spec.js';
import { BuildPdfReportUseCase } from './modules/reporting/application/build-pdf-report.js';
import { ReportPointsAdapter } from './modules/reporting/adapters/report-points-adapter.js';
import { ReportStatsAdapter } from './modules/reporting/adapters/report-stats-adapter.js';
import type { ExportFileSaver } from './modules/reporting/application/ports/export-file-saver.js';
import type { MeasurementPointsPort } from './modules/analytics/index.js';
import { assessCritical } from './modules/measurement/index.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

const KEY_HEX = 'ab'.repeat(32);
const NOW_MS = 1_758_816_000_000; // 2025-09-25T16:00Z
const TZ = 180;
const PROFILE = 'seed-profile-0001';
const RECORDS = 50;

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-pdf-smoke-int-'));

class MockVault implements KeyVault {
  private ensured = 0;

  /** TASK-121 §3: импорт ключа из копии — мок-заглушка (сценарий восстановление не зовёт). */
  importKey(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({
      ok: true,
      value: { keyHex: KEY_HEX, created: this.ensured++ === 0 },
    });
  }

  exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>> {
    return Promise.resolve({
      ok: false,
      error: AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY),
    });
  }

  // TASK-093 §5/§7: парольные режимы в этом сценарии не используются — нейтральные
  // заглушки контракта (сессия всегда разблокирована, mode='none').
  setPassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  changePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  removePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  unlock(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  // TASK-094 §5: сброс сессии в mode=none — no-op (мок; см. порт key-vault).
  lock(): void {}

  getMode(): 'none' {
    return 'none';
  }
}

/** Saver — «пользователь выбрал путь»: запись байтов во временный каталог (§22). */
const makeSaver = (outDir: string): ExportFileSaver => ({
  saveCsv: () => Promise.reject(new Error('smoke: saveCsv не вызывается')),
  saveJson: () => Promise.reject(new Error('smoke: saveJson не вызывается')),
  savePdf: (defaultName, pdf) => {
    const path = join(outDir, defaultName);
    return writeFile(path, pdf).then(() => ({ path }));
  },
});

describe('smoke: tmp-БД 50 записей → PDF >10 КБ (TASK-068 §19/§20)', () => {
  const dir = newUserDataDir();
  const outDir = join(dir, 'out');
  let container: Awaited<ReturnType<typeof buildContainer>> | undefined;

  afterAll(() => {
    try {
      container?.close();
    } catch {
      // повторное закрытие — no-op
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'боевая цепочка (SQLite → адаптеры → WorkerPool pdf.render → запись) даёт файл >10 КБ',
    { timeout: 60_000 },
    async () => {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(outDir, { recursive: true });
      container = await buildContainer({
        userDataPath: dir,
        clock: new FixedClock(NOW_MS, TZ),
        vault: () => new MockVault(),
        // entry .ts под type-stripping (прецедент container-pdf.int.test.ts);
        // tasksModule — боевой дефолт (задача pdf.render reporting).
        workerPool: {
          entryUrl: new URL('./shared/workerpool/worker.ts', import.meta.url),
        },
      });

      // 50 записей за ~30 дней через полный путь записи (measurements/add, §19 056).
      for (let i = 0; i < RECORDS; i += 1) {
        const utcMs = NOW_MS - 86_400_000 * 30 + (i * (86_400_000 * 30)) / RECORDS;
        const envelope = await container.channels.dispatch({
          channel: 'measurements/add',
          payload: {
            profileId: PROFILE,
            sys: 110 + (i % 40),
            dia: 70 + (i % 25),
            pulse: 58 + (i % 30),
            irregularPulse: false,
            arm: i % 2 === 0 ? 'left' : 'right',
            ...(i % 10 === 0 ? { note: `заметка ${i}` } : {}),
            takenAt: { utcMs: Math.floor(utcMs), tzOffsetMin: TZ },
          },
        });
        expect(envelope).toMatchObject({ ok: true });
      }

      // Use case на боевых частях: порты над SQLite-репозиторием контейнера,
      // рендер — боевой WorkerPool (pdf.render в воркере), запись — общая очередь.
      const repo = container.measurementRepo;
      const pointsPort: MeasurementPointsPort = {
        listByPeriod: (query) =>
          repo.listByPeriod(query).then((measurements) =>
            measurements.map((m) => ({
              id: m.id,
              sys: m.bp.sys,
              dia: m.bp.dia,
              pulse: m.pulse,
              takenAt: m.takenAt,
              critical: assessCritical(m.bp.sys, m.bp.dia),
            })),
          ),
      };
      const useCase = new BuildPdfReportUseCase({
        points: new ReportPointsAdapter(repo),
        stats: new ReportStatsAdapter(pointsPort),
        // Карта задач боевого пула шире карты 067 — приведение на границе теста
        // (прецедент container-pdf.int.test.ts: run('pdf.render') as PdfRenderResult).
        pool: {
          run: (name, payload) =>
            container!.workerPool.run(name, payload) as Promise<PdfRenderResult>,
        },
        saver: makeSaver(outDir),
        queue: container.fileOpQueue,
        clock: container.clock,
        appVersion: '0.0.0',
        logger: silentLogger(),
      });

      const result = await useCase.execute({
        profileId: PROFILE,
        period: { fromUtcMs: NOW_MS - 86_400_000 * 31, toUtcMs: NOW_MS },
        includeAiSection: false,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // §20-1 «открывается» (автоматический эквивалент, без GUI): число страниц
      // честное (таблица 50 записей + средние/регулярность/график).
      expect(result.value.pages).toBeGreaterThanOrEqual(2);
      expect('path' in result.value.file).toBe(true);
      if (!('path' in result.value.file)) {
        return;
      }
      expect(existsSync(result.value.file.path)).toBe(true);
      // §19: PDF файл существует и >10 КБ (шрифты Roboto + таблица 50 записей).
      expect(statSync(result.value.file.path).size).toBeGreaterThan(10 * 1024);
      // Структурная валидность PDF-файла на диске (то, что читает системный
      // просмотрщик): заголовок %PDF- в начале и хвост %%EOF в конце.
      const bytes = readFileSync(result.value.file.path);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(bytes.subarray(bytes.length - 32).toString('latin1')).toContain('%%EOF');
    },
  );
});
