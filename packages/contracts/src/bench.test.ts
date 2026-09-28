// TASK-062 §9/§11/§14: контракт-тесты test-only канала `__bench/seed` — zod на
// границе доверия (арх. 08 §4), strict-объекты (§14). Матрица:
//  - request {count} — strict, count — целое 0..200000 (10k bench / 100 smoke /
//    запас на будущие профили нагрузки; отрицательные и дробные — отказ);
//  - response {inserted} — strict, целое ≥ 0 (факт вставки main-стороны);
//  - канал присутствует в реестре CHANNEL_SCHEMAS и union ChannelName (§11:
//    test-only — регистрация решает main-гард HL_BENCH, контракт — только форма).
import { describe, expect, it } from 'vitest';

import { BENCH_SEED_REQUEST_SCHEMA, BENCH_SEED_RESPONSE_SCHEMA } from './bench.js';
import { CHANNEL_SCHEMAS } from './schemas.js';

describe('BENCH_SEED_REQUEST_SCHEMA — запрос __bench/seed (§9: {count})', () => {
  it('принимает целое count в границах (10k bench, 100 smoke, 0 — пустой сид)', () => {
    expect(BENCH_SEED_REQUEST_SCHEMA.safeParse({ count: 10_000 }).success).toBe(true);
    expect(BENCH_SEED_REQUEST_SCHEMA.safeParse({ count: 100 }).success).toBe(true);
    expect(BENCH_SEED_REQUEST_SCHEMA.safeParse({ count: 0 }).success).toBe(true);
  });

  it('отказ: дробное, отрицательное, сверх максимума, лишние поля (strict, §14)', () => {
    expect(BENCH_SEED_REQUEST_SCHEMA.safeParse({ count: 10.5 }).success).toBe(false);
    expect(BENCH_SEED_REQUEST_SCHEMA.safeParse({ count: -1 }).success).toBe(false);
    expect(BENCH_SEED_REQUEST_SCHEMA.safeParse({ count: 200_001 }).success).toBe(false);
    expect(BENCH_SEED_REQUEST_SCHEMA.safeParse({ count: 10, seed: 7 }).success).toBe(false);
    expect(BENCH_SEED_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
  });
});

describe('BENCH_SEED_RESPONSE_SCHEMA — ответ __bench/seed (§9: факт вставки)', () => {
  it('принимает {inserted: N≥0}, отказывает дробному/отрицательному/лишним полям', () => {
    expect(BENCH_SEED_RESPONSE_SCHEMA.safeParse({ inserted: 10_000 }).success).toBe(true);
    expect(BENCH_SEED_RESPONSE_SCHEMA.safeParse({ inserted: 0 }).success).toBe(true);
    expect(BENCH_SEED_RESPONSE_SCHEMA.safeParse({ inserted: 1.5 }).success).toBe(false);
    expect(BENCH_SEED_RESPONSE_SCHEMA.safeParse({ inserted: -1 }).success).toBe(false);
    expect(BENCH_SEED_RESPONSE_SCHEMA.safeParse({ inserted: 1, tookMs: 2 }).success).toBe(false);
  });
});

describe('CHANNEL_SCHEMAS — test-only канал __bench/seed в реестре (§11)', () => {
  it('запись реестра — те же схемы, что экспортирует bench.ts', () => {
    expect(CHANNEL_SCHEMAS['__bench/seed']?.request).toBe(BENCH_SEED_REQUEST_SCHEMA);
    expect(CHANNEL_SCHEMAS['__bench/seed']?.response).toBe(BENCH_SEED_RESPONSE_SCHEMA);
  });
});
