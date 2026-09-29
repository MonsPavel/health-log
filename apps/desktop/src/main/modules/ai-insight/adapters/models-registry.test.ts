/**
 * TASK-079 §19/§20: юнит-тесты ModelsRegistry — чтение/валидация манифеста
 * моделей при «загрузке» (listModels, §5): валидный список читается, КАЖДЫЙ
 * вид порчи (не-JSON, нарушение схемы §13, дубликаты id, отсутствие файла) —
 * контролируемый отказ AppError с логом (AC3), реестр stateless — отказ не
 * портит последующие вызовы («приложение живо», §5). Отдельно — тест РЕАЛЬНОГО
 * ресурса приложения (§19: читает настоящий models-manifest.json по пути по
 * умолчанию): парсится схемой, содержит dev-запись с PLACEHOLDER-пометкой и
 * https-URL (AC2/AC4 — отбор реальных моделей внешний процесс, §5).
 *
 * Путь — параметр (§9); дефолтный резолв (asar-раскладка §9) проверяется
 * тестом реального ресурса на исходной раскладке (та же глубина каталогов).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '@hl/kernel';

import { ModelsRegistry } from './models-registry.js';
import type { LlmClientLogger } from './llm-process-client.js';

/** Каталог tmp-фикстур (манифесты кейсов). */
const fixtureDir = mkdtempSync(join(tmpdir(), 'hl-models-registry-'));

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** Фейк структурного логгера (§18): собирает вызовы error для проверок AC3. */
function fakeLogger(): { logger: LlmClientLogger; errors: Array<{ message: string; meta?: Record<string, unknown> }> } {
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    errors,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message, meta) => {
        errors.push({ message, meta });
      },
    },
  };
}

/** Пишет манифест-фикстуру и возвращает её путь. */
function writeManifest(name: string, content: string): string {
  const path = join(fixtureDir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Валидная запись (форма §7) — литерал фикстуры. */
const VALID_MODEL = {
  id: 'dev-placeholder-ru',
  name: 'Dev Placeholder Model',
  version: '0.0.0-dev',
  file: 'dev-placeholder.gguf',
  url: 'https://cdn.example.com/models/dev-placeholder.gguf',
  sha256: 'a'.repeat(64),
  sizeBytes: 986_000_000,
  languages: ['ru', 'en'],
  minRamGb: 8,
  license: 'apache-2.0',
};

describe('ModelsRegistry.listModels — валидный манифест', () => {
  it('читает и валидирует список записей (§5)', () => {
    const path = writeManifest('valid.json', JSON.stringify([VALID_MODEL]));
    const models = new ModelsRegistry({ manifestPath: path }).listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('dev-placeholder-ru');
    expect(models[0]?.sha256).toBe('a'.repeat(64));
  });

  it('перечитывает ресурс при каждом вызове (stateless, правка списка = правка файла)', () => {
    const path = writeManifest('reread.json', JSON.stringify([VALID_MODEL]));
    const registry = new ModelsRegistry({ manifestPath: path });
    expect(registry.listModels()).toHaveLength(1);
    writeFileSync(path, JSON.stringify([{ ...VALID_MODEL, id: 'second' }]), 'utf8');
    expect(registry.listModels().map((model) => model.id)).toEqual(['second']);
  });
});

describe('ModelsRegistry.listModels — битый манифест → отказ с логом (AC3)', () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly content: string }> = [
    { name: 'не-JSON (обрыв записи)', content: '{ "id": "x", ' },
    { name: 'не-массив (объект)', content: JSON.stringify({ models: [] }) },
    {
      name: 'нарушение схемы §13 (http-url)',
      content: JSON.stringify([{ ...VALID_MODEL, url: 'http://cdn.example.com/m.gguf' }]),
    },
    {
      name: 'нарушение схемы §13 (короткий sha256)',
      content: JSON.stringify([{ ...VALID_MODEL, sha256: 'a'.repeat(63) }]),
    },
    {
      name: 'дубликаты id (§13)',
      content: JSON.stringify([VALID_MODEL, { ...VALID_MODEL, name: 'Same id' }]),
    },
  ];

  it.each(cases)('$name → AppError APP/INTERNAL + error-лог, приложение живо', ({ content }) => {
    const path = writeManifest('broken.json', content);
    const { logger, errors } = fakeLogger();
    const registry = new ModelsRegistry({ manifestPath: path, logger });

    // Контролируемый отказ домена (AppError), не сырой краш парсера/файла.
    expect(() => registry.listModels()).toThrow(AppError);
    try {
      registry.listModels();
    } catch (error) {
      expect((error as AppError).code).toBe('APP/INTERNAL');
      expect((error as AppError).messageKey).toBe('errors.internal');
      expect((error as AppError).cause).toBeDefined();
    }
    // Лог отказа (§5 AC3): с адресом ресурса, без дублирования вызовов.
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toBe('models: manifest rejected');
    expect(errors[0]?.meta?.['path']).toBe(path);
    // Повторный вызов — тот же предсказуемый отказ (состояние не испорчено).
    expect(errors[1]?.meta?.['reason']).toBe('models-manifest');
  });

  it('отсутствующий файл — тот же отказ (ресурс не доехал в сборку)', () => {
    const { logger, errors } = fakeLogger();
    const registry = new ModelsRegistry({
      manifestPath: join(fixtureDir, 'missing.json'),
      logger,
    });
    expect(() => registry.listModels()).toThrow(AppError);
    expect(errors).toHaveLength(1);
  });

  it('отказ одного реестра не мешает другим (модульная изоляция — «приложение живо»)', () => {
    const broken = new ModelsRegistry({ manifestPath: join(fixtureDir, 'missing.json') });
    const healthy = new ModelsRegistry({
      manifestPath: writeManifest('healthy.json', JSON.stringify([VALID_MODEL])),
    });
    expect(() => broken.listModels()).toThrow(AppError);
    expect(healthy.listModels()).toHaveLength(1);
  });
});

describe('ModelsRegistry — реальный ресурс приложения (AC2/AC4)', () => {
  it('models-manifest.json по пути по умолчанию валиден: одна dev-запись, PLACEHOLDER, https', () => {
    const models = new ModelsRegistry().listModels();
    expect(models.length).toBeGreaterThanOrEqual(1);
    for (const model of models) {
      expect(model.url.startsWith('https://')).toBe(true);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.languages.length).toBeGreaterThan(0);
    }
    const dev = models.find((model) => model.url.includes('PLACEHOLDER'));
    expect(dev).toBeDefined();
    // Пометка о dev-статусе — ключ i18n (§16–17): тексты каталога, не модели.
    expect(dev?.notesKey).toBeDefined();
    expect(dev?.notesKey?.startsWith('models.')).toBe(true);
  });
});
