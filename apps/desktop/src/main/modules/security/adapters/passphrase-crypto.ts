/**
 * TASK-093 §5/§2: крипто-примитивы двойной обёртки ключа БД паролем —
 * `KEK = Argon2id(passphrase, salt)` и `wrappedKey = AES-256-GCM(dbKey, KEK)`
 * (арх. 08 §2/§7: только стандартные примитивы — node:crypto + argon2, прецедент
 * backup-crypto TASK-070; «своей криптографии нет»).
 *
 * Верификация пароля (§5 — РЕШЕНИЕ): verifier = auth-tag GCM самой обёртки.
 * Быстрой проверки «пароль даже не тот» НЕТ (SHA-256 по wrappedKey отвергнут —
 * офлайн-перебор минуя Argon2): проверка происходит только после полного derive
 * KEK — unwrapDbKey падает на auth-tag при неверном пароле/подмене/порче.
 *
 * Безопасность (§14): пароль/KEK/salt никогда не логируются (модуль не пишет в лог
 * вовсе — прецедент backup-crypto; redact-список логгера страхует нарушителя в
 * глубине). Обнуление строк пароля — JS-ограничение, документировано (ADR-0002).
 * Минимальная длина пароля (8) — политика UI, TASK-095 (§14 «крипто-агностик»):
 * этот слой политику не дублирует.
 *
 * Зоны (арх. 03 §4): чистый адаптер-модуль — kernel разрешён, shared/соседние
 * модули не импортируются (свой Argon2Params — расчёт на независимость модулей).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { argon2id, hash as argon2Hash } from 'argon2';

import { SystemClock, type Clock } from '@hl/kernel';

/** Параметры Argon2id (манифест/файл vault §5: «параметры в файле, не в коде»). */
export interface Argon2Params {
  /** timeCost — число итераций. */
  readonly iterations: number;
  /** memoryCost, КиБ. */
  readonly memoryKib: number;
  /** parallelism — потоки. */
  readonly parallelism: number;
}

/** Длина KEK (байты): AES-256 → 32. */
export const KEK_BYTES = 32;
/** Длина соли Argon2id (байты; минимум алгоритма — 8, берём 16; прецедент backup §8). */
export const PASSPHRASE_SALT_BYTES = 16;
/** Минимальная соль Argon2id (байты) — требование алгоритма (контракт deriveKek). */
export const ARGON2_MIN_SALT_BYTES = 8;
/** Длина IV AES-GCM (байты). */
export const WRAP_IV_BYTES = 12;
/** Длина auth-тега GCM (байты) — он же verifier обёртки (§5 РЕШЕНИЕ). */
export const WRAP_TAG_BYTES = 16;

/** Бюджет разблокировки (§15: Argon2id ~500 мс — unlock-UX приемлем). */
export const ARGON2ID_TARGET_UNLOCK_MS = 500;
/** Память калибровки (§4: 64 МБ фикс — memory-hard по OWASP; итерации подбираются). */
export const ARGON2ID_CALIBRATION_MEMORY_KIB = 65_536;
/** Потоки калибровки (§14 backup-crypto: 4 — типовое многоядерное железо). */
export const ARGON2ID_CALIBRATION_PARALLELISM = 4;
/** Границы подбора итераций: не быстрее одной итерации, не дороже максимума. */
export const ARGON2ID_MIN_ITERATIONS = 1;
export const ARGON2ID_MAX_ITERATIONS = 16;

/**
 * Ошибка целостности обёртки: auth-tag GCM не сошёлся — неверный пароль, подмена
 * или порча wrappedKey (криптографически неотличимы, §14 backup-crypto). Прецедент
 * BackupIntegrityError: живёт у потребителя семантики (SafeStorageKeyVault маппит
 * в VAULT/WRONG_PASSPHRASE — §19), application адаптеры не импортирует.
 */
export class PassphraseWrapIntegrityError extends Error {
  constructor(message = 'GCM auth failed: неверный пароль или обёртка повреждена') {
    super(message);
    this.name = 'PassphraseWrapIntegrityError';
  }
}

/**
 * KEK из пароля (§2): Argon2id с солью и параметрами (записываются в файл vault,
 * §5). Соль короче минимума алгоритма — TypeError (программная ошибка вызова;
 * соли генерирует сам адаптер — PASSPHRASE_SALT_BYTES; прецедент deriveArgon2idKey).
 */
export function deriveKek(passphrase: string, salt: Buffer, params: Argon2Params): Promise<Buffer> {
  if (salt.length < ARGON2_MIN_SALT_BYTES) {
    throw new TypeError(
      `deriveKek: соль должна быть ≥ ${ARGON2_MIN_SALT_BYTES} байт (нарушение контракта — программная ошибка, TASK-093 §2)`,
    );
  }
  return argon2Hash(passphrase, {
    type: argon2id,
    salt,
    hashLength: KEK_BYTES,
    timeCost: params.iterations,
    memoryCost: params.memoryKib,
    parallelism: params.parallelism,
    raw: true,
  });
}

/** Подпись хеширующей функции калибровки (подменяется в тестах, §19). */
export type Argon2HashFn = (
  passphrase: string,
  salt: Buffer,
  params: Argon2Params,
) => Promise<Buffer>;

/**
 * Оборачивает ключ БД (§2): AES-256-GCM(dbKey, KEK), свежий случайный IV.
 * Результат — байты `iv || ciphertext || tag` (адаптер кодирует в base64 для
 * файла vault: поле wrappedKeyB64 §5; tag внутри блоба = verifier, §5 РЕШЕНИЕ).
 */
export function wrapDbKey(dbKey: Buffer, kek: Buffer): Buffer {
  const iv = randomBytes(WRAP_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: WRAP_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(dbKey), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

/**
 * Разворачивает ключ БД (§2): GCM-открытие блоба `iv || ct || tag` тем же KEK.
 * Любой сбой (неверный KEK, подмена байта, обрезка) → PassphraseWrapIntegrityError
 * — наружу никогда не выходит расшифрованный мусор (fail-closed, §14).
 */
export function unwrapDbKey(wrapped: Buffer, kek: Buffer): Buffer {
  if (wrapped.length <= WRAP_IV_BYTES + WRAP_TAG_BYTES) {
    throw new PassphraseWrapIntegrityError('обёртка короче iv+tag — порча wrappedKey');
  }
  const iv = wrapped.subarray(0, WRAP_IV_BYTES);
  const tag = wrapped.subarray(wrapped.length - WRAP_TAG_BYTES);
  const ciphertext = wrapped.subarray(WRAP_IV_BYTES, wrapped.length - WRAP_TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, iv, { authTagLength: WRAP_TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new PassphraseWrapIntegrityError();
  }
}

/** Опции калибровки (§19: детерминизм — hashFn и Clock подставляются тестами). */
export interface CalibrateOptions {
  /** Бюджет одной разблокировки, мс (§15: 500). */
  readonly targetMs?: number;
  /** Хеширующая функция (по умолчанию — реальный deriveKek). */
  readonly hashFn?: Argon2HashFn;
  /** Источник замеров времени (по умолчанию SystemClock; тесты — step-часы). */
  readonly clock?: Clock;
}

/**
 * Калибровка Argon2id (§5/§15): одна пробная итерация на боевой памяти (64 МБ) →
 * iterations = бюджет / длительность итерации (границы 1..16). Вызывается однократно
 * при setPassphrase (§15); параметры сохраняются в файле vault (§5: «в файле, не в
 * коде») — эволюционируют вместе с железом пользователей.
 */
export async function calibrate(options: CalibrateOptions = {}): Promise<Argon2Params> {
  const targetMs = options.targetMs ?? ARGON2ID_TARGET_UNLOCK_MS;
  const hashFn = options.hashFn ?? deriveKek;
  const clock = options.clock ?? new SystemClock();

  const probeSalt = randomBytes(PASSPHRASE_SALT_BYTES);
  const probeParams: Argon2Params = {
    iterations: ARGON2ID_MIN_ITERATIONS,
    memoryKib: ARGON2ID_CALIBRATION_MEMORY_KIB,
    parallelism: ARGON2ID_CALIBRATION_PARALLELISM,
  };

  const startedMs = clock.nowMs();
  await hashFn('hl-calibrate', probeSalt, probeParams);
  const iterationMs = Math.max(clock.nowMs() - startedMs, 0);

  const estimated = iterationMs === 0 ? ARGON2ID_MAX_ITERATIONS : Math.round(targetMs / iterationMs);
  const iterations = Math.min(
    Math.max(estimated, ARGON2ID_MIN_ITERATIONS),
    ARGON2ID_MAX_ITERATIONS,
  );
  return {
    iterations,
    memoryKib: ARGON2ID_CALIBRATION_MEMORY_KIB,
    parallelism: ARGON2ID_CALIBRATION_PARALLELISM,
  };
}
