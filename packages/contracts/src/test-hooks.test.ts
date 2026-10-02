// TASK-102 §11/§14: контракт-тесты test-only каналов `__test/insert-batch` и
// `__test/db-state` — крэш-тест потери питания (NFR-3). zod на границе доверия
// (арх. 08 §4), strict-объекты (§14). Матрица:
//  - insert-batch: request {count ≥ 1} (размер батча — 50 в прогоне, больше 1 —
//    demo авто-коммита §20-3), response {committedTotal ≥ 0} — подтверждённый
//    total строк в таблице ПОСЛЕ транзакции (ack-оракул инварианта §2/§8);
//  - db-state: request {} → response {count, dataVersion, schemaVersion} —
//    снимок состояния БД после перезапуска (проверяемые свойства §8);
//  - оба канала в реестре CHANNEL_SCHEMAS и union ChannelName, помечены secure
//    (пишут/читают БД — инвентарь vault.test.ts §14); регистрация решает main-гард
//    HL_TEST_HOOKS (TASK-102 §4/§6), контракт — только форма.
import { describe, expect, it } from 'vitest';

import { CHANNEL_SCHEMAS } from './schemas.js';
import {
  TEST_DB_STATE_REQUEST_SCHEMA,
  TEST_DB_STATE_RESPONSE_SCHEMA,
  TEST_INSERT_BATCH_COUNT_MAX,
  TEST_INSERT_BATCH_REQUEST_SCHEMA,
  TEST_INSERT_BATCH_RESPONSE_SCHEMA,
} from './test-hooks.js';

describe('TEST_INSERT_BATCH_REQUEST_SCHEMA — запрос __test/insert-batch (§11: {count})', () => {
  it('принимает целое count ≥ 1 в границах (батч 50, демо-батч 5000)', () => {
    expect(TEST_INSERT_BATCH_REQUEST_SCHEMA.safeParse({ count: 50 }).success).toBe(true);
    expect(TEST_INSERT_BATCH_REQUEST_SCHEMA.safeParse({ count: 1 }).success).toBe(true);
    expect(TEST_INSERT_BATCH_REQUEST_SCHEMA.safeParse({ count: TEST_INSERT_BATCH_COUNT_MAX }).success).toBe(
      true,
    );
  });

  it('отказ: 0, дробное, отрицательное, сверх максимума, лишние поля (strict, §14)', () => {
    expect(TEST_INSERT_BATCH_REQUEST_SCHEMA.safeParse({ count: 0 }).success).toBe(false);
    expect(TEST_INSERT_BATCH_REQUEST_SCHEMA.safeParse({ count: 10.5 }).success).toBe(false);
    expect(TEST_INSERT_BATCH_REQUEST_SCHEMA.safeParse({ count: -1 }).success).toBe(false);
    expect(TEST_INSERT_BATCH_REQUEST_SCHEMA.safeParse({ count: TEST_INSERT_BATCH_COUNT_MAX + 1 }).success).toBe(
      false,
    );
    expect(TEST_INSERT_BATCH_REQUEST_SCHEMA.safeParse({ count: 50, seed: 7 }).success).toBe(false);
    expect(TEST_INSERT_BATCH_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
  });
});

describe('TEST_INSERT_BATCH_RESPONSE_SCHEMA — ответ __test/insert-batch (§11: ack)', () => {
  it('принимает {committedTotal: N≥0}, отказывает дробному/отрицательному/лишним полям', () => {
    expect(TEST_INSERT_BATCH_RESPONSE_SCHEMA.safeParse({ committedTotal: 500 }).success).toBe(true);
    expect(TEST_INSERT_BATCH_RESPONSE_SCHEMA.safeParse({ committedTotal: 0 }).success).toBe(true);
    expect(TEST_INSERT_BATCH_RESPONSE_SCHEMA.safeParse({ committedTotal: 1.5 }).success).toBe(false);
    expect(TEST_INSERT_BATCH_RESPONSE_SCHEMA.safeParse({ committedTotal: -1 }).success).toBe(false);
    expect(TEST_INSERT_BATCH_RESPONSE_SCHEMA.safeParse({ committedTotal: 5, tookMs: 2 }).success).toBe(
      false,
    );
  });
});

describe('TEST_DB_STATE_* — канал __test/db-state (§11: {} → {count, dataVersion, schemaVersion})', () => {
  it('request — только пустой strict-объект', () => {
    expect(TEST_DB_STATE_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(TEST_DB_STATE_REQUEST_SCHEMA.safeParse({ count: 1 }).success).toBe(false);
  });

  it('response — три целых ≥ 0; отказ дробным/отрицательным/лишним полям', () => {
    expect(
      TEST_DB_STATE_RESPONSE_SCHEMA.safeParse({ count: 750, dataVersion: 751, schemaVersion: 7 })
        .success,
    ).toBe(true);
    expect(
      TEST_DB_STATE_RESPONSE_SCHEMA.safeParse({ count: 0, dataVersion: 0, schemaVersion: 0 }).success,
    ).toBe(true);
    expect(
      TEST_DB_STATE_RESPONSE_SCHEMA.safeParse({ count: 1.5, dataVersion: 1, schemaVersion: 7 })
        .success,
    ).toBe(false);
    expect(
      TEST_DB_STATE_RESPONSE_SCHEMA.safeParse({ count: -1, dataVersion: 1, schemaVersion: 7 })
        .success,
    ).toBe(false);
    expect(
      TEST_DB_STATE_RESPONSE_SCHEMA.safeParse({ count: 1, dataVersion: 1, schemaVersion: 7, extra: 1 })
        .success,
    ).toBe(false);
    expect(TEST_DB_STATE_RESPONSE_SCHEMA.safeParse({ count: 1 }).success).toBe(false);
  });
});

describe('CHANNEL_SCHEMAS — test-only каналы __test/* в реестре (§11)', () => {
  it('записи реестра — те же схемы, что экспортирует test-hooks.ts', () => {
    expect(CHANNEL_SCHEMAS['__test/insert-batch']?.request).toBe(TEST_INSERT_BATCH_REQUEST_SCHEMA);
    expect(CHANNEL_SCHEMAS['__test/insert-batch']?.response).toBe(TEST_INSERT_BATCH_RESPONSE_SCHEMA);
    expect(CHANNEL_SCHEMAS['__test/db-state']?.request).toBe(TEST_DB_STATE_REQUEST_SCHEMA);
    expect(CHANNEL_SCHEMAS['__test/db-state']?.response).toBe(TEST_DB_STATE_RESPONSE_SCHEMA);
  });

  it('оба канала пишут/читают БД — secure: true (инвентарь vault.test.ts, §14)', () => {
    expect(CHANNEL_SCHEMAS['__test/insert-batch']?.secure).toBe(true);
    expect(CHANNEL_SCHEMAS['__test/db-state']?.secure).toBe(true);
  });
});
