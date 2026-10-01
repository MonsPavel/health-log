/**
 * TASK-092 §19/§20.3: юнит-тесты гейт-функций fetch-скрипта ночной eval-модели.
 *
 * Скрипт переиспользует манифест моделей приложения (079 — единственный источник
 * «что можно поставить»; §14: sha256 из манифеста обязателен, «не верим URL»).
 * Гейты, которые здесь проверяются:
 *  - pickModelEntry: выбор dev-записи манифеста (первая по умолчанию / по id);
 *    пустой манифест и неизвестный id — контролируемый отказ;
 *  - verifySha256: sha256-мismatch скачанного файла → отказ с понятной ошибкой
 *    (§20.3: «контрольный прогон с битым манифест-моком» — шаг падает);
 *  - fetchEvalModel (оркестратор, загрузчик внедряется — §19 без сети):
 *    файл отсутствует → скачивание + проверка; файл на месте с верным sha256 →
 *    БЕЗ повторного скачивания (кэш §20.2); на месте с неверным sha256 →
 *    перекачивание (битый кэш не роняет прогон навсегда); скачанное не сошлось
 *    по sha256 → отказ (гейт честный, §14);
 *  - emitGithubOutput: model-path в $GITHUB_OUTPUT (артефакт-конвейер workflow)
 *    и безопасное отсутствие переменной вне Actions.
 *
 * Запуск: `pnpm test` (проект tools-scripts, прецедент size-audit.test.mjs).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  fetchEvalModel,
  pickModelEntry,
  sha256Hex,
  verifySha256,
} from './fetch-eval-model.mjs';

/** Тело «модели» фикстур и его настоящий sha256. */
const MODEL_BODY = 'GGUF-fake-model-body';
const MODEL_SHA256 = createHash('sha256').update(MODEL_BODY).digest('hex');

/** Мини-манифест (та же форма, что apps/desktop/resources/models-manifest.json). */
const MANIFEST = [
  {
    id: 'dev-fixture-1b',
    name: 'Dev Fixture 1B',
    version: '1.0.0-test',
    file: 'dev-fixture-1b.gguf',
    url: 'https://example.invalid/models/dev-fixture-1b.gguf',
    sha256: MODEL_SHA256,
    sizeBytes: MODEL_BODY.length,
    languages: ['ru'],
    minRamGb: 8,
    license: 'TEST',
    notesKey: 'models.notes.devFixture',
  },
];

/** Свежий tmp-каталог на тест; удаление в afterEach (§14). */
let workDir;

afterEach(() => {
  if (workDir !== undefined) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function freshDir() {
  workDir = mkdtempSync(join(tmpdir(), 'hl-fetch-eval-model-'));
  return workDir;
}

/** Внедряемый загрузчик: «скачивает» тело фикстуры (или переданный мусор). */
function fakeDownloader(body = MODEL_BODY) {
  const calls = [];
  return {
    calls,
    async download(url, destPath) {
      calls.push({ url, destPath });
      writeFileSync(destPath, body, 'utf8');
    },
  };
}

describe('pickModelEntry — выбор dev-записи манифеста (§5 «переиспользует манифест»)', () => {
  it('по умолчанию — первая запись манифеста', () => {
    expect(pickModelEntry(MANIFEST).id).toBe('dev-fixture-1b');
  });

  it('явный id выбирает конкретную запись', () => {
    expect(pickModelEntry(MANIFEST, 'dev-fixture-1b').file).toBe('dev-fixture-1b.gguf');
  });

  it('пустой манифест и неизвестный id — понятный отказ', () => {
    expect(() => pickModelEntry([], undefined)).toThrow(/манифест/i);
    expect(() => pickModelEntry(MANIFEST, 'no-such-id')).toThrow(/no-such-id/);
  });

  it('запись без обязательных полей (url/sha256/file) — отказ (§14: не верим URL без sha256)', () => {
    expect(() => pickModelEntry([{ id: 'broken', file: 'a.gguf' }], 'broken')).toThrow(/sha256/i);
  });
});

describe('verifySha256 — гейт целостности (§14/§20.3)', () => {
  it('верный sha256 — проходит; hex без учёта регистра', () => {
    const dir = freshDir();
    const file = join(dir, 'm.gguf');
    writeFileSync(file, MODEL_BODY, 'utf8');
    expect(verifySha256(file, MODEL_SHA256.toUpperCase())).toBe(true);
  });

  it('sha256-мismatch — отказ с ожиданием и фактом (§20.3: понятная ошибка шага)', () => {
    const dir = freshDir();
    const file = join(dir, 'm.gguf');
    writeFileSync(file, 'tampered', 'utf8');
    expect(() => verifySha256(file, MODEL_SHA256)).toThrow(/sha256/i);
    try {
      verifySha256(file, MODEL_SHA256);
      expect.unreachable('гейт обязан отказать');
    } catch (error) {
      expect(String(error)).toContain(MODEL_SHA256);
      expect(String(error)).toContain(sha256Hex('tampered'));
    }
  });

  it('файл отсутствует — отказ', () => {
    const dir = freshDir();
    expect(() => verifySha256(join(dir, 'absent.gguf'), MODEL_SHA256)).toThrow(/absent\.gguf/);
  });
});

describe('fetchEvalModel — оркестратор (кэш §20.2, гейт §14/§20.3)', () => {
  it('файла нет — скачивает, проверяет sha256, возвращает путь', async () => {
    const dir = freshDir();
    const downloader = fakeDownloader();
    const result = await fetchEvalModel({
      manifest: MANIFEST,
      dir,
      download: downloader.download,
      log: () => undefined,
    });
    expect(downloader.calls).toHaveLength(1);
    expect(result.downloaded).toBe(true);
    expect(result.modelPath).toBe(join(dir, 'dev-fixture-1b.gguf'));
    expect(readFileSync(result.modelPath, 'utf8')).toBe(MODEL_BODY);
  });

  it('файл на месте с верным sha256 — скачивания НЕТ (§20.2: кэш, лог пропуска)', async () => {
    const dir = freshDir();
    const target = join(dir, 'dev-fixture-1b.gguf');
    writeFileSync(target, MODEL_BODY, 'utf8');
    const downloader = fakeDownloader();
    const logs = [];
    const result = await fetchEvalModel({
      manifest: MANIFEST,
      dir,
      download: downloader.download,
      log: (message) => logs.push(message),
    });
    expect(downloader.calls).toHaveLength(0);
    expect(result.downloaded).toBe(false);
    expect(logs.some((message) => message.includes('пропущ'))).toBe(true);
  });

  it('файл на месте с битым sha256 — перекачивание (кэш не роняет прогон навсегда)', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'dev-fixture-1b.gguf'), 'corrupted-cache', 'utf8');
    const downloader = fakeDownloader();
    const result = await fetchEvalModel({
      manifest: MANIFEST,
      dir,
      download: downloader.download,
      log: () => undefined,
    });
    expect(downloader.calls).toHaveLength(1);
    expect(result.downloaded).toBe(true);
    expect(verifySha256(result.modelPath, MODEL_SHA256)).toBe(true);
  });

  it('скачанное не сошлось по sha256 — отказ (§20.3: битый манифест-мок → шаг красный)', async () => {
    const dir = freshDir();
    const downloader = fakeDownloader('wrong-bytes');
    await expect(
      fetchEvalModel({
        manifest: MANIFEST,
        dir,
        download: downloader.download,
        log: () => undefined,
      }),
    ).rejects.toThrow(/sha256/i);
  });
});

describe('emitGithubOutput — проводка model-path в workflow (§5)', () => {
  it('GITHUB_OUTPUT задан — строка model-path дописана; не задан — no-op без падения', async () => {
    const dir = freshDir();
    const outputFile = join(dir, 'github-output.txt');
    const result = await fetchEvalModel({
      manifest: MANIFEST,
      dir,
      download: fakeDownloader().download,
      log: () => undefined,
      githubOutputPath: outputFile,
    });
    expect(readFileSync(outputFile, 'utf8')).toContain(`model-path=${result.modelPath}`);

    const resultNoOutput = await fetchEvalModel({
      manifest: MANIFEST,
      dir,
      download: fakeDownloader().download,
      log: () => undefined,
      githubOutputPath: undefined,
    });
    expect(resultNoOutput.modelPath).toBe(join(dir, 'dev-fixture-1b.gguf'));
  });
});
