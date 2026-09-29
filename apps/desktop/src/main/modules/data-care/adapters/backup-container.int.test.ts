/**
 * TASK-070 §19/§20: интеграционные тесты контейнера копии (формат HLBK1) — tmp-файлы.
 *
 * Формат (§4): `[magic 'HLBK1'][len uint32BE][manifest-json][iv 12б][ciphertext][tag 16б]`;
 * манифест привязан к шифрованию как AAD (§14).
 *
 * Матрица:
 *  - writeContainer: файл начинается с магии; длина манифеста в заголовке совпадает;
 *    sizeBytes = полный размер файла; снапшот не читается во время записи
 *    (консистентный файл-источник);
 *  - readContainer roundtrip: payload = байты снапшота; манифест-байты без изменений;
 *  - целостность (AC-3): подмена байта шифртекста / манифеста → BackupIntegrityError;
 *  - формат: чужая магия и обрезанный файл → BackupContainerFormatError (не краш);
 *  - prepareKey/contentKeyFor: пароль → запись kdf argon2id (детерминированный вывод
 *    того же ключа по записи манифеста — путь восстановления 071); db-key → ключ БД;
 *    нарушение контракта hex — TypeError;
 *  - readHeader (071 §5): заголовок без расшифровки — байты манифеста для выбора
 *    записи kdf; чужая магия/не-JSON — BackupContainerFormatError.
 *
 * Файлы в tmp ОС, удаляются в afterAll (§14); ключи генерируются в тесте.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { BackupContainerFormatError, BackupContainerCodec } from './backup-container.js';
import { BackupIntegrityError } from './backup-crypto.js';

/** Тестовые параметры Argon2id: минимальные (скорость набора; боевые — в адаптере). */
const TEST_PARAMS = { iterations: 1, memoryKib: 64, parallelism: 1 } as const;

/** Каталог этой сессии — удаляется в afterAll (§14). */
let dir: string;
const newDir = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'hl-backup-container-int-'));
  return dir;
};

afterAll(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Кодек с тестовыми параметрами Argon2id (§14: параметры — конфигурация точки сборки). */
const newCodec = () => new BackupContainerCodec({ argon2Params: TEST_PARAMS });

/** Манифест-пример с kdf=argon2id (форма контракта BACKUP_MANIFEST_SCHEMA). */
const manifest = {
  formatVersion: 1,
  schemaVersion: 4,
  appVersion: '0.0.0',
  createdAtUtc: 1_758_816_000_000,
  counts: { measurements: 2 },
  dbSha256: 'a'.repeat(64),
  kdf: { id: 'db-key' },
} as const;

/** Файл-«снапшот» с псевдослучайными байтами (нестрогая длина — формат произвольный). */
const writeSnapshot = (path: string, bytes = 5120): void => {
  writeFileSync(path, randomBytes(bytes));
};

describe('BackupContainerCodec.writeContainer / readContainer (§4: формат HLBK1)', () => {
  it('запись: магия HLBK1, длина манифеста в заголовке, sizeBytes = размер файла', async () => {
    const base = newDir();
    const snapshotPath = join(base, 'snapshot.db');
    writeSnapshot(snapshotPath, 5120);
    const destinationPath = join(base, 'out.hlbackup');
    const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');

    const codec = newCodec();
    const { sizeBytes } = await codec.writeContainer({
      manifestJson,
      contentKey: randomBytes(32),
      snapshotPath,
      destinationPath,
    });

    const file = readFileSync(destinationPath);
    expect(file.subarray(0, 5).toString('latin1')).toBe('HLBK1');
    expect(file.readUInt32BE(5)).toBe(manifestJson.length);
    expect(sizeBytes).toBe(file.length);
    // Полная структура: 5 (magic) + 4 (len) + manifest + 12 (iv) + снапшот + 16 (tag).
    expect(file.length).toBe(5 + 4 + manifestJson.length + 12 + 5120 + 16);
  });

  it('roundtrip: payload = байты снапшота, манифест-байты без изменений (AC-1 база)', async () => {
    const base = newDir();
    const snapshotBytes = randomBytes(4096);
    const snapshotPath = join(base, 'snapshot.db');
    writeFileSync(snapshotPath, snapshotBytes);
    const destinationPath = join(base, 'out.hlbackup');
    const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
    const contentKey = randomBytes(32);

    const codec = newCodec();
    await codec.writeContainer({ manifestJson, contentKey, snapshotPath, destinationPath });

    const read = await codec.readContainer({ containerPath: destinationPath, contentKey });
    expect(read.payload.equals(snapshotBytes)).toBe(true);
    expect(read.manifestJson.equals(manifestJson)).toBe(true);
    expect(read.manifest).toEqual(manifest);
  });

  it('подмена байта шифртекста → BackupIntegrityError, не мусор (AC-3)', async () => {
    const base = newDir();
    const snapshotPath = join(base, 'snapshot.db');
    writeSnapshot(snapshotPath, 2048);
    const destinationPath = join(base, 'tampered.hlbackup');
    const contentKey = randomBytes(32);

    const codec = newCodec();
    await codec.writeContainer({
      manifestJson: Buffer.from(JSON.stringify(manifest), 'utf8'),
      contentKey,
      snapshotPath,
      destinationPath,
    });

    const file = readFileSync(destinationPath);
    file[5 + 4 + Buffer.byteLength(JSON.stringify(manifest)) + 12] ^= 0xff; // первый байт шифртекста
    writeFileSync(destinationPath, file);

    await expect(
      codec.readContainer({ containerPath: destinationPath, contentKey }),
    ).rejects.toThrow(BackupIntegrityError);
  });

  it('подмена байта манифеста → BackupIntegrityError (AAD-привязка метаданных, §14)', async () => {
    const base = newDir();
    const snapshotPath = join(base, 'snapshot.db');
    writeSnapshot(snapshotPath, 512);
    const destinationPath = join(base, 'tampered-manifest.hlbackup');
    const contentKey = randomBytes(32);

    const codec = newCodec();
    await codec.writeContainer({
      manifestJson: Buffer.from(JSON.stringify(manifest), 'utf8'),
      contentKey,
      snapshotPath,
      destinationPath,
    });

    const file = readFileSync(destinationPath);
    file[9] ^= 0x01; // первый байт манифеста ('{')
    writeFileSync(destinationPath, file);

    await expect(
      codec.readContainer({ containerPath: destinationPath, contentKey }),
    ).rejects.toThrow(BackupIntegrityError);
  });

  it('чужая магия → BackupContainerFormatError', async () => {
    const base = newDir();
    const destinationPath = join(base, 'alien.hlbackup');
    writeFileSync(
      destinationPath,
      Buffer.concat([Buffer.from('NOTBK', 'latin1'), randomBytes(64)]),
    );

    await expect(
      newCodec().readContainer({ containerPath: destinationPath, contentKey: randomBytes(32) }),
    ).rejects.toThrow(BackupContainerFormatError);
  });

  it('обрезанный файл → BackupContainerFormatError (без краша на длинах)', async () => {
    const base = newDir();
    const destinationPath = join(base, 'truncated.hlbackup');
    writeFileSync(
      destinationPath,
      Buffer.concat([Buffer.from('HLBK1', 'latin1'), Buffer.alloc(4, 0), Buffer.from('{}')]),
    );

    await expect(
      newCodec().readContainer({ containerPath: destinationPath, contentKey: randomBytes(32) }),
    ).rejects.toThrow(BackupContainerFormatError);
  });
});

describe('BackupContainerCodec.prepareKey / contentKeyFor (§8: два вида ключа)', () => {
  it('пароль → kdf argon2id (соль/параметры записи) + 32-байтный ключ', async () => {
    const codec = newCodec();
    const { kdf, contentKey } = await codec.prepareKey({
      kind: 'passphrase',
      passphrase: 'пароль',
    });

    expect(kdf.id).toBe('argon2id');
    if (kdf.id !== 'argon2id') {
      return;
    }
    expect(kdf.iterations).toBe(TEST_PARAMS.iterations);
    expect(kdf.memoryKib).toBe(TEST_PARAMS.memoryKib);
    expect(kdf.parallelism).toBe(TEST_PARAMS.parallelism);
    expect(Buffer.from(kdf.saltB64, 'base64')).toHaveLength(16);
    expect(contentKey).toHaveLength(32);
  });

  it('contentKeyFor по записи манифеста → тот же ключ (путь восстановления 071)', async () => {
    const codec = newCodec();
    const passphrase = 'пароль';
    const { kdf, contentKey } = await codec.prepareKey({ kind: 'passphrase', passphrase });

    const restored = await codec.contentKeyFor(kdf, { kind: 'passphrase', passphrase });
    expect(restored.equals(contentKey)).toBe(true);
  });

  it('db-key → {id: db-key}, ключ = байты hex ключа БД (авто-копии, §5/§9)', async () => {
    const codec = newCodec();
    const keyHex = randomBytes(32).toString('hex');
    const { kdf, contentKey } = await codec.prepareKey({ kind: 'dbKey', keyHex });

    expect(kdf).toEqual({ id: 'db-key' });
    expect(contentKey.equals(Buffer.from(keyHex, 'hex'))).toBe(true);

    const restored = await codec.contentKeyFor({ id: 'db-key' }, { kind: 'dbKey', keyHex });
    expect(restored.equals(contentKey)).toBe(true);
  });

  it('вид источника не соответствует записи kdf → TypeError (dev-контракт вызова)', async () => {
    const codec = newCodec();
    await expect(
      codec.contentKeyFor({ id: 'db-key' }, { kind: 'passphrase', passphrase: 'пароль' }),
    ).rejects.toThrow(TypeError);
    await expect(
      codec.contentKeyFor(
        {
          id: 'argon2id',
          saltB64: Buffer.alloc(16, 1).toString('base64'),
          iterations: 1,
          memoryKib: 64,
          parallelism: 1,
        },
        { kind: 'dbKey', keyHex: 'ab'.repeat(32) },
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe('BackupContainerCodec.readHeader (TASK-071 §5: заголовок без расшифровки)', () => {
  it('манифест заголовка = записанным байтам, без GCM (выбор записи kdf для вывода ключа)', async () => {
    const base = newDir();
    const snapshotPath = join(base, 'snapshot.db');
    writeSnapshot(snapshotPath, 1024);
    const destinationPath = join(base, 'header.hlbackup');
    const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');

    const codec = newCodec();
    await codec.writeContainer({
      manifestJson,
      contentKey: randomBytes(32),
      snapshotPath,
      destinationPath,
    });

    const header = await codec.readHeader({ containerPath: destinationPath });
    expect(header.manifestJson.equals(manifestJson)).toBe(true);
    expect(header.manifest).toEqual(manifest);
  });

  it('чужая магия → BackupContainerFormatError (как у readContainer)', async () => {
    const base = newDir();
    const destinationPath = join(base, 'header-alien.hlbackup');
    writeFileSync(
      destinationPath,
      Buffer.concat([Buffer.from('XXXXX', 'latin1'), randomBytes(64)]),
    );
    await expect(newCodec().readHeader({ containerPath: destinationPath })).rejects.toThrow(
      BackupContainerFormatError,
    );
  });

  it('не-JSON манифест при валидных длинах → BackupContainerFormatError', async () => {
    const base = newDir();
    const destinationPath = join(base, 'header-badjson.hlbackup');
    const garbageManifest = Buffer.from('не-json{', 'utf8');
    const header = Buffer.alloc(5 + 4 + garbageManifest.length + 12 + 16);
    header.write('HLBK1', 0, 'latin1');
    header.writeUInt32BE(garbageManifest.length, 5);
    garbageManifest.copy(header, 9);
    writeFileSync(destinationPath, header);

    await expect(newCodec().readHeader({ containerPath: destinationPath })).rejects.toThrow(
      BackupContainerFormatError,
    );
  });
});
