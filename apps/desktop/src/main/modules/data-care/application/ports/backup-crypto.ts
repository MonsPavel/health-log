/**
 * TASK-070 §5/арх. 02 §3.5: порт BackupCrypto — криптоконтейнер копии (application
 * владеет интерфейсом, реализация — adapters/backup-container.ts, механика —
 * adapters/backup-crypto.ts).
 *
 * Два вида ключа содержимого (§8 — РЕШЕНИЕ, см. contracts/data-care/schemas.ts):
 *  - {kind: 'passphrase'} — пользовательская копия: ключ = Argon2id(пароль, соль,
 *    параметры записи kdf) — машина-независимо;
 *  - {kind: 'dbKey'} — авто-копия без диалога (hook миграций, §5/§9): ключ = ключ
 *    БД — машиносвязно (откат миграции на той же машине).
 *
 * Соглашения (прецедент порта KeyVault TASK-023): Promise-методы; нарушение
 * контракта вызова — TypeError в точке вызова (dev-контракт); типы манифеста —
 * контракт @hl/contracts (type-only, арх. 03 §4).
 */
import type { BackupKdf, BackupManifest } from '@hl/contracts';

/** Контрактные формы манифеста — реэкспорт порта (адаптеры типы берут через порт,
 * прецедент notes-search: adapters → contracts напрямую запрещён матрицей арх. 03 §4). */
export type { BackupKdf, BackupManifest };

/** Источник ключа содержимого копии (§8). */
export type BackupKeySource =
  | { readonly kind: 'passphrase'; readonly passphrase: string }
  | { readonly kind: 'dbKey'; readonly keyHex: string };

/** Подготовленный ключ: запись KDF для манифеста + 32-байтный ключ содержимого. */
export interface PreparedBackupKey {
  /** Запись KDF (contract): {id:'db-key'} | {id:'argon2id', соль, параметры}. */
  readonly kdf: BackupKdf;
  /** Ключ содержимого AES-256: 32 байта. */
  readonly contentKey: Buffer;
}

/** Вход записи контейнера (§4): манифест-байты (AAD) + ключ + снапшот → файл. */
export interface WriteContainerInput {
  /** Точные байты манифеста (JSON, UTF-8) — пишутся в заголовок и привязываются как AAD. */
  readonly manifestJson: Buffer;
  /** Ключ содержимого (32 байта) — из prepareKey. */
  readonly contentKey: Buffer;
  /** Путь файла-снапшота (VACUUM INTO) — читается потоком. */
  readonly snapshotPath: string;
  /** Путь записи контейнера. */
  readonly destinationPath: string;
}

/** Результат чтения контейнера (§19: roundtrip; восстановление — 071). */
export interface ReadContainerResult {
  /** Манифест, разобранный из заголовка (валидацию zod выполняет вызыватель — §7). */
  readonly manifest: BackupManifest;
  /** Точные байты манифеста из контейнера (привязаны GCM как AAD). */
  readonly manifestJson: Buffer;
  /** Расшифрованная полезная нагрузка — байты снапшота БД. */
  readonly payload: Buffer;
}

/** Порт криптоконтейнера копии (арх. 02 §3.5). Реализация — BackupContainerCodec. */
export interface BackupCrypto {
  /**
   * Готовит ключ содержимого для НОВОЙ копии: генерирует соль (для argon2id),
   * выводит ключ, возвращает запись KDF для манифеста (§8).
   */
  prepareKey(source: BackupKeySource): Promise<PreparedBackupKey>;

  /**
   * Восстанавливает ключ содержимого ПО записи манифеста (путь восстановления —
   * 071/101): argon2id → derive(пароль, соль записи); db-key → байты ключа БД.
   * Вид источника не соответствует записи kdf → TypeError (dev-контракт).
   */
  contentKeyFor(kdf: BackupKdf, source: BackupKeySource): Promise<Buffer>;

  /**
   * Пишет контейнер формата HLBK1 (§4): [magic][len][manifest][iv][ciphertext][tag].
   * Возвращает полный размер файла (§18: sizeBytes). Ошибка записи (например,
   * исчерпание диска) — наружу как есть: use case маппит в BACKUP/FAILED (§13).
   */
  writeContainer(input: WriteContainerInput): Promise<{ sizeBytes: number }>;

  /**
   * Читает и расшифровывает контейнер (§4): magic/длины (BackupContainerFormatError),
   * GCM-проверка манифеста+шифртекста (BackupIntegrityError — порча/чужой ключ).
   * Снапшот целиком в памяти (§15: ~20 МБ); потоковая версия — 071 при потребности.
   */
  readContainer(input: { containerPath: string; contentKey: Buffer }): Promise<ReadContainerResult>;
}
