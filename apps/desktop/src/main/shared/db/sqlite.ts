/**
 * TASK-022 §6/§7: обёртка открытия зашифрованной БД — ЕДИНСТВЕННАЯ точка открытия
 * базы в проекте (используется контейнером, TASK-027; better-sqlite3 синхронный —
 * принято, арх. 03 §6, TD-1).
 *
 * Стек (§4, ADR-0002): better-sqlite3-multiple-ciphers — community-пресет better-sqlite3
 * с SQLCipher-совместимым шифрованием (SQLite3MultipleCiphers, режим `cipher='sqlcipher'`):
 * npm-пакет с prebuilt-бинарниками (Node-API v13 — один бинарник для node и Electron),
 * пересборка не требуется, fallback electron-rebuild — в scripts/prepare-native.sh.
 *
 * Порядок прагм (важен):
 *   1. `cipher = 'sqlcipher'` — ДО key: SQLCipher-совместимый формат и дефолты
 *      SQLCipher 4 (§5: «PRAGMA cipher_* дефолтами»);
 *   2. `key = "x'<hex>'"` — raw-ключ 32 байта, KDF не применяется (ключ и так
 *      случайный, §6 арх. 04; строка прагмы никогда не логируется, §14);
 *   3. `quick_check` — проверочное чтение первой страницы (§13): неверный ключ и
 *      чужой файл дают SQLITE_NOTADB ещё на открытии, а не крипто-мусор при первом
 *      запросе; заодно детект повреждения при старте (полный сценарий — TASK-100/101);
 *   4. `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL` (§8: баланс
 *      durability/скорости — WAL+NORMAL переживает краш процесса; решение в ADR-0002).
 *
 * Ошибки (§7/§13): маппинг кодов SQLite в STORAGE/* — наружу только AppError,
 * оригинальная ошибка остаётся в cause (память main, §14):
 *   SQLITE_NOTADB            → STORAGE/BAD_KEY  (неверный/отсутствующий ключ);
 *   SQLITE_BUSY/SQLITE_LOCKED→ STORAGE/LOCKED   (файл занят другим процессом;
 *                         защита — single-instance TASK-012, здесь только код);
 *   quick_check ≠ 'ok'       → STORAGE/CORRUPT;
 *   остальное                → APP/INTERNAL (детали в cause для логов).
 *
 * Ключ (§14): валидируется ДО обращения к файлу (dev-контракт: TypeError в точке
 * вызова, прецедент §20 — скоуп profileId TASK-021); JS-гарантий обнуления строки
 * нет — документировано в ADR-0002; redact-список логгера дополняют keyHex/key.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- локальные типы better-sqlite3-multiple-ciphers (exports-map v13.0.3 без types, см. шим §6): path-reference добавляет d.ts в программы обоих tsconfig-проектов без правок конфигов; directive обязан стоять в самом верху файла
/// <reference path="./better-sqlite3-multiple-ciphers.d.ts" />
import Database from 'better-sqlite3-multiple-ciphers';

import { AppError } from '@hl/kernel';

import { createLogger } from '../logger/logger.js';

/** Тип открытого соединения (экземпляр конструктора модуля). */
export type EncryptedDatabase = InstanceType<typeof Database>;

/** Ключи i18n-каталога по конвенции арх. 05 §29 (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`); тексты — TASK-101. */
export const STORAGE_BAD_KEY_MESSAGE_KEY = 'errors.STORAGE_BAD_KEY';
export const STORAGE_LOCKED_MESSAGE_KEY = 'errors.STORAGE_LOCKED';
export const STORAGE_CORRUPT_MESSAGE_KEY = 'errors.STORAGE_CORRUPT';

/** Ключ APP/INTERNAL из контракта каркаса (contracts, app-error-dto.ts TASK-008). */
const APP_INTERNAL_MESSAGE_KEY = 'errors.internal';

/** §7: ключ — ровно 64 hex-символа (32 байта). */
const KEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Логгер категории db (§18): событие открытия БД — факт без пути и ключа. */
const dbLog = createLogger('db');

/**
 * Валидация ключа (§7): hex 64 символа. Нарушение — программная ошибка: синхронный
 * throw TypeError в точке вызова ДО открытия файла (файл не создаётся).
 */
function assertKeyHex(keyHex: string): string {
  if (typeof keyHex !== 'string' || !KEY_HEX_PATTERN.test(keyHex)) {
    throw new TypeError(
      'openEncrypted: keyHex должен быть строкой из 64 hex-символов (32 байта) — нарушение контракта обёртки является программной ошибкой (TASK-022 §7)',
    );
  }
  return keyHex.toLowerCase();
}

/** Код ошибки SQLite на SqliteError (better-sqlite3); у прочих ошибок кода нет. */
function sqliteErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Маппинг ошибки открытия в AppError (§7/§13 — наружу только коды, детали в cause). */
function mapOpenError(error: unknown): AppError {
  switch (sqliteErrorCode(error)) {
    case 'SQLITE_NOTADB':
      return AppError.of('STORAGE/BAD_KEY', STORAGE_BAD_KEY_MESSAGE_KEY, undefined, error);
    case 'SQLITE_BUSY':
    case 'SQLITE_LOCKED':
      return AppError.of('STORAGE/LOCKED', STORAGE_LOCKED_MESSAGE_KEY, undefined, error);
    default:
      return AppError.of('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, error);
  }
}

/**
 * Открывает зашифрованную БД (§7): `new Database(path)` → `PRAGMA key` → проверка
 * ключа/целостности → прагмы окружения (§8). Единственная точка открытия БД проекта.
 *
 * При любой ошибке соединение закрывается перед пробросом AppError — открытый
 * дескриптор не должен переживать неудачное открытие (Windows: файл остаётся
 * заблокированным для удаления).
 */
export function openEncrypted(path: string, keyHex: string): EncryptedDatabase {
  const normalizedKeyHex = assertKeyHex(keyHex);
  const db = new Database(path);
  try {
    // SQLCipher-совместимый шифр — строго ДО key (SQLite3MultipleCiphers, §5).
    db.pragma("cipher = 'sqlcipher'");
    // Raw-ключ hex: KDF не применяется (ключ случайный 32 байта). Не логируется (§14).
    db.pragma(`key = "x'${normalizedKeyHex}'"`);
    // Проверочное чтение первой страницы (§13): неверный ключ → SQLITE_NOTADB;
    // чужая блокировка → SQLITE_BUSY; повреждение → non-'ok' отчёт без исключения.
    const quickCheck = db.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') {
      // Контракт §7: обёртка сигнализирует ошибкой типа AppError (не Error) —
      // как хендлеры каркаса (прецедент register-channel.test.ts §13 п. 3);
      // правилу only-throw-error это объяснено здесь.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw AppError.of(
        'STORAGE/CORRUPT',
        STORAGE_CORRUPT_MESSAGE_KEY,
        undefined,
        `PRAGMA quick_check: ${String(quickCheck)}`,
      );
    }
    // Прагмы окружения (§8). WAL обязателен (§15: без него вставки в 10+ раз медленнее).
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    // §18: только факт открытия, без пути (каталог может содержать имя пользователя) и ключа.
    dbLog.info('db opened', { cipher: 'on' });
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // соединение уже закрыто — при пробросе ошибки это не важно
    }
    if (error instanceof AppError) {
      // Контракт §7: наружу — AppError (см. пояснение к only-throw-error выше).
      throw error;
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw mapOpenError(error);
  }
}
