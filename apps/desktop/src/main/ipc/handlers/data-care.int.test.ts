// TASK-073 §5/§11/§19: интеграционный тест хендлеров Data Care — каналы
// `backup/create`, `backup/restore`, `data/wipe` через полный каркас TASK-008
// (dispatch → zod → хендлер → use case → очередь), прецедент report.int.test.ts.
//
// Use cases — БОЕВЫЕ (070/071/072); инфраструктура — подстановочная (§19): БД —
// фейк порта BackupDatabase (VACUUM INTO пишет фикстурный снапшот, meta/COUNT —
// константы), fileSaver копии — фейк, relaunch/close — шпионы. Криптоконтейнер —
// РЕАЛЬНЫЙ BackupContainerCodec (argon2+GCM): форма ответов и маппинг плана
// (манифест наружу не идёт — §14) проверяются на настоящих контейнерах.
//
// Матрица:
//  - backup/create ask: ok {file: basename, sizeBytes, manifest}; ПОЛНОГО пути в
//    ответе нет (§14); отмена диалога → конверт ok:false BACKUP/CANCELED (§13);
//  - backup/restore фаза 1: план в форме контракта (без манифеста/соли), счётчики
//    копии и текущей БД; неверный пароль → BACKUP/WRONG_PASSPHRASE (AC3);
//  - backup/restore фаза 2: {restarting: true}; текущая БД ЗАМЕНЕНА байтами копии,
//    closeCurrentDb/relaunch вызваны (§9 — перезапуск запланирован);
//  - data/wipe plan: план {files, counts, rendererLocalStorage}, НИЧЕГО не удалено;
//  - data/wipe execute без plan → WIPE/FAILED (двухшаговость, §13);
//  - data/wipe plan → execute: {restarting: true}, файлы удалены, relaunch вызван;
//  - file/open-dialog зарегистрирован: strict-схема отвергает лишние поля до хендлера.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { CHANNEL_SCHEMAS, type ApiEnvelope } from '@hl/contracts';
import { ok, FixedClock } from '@hl/kernel';

import { BackupContainerCodec } from '../../modules/data-care/adapters/backup-container.js';
import { FileOpQueue } from '../../modules/data-care/application/file-op-queue.js';
import { CreateBackupUseCase } from '../../modules/data-care/application/create-backup.js';
import { RestoreBackupUseCase } from '../../modules/data-care/application/restore-backup.js';
import { WipeAllDataUseCase } from '../../modules/data-care/application/wipe-all.js';
import type {
  BackupDatabase,
  BackupStatement,
} from '../../modules/data-care/application/ports/backup-database.js';
import type { BackupFileSaver } from '../../modules/data-care/application/ports/backup-file-saver.js';
import { silentLogger } from '../../shared/logger/silent-logger.js';
import { electronFileOpenDialog } from '../../platform/file-open.js';
import { createChannelRegistry } from '../register-channel.js';
import {
  createBackupCreateHandler,
  createBackupRestoreHandler,
  createDataWipeHandler,
} from './data-care.js';
import { createFileOpenDialogHandler } from './file-open-dialog.js';

const NOW_MS = 1_790_341_200_000; // 2026-09-25T16:00:00+03:00
const PASSPHRASE = 'верный-пароль-копии';
/** Байты «снапшота БД» — фикстура, которой фейк БД отвечает на VACUUM INTO. */
const SNAPSHOT_BYTES = Buffer.from('health-log-snapshot-fixture-bytes');

const silenceLogger = silentLogger();

/**
 * Фейк открытой БД (порт BackupDatabase, §19): VACUUM INTO '<path>' пишет фикстурные
 * байты снапшота на путь (реальный шифровальщик читает файл с диска); meta — схема
 * v4, COUNT — 2 измерения.
 */
class FakeBackupDatabase implements BackupDatabase {
  exec(sql: string): void {
    const match = /VACUUM INTO '(.+)'/.exec(sql);
    if (match !== null) {
      writeFileSync((match[1] as string).replace(/''/g, "'"), SNAPSHOT_BYTES);
    }
  }

  prepare(sql: string): BackupStatement {
    const get = (): unknown => (sql.includes('schema_version') ? { value: '4' } : { n: 2 });
    return { get };
  }
}

describe('data-care хендлеры через каркас (TASK-073 §19)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-data-care-handlers-int-'));
  const backupsDir = join(dir, 'backups');

  // create: фейк-диалог сохраняет копию в фиксированный путь — путь известен тесту.
  const containerTarget = join(dir, 'health-log-backup.hlbackup');
  const fileSaver: BackupFileSaver = {
    save: () => Promise.resolve(containerTarget),
  };
  const KEY_HEX = 'cd'.repeat(32);
  const clock = new FixedClock(NOW_MS, 180);

  // restore: шпионы точек контейнера (§19).
  const closeCurrentDb = vi.fn(() => undefined);
  const verifyDatabaseOpens = vi.fn(() => undefined);
  const restoreRelaunch = vi.fn(() => undefined);
  const dbPath = join(dir, 'health-log.db');

  const registry = createChannelRegistry();
  const createBackup = new CreateBackupUseCase({
    db: new FakeBackupDatabase(),
    clock,
    logger: silenceLogger,
    crypto: new BackupContainerCodec(),
    fileSaver,
    queue: new FileOpQueue(),
    backupsDir,
    appVersion: '0.0.0-test',
    dbKeyHex: () => KEY_HEX,
  });
  const restoreBackup = new RestoreBackupUseCase({
    currentDb: new FakeBackupDatabase(),
    closeCurrentDb,
    dbPath,
    verifyDatabaseOpens,
    crypto: new BackupContainerCodec(),
    keyVault: { importKey: () => Promise.resolve(ok(undefined)) },
    logger: silenceLogger,
    queue: new FileOpQueue(),
    relaunch: restoreRelaunch,
    safetyFlagPath: join(dir, 'restore-safety.flag'),
    clock,
    appVersion: '0.0.0-test',
  });
  registry.register(
    'backup/create',
    CHANNEL_SCHEMAS['backup/create'],
    createBackupCreateHandler(createBackup),
  );
  registry.register(
    'backup/restore',
    CHANNEL_SCHEMAS['backup/restore'],
    createBackupRestoreHandler(restoreBackup),
  );
  registry.register(
    'file/open-dialog',
    CHANNEL_SCHEMAS['file/open-dialog'],
    createFileOpenDialogHandler(electronFileOpenDialog),
  );

  // wipe: свой набор файлов (план строит main из фактических каталогов, §7 072).
  const wipeDir = mkdtempSync(join(tmpdir(), 'hl-data-care-wipe-int-'));
  const wipeDbPath = join(wipeDir, 'health-log.db');
  const wipeVaultKeyPath = join(wipeDir, 'vault.key');
  const wipeLogsDir = join(wipeDir, 'logs');
  const wipeBackupsDir = join(wipeDir, 'backups');
  const wipeRelaunch = vi.fn(() => undefined);
  const wipeClose = vi.fn(() => undefined);
  const wipe = new WipeAllDataUseCase({
    db: new FakeBackupDatabase(),
    closeCurrentDb: wipeClose,
    dbPath: wipeDbPath,
    vaultKeyPath: wipeVaultKeyPath,
    logsDir: wipeLogsDir,
    backupsDir: wipeBackupsDir,
    logger: silenceLogger,
    queue: new FileOpQueue(),
    relaunch: wipeRelaunch,
  });
  registry.register('data/wipe', CHANNEL_SCHEMAS['data/wipe'], createDataWipeHandler(wipe));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(wipeDir, { recursive: true, force: true });
  });

  it('backup/create ask: ok {file: basename, sizeBytes, manifest}; полного пути в ответе НЕТ (§14)', async () => {
    const envelope = (await registry.dispatch({
      channel: 'backup/create',
      payload: { mode: 'ask', passphrase: PASSPHRASE },
    })) as ApiEnvelope<Record<string, unknown>>;

    expect(envelope.ok).toBe(true);
    const data = envelope.ok === true ? envelope.data : {};
    expect(data['file']).toBe('health-log-backup.hlbackup');
    expect(data['sizeBytes']).toBeGreaterThan(1);
    expect(data['manifest']).toMatchObject({
      formatVersion: 1,
      schemaVersion: 4,
      appVersion: '0.0.0-test',
      createdAtUtc: NOW_MS,
      counts: { measurements: 2 },
      kdf: { id: 'argon2id' },
    });
    expect(Object.keys(data)).not.toContain('path');
    expect(existsSync(containerTarget)).toBe(true);
  });

  it('backup/create: отмена диалога сохранения → конверт ok:false BACKUP/CANCELED (§13 070)', async () => {
    const cancelingRegistry = createChannelRegistry();
    cancelingRegistry.register(
      'backup/create',
      CHANNEL_SCHEMAS['backup/create'],
      createBackupCreateHandler(
        new CreateBackupUseCase({
          db: new FakeBackupDatabase(),
          clock,
          logger: silenceLogger,
          crypto: new BackupContainerCodec(),
          fileSaver: { save: () => Promise.resolve(null) },
          queue: new FileOpQueue(),
          backupsDir,
          appVersion: '0.0.0-test',
          dbKeyHex: () => KEY_HEX,
        }),
      ),
    );

    const envelope = await cancelingRegistry.dispatch({
      channel: 'backup/create',
      payload: { mode: 'ask', passphrase: PASSPHRASE },
    });

    expect(envelope).toMatchObject({
      v: 1,
      ok: false,
      error: { code: 'BACKUP/CANCELED', messageKey: 'errors.BACKUP_CANCELED' },
    });
  });

  it('backup/restore фаза 1: план в форме контракта (без манифеста/соли — §14), счётчики копии и текущей БД', async () => {
    const envelope = (await registry.dispatch({
      channel: 'backup/restore',
      payload: { file: containerTarget, passphrase: PASSPHRASE, confirmed: false },
    })) as ApiEnvelope<Record<string, unknown>>;

    expect(envelope.ok).toBe(true);
    const plan =
      envelope.ok === true ? (envelope.data as { plan: Record<string, unknown> }).plan : {};
    expect(plan).toEqual({
      schemaVersion: 4,
      schemaDelta: 'equal',
      createdAtUtc: NOW_MS,
      counts: { measurements: 2 },
      currentCounts: { measurements: 2 },
      warnings: ['replaces-current'],
    });
    // §14: полного манифеста наружу нет (соль/параметры KDF/хеш — только в main).
    const raw = JSON.stringify(plan) ?? '';
    expect(raw).not.toContain('saltB64');
    expect(raw).not.toContain('dbSha256');
  });

  it('backup/restore неверный пароль → конверт ok:false BACKUP/WRONG_PASSPHRASE (AC3)', async () => {
    const envelope = await registry.dispatch({
      channel: 'backup/restore',
      payload: { file: containerTarget, passphrase: 'не-тот-пароль', confirmed: false },
    });

    expect(envelope).toMatchObject({
      v: 1,
      ok: false,
      error: { code: 'BACKUP/WRONG_PASSPHRASE', messageKey: 'errors.BACKUP_WRONG_PASSPHRASE' },
    });
  });

  it('backup/restore фаза 2: {restarting: true}; БД замещена байтами копии; close/relaunch вызваны (§8/§9)', async () => {
    writeFileSync(dbPath, Buffer.from('ТЕКУЩАЯ-БД-БУДЕТ-ЗАМЕНЕНА'));
    expect(closeCurrentDb).not.toHaveBeenCalled();

    const envelope = (await registry.dispatch({
      channel: 'backup/restore',
      payload: { file: containerTarget, passphrase: PASSPHRASE, confirmed: true },
    })) as ApiEnvelope<Record<string, unknown>>;

    expect(envelope).toMatchObject({ v: 1, ok: true, data: { restarting: true } });
    expect(closeCurrentDb).toHaveBeenCalledTimes(1);
    expect(verifyDatabaseOpens).toHaveBeenCalledWith(dbPath);
    expect(restoreRelaunch).toHaveBeenCalledTimes(1);
    expect(readFileSync(dbPath)).toEqual(SNAPSHOT_BYTES);
  });

  it('data/wipe plan: план {files, counts, rendererLocalStorage}; НИЧЕГО не удалено (§5 072)', async () => {
    writeFileSync(wipeDbPath, Buffer.from('db'));
    writeFileSync(`${wipeDbPath}-wal`, Buffer.from('wal'));
    writeFileSync(wipeVaultKeyPath, Buffer.from('key'));
    rmSync(wipeLogsDir, { recursive: true, force: true });
    mkdirSync(wipeLogsDir, { recursive: true });
    writeFileSync(join(wipeLogsDir, 'app.log'), Buffer.from('log'));
    rmSync(wipeBackupsDir, { recursive: true, force: true });
    mkdirSync(wipeBackupsDir, { recursive: true });
    writeFileSync(join(wipeBackupsDir, 'copy.hlbackup'), Buffer.from('copy'));

    const envelope = (await registry.dispatch({
      channel: 'data/wipe',
      payload: { phase: 'plan' },
    })) as ApiEnvelope<Record<string, unknown>>;

    expect(envelope.ok).toBe(true);
    const plan =
      envelope.ok === true ? (envelope.data as { plan: Record<string, unknown> }).plan : {};
    // Порядок удаления §19 072: backups → logs → key → db (БД последней).
    expect(plan['files']).toEqual([
      { path: 'copy.hlbackup', category: 'backups' },
      { path: 'app.log', category: 'logs' },
      { path: 'vault.key', category: 'key' },
      { path: 'health-log.db-wal', category: 'db' },
      { path: 'health-log.db', category: 'db' },
    ]);
    expect(plan['counts']).toEqual({ measurements: 2 });
    expect(plan['rendererLocalStorage']).toBe(true);
    // Plan НЕ удаляет (§5 072).
    expect(existsSync(wipeDbPath)).toBe(true);
    expect(existsSync(join(wipeBackupsDir, 'copy.hlbackup'))).toBe(true);
  });

  it('data/wipe execute без plan → конверт ok:false WIPE/FAILED (двухшаговость §13 072)', async () => {
    const fresh = createChannelRegistry();
    fresh.register(
      'data/wipe',
      CHANNEL_SCHEMAS['data/wipe'],
      createDataWipeHandler(
        new WipeAllDataUseCase({
          db: new FakeBackupDatabase(),
          closeCurrentDb: vi.fn(),
          dbPath: wipeDbPath,
          vaultKeyPath: wipeVaultKeyPath,
          logsDir: wipeLogsDir,
          backupsDir: wipeBackupsDir,
          logger: silenceLogger,
          queue: new FileOpQueue(),
          relaunch: vi.fn(),
        }),
      ),
    );

    const envelope = await fresh.dispatch({ channel: 'data/wipe', payload: { phase: 'execute' } });

    expect(envelope).toMatchObject({
      v: 1,
      ok: false,
      error: { code: 'WIPE/FAILED', messageKey: 'errors.WIPE_FAILED' },
    });
    expect(wipeRelaunch).not.toHaveBeenCalled();
  });

  it('data/wipe plan → execute: {restarting: true}; файлы удалены; close/relaunch вызваны (§5/§9 072)', async () => {
    const envelope = (await registry.dispatch({
      channel: 'data/wipe',
      payload: { phase: 'execute' },
    })) as ApiEnvelope<Record<string, unknown>>;

    expect(envelope).toMatchObject({ v: 1, ok: true, data: { restarting: true } });
    expect(wipeClose).toHaveBeenCalledTimes(1);
    expect(wipeRelaunch).toHaveBeenCalledTimes(1);
    expect(existsSync(wipeDbPath)).toBe(false);
    expect(existsSync(`${wipeDbPath}-wal`)).toBe(false);
    expect(existsSync(wipeVaultKeyPath)).toBe(false);
    expect(existsSync(join(wipeLogsDir, 'app.log'))).toBe(false);
    expect(existsSync(join(wipeBackupsDir, 'copy.hlbackup'))).toBe(false);
  });

  it('file/open-dialog: strict-схема отвергает лишние поля до хендлера (VALIDATION/FAILED)', async () => {
    const envelope = await registry.dispatch({
      channel: 'file/open-dialog',
      payload: { filters: [{ name: 'X', extensions: ['hlbackup'] }], path: 'C:\\x' },
    });

    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'VALIDATION/FAILED' } });
  });
});
