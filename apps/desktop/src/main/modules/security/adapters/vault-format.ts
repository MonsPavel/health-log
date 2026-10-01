/**
 * TASK-093 §5: формат файла vault.key v2 — `{v: 2, mode: 'safeStorage'|'passphrase',
 * saltB64?, argonParams?, wrappedKeyB64, createdUtc}` — и миграция v1→v2 при старте.
 *
 * Поля:
 *  - mode='safeStorage' — обёртка DPAPI/Keychain (TASK-023 как есть; wrappedKeyB64 —
 *    тот же blob, что v1.wrapped); поля saltB64/argonParams обязаны ОТСУТСТВОВАТЬ
 *    (противоречие схемы — файл повреждён, §13);
 *  - mode='passphrase' — двойная обёртка (§2): wrappedKeyB64 = base64(iv||ct||tag)
 *    AES-256-GCM(dbKey, KEK), KEK = Argon2id(passphrase, salt, argonParams); saltB64
 *    и argonParams обязательны. Параметры — В ФАЙЛЕ, не в коде (§14: эволюционируют,
 *    значение даёт calibrate §15).
 *  - verifier — НЕ отдельное поле (§5 — РЕШЕНИЕ): verifier = auth-tag GCM внутри
 *    wrappedKeyB64, проверка только после полного derive KEK; быстрого обхода
 *    Argon2id нет. Поле `verifier?` из §5 остаётся зарезервированным и не пишется.
 *
 * Downgrade v2→v1 запрещён (§13): сериализация пишет только v2; v1-ридер (старая
 * версия приложения) видит v2-файл как повреждённый — обратной записи в v1 нет.
 *
 * Зоны (арх. 03 §4): чистые функции над строкой файла — без IO; чтение/запись и
 * Result-семантика — в адаптере SafeStorageKeyVault (парсинг → undefined →
 * VAULT/KEY_CORRUPT, прецедент parseVaultFile TASK-023).
 */
import {
  ARGON2_MIN_SALT_BYTES,
  WRAP_IV_BYTES,
  WRAP_TAG_BYTES,
  type Argon2Params,
} from './passphrase-crypto.js';

/** Режим обёртки ключа в файле (§5). */
export type VaultMode = 'safeStorage' | 'passphrase';

/** Актуальная версия формата файла ключа (§5: v = 2). */
export const VAULT_FORMAT_VERSION = 2;

/** Общая часть файла vault.key v2 (§5). */
interface VaultKeyFileV2Base {
  readonly v: 2;
  /** Обёртка ключа: base64(iv||ct||tag) в passphrase-режиме, blob safeStorage — в safeStorage. */
  readonly wrappedKeyB64: string;
  /** Момент создания ключа, мс эпохи Unix (наследовано v1; резервные копии §7). */
  readonly createdUtc: number;
}

/** Файл v2, mode='safeStorage': поля парольной обёртки отсутствуют (противоречие схемы). */
export interface SafeStorageVaultFile extends VaultKeyFileV2Base {
  readonly mode: 'safeStorage';
}

/** Файл v2, mode='passphrase': соль и параметры Argon2id обязательны (§5). */
export interface PassphraseVaultFile extends VaultKeyFileV2Base {
  readonly mode: 'passphrase';
  /** Соль Argon2id (base64). */
  readonly saltB64: string;
  /** Параметры Argon2id — в файле, не в коде (§14). */
  readonly argonParams: Argon2Params;
}

/** Валидированное содержимое файла vault.key v2 (§5) — дисриминация по mode. */
export type VaultKeyFileV2 = SafeStorageVaultFile | PassphraseVaultFile;

/** Легаси-содержимое файла v1 (TASK-023 §5) — только вход миграции. */
export interface VaultKeyFileV1 {
  readonly wrapped: string;
  readonly createdUtc: number;
}

/** Границы валидации параметров Argon2id из файла (§13: порча → KEY_CORRUPT, не OOM). */
const PARAM_BOUNDS = {
  iterations: [1, 1024],
  memoryKib: [8, 4_194_304], // 8 КиБ .. 4 ГиБ
  parallelism: [1, 1024],
} as const;

/** Минимальная длина расшифрованной обёртки (байты): не пусто и не мусор. */
const MIN_WRAPPED_BYTES = 8;

/** true — строка канонический base64 (Buffer игнорирует чужие символы — roundtrip). */
function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length >= MIN_WRAPPED_BYTES && decoded.toString('base64') === value;
}

/** Длина расшифрованного base64 в байтах (вызов — после isCanonicalBase64). */
function base64ByteLength(value: string): number {
  return Buffer.from(value, 'base64').length;
}

/** true — целое в границах [min, max]. */
function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Валидация блока argonParams (границы §13 — защита от OOM при порче файла). */
function parseArgonParams(value: unknown): Argon2Params | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const params = value as Record<string, unknown>;
  const [minIt, maxIt] = PARAM_BOUNDS.iterations;
  const [minMem, maxMem] = PARAM_BOUNDS.memoryKib;
  const [minPar, maxPar] = PARAM_BOUNDS.parallelism;
  if (
    !isIntInRange(params.iterations, minIt, maxIt) ||
    !isIntInRange(params.memoryKib, minMem, maxMem) ||
    !isIntInRange(params.parallelism, minPar, maxPar)
  ) {
    return undefined;
  }
  return {
    iterations: params.iterations,
    memoryKib: params.memoryKib,
    parallelism: params.parallelism,
  };
}

/** Общая проверка полей v/createdUtc (схемы v1/v2). */
function checkCommon(
  file: Record<string, unknown>,
  version: number,
): file is Record<string, unknown> & { createdUtc: number } {
  return (
    file.v === version && typeof file.createdUtc === 'number' && Number.isFinite(file.createdUtc)
  );
}

/**
 * Разбор и валидация файла формата v2 (§5). Любое отклонение схемы — undefined
 * (адаптер маппит в VAULT/KEY_CORRUPT, §13: «файл есть и валиден» — иначе повреждён).
 */
export function parseV2(raw: string): VaultKeyFileV2 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const file = parsed as Record<string, unknown>;
  if (!checkCommon(file, VAULT_FORMAT_VERSION)) {
    return undefined;
  }
  if (file.mode !== 'safeStorage' && file.mode !== 'passphrase') {
    return undefined;
  }
  if (!isCanonicalBase64(file.wrappedKeyB64)) {
    return undefined;
  }
  if (file.mode === 'passphrase') {
    // §13 «порча wrapped»: парольная обёртка не бывает короче iv||ct||tag даже
    // с пустым ct (12+16+1 байт) — обрезка ловится здесь, а не при разворачивании.
    if (base64ByteLength(file.wrappedKeyB64) < WRAP_IV_BYTES + WRAP_TAG_BYTES + 1) {
      return undefined;
    }
    if (
      !isCanonicalBase64(file.saltB64) ||
      base64ByteLength(file.saltB64) < ARGON2_MIN_SALT_BYTES
    ) {
      return undefined;
    }
    const argonParams = parseArgonParams(file.argonParams);
    if (argonParams === undefined) {
      return undefined;
    }
    const passphraseFile: PassphraseVaultFile = {
      v: 2,
      mode: 'passphrase',
      wrappedKeyB64: file.wrappedKeyB64,
      createdUtc: file.createdUtc,
      saltB64: file.saltB64,
      argonParams,
    };
    return passphraseFile;
  }
  // mode='safeStorage': поля парольной обёртки обязаны отсутствовать (противоречие схемы).
  if (file.saltB64 !== undefined || file.argonParams !== undefined) {
    return undefined;
  }
  const safeStorageFile: SafeStorageVaultFile = {
    v: 2,
    mode: 'safeStorage',
    wrappedKeyB64: file.wrappedKeyB64,
    createdUtc: file.createdUtc,
  };
  return safeStorageFile;
}

/**
 * Разбор легаси-схемы v1 (TASK-023 §5): `{v: 1, wrapped: non-empty base64,
 * createdUtc: finite}` — единственный вход миграции v1→v2.
 */
export function parseV1(raw: string): VaultKeyFileV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const file = parsed as Record<string, unknown>;
  if (!checkCommon(file, 1)) {
    return undefined;
  }
  if (!isCanonicalBase64(file.wrapped)) {
    return undefined;
  }
  return { wrapped: file.wrapped, createdUtc: file.createdUtc };
}

/**
 * Переупаковка v1→v2 (§5): та же safeStorage-обёртка и createdUtc, mode='safeStorage'
 * — ключ НЕ перекрыт (data сохраняется), меняется только носитель формата.
 */
export function migrateV1ToV2(legacy: VaultKeyFileV1): VaultKeyFileV2 {
  return {
    v: VAULT_FORMAT_VERSION,
    mode: 'safeStorage',
    wrappedKeyB64: legacy.wrapped,
    createdUtc: legacy.createdUtc,
  };
}

/** Сериализация файла v2 (единственная форма записи — downgrade v2→v1 запрещён, §13). */
export function serializeV2(file: VaultKeyFileV2): string {
  return JSON.stringify(file);
}
