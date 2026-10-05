/**
 * TASK-070 §4/§5 + TASK-121 §3: контейнер копии — линейный формат (структура
 * неизменна, эволюционирует магия):
 *   `[magic][manifest-json-len uint32BE][manifest-json][iv 12б][ciphertext][auth-tag 16б]`
 *
 * Версии формата:
 *  - HLBK1 (v1, §4) — исходный формат; авто-копии hook'а пишутся им и сейчас
 *    (машиносвязны по построению, TASK-121 §3);
 *  - HLBK2 (v2, TASK-121) — пользовательские копии с переносимым ключом БД
 *    в манифесте (`dbKeyWrap`); чтение ОБЕИХ магий — совместимость старых копий.
 *
 * Разбор формата:
 *  - magic фиксирует версию формата (§7: «версия в magic»; manifest.formatVersion
 *    обязан совпадать с магией — расхождение = FormatError, писавший сломан);
 *  - iv хранится рядом с шифртекстом (не секрет; структурно формат §4 не меняет);
 *  - манифест привязан к шифрованию как AAD (§14): подмена метаданных детектируется
 *    той же GCM-проверкой, что и подмена шифртекста;
 *  - тег — последние 16 байт файла.
 *
 * Запись (§15): снапшот читается потоком → cipher → файл (50k-БД ~20 МБ — без
 * буферизации в памяти); после finish — fsync (копия = страховка пользователя,
 * потеря при краче ОС недопустима). Фабрика потока записи переопределяема
 * (§19: /dev/full-подобный мок в тестах — боевой путь fs.createWriteStream).
 *
 * Чтение (§19 roundtrip, 071): файл в память, разбор заголовков с проверками формата
 * (BackupContainerFormatError — чужая магия/битые длины), расшифровка с GCM-проверкой
 * (BackupIntegrityError — порча/чужой ключ, AC-3). Манифест валидирует zod-схемой
 * вызыватель (§7: «восстановление валидирует») — адаптер не знает схему.
 *
 * Ключи (§8): prepareKey (пароль → argon2id-запись манифеста) и contentKeyFor
 * (восстановление по записи); db-key — прямой hex ключа БД. TASK-121: wrapDbKey/
 * unwrapDbKey — обёртка/разворачивание ключа БД паролем копии (манифест v2).
 */
import { createWriteStream as fsCreateWriteStream, createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Writable, type Writable as WritableType } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  ARGON2ID_DEFAULT_PARAMS,
  BACKUP_SALT_BYTES,
  createBackupCipher,
  contentKeyFromDbKeyHex,
  decryptBackupPayload,
  deriveArgon2idKey,
  IV_BYTES,
  TAG_BYTES,
  unwrapDbKey,
  wrapDbKey,
  type Argon2Params,
} from './backup-crypto.js';
import {
  BackupContainerFormatError,
  type BackupCrypto,
  type BackupDbKeyWrap,
  type BackupKeySource,
  type BackupKdf,
  type PreparedBackupKey,
  type ReadContainerResult,
  type ReadHeaderResult,
  type WriteContainerInput,
} from '../application/ports/backup-crypto.js';

/**
 * Ошибка формата контейнера — с TASK-071 живёт в порте BackupCrypto (см. шапку
 * порта). Реэкспорт — совместимость существующих импортов.
 */
export { BackupContainerFormatError };

/** Магии формата по версиям (§4: HLBK1; TASK-121: HLBK2 — «Health Log Backup v2»). */
const BACKUP_MAGIC_V1 = Buffer.from('HLBK1', 'utf8');
const BACKUP_MAGIC_V2 = Buffer.from('HLBK2', 'utf8');
/** Обе магии одной длины (5) — смещения заголовка общие. */
const BACKUP_MAGIC_BYTES = BACKUP_MAGIC_V1.length;
/** Смещение манифеста: magic (5) + длина (4). */
const HEADER_BYTES = BACKUP_MAGIC_BYTES + 4;
/** Верхний предел манифеста (защита от битых длин, §14: форма манифеста ~ сотни байт). */
const MANIFEST_MAX_BYTES = 64 * 1024;
/** Минимальный размер контейнера: заголовок + iv + тег (+ непустой манифест). */
const MIN_CONTAINER_BYTES = HEADER_BYTES + IV_BYTES + TAG_BYTES + 2;

/**
 * Разбор заголовка (§4 + TASK-121: обе магии): magic/длины (FormatError) → версия
 * формата из магии + срезы манифеста, iv, шифртекста и тега. Разбор НЕ
 * аутентифицирует байты — GCM-проверка в readContainer (§14: сначала
 * аутентификация, потом использование).
 */
function parseHeader(file: Buffer): {
  readonly formatVersion: 1 | 2;
  readonly manifestJson: Buffer;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
} {
  const magic = file.subarray(0, BACKUP_MAGIC_BYTES);
  const formatVersion = magic.equals(BACKUP_MAGIC_V1)
    ? 1
    : magic.equals(BACKUP_MAGIC_V2)
      ? 2
      : undefined;
  if (file.length < MIN_CONTAINER_BYTES || formatVersion === undefined) {
    throw new BackupContainerFormatError(
      'контейнер копии повреждён: магия HLBK1/HLBK2 не найдена (§4/TASK-121)',
    );
  }
  const manifestLength = file.readUInt32BE(BACKUP_MAGIC_BYTES);
  const manifestStart = HEADER_BYTES;
  const ivStart = manifestStart + manifestLength;
  const ciphertextStart = ivStart + IV_BYTES;
  const tagStart = file.length - TAG_BYTES;
  if (manifestLength < 2 || manifestLength > MANIFEST_MAX_BYTES || ciphertextStart > tagStart) {
    throw new BackupContainerFormatError(
      'контейнер копии повреждён: длины заголовка не сходятся (§4)',
    );
  }
  return {
    formatVersion,
    manifestJson: file.subarray(manifestStart, ivStart),
    iv: file.subarray(ivStart, ciphertextStart),
    ciphertext: file.subarray(ciphertextStart, tagStart),
    tag: file.subarray(tagStart),
  };
}

/**
 * Гард «магия = formatVersion манифеста» (TASK-121): расхождение — FormatError
 * (писавший сломан / файл склеен из частей). Манифест здесь НЕ доверенный —
 * проверяется только целочисленное поле версии (мусор → FormatError как не-JSON).
 */
function assertMagicMatchesManifest(formatVersion: 1 | 2, manifest: unknown): void {
  const manifestVersion =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as { formatVersion?: unknown }).formatVersion
      : undefined;
  if (manifestVersion !== formatVersion) {
    throw new BackupContainerFormatError(
      `контейнер копии повреждён: магия v${formatVersion} не совпадает с formatVersion манифеста (§4/TASK-121)`,
    );
  }
}

/** Опции кодека (точка сборки; §14: параметры Argon2id переопределяются калибровкой 093). */
export interface BackupContainerCodecOptions {
  /** Параметры Argon2id для НОВЫХ парольных копий; по умолчанию — база TASK-093. */
  readonly argon2Params?: Argon2Params;
  /** Фабрика потока записи (§19: мок исчерпания диска); по умолчанию fs.createWriteStream. */
  readonly createWriteStream?: (path: string) => WritableType;
}

/**
 * Кодек контейнера копии — реализация порта BackupCrypto (§5/арх. 02 §3.5).
 * Без состояния: один экземпляр на приложение (контейнер TASK-027).
 */
export class BackupContainerCodec implements BackupCrypto {
  private readonly argon2Params: Argon2Params;
  private readonly createWriteStream: (path: string) => WritableType;

  constructor(options: BackupContainerCodecOptions = {}) {
    this.argon2Params = options.argon2Params ?? ARGON2ID_DEFAULT_PARAMS;
    this.createWriteStream = options.createWriteStream ?? fsCreateWriteStream;
  }

  /** §8: пароль → соль + derive + запись kdf; dbKey → прямой ключ (без KDF). */
  async prepareKey(source: BackupKeySource): Promise<PreparedBackupKey> {
    if (source.kind === 'dbKey') {
      return { kdf: { id: 'db-key' }, contentKey: contentKeyFromDbKeyHex(source.keyHex) };
    }
    const salt = randomSalt();
    const contentKey = await deriveArgon2idKey(source.passphrase, salt, this.argon2Params);
    return {
      kdf: {
        id: 'argon2id',
        saltB64: salt.toString('base64'),
        iterations: this.argon2Params.iterations,
        memoryKib: this.argon2Params.memoryKib,
        parallelism: this.argon2Params.parallelism,
      },
      contentKey,
    };
  }

  /** Восстановление ключа по записи манифеста (путь 071); рассинхрон вида — TypeError. */
  async contentKeyFor(kdf: BackupKdf, source: BackupKeySource): Promise<Buffer> {
    if (kdf.id === 'db-key') {
      if (source.kind !== 'dbKey') {
        throw new TypeError(
          "contentKeyFor: запись kdf db-key требует источник dbKey (авто-копия hook'а, TASK-070 §8)",
        );
      }
      return contentKeyFromDbKeyHex(source.keyHex);
    }
    if (source.kind !== 'passphrase') {
      throw new TypeError(
        'contentKeyFor: запись kdf argon2id требует источник passphrase (§8: пользовательская копия)',
      );
    }
    const salt = Buffer.from(kdf.saltB64, 'base64');
    return deriveArgon2idKey(source.passphrase, salt, {
      iterations: kdf.iterations,
      memoryKib: kdf.memoryKib,
      parallelism: kdf.parallelism,
    });
  }

  /**
   * Пишет контейнер (§4 + TASK-121): заголовок (magic по formatVersion/len/manifest/iv)
   * → pipeline снапшота через GCM → тег → fsync. По ошибке все потоки уничтожаются
   * pipeline'ом; частичный файл удаляет вызыватель (use case: cleanup в finally, §9).
   */
  async writeContainer(input: WriteContainerInput): Promise<{ sizeBytes: number }> {
    const magic = input.formatVersion === 2 ? BACKUP_MAGIC_V2 : BACKUP_MAGIC_V1;
    const cipher = createBackupCipher(input.contentKey, input.manifestJson);
    const out = this.createWriteStream(input.destinationPath);

    out.write(magic);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(input.manifestJson.length);
    out.write(length);
    out.write(input.manifestJson);
    out.write(cipher.iv);

    // Тег известен только после end шифртекста: sink пишет поток GCM, в final —
    // тег и end файла (порядок формата §4: ciphertext затем tag).
    const tagSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (out.write(chunk)) {
          cb();
        } else {
          out.once('drain', cb);
        }
      },
      final(cb) {
        let tag: Buffer;
        try {
          tag = cipher.authTag();
        } catch (error) {
          cb(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        out.write(tag);
        out.end(() => cb());
      },
    });
    out.on('error', (error) => {
      tagSink.destroy(error);
    });

    await pipeline(createReadStream(input.snapshotPath), cipher.transform, tagSink);
    await once(out, 'close');

    // Долговечность (§8-семантика страховки): байты на диске до возврата успеха.
    const handle = await open(input.destinationPath, 'r+');
    let sizeBytes: number;
    try {
      await handle.sync();
      sizeBytes = (await handle.stat()).size;
    } finally {
      await handle.close();
    }
    return { sizeBytes };
  }

  /**
   * Читает контейнер (§4): формат-проверки → расшифровка с AAD-привязкой манифеста.
   * Ошибка GCM → BackupIntegrityError (§14/AC-3), формат → BackupContainerFormatError.
   */
  async readContainer(input: {
    containerPath: string;
    contentKey: Buffer;
  }): Promise<ReadContainerResult> {
    const header = parseHeader(await readFile(input.containerPath));

    // ПОРЯДОК (§14): сначала аутентификация (манифест — AAD), потом разбор JSON —
    // ЛЮБАЯ подмена манифеста даёт BackupIntegrityError (необработанный
    // атакующим контент не разбирается); не-JSON после успешной аутентификации
    // означал бы ошибку писавшего — FormatError (патологический случай).
    const payload = decryptBackupPayload({
      contentKey: input.contentKey,
      iv: header.iv,
      aad: header.manifestJson,
      tag: header.tag,
      ciphertext: header.ciphertext,
    });

    let manifest: unknown;
    try {
      manifest = JSON.parse(header.manifestJson.toString('utf8'));
    } catch (error) {
      throw new BackupContainerFormatError('манифест контейнера не является JSON (§7)', {
        cause: error,
      });
    }
    assertMagicMatchesManifest(header.formatVersion, manifest);

    return {
      manifest: manifest as ReadContainerResult['manifest'],
      manifestJson: header.manifestJson,
      payload,
    };
  }

  /**
   * Читает заголовок БЕЗ расшифровки (TASK-071 §5): формат-проверки (FormatError),
   * разбор JSON манифеста — БЕЗ GCM (см. контракт порта: манифест не доверенный
   * до readContainer; вызыватель валидирует zod и использует только запись kdf).
   */
  async readHeader(input: { containerPath: string }): Promise<ReadHeaderResult> {
    const { formatVersion, manifestJson } = parseHeader(await readFile(input.containerPath));
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestJson.toString('utf8'));
    } catch (error) {
      throw new BackupContainerFormatError('манифест контейнера не является JSON (§7)', {
        cause: error,
      });
    }
    assertMagicMatchesManifest(formatVersion, manifest);
    return { manifest: manifest as ReadHeaderResult['manifest'], manifestJson };
  }

  /** TASK-121 §3: обёртка ключа БД паролем — примитивы backup-crypto (TASK-093 §2). */
  wrapDbKey(input: { keyHex: string; passphrase: string }): Promise<BackupDbKeyWrap> {
    return wrapDbKey(input.keyHex, input.passphrase, this.argon2Params);
  }

  /** TASK-121 §3: разворачивание ключа БД из записи манифеста (см. порт). */
  unwrapDbKey(input: { wrap: BackupDbKeyWrap; passphrase: string }): Promise<string> {
    return unwrapDbKey(input.wrap, input.passphrase);
  }
}

/** Свежая соль Argon2id (16 байт). */
function randomSalt(): Buffer {
  return randomBytes(BACKUP_SALT_BYTES);
}
