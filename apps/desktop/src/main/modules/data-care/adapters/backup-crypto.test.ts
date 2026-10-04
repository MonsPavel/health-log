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
import { createCipheriv, randomBytes } from 'node:crypto';
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
  unwrapDbKey,
  wrapDbKey,
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
    const ciphertext = Buffer.concat([
      cipher.transform.update(plaintext),
      cipher.transform.final(),
    ]);
    const tag = cipher.authTag();
    expect(tag).toHaveLength(16);

    const decrypted = decryptBackupPayload({
      contentKey: key,
      iv: cipher.iv,
      aad,
      tag,
      ciphertext,
    });
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('подмена байта шифртекста → BackupIntegrityError, не мусор (AC-3)', () => {
    const cipher = createBackupCipher(key, aad);
    const ciphertext = Buffer.concat([
      cipher.transform.update(plaintext),
      cipher.transform.final(),
    ]);
    const tampered = Buffer.from(ciphertext);
    tampered[0]! ^= 0xff;

    expect(() =>
      decryptBackupPayload({
        contentKey: key,
        iv: cipher.iv,
        aad,
        tag: cipher.authTag(),
        ciphertext: tampered,
      }),
    ).toThrow(BackupIntegrityError);
  });

  it('подмена байта AAD (манифеста) → BackupIntegrityError (§14: метаданные привязаны)', () => {
    const cipher = createBackupCipher(key, aad);
    const ciphertext = Buffer.concat([
      cipher.transform.update(plaintext),
      cipher.transform.final(),
    ]);
    const tamperedAad = Buffer.from(aad);
    tamperedAad[2]! ^= 0x01;

    expect(() =>
      decryptBackupPayload({
        contentKey: key,
        iv: cipher.iv,
        aad: tamperedAad,
        tag: cipher.authTag(),
        ciphertext,
      }),
    ).toThrow(BackupIntegrityError);
  });

  it('подмена байта тега → BackupIntegrityError', () => {
    const cipher = createBackupCipher(key, aad);
    const ciphertext = Buffer.concat([
      cipher.transform.update(plaintext),
      cipher.transform.final(),
    ]);
    const tamperedTag = Buffer.from(cipher.authTag());
    tamperedTag[15]! ^= 0xff;

    expect(() =>
      decryptBackupPayload({ contentKey: key, iv: cipher.iv, aad, tag: tamperedTag, ciphertext }),
    ).toThrow(BackupIntegrityError);
  });

  it('чужой ключ (неверный пароль копии) → BackupIntegrityError', () => {
    const cipher = createBackupCipher(key, aad);
    const ciphertext = Buffer.concat([
      cipher.transform.update(plaintext),
      cipher.transform.final(),
    ]);

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

describe('wrapDbKey / unwrapDbKey (TASK-121 §3: переносимый ключ — конвенции TASK-093)', () => {
  const KEY_HEX = randomBytes(32).toString('hex');
  const PASSPHRASE = 'пароль-копии-121';

  it('roundtrip: разворачивание возвращает исходный ключ; форма записи — TASK-093 §2/§5', async () => {
    const wrap = await wrapDbKey(KEY_HEX, PASSPHRASE, TEST_PARAMS);
    // Соль Argon2id 16 байт (прецедент PASSPHRASE_SALT_BYTES TASK-093).
    expect(Buffer.from(wrap.saltB64, 'base64')).toHaveLength(16);
    // Параметры записи — параметры вызова (§14: параметры в файле, не в коде).
    expect(wrap.iterations).toBe(TEST_PARAMS.iterations);
    expect(wrap.memoryKib).toBe(TEST_PARAMS.memoryKib);
    expect(wrap.parallelism).toBe(TEST_PARAMS.parallelism);
    // Блоб = iv(12) || ct(32) || tag(16) — 60 байт (не пустая заглушка).
    expect(Buffer.from(wrap.wrappedKeyB64, 'base64')).toHaveLength(12 + 32 + 16);

    const unwrapped = await unwrapDbKey(wrap, PASSPHRASE);
    expect(unwrapped).toBe(KEY_HEX);
  });

  it('свежая соль на каждый вызов: две обёртки одного ключа различаются', async () => {
    const first = await wrapDbKey(KEY_HEX, PASSPHRASE, TEST_PARAMS);
    const second = await wrapDbKey(KEY_HEX, PASSPHRASE, TEST_PARAMS);
    expect(first.saltB64).not.toBe(second.saltB64);
    expect(first.wrappedKeyB64).not.toBe(second.wrappedKeyB64);
  });

  it('неверный пароль → BackupIntegrityError (auth-tag GCM — верификатор, §5 TASK-093)', async () => {
    const wrap = await wrapDbKey(KEY_HEX, PASSPHRASE, TEST_PARAMS);
    await expect(unwrapDbKey(wrap, 'другой-пароль')).rejects.toThrow(BackupIntegrityError);
  });

  it('порча байта обёртки → BackupIntegrityError (fail-closed, §14)', async () => {
    const wrap = await wrapDbKey(KEY_HEX, PASSPHRASE, TEST_PARAMS);
    const blob = Buffer.from(wrap.wrappedKeyB64, 'base64');
    blob[13]! ^= 0xff;
    await expect(
      unwrapDbKey({ ...wrap, wrappedKeyB64: blob.toString('base64') }, PASSPHRASE),
    ).rejects.toThrow(BackupIntegrityError);
  });

  it('обрезанный блоб короче iv+tag → BackupIntegrityError (прецедент unwrapDbKey 093)', async () => {
    const wrap = await wrapDbKey(KEY_HEX, PASSPHRASE, TEST_PARAMS);
    await expect(
      unwrapDbKey({ ...wrap, wrappedKeyB64: Buffer.alloc(20).toString('base64') }, PASSPHRASE),
    ).rejects.toThrow(BackupIntegrityError);
  });

  it('нарушение контракта keyHex — TypeError в точке вызова (dev-контракт)', async () => {
    await expect(wrapDbKey('ab'.repeat(31), PASSPHRASE, TEST_PARAMS)).rejects.toThrow(TypeError);
    await expect(wrapDbKey('zz'.repeat(32), PASSPHRASE, TEST_PARAMS)).rejects.toThrow(TypeError);
  });

  it('развёрнутый текст не 64-hex → BackupIntegrityError (мусор наружу не проходит)', async () => {
    // Подделка: GCM-валидный блоб с НЕ-ключевым содержимым тем же паролем/солью —
    // гард «развёрнуто 32 байта» обязан отклонить, не отдав мусор.
    const wrap = await wrapDbKey(KEY_HEX, PASSPHRASE, TEST_PARAMS);
    const kek = await deriveArgon2idKey(
      PASSPHRASE,
      Buffer.from(wrap.saltB64, 'base64'),
      TEST_PARAMS,
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: 16 });
    const notAKey = Buffer.from('это не ключ БД — 16 байт мусора', 'utf8');
    const ct = Buffer.concat([cipher.update(notAKey), cipher.final()]);
    const forged = Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
    await expect(unwrapDbKey({ ...wrap, wrappedKeyB64: forged }, PASSPHRASE)).rejects.toThrow(
      BackupIntegrityError,
    );
  });
});
