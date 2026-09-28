/**
 * TASK-067 §9/§20: интеграционный тест боевой проводки — контейнер создаёт пул
 * воркеров с ДЕФОЛТНЫМ tasksModule reporting (pdf-tasks-url.ts), и задача
 * `pdf.render` доступна без ручной подстановки (§9: «pdf-task регистрируется
 * в пуле»). entryUrl подставляется (.ts под type-stripping — прецедент
 * container-workerpool.int.test.ts); tasksModule — боевой дефолт (резолвинг
 * pdf-tasks-url: собранный .js, иначе исходник .ts — свежий checkout).
 *
 * Хелперы (мок-vault, tmp-userData) повторяют container.int.test.ts: импорт
 * тест-файла в тест-файл регистрировал бы его describe-блоки повторно — копия.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AppError, FixedClock, type Result } from '@hl/kernel';

import { buildContainer } from './container.js';
import { GOLDEN_PAYLOAD } from './modules/reporting/adapters/pdf/__fixtures__/golden-payload.ts';
import type { PdfRenderResult } from './modules/reporting/application/report-spec.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

const KEY_HEX = 'ab'.repeat(32);
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

/** Исходник воркера: дефолт entry пула — собранный worker.js из dist (прод). */
const WORKER_ENTRY_URL = new URL('./shared/workerpool/worker.ts', import.meta.url);

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-pdf-int-'));

class MockVault implements KeyVault {
  private ensured = 0;

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
}

describe('container + pdf.render по умолчанию (TASK-067 §9/§20)', () => {
  it(
    "контейнер без override задач: workerPool.run('pdf.render') рендерит %PDF",
    { timeout: 30_000 },
    async () => {
      const dir = newUserDataDir();
      const container = await buildContainer({
        userDataPath: dir,
        clock: new FixedClock(NOW_MS, TZ),
        vault: () => new MockVault(),
        workerPool: { entryUrl: WORKER_ENTRY_URL }, // tasksModule — боевой дефолт
      });
      try {
        const result = (await container.workerPool.run(
          'pdf.render',
          GOLDEN_PAYLOAD,
        )) as PdfRenderResult;
        expect(Buffer.from(result.pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
        expect(result.pages).toBeGreaterThanOrEqual(2);
        expect(result.records).toBe(40);
      } finally {
        container.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
