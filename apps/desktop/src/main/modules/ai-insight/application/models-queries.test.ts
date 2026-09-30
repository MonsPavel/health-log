/**
 * TASK-081 §5/§9/§19: тесты use case AiModelsQueries — тонкие обёртки экрана
 * «Модель» над ModelStore/реестром/ prefs:
 *  - list — одним вызовом всё для экрана (§7): витрины {descriptor, state,
 *    bytesLoaded?, errorKey?} + ОЗУ машины + язык интерфейса;
 *  - download/resume — делегирование store (§9: хендлеры тонкие); при включённом
 *    test-install (§22, HL_TEST_MODEL_FILE) — установка мимо сети, store не зовётся;
 *  - pause/reset — операция + статус после (§5 080);
 *  - select — id из манифеста → prefs.aiSettings целиком (сохраняя dismissed),
 *    чужой id → AI/MODEL_NOT_FOUND, prefs не тронут (§13);
 *  - отказ реестра (битый манифест) — err, наружу AppError (079 контракт).
 */
import { describe, expect, it, vi } from 'vitest';

import { AppError, err, ok, type Result } from '@hl/kernel';
import type {
  AiModelsListResponse,
  AiModelsSelectResponse,
  ModelDescriptor,
  ModelStatusInfo,
  ModelView,
  Prefs,
  PrefsPatch,
} from '@hl/contracts';

import { AiModelsQueries } from './models-queries.js';
import type { ModelsCatalogPort } from './models-queries.js';

/** Валидный дескриптор — форма манифеста 079. */
function descriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'dev-ru',
    name: 'Dev Model',
    version: '1.0.0',
    file: 'dev.gguf',
    url: 'https://cdn.example.invalid/models/dev.gguf',
    sha256: 'a'.repeat(64),
    sizeBytes: 2_100_000_000,
    languages: ['ru', 'en'],
    minRamGb: 8,
    license: 'Apache-2.0',
    ...overrides,
  };
}

/** Store-порт с настраиваемым статусом и spy-делегированием (§19). */
class FakeStore {
  readonly downloadSpy = vi.fn((modelId: string) => Promise.resolve(ok({ state: 'installed' as const })));
  readonly resumeSpy = vi.fn((modelId: string) => Promise.resolve(ok({ state: 'paused' as const })));
  readonly pauseSpy = vi.fn((modelId: string) => undefined);
  readonly resetSpy = vi.fn((modelId: string) => undefined);

  constructor(public statusResult: ModelStatusInfo = { state: 'not_installed' }) {}

  download(modelId: string): Promise<Result<ModelStatusInfo>> {
    return this.downloadSpy(modelId);
  }
  resume(modelId: string): Promise<Result<ModelStatusInfo>> {
    return this.resumeSpy(modelId);
  }
  pause(modelId: string): void {
    this.pauseSpy(modelId);
  }
  reset(modelId: string): void {
    this.resetSpy(modelId);
  }
  status(_modelId: string): ModelStatusInfo {
    return this.statusResult;
  }
}

/** Реестр с фикстурой дескрипторов или отказом (битый манифест). */
class FakeRegistry implements ModelsCatalogPort {
  constructor(
    private readonly models: ModelDescriptor[] = [descriptor()],
    private readonly failure?: unknown,
  ) {}

  listModels(): ModelDescriptor[] {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.models;
  }
}

/** Prefs-порт: merge patch поверх документа (как PreferencesService, §9 047). */
class FakePrefs {
  document: Prefs = {
    theme: 'system',
    textScale: '100',
    dateFormat: 'auto',
    advancedMode: false,
    netConsents: { updatesCheck: false, modelsDownload: false },
    jobState: { jobs: {}, shown: {} },
    aiSettings: { dismissed: false },
  };
  readonly setSpy = vi.fn((patch: PrefsPatch) => {
    this.document = { ...this.document, ...patch };
    return Promise.resolve(this.document);
  });

  getPrefs(): Promise<Prefs> {
    return Promise.resolve(this.document);
  }
  setPrefs(patch: PrefsPatch): Promise<Prefs> {
    return this.setSpy(patch);
  }
}

/** Test-install порт (§22): включаемость + spy установки мимо сети. */
class FakeTestInstall {
  readonly installSpy = vi.fn((_modelId: string) => Promise.resolve(ok({ state: 'installed' as const })));

  constructor(public enabled = false) {}

  isEnabled(): boolean {
    return this.enabled;
  }
  install(modelId: string): Promise<Result<ModelStatusInfo>> {
    return this.installSpy(modelId);
  }
}

function build(overrides: {
  store?: FakeStore;
  registry?: FakeRegistry;
  prefs?: FakePrefs;
  testInstall?: FakeTestInstall;
  ramTotalGb?: () => number;
  uiLanguage?: () => string;
}): AiModelsQueries {
  return new AiModelsQueries({
    store: overrides.store ?? new FakeStore(),
    registry: overrides.registry ?? new FakeRegistry(),
    prefs: overrides.prefs ?? new FakePrefs(),
    ramTotalGb: overrides.ramTotalGb ?? (() => 15.9),
    uiLanguage: overrides.uiLanguage ?? (() => 'ru'),
    testInstall: overrides.testInstall,
  });
}

describe('AiModelsQueries.list — одним вызовом всё для экрана (TASK-081 §7)', () => {
  it('витрина из манифеста + статуса store; ramTotalGb/uiLanguage из портов', async () => {
    const registry = new FakeRegistry([
      descriptor(),
      descriptor({
        id: 'big-en',
        name: 'Big EN',
        file: 'big.gguf',
        languages: ['en'],
        minRamGb: 16,
      }),
    ]);
    const store = new FakeStore({ state: 'paused', bytesLoaded: 1024, totalBytes: 2048 });

    const result = await build({ registry, store }).list();

    expect(result.ok).toBe(true);
    const data = (result as { ok: true; value: AiModelsListResponse }).value;
    expect(data.ramTotalGb).toBe(15.9);
    expect(data.uiLanguage).toBe('ru');
    expect(data.models).toHaveLength(2);
    const first: ModelView = data.models[0] as ModelView;
    expect(first.descriptor.id).toBe('dev-ru');
    expect(first.state).toBe('paused');
    expect(first.bytesLoaded).toBe(1024);
    // Форма витрины §7: totalBytes/resumable статуса в ModelView не входят (strict).
    expect(Object.keys(first).sort()).toEqual(['bytesLoaded', 'descriptor', 'state']);
  });

  it('error-состояние несёт errorKey (§16–17: ключ текста, не текст)', async () => {
    const store = new FakeStore({ state: 'error', errorKey: 'errors.AI_HASH_MISMATCH' });

    const result = await build({ store }).list();

    const data = (result as { ok: true; value: AiModelsListResponse }).value;
    expect(data.models[0]?.state).toBe('error');
    expect(data.models[0]?.errorKey).toBe('errors.AI_HASH_MISMATCH');
  });

  it('отказ реестра (битый манифест, AppError 079) → err без выброса', async () => {
    const boom = AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'models-manifest' });
    const result = await build({ registry: new FakeRegistry([], boom) }).list();

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: AppError }).error.code).toBe('APP/INTERNAL');
  });
});

describe('AiModelsQueries.download/resume — делегирование store (§9)', () => {
  it('download → store.download(modelId), Result пробрасывается как есть', async () => {
    const store = new FakeStore();
    const result = await build({ store }).download('dev-ru');

    expect(store.downloadSpy).toHaveBeenCalledWith('dev-ru');
    expect(result.ok).toBe(true);
  });

  it('resume → store.resume(modelId)', async () => {
    const store = new FakeStore();
    const result = await build({ store }).resume('dev-ru');

    expect(store.resumeSpy).toHaveBeenCalledWith('dev-ru');
    expect(result.ok).toBe(true);
  });

  it('test-install включён (§22): store не зовётся, установка мимо сети, её Result наружу', async () => {
    const store = new FakeStore();
    const testInstall = new FakeTestInstall(true);
    const failure = err(AppError.of('AI/MODEL_NOT_FOUND', 'errors.AI_MODEL_NOT_FOUND'));
    testInstall.installSpy.mockReturnValue(Promise.resolve(failure));

    const result = await build({ store, testInstall }).download('dev-ru');

    expect(store.downloadSpy).not.toHaveBeenCalled();
    expect(testInstall.installSpy).toHaveBeenCalledWith('dev-ru');
    expect(result).toBe(failure);
  });

  it('test-install выключен — боевой путь store (§22: гард на контейнере)', async () => {
    const store = new FakeStore();
    const testInstall = new FakeTestInstall(false);

    await build({ store, testInstall }).download('dev-ru');

    expect(store.downloadSpy).toHaveBeenCalledWith('dev-ru');
    expect(testInstall.installSpy).not.toHaveBeenCalled();
  });
});

describe('AiModelsQueries.pause/reset — операция + статус после (§5)', () => {
  it('pause: store.pause, ответ — статус store после операции', async () => {
    const store = new FakeStore({ state: 'paused', bytesLoaded: 4096 });

    const result = await build({ store }).pause('dev-ru');

    expect(store.pauseSpy).toHaveBeenCalledWith('dev-ru');
    expect((result as { ok: true; value: ModelStatusInfo }).value.state).toBe('paused');
  });

  it('reset: store.reset, ответ — статус после (not_installed, §7 080)', async () => {
    const store = new FakeStore({ state: 'not_installed' });

    const result = await build({ store }).reset('dev-ru');

    expect(store.resetSpy).toHaveBeenCalledWith('dev-ru');
    expect((result as { ok: true; value: ModelStatusInfo }).value.state).toBe('not_installed');
  });
});

describe('AiModelsQueries.select — prefs.aiSettings.modelId (§5/§9/§13)', () => {
  it('валидный id → setPrefs {aiSettings целиком, modelId внутри}; dismissed сохранён', async () => {
    const prefs = new FakePrefs();
    prefs.document = {
      ...prefs.document,
      aiSettings: { dismissed: true },
    };

    const result = await build({ prefs }).select('dev-ru');

    expect(prefs.setSpy).toHaveBeenCalledWith({
      aiSettings: { dismissed: true, modelId: 'dev-ru' },
    });
    const data = (result as { ok: true; value: AiModelsSelectResponse }).value;
    expect(data.modelId).toBe('dev-ru');
  });

  it('чужой id (вне манифеста) → err AI/MODEL_NOT_FOUND, prefs не тронут (§13)', async () => {
    const prefs = new FakePrefs();

    const result = await build({ prefs }).select('no-such-model');

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: AppError }).error.code).toBe('AI/MODEL_NOT_FOUND');
    expect(prefs.setSpy).not.toHaveBeenCalled();
  });

  it('битый манифест при select → err APP/INTERNAL (контракт реестра 079)', async () => {
    const boom = AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'models-manifest' });
    const result = await build({ registry: new FakeRegistry([], boom) }).select('dev-ru');

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: AppError }).error.code).toBe('APP/INTERNAL');
  });
});
