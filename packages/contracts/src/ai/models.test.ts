// TASK-080 §6/§7/§14: тест-контракт витрины моделей — статусы жизненного цикла
// загрузки (§7: машина not_installed→downloading⇄paused→verifying→installed;
// error — терминальное с reset-возможностью), форма статуса (§5: место для
// пометки «докачка невозможна») и паттерн имени файла из манифеста (§14:
// path traversal запрещён — имя строго [a-z0-9.-]+).
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MODEL_FILE_PATTERN,
  MODEL_STATUSES,
  type ModelProgressPayload,
  type ModelStatus,
  type ModelStatusInfo,
} from './models.js';

describe('MODEL_STATUSES — жизненный цикл загрузки модели (TASK-080 §6/§7)', () => {
  it('фиксированный состав статусов §6 — ровно шесть, порядок машины состояний', () => {
    expect([...MODEL_STATUSES]).toEqual([
      'not_installed',
      'downloading',
      'paused',
      'installed',
      'verifying',
      'error',
    ]);
  });

  it('тип ModelStatus — union строковых литералов из MODEL_STATUSES', () => {
    expectTypeOf<ModelStatus>().toEqualTypeOf<
      'not_installed' | 'downloading' | 'paused' | 'installed' | 'verifying' | 'error'
    >();
  });
});

describe('ModelStatusInfo — форма статуса для list-канала 081 (§5/§11)', () => {
  it('state обязателен; bytesLoaded/totalBytes/resumable/errorKey — опциональные', () => {
    expectTypeOf<ModelStatusInfo>().toEqualTypeOf<{
      readonly state: ModelStatus;
      readonly bytesLoaded?: number;
      readonly totalBytes?: number;
      /** false — сервер без Range: докачка невозможна (§5 «отмечаем в состоянии»). */
      readonly resumable?: boolean;
      /** Ключ i18n терминальной ошибки (state=error), не текст (§16–17). */
      readonly errorKey?: string;
    }>();
  });
});

describe('ModelProgressPayload — payload события ai:progress (§11)', () => {
  it('форма {modelId, downloadedBytes, totalBytes, state} — без PHI (§14)', () => {
    expectTypeOf<ModelProgressPayload>().toEqualTypeOf<{
      readonly modelId: string;
      readonly downloadedBytes: number;
      readonly totalBytes: number;
      readonly state: ModelStatus;
    }>();
  });
});

describe('MODEL_FILE_PATTERN — валидация имени файла манифеста (§14)', () => {
  it.each(['dev-placeholder.gguf', 'model-q4-k-m.gguf', 'a.b-c.d'])(
    'валидное имя %j проходит целиком',
    (file) => {
      expect(MODEL_FILE_PATTERN.test(file)).toBe(true);
    },
  );

  it.each([
    ['..', 'родительский каталог'],
    ['../evil.gguf', 'traversal вверх'],
    ['.gguf', 'скрытый файл — ведущая точка (усиление §14 против «..»)'],
    ['sub/dir.gguf', 'вложенный путь'],
    ['C:\\evil.gguf', 'windows-путь'],
    ['Model.GGUF', 'верхний регистр'],
    ['model-q4_k_m.gguf', 'подчёркивание вне класса §14'],
    ['a b.gguf', 'пробел'],
    ['', 'пустая строка'],
  ])('невалидное имя %j (%s) отвергается', (file) => {
    expect(MODEL_FILE_PATTERN.test(file)).toBe(false);
  });
});
