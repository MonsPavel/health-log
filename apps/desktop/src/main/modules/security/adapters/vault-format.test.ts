/**
 * TASK-093 §5/§19: тесты формата файла vault.key v2 (vault-format):
 *  - parseV2: строгая схема `{v:2, mode, wrappedKeyB64, createdUtc, saltB64?,
 *    argonParams?}` — любое отклонение (JSON, версия, mode, base64, границы
 *    параметров Argon2id, salt<8 байт, «passphrase без соли», «safeStorage с
 *    солью») → undefined (адаптер маппит в VAULT/KEY_CORRUPT, §13);
 *  - parseV1: схема v1 `{v:1, wrapped, createdUtc}` — для миграции при старте;
 *  - migrateV1ToV2: переупаковка v1→v2 без перекрытия ключа (data сохраняется —
 *    §5: «old safeStorage-wrap переупаковывается»); downgrade v2→v1 невозможен —
 *    сериализация всегда пишет v2 (§13 «downgrade формата v2→v1 запрещён»).
 */
import { describe, expect, it } from 'vitest';

import {
  VAULT_FORMAT_VERSION,
  migrateV1ToV2,
  parseV1,
  parseV2,
  serializeV2,
  type VaultKeyFileV2,
} from './vault-format.js';

/** Реалистичная safeStorage-обёртка (base64 ≥ 8 байт — как DPAPI-blob). */
const WRAPPED_B64 = Buffer.alloc(32, 5).toString('base64');

/** Валидный safeStorage-файл v2 (после миграции v1 или первой установки). */
const SAFE_STORAGE_FILE: VaultKeyFileV2 = {
  v: 2,
  mode: 'safeStorage',
  wrappedKeyB64: WRAPPED_B64,
  createdUtc: 1_700_000_000_000,
};

/** Валидный passphrase-файл v2 (после setPassphrase; параметры — от calibrate). */
const PASSPHRASE_FILE: VaultKeyFileV2 = {
  v: 2,
  mode: 'passphrase',
  wrappedKeyB64: Buffer.alloc(12 + 32 + 16, 7).toString('base64'),
  createdUtc: 1_700_000_000_000,
  saltB64: Buffer.alloc(16, 3).toString('base64'),
  argonParams: { iterations: 5, memoryKib: 65_536, parallelism: 4 },
};

describe('parseV2 — строгая схема формата v2 (TASK-093 §5)', () => {
  it('валидные файлы обеих мод читаются как есть', () => {
    expect(parseV2(JSON.stringify(SAFE_STORAGE_FILE))).toEqual(SAFE_STORAGE_FILE);
    expect(parseV2(JSON.stringify(PASSPHRASE_FILE))).toEqual(PASSPHRASE_FILE);
  });

  it('отклонения схемы → undefined (не JSON, версия, mode, поля, base64, границы)', () => {
    const badPayloads: unknown[] = [
      'not-json{',
      null,
      [1, 2],
      { ...SAFE_STORAGE_FILE, v: 1 },
      { ...SAFE_STORAGE_FILE, v: 3 },
      { ...SAFE_STORAGE_FILE, mode: 'passphrase' }, // нет salt/params
      { ...PASSPHRASE_FILE, mode: 'unexpected' },
      { ...SAFE_STORAGE_FILE, wrappedKeyB64: '' },
      { ...SAFE_STORAGE_FILE, wrappedKeyB64: 'не-base64!!!' },
      { ...SAFE_STORAGE_FILE, wrappedKeyB64: 42 },
      { ...SAFE_STORAGE_FILE, createdUtc: 'не-число' },
      { ...SAFE_STORAGE_FILE, createdUtc: Number.POSITIVE_INFINITY },
      { ...PASSPHRASE_FILE, saltB64: undefined }, // passphrase без соли
      { ...PASSPHRASE_FILE, saltB64: 'не-base64!!!' },
      { ...PASSPHRASE_FILE, saltB64: Buffer.alloc(7).toString('base64') }, // < 8 байт
      { ...PASSPHRASE_FILE, argonParams: undefined }, // passphrase без параметров
      { ...PASSPHRASE_FILE, argonParams: { ...PASSPHRASE_FILE.argonParams, iterations: 0 } },
      { ...PASSPHRASE_FILE, argonParams: { ...PASSPHRASE_FILE.argonParams, memoryKib: 7 } },
      { ...PASSPHRASE_FILE, argonParams: { ...PASSPHRASE_FILE.argonParams, parallelism: 0 } },
      { ...PASSPHRASE_FILE, argonParams: { ...PASSPHRASE_FILE.argonParams, iterations: 1.5 } },
      // safeStorage с полями парольной обёртки — противоречие схемы.
      { ...SAFE_STORAGE_FILE, saltB64: Buffer.alloc(16).toString('base64') },
      {
        ...SAFE_STORAGE_FILE,
        argonParams: { iterations: 1, memoryKib: 65_536, parallelism: 1 },
      },
      {}, // пустой объект
    ];

    for (const payload of badPayloads) {
      expect(parseV2(JSON.stringify(payload)), JSON.stringify(payload)).toBeUndefined();
    }
  });
});

describe('parseV1 — легаси-схема для миграции (TASK-093 §5)', () => {
  it('валидный v1-файл читается: {v:1, wrapped, createdUtc}', () => {
    const legacy = parseV1(
      JSON.stringify({ v: 1, wrapped: WRAPPED_B64, createdUtc: 1_700_000_000_000 }),
    );
    expect(legacy).toEqual({ wrapped: WRAPPED_B64, createdUtc: 1_700_000_000_000 });
  });

  it('отклонения схемы v1 → undefined', () => {
    const badPayloads: unknown[] = [
      'not-json{',
      { v: 2, wrapped: WRAPPED_B64, createdUtc: 1 },
      { v: 1, wrapped: '', createdUtc: 1 },
      { v: 1, wrapped: 'не-base64!!!', createdUtc: 1 },
      { v: 1, wrapped: 42, createdUtc: 1 },
      { v: 1, wrapped: WRAPPED_B64, createdUtc: 'не-число' },
      { v: 1, wrapped: WRAPPED_B64 },
      {},
    ];
    for (const payload of badPayloads) {
      expect(parseV1(JSON.stringify(payload)), JSON.stringify(payload)).toBeUndefined();
    }
  });
});

describe('migrateV1ToV2/serializeV2 — переупаковка без потери данных (§5/§13)', () => {
  it('v1 → v2: обёртка и createdUtc сохраняются, mode=safeStorage, v=2', () => {
    const legacy = { wrapped: WRAPPED_B64, createdUtc: 1_700_000_000_000 };
    const migrated = migrateV1ToV2(legacy);

    expect(migrated).toEqual({
      v: VAULT_FORMAT_VERSION,
      mode: 'safeStorage',
      wrappedKeyB64: WRAPPED_B64,
      createdUtc: 1_700_000_000_000,
    });
    // Сериализованный файл немедленно читается строгим парсером v2 (обратная связь).
    expect(parseV2(serializeV2(migrated))).toEqual(migrated);
  });

  it('downgrade запрещён: сериализация всегда пишет v=2 — v1-ридер видит KEY_CORRUPT (§13)', () => {
    const legacy = { wrapped: WRAPPED_B64, createdUtc: 1 };
    const roundtrip = parseV1(serializeV2(migrateV1ToV2(legacy)));
    expect(roundtrip).toBeUndefined(); // v1-схема v2-файл больше не принимает
  });
});
