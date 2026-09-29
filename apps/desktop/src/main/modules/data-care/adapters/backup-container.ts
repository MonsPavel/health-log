/**
 * TASK-070 §4/§5: контейнер копии — линейный формат HLBK1:
 *   `[magic 'HLBK1'][manifest-json-len uint32BE][manifest-json][iv 12б][ciphertext][auth-tag 16б]`
 *
 * Разбор формата:
 *  - magic фиксирует версию формата (§7: «версия в magic»; manifest.formatVersion = 1);
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
 * (восстановление по записи); db-key — прямой hex ключа БД.
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
  type Argon2Params,
} from './backup-crypto.js';
import type {
  BackupCrypto,
  BackupKeySource,
  BackupKdf,
  PreparedBackupKey,
  ReadContainerResult,
  WriteContainerInput,
} from '../application/ports/backup-crypto.js';

/** Магия формата (§4: HLBK1 — «Health Log Backup v1»). */
const BACKUP_MAGIC = Buffer.from('HLBK1', 'utf8');
/** Смещение манифеста: magic (5) + длина (4). */
const HEADER_BYTES = BACKUP_MAGIC.length + 4;
/** Верхний предел манифеста (защита от битых длин, §14: форма манифеста ~ сотни байт). */
const MANIFEST_MAX_BYTES = 64 * 1024;
/** Минимальный размер контейнера: заголовок + iv + тег (+ непустой манифест). */
const MIN_CONTAINER_BYTES = HEADER_BYTES + IV_BYTES + TAG_BYTES + 2;

/** Ошибка формата контейнера (не крипто): чужая магия, битые длины, не-JSON манифест. */
export class BackupContainerFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BackupContainerFormatError';
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
   * Пишет контейнер (§4): заголовок (magic/len/manifest/iv) → pipeline снапшота через
   * GCM → тег → fsync. По ошибке все потоки уничтожаются pipeline'ом; частичный файл
   * удаляет вызыватель (use case: cleanup в finally, §9).
   */
  async writeContainer(input: WriteContainerInput): Promise<{ sizeBytes: number }> {
    const cipher = createBackupCipher(input.contentKey, input.manifestJson);
    const out = this.createWriteStream(input.destinationPath);

    out.write(BACKUP_MAGIC);
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
    const file = await readFile(input.containerPath);
    if (
      file.length < MIN_CONTAINER_BYTES ||
      !file.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)
    ) {
      throw new BackupContainerFormatError(
        'контейнер копии повреждён: магия HLBK1 не найдена (§4)',
      );
    }
    const manifestLength = file.readUInt32BE(BACKUP_MAGIC.length);
    const manifestStart = HEADER_BYTES;
    const ivStart = manifestStart + manifestLength;
    const ciphertextStart = ivStart + IV_BYTES;
    const tagStart = file.length - TAG_BYTES;
    if (manifestLength < 2 || manifestLength > MANIFEST_MAX_BYTES || ciphertextStart > tagStart) {
      throw new BackupContainerFormatError(
        'контейнер копии повреждён: длины заголовка не сходятся (§4)',
      );
    }

    const manifestJson = file.subarray(manifestStart, ivStart);
    const iv = file.subarray(ivStart, ciphertextStart);
    const tag = file.subarray(tagStart);
    const ciphertext = file.subarray(ciphertextStart, tagStart);

    // ПОРЯДОК (§14): сначала аутентификация (манифест — AAD), потом разбор JSON —
    // ЛЮБАЯ подмена манифеста даёт BackupIntegrityError (необработанный
    // атакующим контент не разбирается); не-JSON после успешной аутентификации
    // означал бы ошибку писавшего — FormatError (патологический случай).
    const payload = decryptBackupPayload({
      contentKey: input.contentKey,
      iv,
      aad: manifestJson,
      tag,
      ciphertext,
    });

    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestJson.toString('utf8'));
    } catch (error) {
      throw new BackupContainerFormatError('манифест контейнера не является JSON (§7)', {
        cause: error,
      });
    }

    return { manifest: manifest as ReadContainerResult['manifest'], manifestJson, payload };
  }
}

/** Свежая соль Argon2id (16 байт). */
function randomSalt(): Buffer {
  return randomBytes(BACKUP_SALT_BYTES);
}
