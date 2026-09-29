// TASK-073 §5/§9/§11/§19: интеграционный тест хендлеров Data Care — полный путь
// по каркасу TASK-008: dispatch(registry) → zod-валидация → хендлер → use case
// (СТАБЫ: 070/071/072 покрыты собственными int-наборами; здесь — маппинг
// Result → контракт канала и AppError → DTO, прецедент report.ts/report.int.test.ts).
//
// Покрывается (§19):
//  - backup/create: ok {file, sizeBytes, manifest} — ПОЛНЫЙ путь в ответ НЕ идёт
//    (§14: basename только); err BACKUP/CANCELED → DTO; пустой пароль →
//    VALIDATION/FAILED до хендлера;
//  - backup/restore: план фазы 1 — манифест СХЛОПЫВАЕТСЯ до полей плана (соль/kdf
//    наружу не идут, §14); execute → {restarting: true}; BACKUP/WRONG_PASSPHRASE →
//    DTO без изменения;
//  - data/wipe: plan → {plan} (basename+категория), execute → {restarting: true};
//    WIPE/FAILED с params.remainingCount → DTO;
//  - file/open-dialog: путь адаптера → {path}; отмена (null) → {canceled: true}
//    (§7 — не ошибка); битая форма фильтров → VALIDATION/FAILED.
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_SCHEMAS,
  type ApiEnvelope,
  type BackupManifest,
  type BackupRestorePlan,
  type DataWipePlan,
} from '@hl/contracts';
import { AppError, type Result } from '@hl/kernel';

import { createChannelRegistry } from '../register-channel.js';
import {
  createBackupCreateHandler,
  createRestoreBackupHandler,
  createWipeAllDataHandler,
} from './data-care.js';
import { createOpenDialogHandler } from './file-dialog.js';
import type { BackupCreateResult } from '../../modules/data-care/application/create-backup.js';
import type {
  RestoreBackupCommand,
  RestoreBackupResultValue,
} from '../../modules/data-care/application/restore-backup.js';
import type {
  WipeAllDataCommand,
  WipeAllDataResultValue,
} from '../../modules/data-care/application/wipe-all.js';

const NOW_MS = 1_790_341_200_000;

/** Манифест-фикстура (валиден по BACKUP_MANIFEST_SCHEMA — из контракта 070). */
const MANIFEST: BackupManifest = {
  formatVersion: 1,
  schemaVersion: 2,
  appVersion: '0.1.0-test',
  createdAtUtc: NOW_MS,
  counts: { measurements: 120 },
  dbSha256: 'a'.repeat(64),
  kdf: { id: 'argon2id', saltB64: 'c2FsdA==', iterations: 3, memoryKib: 65_536, parallelism: 2 },
};

/** Стаб create: отдаёт заранее заданный Result; вызовы журналируются. */
function stubCreate(result: Result<BackupCreateResult, AppError>) {
  const execute = vi.fn(() => Promise.resolve(result));
  return { execute };
}

/** Стаб restore: возвращает по confirmed (plan/execute), вызовы журналируются. */
function stubRestore(
  plan: Result<RestoreBackupResultValue, AppError>,
  restart: Result<RestoreBackupResultValue, AppError>,
) {
  const execute = vi.fn((command: RestoreBackupCommand) =>
    Promise.resolve(command.confirmed ? restart : plan),
  );
  return { execute };
}

/** Стаб wipe: возвращает по phase (plan/execute), вызовы журналируются. */
function stubWipe(
  plan: Result<WipeAllDataResultValue, AppError>,
  restart: Result<WipeAllDataResultValue, AppError>,
) {
  const execute = vi.fn((command: WipeAllDataCommand) =>
    Promise.resolve(command.phase === 'execute' ? restart : plan),
  );
  return { execute };
}

const WIPE_PLAN: DataWipePlan = {
  files: [
    { path: 'pre-migration-v1.hlbackup', category: 'backups' },
    { path: 'hl.log', category: 'logs' },
    { path: 'vault.key', category: 'key' },
    { path: 'health-log.db', category: 'db' },
  ],
  counts: { measurements: 350 },
  rendererLocalStorage: true,
};

const RESTORE_PLAN: BackupRestorePlan = {
  schemaVersion: 2,
  schemaDelta: 'equal',
  createdAtUtc: NOW_MS,
  counts: { measurements: 120 },
  currentCounts: { measurements: 350 },
  warnings: ['replaces-current'],
};

function buildRegistry() {
  const registry = createChannelRegistry(undefined, { isDev: false });
  const create = stubCreate({
    ok: true,
    value: {
      file: 'health-log-backup-20260925.hlbackup',
      path: 'C:\\Users\\me\\health-log-backup-20260925.hlbackup',
      sizeBytes: 123_456,
      manifest: MANIFEST,
    },
  });
  const restore = stubRestore(
    {
      ok: true,
      value: {
        plan: {
          manifest: MANIFEST,
          schemaDelta: 'equal',
          warnings: ['replaces-current'],
          currentCounts: { measurements: 350 },
        },
      },
    },
    { ok: true, value: { restarting: true } },
  );
  const wipe = stubWipe(
    { ok: true, value: { plan: WIPE_PLAN } },
    { ok: true, value: { restarting: true } },
  );
  registry.register(
    'backup/create',
    CHANNEL_SCHEMAS['backup/create'],
    createBackupCreateHandler(create),
  );
  registry.register(
    'backup/restore',
    CHANNEL_SCHEMAS['backup/restore'],
    createRestoreBackupHandler(restore),
  );
  registry.register(
    'data/wipe',
    CHANNEL_SCHEMAS['data/wipe'],
    createWipeAllDataHandler(wipe),
  );
  const openDialog = { open: vi.fn(() => Promise.resolve<string | null>('C:\\tmp\\copy.hlbackup')) };
  registry.register(
    'file/open-dialog',
    CHANNEL_SCHEMAS['file/open-dialog'],
    createOpenDialogHandler(openDialog),
  );
  return { registry, create, restore, wipe, openDialog };
}

const envelopeOf = (data: unknown): ApiEnvelope<unknown> => data as ApiEnvelope<unknown>;

describe('backup/create — хендлер (TASK-073 §19)', () => {
  it('ok: ответ {file, sizeBytes, manifest}; ПОЛНЫЙ путь наружу не идёт (§14)', async () => {
    const { registry, create } = buildRegistry();

    const envelope = envelopeOf(
      await registry.dispatch({
        channel: 'backup/create',
        payload: { mode: 'ask', passphrase: 'пароль-копии' },
      }),
    );

    expect(create.execute).toHaveBeenCalledWith({ mode: 'ask', passphrase: 'пароль-копии' });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({
      file: 'health-log-backup-20260925.hlbackup',
      sizeBytes: 123_456,
      manifest: MANIFEST,
    });
    expect(JSON.stringify(envelope.data)).not.toContain('C:\\Users');
  });

  it('auto-режим проходит в use case без изменений (контракт 070 — discriminated по mode)', async () => {
    const { registry, create } = buildRegistry();

    await registry.dispatch({ channel: 'backup/create', payload: { mode: 'auto' } });

    expect(create.execute).toHaveBeenCalledWith({ mode: 'auto' });
  });

  it('отмена диалога (BACKUP/CANCELED) → конверт ok:false с кодом (§7 — исход, не сбой каркаса)', async () => {
    const registry = createChannelRegistry(undefined, { isDev: false });
    registry.register(
      'backup/create',
      CHANNEL_SCHEMAS['backup/create'],
      createBackupCreateHandler(
        stubCreate({ ok: false, error: AppError.of('BACKUP/CANCELED', 'errors.BACKUP_CANCELED') }),
      ),
    );

    const envelope = envelopeOf(
      await registry.dispatch({
        channel: 'backup/create',
        payload: { mode: 'ask', passphrase: 'пароль-копии' },
      }),
    );

    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'BACKUP/CANCELED' } });
  });

  it('пустой пароль отклоняется схемой → VALIDATION/FAILED, хендлер не зовётся', async () => {
    const { registry, create } = buildRegistry();

    const envelope = envelopeOf(
      await registry.dispatch({ channel: 'backup/create', payload: { mode: 'ask', passphrase: '' } }),
    );

    expect(create.execute).not.toHaveBeenCalled();
    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'VALIDATION/FAILED' } });
  });
});

describe('backup/restore — хендлер: двухфазный (TASK-073 §19/§11)', () => {
  it('фаза 1: план — манифест схлопнут до полей контракта (соль/kdf наружу не идут, §14)', async () => {
    const { registry, restore } = buildRegistry();

    const envelope = envelopeOf(
      await registry.dispatch({
        channel: 'backup/restore',
        payload: { file: 'C:\\tmp\\copy.hlbackup', passphrase: 'пароль', confirmed: false },
      }),
    );

    expect(restore.execute).toHaveBeenCalledWith({
      file: 'C:\\tmp\\copy.hlbackup',
      passphrase: 'пароль',
      confirmed: false,
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ plan: RESTORE_PLAN });
    expect(JSON.stringify(envelope.data)).not.toContain('saltB64');
    expect(JSON.stringify(envelope.data)).not.toContain('dbSha256');
  });

  it('фаза 2: {restarting: true} (§9: ответ уходит до relaunch)', async () => {
    const { registry } = buildRegistry();

    const envelope = envelopeOf(
      await registry.dispatch({
        channel: 'backup/restore',
        payload: { file: 'C:\\tmp\\copy.hlbackup', passphrase: 'пароль', confirmed: true },
      }),
    );

    expect(envelope).toEqual({ v: 1, ok: true, data: { restarting: true } });
  });

  it('неверный пароль: BACKUP/WRONG_PASSPHRASE → DTO без изменения (инлайн-ошибка UI, AC)', async () => {
    const registry = createChannelRegistry(undefined, { isDev: false });
    const restore = stubRestore(
      {
        ok: false,
        error: AppError.of('BACKUP/WRONG_PASSPHRASE', 'errors.BACKUP_WRONG_PASSPHRASE'),
      },
      { ok: false, error: AppError.of('BACKUP/WRONG_PASSPHRASE', 'errors.BACKUP_WRONG_PASSPHRASE') },
    );
    registry.register(
      'backup/restore',
      CHANNEL_SCHEMAS['backup/restore'],
      createRestoreBackupHandler(restore),
    );

    const envelope = envelopeOf(
      await registry.dispatch({
        channel: 'backup/restore',
        payload: { file: 'C:\\tmp\\copy.hlbackup', passphrase: 'неверно', confirmed: false },
      }),
    );

    expect(envelope).toMatchObject({
      v: 1,
      ok: false,
      error: { code: 'BACKUP/WRONG_PASSPHRASE', messageKey: 'errors.BACKUP_WRONG_PASSPHRASE' },
    });
  });
});

describe('data/wipe — хендлер: двухфазный (TASK-073 §19/§11)', () => {
  it('plan: {plan} — basename + категория, без полных путей (§14)', async () => {
    const { registry, wipe } = buildRegistry();

    const envelope = envelopeOf(
      await registry.dispatch({ channel: 'data/wipe', payload: { phase: 'plan' } }),
    );

    expect(wipe.execute).toHaveBeenCalledWith({ phase: 'plan' });
    expect(envelope).toEqual({ v: 1, ok: true, data: { plan: WIPE_PLAN } });
    expect(JSON.stringify(envelope.data)).not.toContain('C:\\');
  });

  it('execute: {restarting: true}', async () => {
    const { registry, wipe } = buildRegistry();

    const envelope = envelopeOf(
      await registry.dispatch({ channel: 'data/wipe', payload: { phase: 'execute' } }),
    );

    expect(wipe.execute).toHaveBeenCalledWith({ phase: 'execute' });
    expect(envelope).toEqual({ v: 1, ok: true, data: { restarting: true } });
  });

  it('частичный сбой: WIPE/FAILED с params.remainingCount → DTO (§11: что осталось)', async () => {
    const registry = createChannelRegistry(undefined, { isDev: false });
    const wipe = stubWipe(
      {
        ok: false,
        error: AppError.of('WIPE/FAILED', 'errors.WIPE_FAILED', { remainingCount: 2 }),
      },
      { ok: false, error: AppError.of('WIPE/FAILED', 'errors.WIPE_FAILED') },
    );
    registry.register(
      'data/wipe',
      CHANNEL_SCHEMAS['data/wipe'],
      createWipeAllDataHandler(wipe),
    );

    const envelope = envelopeOf(
      await registry.dispatch({ channel: 'data/wipe', payload: { phase: 'execute' } }),
    );

    expect(envelope).toMatchObject({
      v: 1,
      ok: false,
      error: { code: 'WIPE/FAILED', params: { remainingCount: 2 } },
    });
  });
});

describe('file/open-dialog — хендлер (TASK-073 §9/§19)', () => {
  it('адаптер вернул путь → {path} (выбор пользователя — наружу можно, §14)', async () => {
    const { registry, openDialog } = buildRegistry();

    const envelope = envelopeOf(
      await registry.dispatch({
        channel: 'file/open-dialog',
        payload: { filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }] },
      }),
    );

    expect(openDialog.open).toHaveBeenCalledWith({
      filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }],
    });
    expect(envelope).toEqual({ v: 1, ok: true, data: { path: 'C:\\tmp\\copy.hlbackup' } });
  });

  it('отмена (null) → {canceled: true} — конверт ok (§7: не ошибка)', async () => {
    const registry = createChannelRegistry(undefined, { isDev: false });
    const openDialog = { open: vi.fn(() => Promise.resolve<string | null>(null)) };
    registry.register(
      'file/open-dialog',
      CHANNEL_SCHEMAS['file/open-dialog'],
      createOpenDialogHandler(openDialog),
    );

    const envelope = envelopeOf(await registry.dispatch({ channel: 'file/open-dialog', payload: {} }));

    expect(envelope).toEqual({ v: 1, ok: true, data: { canceled: true } });
  });

  it('путь от renderer и битые фильтры отклоняются схемой (§14)', async () => {
    const { registry, openDialog } = buildRegistry();

    const withPath = envelopeOf(
      await registry.dispatch({ channel: 'file/open-dialog', payload: { path: 'C:/evil' } }),
    );
    const badFilter = envelopeOf(
      await registry.dispatch({
        channel: 'file/open-dialog',
        payload: { filters: [{ name: 'X', extensions: ['.hlbackup'] }] },
      }),
    );

    expect(openDialog.open).not.toHaveBeenCalled();
    expect(withPath).toMatchObject({ ok: false, error: { code: 'VALIDATION/FAILED' } });
    expect(badFilter).toMatchObject({ ok: false, error: { code: 'VALIDATION/FAILED' } });
  });
});
