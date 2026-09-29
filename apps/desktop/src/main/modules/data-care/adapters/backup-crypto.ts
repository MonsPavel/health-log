/**
 * TASK-070 §5/§8/§14: крипто-примитивы копии — KDF Argon2id и AES-256-GCM
 * (node:crypto + argon2, N-API prebuilds; «своей криптографии нет» — арх. 08 §7).
 *
 * Ключ содержимого (§8 — РЕШЕНИЕ): НЕ ключ БД из KeyVault, а производный от
 * ПАРОЛЯ КОПИИ — машина-независимо (копия восстанавливается на новом ПК). Параметры
 * Argon2id по умолчанию — база для TASK-093 (§14: «параметры в файле, не в коде» —
 * в манифесте копии, точка сборки может переопределить калибровкой 093).
 *
 * Целостность (§14): AES-256-GCM с authTagLength — подмена шифртекста/тега ИЛИ
 * AAD (манифест привязан как AAD) даёт BackupIntegrityError при расшифровке —
 * мусор-данные наружу не проходят (AC-3); неудачная расшифровка = неверный пароль
 * или порча контейнера (различение — TASK-071).
 *
 * Безопасность (§14): ключ копии/пароль никогда не логируются (нечего логировать —
 * функции не пишут в лог вовсе; redact-список logger.ts страхует нарушителя).
 * Обнуление строк пароля — JS-ограничение, документировано (ADR-0002 §14-прецедент).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { argon2id, hash as argon2Hash } from 'argon2';

/** Параметры Argon2id по умолчанию (§14: база TASK-093 — 64 МБ, 3 итерации, 4 потока). */
export const ARGON2ID_DEFAULT_PARAMS: Readonly<Argon2Params> = {
  iterations: 3,
  memoryKib: 65536,
  parallelism: 4,
};

/** Параметры Argon2id (манифест §8: «параметры в файле» — эволюционируют). */
export interface Argon2Params {
  /** timeCost — число итераций. */
  readonly iterations: number;
  /** memoryCost, КиБ. */
  readonly memoryKib: number;
  /** parallelism — потоки. */
  readonly parallelism: number;
}

/** Длина ключа содержимого AES-256 (байты). */
export const BACKUP_KEY_BYTES = 32;
/** Длина соли Argon2id (байты; минимум argon2 — 8, берём 16). */
export const BACKUP_SALT_BYTES = 16;
/** Длина IV AES-GCM (байты, §5: «iv 12б»). */
export const IV_BYTES = 12;
/** Длина auth-тега GCM (байты). */
export const TAG_BYTES = 16;

/**
 * Ошибка целостности контейнера — с TASK-071 живёт в порте BackupCrypto (часть
 * контракта: use case восстановления маппит её в коды BACKUP/*, application не
 * импортирует адаптеры, арх. 03 §4). Реэкспорт — совместимость существующих
 * импортов (прецедент порта notes-search).
 */
import { BackupIntegrityError } from '../application/ports/backup-crypto.js';
export { BackupIntegrityError };

/** Минимальная соль Argon2id (байты) — требование алгоритма. */
const ARGON2_MIN_SALT_BYTES = 8;

/**
 * Выводит 32-байтный ключ содержимого из пароля копии (§8): Argon2id с солью и
 * параметрами (запись kdf попадает в манифест). Соль < 8 байт — TypeError
 * (программная ошибка вызова; соли генерирует сам адаптер — BACKUP_SALT_BYTES).
 */
export function deriveArgon2idKey(
  passphrase: string,
  salt: Buffer,
  params: Argon2Params,
): Promise<Buffer> {
  if (salt.length < ARGON2_MIN_SALT_BYTES) {
    throw new TypeError(
      `deriveArgon2idKey: соль должна быть ≥ ${ARGON2_MIN_SALT_BYTES} байт (нарушение контракта — программная ошибка, TASK-070 §8)`,
    );
  }
  return argon2Hash(passphrase, {
    type: argon2id,
    salt,
    hashLength: BACKUP_KEY_BYTES,
    timeCost: params.iterations,
    memoryCost: params.memoryKib,
    parallelism: params.parallelism,
    raw: true,
  });
}

/**
 * Ключ содержимого из hex-ключа БД (§8: авто-копии hook'а без диалога — машиносвязны).
 * Нарушение контракта 64-hex — TypeError в точке вызова (dev-контракт, прецедент
 * assertKeyHex TASK-022 §7).
 */
export function contentKeyFromDbKeyHex(keyHex: string): Buffer {
  if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new TypeError(
      'contentKeyFromDbKeyHex: keyHex должен быть строкой из 64 hex-символов (32 байта) — нарушение контракта является программной ошибкой (TASK-070 §8)',
    );
  }
  return Buffer.from(keyHex.toLowerCase(), 'hex');
}

/** Шифратор копии: готовый AES-256-GCM transform + IV + доступ к тегу после end. */
export interface BackupCipher {
  /** Свежий случайный IV (12 байт, §5) — попадает в контейнер рядом с шифртекстом. */
  readonly iv: Buffer;
  /** Поток-трансформер GCM (уже с AAD). */
  readonly transform: CipherGCM;
  /** Auth-тег (16 байт); корректен после end потока. */
  authTag(): Buffer;
}

/**
 * Создаёт шифратор (§5): AES-256-GCM, свежий IV, манифест — AAD (§14: метаданные
 * привязаны к целостности). Нарушение длины ключа — TypeError (крипто-контракт).
 */
export function createBackupCipher(contentKey: Buffer, aad: Buffer): BackupCipher {
  const iv = createIv();
  const transform = createCipheriv('aes-256-gcm', contentKey, iv, { authTagLength: TAG_BYTES });
  transform.setAAD(aad);
  return { iv, transform, authTag: () => transform.getAuthTag() };
}

/** Расшифровщик копии: AES-256-GCM с AAD и тегом (проверка целостности в final). */
export function openBackupDecipher(
  contentKey: Buffer,
  iv: Buffer,
  aad: Buffer,
  tag: Buffer,
): DecipherGCM {
  const decipher = createDecipheriv('aes-256-gcm', contentKey, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return decipher;
}

/** Вход расшифровки полезной нагрузки (§19: roundtrip-тесты; восстановление — 071). */
export interface DecryptPayloadInput {
  readonly contentKey: Buffer;
  readonly iv: Buffer;
  readonly aad: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Расшифровывает полезную нагрузку целиком (§15: ~20 МБ — приемлемо в памяти main;
 * потоковая версия — по потребности 071). Ошибка GCM → BackupIntegrityError
 * (не мусор-данные, AC-3).
 */
export function decryptBackupPayload(input: DecryptPayloadInput): Buffer {
  const decipher = openBackupDecipher(input.contentKey, input.iv, input.aad, input.tag);
  try {
    return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
  } catch (error) {
    throw new BackupIntegrityError('GCM auth failed: контейнер повреждён или пароль неверен', {
      cause: error,
    });
  }
}

/** Свежий случайный IV (node:crypto — единственный источник случайности проекта). */
function createIv(): Buffer {
  return randomBytes(IV_BYTES);
}
