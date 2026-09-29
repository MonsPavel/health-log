/**
 * TASK-070 §19/§14: тесты крипто-примитивов копии (backup-crypto) — примесей ФС
 * нет (контейнер-обвязка — backup-container.int.test.ts).
 *
 * Матрица:
 *  - Argon2id (§8): одинаковые (пароль, соль, параметры) → одинаковый 32-байтный
 *    ключ; другая соль → другой ключ (детерминизм KDF и чувствительность к соли);
 *  - AES-256-GCM (§5): roundtrip шифртекст ↔ открытый текст; iv 12 байт,
 *    тег 16 байт;
 *  - целостность (§14/AC-3): подмена ЛЮБОЙ из частей — шифртекста, AAD (манифест),
 *    тега — и чужой ключ дают BackupIntegrityError, а не мусор-данные;
 *  - db-key (§8: авто-копии hook'а): 64-hex → 32 байта; нарушение контракта —
 *    TypeError в точке вызова (dev-контракт, прецедент assertKeyHex TASK-022).
 *
 * Параметры Argon2id в тестах — минимальные (быстро); боевые по умолчанию —
 * ARGON2ID_DEFAULT_PARAMS (§14: «как TASK-093 база», калибровка — 093).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_DEFAULT_PARAMS,
  BackupIntegrityError,
  contentKeyFromDbKeyHex,
  createBackupCipher,
  decryptBackupPayload,
  deriveArgon2idKey,
  IV_BYTES,
  TAG_BYTES,
} from './backup-crypto.js';

/** Тестовые параметры Argon2id: минимальная память/итерации — скорость набора. */
const TEST_PARAMS = { iterations: 1, memoryKib: 64, parallelism: 1 } as const;

/** Соль 16 байт (BACKUP_SALT_BYTES) — минимально допустимая для argon2 (8) с запасом. */
const TEST_SALT = Buffer.alloc(16, 7);

describe('deriveArgon2idKey (TASK-070 §8: ключ копии = Argon2id(пароль))', () => {
  it('детерминизм: те же пароль/соль/параметры → тот же 32-байтный ключ', async () => {
    const first = await deriveArgon2idKey('пароль-копии', TEST_SALT, TEST_PARAMS);
    const second = await deriveArgon2idKey('пароль-копии', TEST_SALT, TEST_PARAMS);
    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
  });

  it('другая соль → другой ключ (соль в манифесте обязательна, §8)', async () => {
    const first = await deriveArgon2idKey('пароль-копии', TEST_SALT, TEST_PARAMS);
    const other = await deriveArgon2idKey('пароль-копии', Buffer.alloc(16, 9), TEST_PARAMS);
    expect(first.equals(other)).toBe(false);
  });

  it('другой пароль → другой ключ', async () => {
    const first = await deriveArgon2idKey('пароль-копии', TEST_SALT, TEST_PARAMS);
    const other = await deriveArgon2idKey('другой-пароль', TEST_SALT, TEST_PARAMS);
    expect(first.equals(other)).toBe(false);
  });

  it('боевые параметры по умолчанию (§14: база TASK-093) — 64 МБ / 3 итерации / 4 потока', () => {
    expect(ARGON2ID_DEFAULT_PARAMS).toEqual({ iterations: 3, memoryKib: 65536, parallelism: 4 });
  });
});

describe('createBackupCipher / decryptBackupPayload (TASK-070 §5: AES-256-GCM)', () => {
  const key = randomBytes(32);
  const aad = Buffer.from('{"formatVersion":1}');
  const plaintext = randomBytes(1024);

  it('roundtrip: расшифровка возвращает исходные байты; iv 12 байт, тег 16 байт', () => {
    const cipher = createBackupCipher(key, aad);
    expect(IV_BYTES).toBe(12);
    expect(TAG_BYTES).toBe(16);
    expect(cipher.iv).toHaveLength(12);
    const ciphertext = Buffer.concat([cipher.transform.update(plaintext), cipher.transform.final()]);
    const tag = cipher.authTag();
    expect(tag).toHaveLength(16);

    const decrypted = decryptBackupPayload({ contentKey: key, iv: cipher.iv, aad, tag, ciphertext });
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('подмена байта шифртекста → BackupIntegrityError, не мусор (AC-3)', () => {
    const cipher = createBackupCipher(key, aad);
    const ciphertext = Buffer.concat([cipher.transform.update(plaintext), cipher.transform.final()]);
    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0xff;

    expect(() =>
      decryptBackupPayload({ contentKey: key, iv: cipher.iv, aad, tag: cipher.authTag(), ciphertext: tampered }),
    ).toThrow(BackupIntegrityError);
  });

  it('подмена байта AAD (манифеста) → BackupIntegrityError (§14: метаданные привязаны)', () => {
    const cipher = createBackupCipher(key, aad);
    const ciphertext = Buffer.concat([cipher.transform.update(plaintext), cipher.transform.final()]);
    const tamperedAad = Buffer.from(aad);
    tamperedAad[2] ^= 0x01;

    expect(() =>
      decryptBackupPayload({ contentKey: key, iv: cipher.iv, aad: tamperedAad, tag: cipher.authTag(), ciphertext }),
    ).toThrow(BackupIntegrityError);
  });

  it('подмена байта тега → BackupIntegrityError', () => {
    const cipher = createBackupCipher(key, aad);
    const ciphertext = Buffer.concat([cipher.transform.update(plaintext), cipher.transform.final()]);
    const tamperedTag = Buffer.from(cipher.authTag());
    tamperedTag[15] ^= 0xff;

    expect(() =>
      decryptBackupPayload({ contentKey: key, iv: cipher.iv, aad, tag: tamperedTag, ciphertext }),
    ).toThrow(BackupIntegrityError);
  });

  it('чужой ключ (неверный пароль копии) → BackupIntegrityError', () => {
    const cipher = createBackupCipher(key, aad);
    const ciphertext = Buffer.concat([cipher.transform.update(plaintext), cipher.transform.final()]);

    expect(() =>
      decryptBackupPayload({
        contentKey: randomBytes(32),
        iv: cipher.iv,
        aad,
        tag: cipher.authTag(),
        ciphertext,
      }),
    ).toThrow(BackupIntegrityError);
  });
});

describe('contentKeyFromDbKeyHex (TASK-070 §8: авто-копии — ключ БД)', () => {
  it('64 hex-символа → 32 байта (регистр нормализуется)', () => {
    const key = contentKeyFromDbKeyHex('AB'.repeat(32));
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from('ab'.repeat(32), 'hex'))).toBe(true);
  });

  it('нарушение контракта hex — TypeError в точке вызова (dev-контракт, §7 TASK-022)', () => {
    expect(() => contentKeyFromDbKeyHex('ab'.repeat(31))).toThrow(TypeError);
    expect(() => contentKeyFromDbKeyHex('zz'.repeat(32))).toThrow(TypeError);
    expect(() => contentKeyFromDbKeyHex('')).toThrow(TypeError);
  });
});
