// TASK-081 §9/§11: юниты хендлеров ai/models/* — слой тонкий (прецедент
// data-care.ts/report.ts): zod-валидацию запроса делает каркас TASK-008 до вызова,
// здесь — вызов use case AiModelsQueries и маппинг Result → контракт:
// ok → ответ по строгой схеме (парс — доказательство формы контракта),
// err → AppError наружу (каркас конвертирует в ApiFailure(toDto), §13 TASK-008).
import { describe, expect, it, vi } from 'vitest';

import {
  AI_MODELS_LIST_RESPONSE_SCHEMA,
  AI_MODELS_STATUS_RESPONSE_SCHEMA,
  AI_MODELS_SELECT_RESPONSE_SCHEMA,
  type Prefs,
  type PrefsPatch,
} from '@hl/contracts';
import { AppError, err, ok, type Result } from '@hl/kernel';
import type { ModelDescriptor, ModelStatusInfo } from '@hl/contracts';

import {
  createAiModelsDownloadHandler,
  createAiModelsListHandler,
  createAiModelsPauseHandler,
  createAiModelsResetHandler,
  createAiModelsResumeHandler,
  createAiModelsSelectHandler,
} from './ai-models.js';
import {
  AiModelsQueries,
  type ModelStorePort,
  type ModelsCatalogPort,
  type ModelsPrefsPort,
} from '../../modules/ai-insight/application/models-queries.js';

/** Валидный дескриптор манифеста (079). */
const DESCRIPTOR: ModelDescriptor = {
  id: 'dev-ru',
  name: 'Dev Model',
  version: '1.0.0',
  file: 'dev.gguf',
  url: 'https://cdn.example.invalid/models/dev.gguf',
  sha256: 'a'.repeat(64),
  sizeBytes: 2_100_000_000,
  languages: ['ru'],
  minRamGb: 8,
  license: 'Apache-2.0',
};

/** Store-порт с spy и настраиваемым статусом (§19). */
function fakeStore(status: ModelStatusInfo = { state: 'not_installed' }): ModelStorePort & {
  downloadSpy: ReturnType<typeof vi.fn>;
  resumeSpy: ReturnType<typeof vi.fn>;
  pauseSpy: ReturnType<typeof vi.fn>;
  resetSpy: ReturnType<typeof vi.fn>;
} {
  const downloadSpy = vi.fn((_id: string) => Promise.resolve(ok({ state: 'installed' as const })));
  const resumeSpy = vi.fn((_id: string) => Promise.resolve(ok({ state: 'paused' as const })));
  const pauseSpy = vi.fn((_id: string) => undefined);
  const resetSpy = vi.fn((_id: string) => undefined);
  return {
    download: downloadSpy,
    resume: resumeSpy,
    pause: pauseSpy,
    reset: resetSpy,
    status: () => status,
    downloadSpy,
    resumeSpy,
    pauseSpy,
    resetSpy,
  };
}

const REGISTRY: ModelsCatalogPort = { listModels: () => [DESCRIPTOR] };

function fakePrefs(doc?: Partial<Prefs>): ModelsPrefsPort & { setSpy: ReturnType<typeof vi.fn> } {
  const document: Prefs = {
    theme: 'system',
    textScale: '100',
    dateFormat: 'auto',
    advancedMode: false,
    netConsents: { updatesCheck: false, modelsDownload: false },
    jobState: { jobs: {}, shown: {} },
    aiSettings: { dismissed: false },
    ...doc,
  };
  const setSpy = vi.fn((patch: PrefsPatch) => {
    Object.assign(document, patch);
    return Promise.resolve(document);
  });
  return { getPrefs: () => Promise.resolve(document), setPrefs: setSpy, setSpy };
}

/** Use case на подстановочных зависимостях (прецедент measurements.test.ts). */
function build(overrides: {
  store?: ReturnType<typeof fakeStore>;
  registry?: ModelsCatalogPort;
  prefs?: ReturnType<typeof fakePrefs>;
} = {}): { queries: AiModelsQueries; store: ReturnType<typeof fakeStore> } {
  const store = overrides.store ?? fakeStore();
  const queries = new AiModelsQueries({
    store,
    registry: overrides.registry ?? REGISTRY,
    prefs: overrides.prefs ?? fakePrefs(),
    ramTotalGb: () => 15.9,
    uiLanguage: () => 'ru',
  });
  return { queries, store };
}

describe('createAiModelsListHandler — {} → витрина экрана (§7/§11)', () => {
  it('ok → ответ по строгой схеме (models/ramTotalGb/uiLanguage)', async () => {
    const { queries } = build({ store: fakeStore({ state: 'downloading', bytesLoaded: 512 }) });
    const handler = createAiModelsListHandler(queries);

    const response = await handler({});

    expect(AI_MODELS_LIST_RESPONSE_SCHEMA.safeParse(response).success).toBe(true);
    expect(response.models).toHaveLength(1);
    expect(response.models[0]?.state).toBe('downloading');
    expect(response.models[0]?.bytesLoaded).toBe(512);
    expect(response.ramTotalGb).toBe(15.9);
    expect(response.uiLanguage).toBe('ru');
  });

  it('битый манифест → AppError APP/INTERNAL наружу (каркас вернёт ApiFailure)', async () => {
    const boom = AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'models-manifest' });
    const { queries } = build({ registry: { listModels: () => { throw boom; } } });
    const handler = createAiModelsListHandler(queries);

    await expect(handler({})).rejects.toBe(boom);
  });
});

describe('createAiModelsDownloadHandler/Resume — {modelId} → финал флоу (§5/§11)', () => {
  it('ok → статус по схеме; делегирование store (ход — событиями ai:progress)', async () => {
    const { queries, store } = build();
    const handler = createAiModelsDownloadHandler(queries);

    const response = await handler({ modelId: 'dev-ru' });

    expect(store.downloadSpy).toHaveBeenCalledWith('dev-ru');
    expect(AI_MODELS_STATUS_RESPONSE_SCHEMA.safeParse(response).success).toBe(true);
    expect(response.state).toBe('installed');
  });

  it('err use case (AI/DOWNLOAD_BUSY) → AppError наружу', async () => {
    const busy = err(AppError.of('AI/DOWNLOAD_BUSY', 'errors.AI_DOWNLOAD_BUSY'));
    const store = fakeStore();
    store.download = () => Promise.resolve(busy as Result<ModelStatusInfo>);
    const { queries } = build({ store });
    const handler = createAiModelsDownloadHandler(queries);

    await expect(handler({ modelId: 'dev-ru' })).rejects.toMatchObject({ code: 'AI/DOWNLOAD_BUSY' });
  });

  it('resume делегирует store.resume', async () => {
    const { queries, store } = build();
    const handler = createAiModelsResumeHandler(queries);

    const response = await handler({ modelId: 'dev-ru' });

    expect(store.resumeSpy).toHaveBeenCalledWith('dev-ru');
    expect(response.state).toBe('paused');
  });
});

describe('createAiModelsPauseHandler/Reset — операция + статус после (§5)', () => {
  it('pause: store.pause вызван, ответ — статус paused по схеме', async () => {
    const { queries, store } = build({ store: fakeStore({ state: 'paused', bytesLoaded: 4096 }) });
    const handler = createAiModelsPauseHandler(queries);

    const response = await handler({ modelId: 'dev-ru' });

    expect(store.pauseSpy).toHaveBeenCalledWith('dev-ru');
    expect(AI_MODELS_STATUS_RESPONSE_SCHEMA.safeParse(response).success).toBe(true);
    expect(response.state).toBe('paused');
    expect(response.bytesLoaded).toBe(4096);
  });

  it('reset: store.reset вызван, ответ — статус not_installed', async () => {
    const { queries, store } = build({ store: fakeStore({ state: 'not_installed' }) });
    const handler = createAiModelsResetHandler(queries);

    const response = await handler({ modelId: 'dev-ru' });

    expect(store.resetSpy).toHaveBeenCalledWith('dev-ru');
    expect(response.state).toBe('not_installed');
  });
});

describe('createAiModelsSelectHandler — {modelId} → prefs.aiSettings (§9)', () => {
  it('ok → {modelId} по схеме; prefs обновлён use case (§13)', async () => {
    const prefs = fakePrefs();
    const { queries } = build({ prefs });
    const handler = createAiModelsSelectHandler(queries);

    const response = await handler({ modelId: 'dev-ru' });

    expect(AI_MODELS_SELECT_RESPONSE_SCHEMA.safeParse(response).success).toBe(true);
    expect(response).toEqual({ modelId: 'dev-ru' });
    expect(prefs.setSpy).toHaveBeenCalledWith({
      aiSettings: { dismissed: false, modelId: 'dev-ru' },
    });
  });

  it('чужой id → AppError AI/MODEL_NOT_FOUND (§13)', async () => {
    const { queries } = build();
    const handler = createAiModelsSelectHandler(queries);

    await expect(handler({ modelId: 'nope' })).rejects.toMatchObject({
      code: 'AI/MODEL_NOT_FOUND',
    });
  });
});
