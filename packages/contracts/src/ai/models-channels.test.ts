// TASK-081 §5/§7/§11: тест-контракт каналов витрины моделей ai/models/* —
// list одним вызовом всё для экрана (§7: ModelView {descriptor, state, bytesLoaded?}
// + ramTotalGb машины + uiLanguage), download/pause/resume/reset {modelId},
// select {modelId} → prefs.aiSettings.modelId. Формы строгие (§14 IPC-гигиены),
// типы выводятся из схем (§23 — без ручной синхронизации).
import { describe, expect, expectTypeOf, it } from 'vitest';

import { MODEL_STATUSES } from './models.js';
import type { ModelDescriptor } from '../models.js';
import {
  AI_MODELS_DOWNLOAD_REQUEST_SCHEMA,
  AI_MODELS_LIST_REQUEST_SCHEMA,
  AI_MODELS_LIST_RESPONSE_SCHEMA,
  AI_MODELS_MODEL_ID_REQUEST_SCHEMA,
  AI_MODELS_RESET_RESPONSE_SCHEMA,
  AI_MODELS_SELECT_RESPONSE_SCHEMA,
  AI_MODELS_STATUS_RESPONSE_SCHEMA,
  MODEL_VIEW_SCHEMA,
  type AiModelsListResponse,
  type ModelView,
} from './models-channels.js';
import { CHANNEL_SCHEMAS } from '../schemas.js';

/** Валидный дескриптор — форма манифеста 079 (общая фикстура таблиц). */
const DESCRIPTOR: ModelDescriptor = {
  id: 'dev-ru',
  name: 'Dev Model',
  version: '1.0',
  file: 'dev.gguf',
  url: 'https://cdn.example.invalid/models/dev.gguf',
  sha256: 'a'.repeat(64),
  sizeBytes: 2_100_000_000,
  languages: ['ru', 'en'],
  minRamGb: 8,
  license: 'Apache-2.0',
};

const CHANNEL_SCHEMAS_KEYS = Object.keys(CHANNEL_SCHEMAS);

describe('реестр каналов — состав ai/models/* (TASK-081 §5/§11)', () => {
  it.each([
    'ai/models/list',
    'ai/models/download',
    'ai/models/pause',
    'ai/models/resume',
    'ai/models/reset',
    'ai/models/select',
  ] as const)('канал %j присутствует в CHANNEL_SCHEMAS', (channel) => {
    expect(CHANNEL_SCHEMAS_KEYS).toContain(channel);
  });
});

describe('ai/models/list — запрос и ответ (§7/§11: одним вызовом всё для экрана)', () => {
  it('запрос {} — strict (лишние поля отвергаются)', () => {
    expect(AI_MODELS_LIST_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(AI_MODELS_LIST_REQUEST_SCHEMA.safeParse({ modelId: 'x' }).success).toBe(false);
  });

  it('ответ: models[] + ramTotalGb + uiLanguage; ModelView = descriptor+state+bytesLoaded?+errorKey?', () => {
    const parsed = AI_MODELS_LIST_RESPONSE_SCHEMA.parse({
      models: [{ descriptor: DESCRIPTOR, state: 'paused', bytesLoaded: 1024 }],
      ramTotalGb: 15.9,
      uiLanguage: 'ru',
    });
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]?.state).toBe('paused');
    expect(parsed.models[0]?.bytesLoaded).toBe(1024);
    expect(parsed.ramTotalGb).toBe(15.9);
  });

  it('ModelView без bytesLoaded валиден (not_installed); с errorKey — error-состояние (§16–17: ключ, не текст)', () => {
    expect(
      MODEL_VIEW_SCHEMA.safeParse({ descriptor: DESCRIPTOR, state: 'not_installed' }).success,
    ).toBe(true);
    expect(
      MODEL_VIEW_SCHEMA.safeParse({
        descriptor: DESCRIPTOR,
        state: 'error',
        errorKey: 'errors.AI_HASH_MISMATCH',
      }).success,
    ).toBe(true);
  });

  it('ModelView отвергает неизвестные поля и чужие state (strict, §14)', () => {
    expect(
      MODEL_VIEW_SCHEMA.safeParse({ descriptor: DESCRIPTOR, state: 'installed', total: 1 }).success,
    ).toBe(false);
    expect(MODEL_VIEW_SCHEMA.safeParse({ descriptor: DESCRIPTOR, state: ' flying' }).success).toBe(
      false,
    );
  });

  it('типы: AiModelsListResponse/ModelView выведены из схем (§23)', () => {
    // z.infer даёт мутабельную форму (не readonly-литерал) — пиняем фактическую.
    expectTypeOf<AiModelsListResponse['models']>().toEqualTypeOf<ModelView[]>();
    expectTypeOf<AiModelsListResponse['ramTotalGb']>().toEqualTypeOf<number>();
    expectTypeOf<AiModelsListResponse['uiLanguage']>().toEqualTypeOf<string>();
    expectTypeOf<ModelView['state']>().toEqualTypeOf<(typeof MODEL_STATUSES)[number]>();
  });
});

describe('ai/models/download|pause|resume|reset — {modelId} → статус (§5/§11)', () => {
  it('запрос {modelId} — strict: пустой/без поля/с лишним отвергаются', () => {
    expect(AI_MODELS_MODEL_ID_REQUEST_SCHEMA.safeParse({ modelId: 'dev-ru' }).success).toBe(true);
    expect(AI_MODELS_DOWNLOAD_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(AI_MODELS_MODEL_ID_REQUEST_SCHEMA.safeParse({ modelId: '' }).success).toBe(false);
    expect(AI_MODELS_MODEL_ID_REQUEST_SCHEMA.safeParse({ modelId: 'x', extra: 1 }).success).toBe(
      false,
    );
  });

  it('ответ-статус: state из MODEL_STATUSES; optionals bytesLoaded/totalBytes/resumable/errorKey', () => {
    expect(
      AI_MODELS_STATUS_RESPONSE_SCHEMA.safeParse({ state: 'downloading', bytesLoaded: 5 }).success,
    ).toBe(true);
    expect(
      AI_MODELS_STATUS_RESPONSE_SCHEMA.safeParse({
        state: 'paused',
        bytesLoaded: 5,
        totalBytes: 10,
        resumable: false,
      }).success,
    ).toBe(true);
    expect(AI_MODELS_STATUS_RESPONSE_SCHEMA.safeParse({ state: 'nope' }).success).toBe(false);
    expect(AI_MODELS_STATUS_RESPONSE_SCHEMA.safeParse({ state: 'paused', x: 1 }).success).toBe(
      false,
    );
  });

  it('reset-ответ — та же форма статуса (reset → not_installed, §7 080)', () => {
    expect(AI_MODELS_RESET_RESPONSE_SCHEMA.safeParse({ state: 'not_installed' }).success).toBe(
      true,
    );
  });
});

describe('ai/models/select — {modelId} → {modelId} (prefs.aiSettings.modelId, §5/§9)', () => {
  it('ответ — эхо выбранного id, strict', () => {
    expect(AI_MODELS_SELECT_RESPONSE_SCHEMA.safeParse({ modelId: 'dev-ru' }).success).toBe(true);
    expect(AI_MODELS_SELECT_RESPONSE_SCHEMA.safeParse({}).success).toBe(false);
    expect(AI_MODELS_SELECT_RESPONSE_SCHEMA.safeParse({ modelId: 'dev-ru', x: 1 }).success).toBe(
      false,
    );
  });
});
