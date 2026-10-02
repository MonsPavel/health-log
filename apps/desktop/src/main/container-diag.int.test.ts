/**
 * TASK-103 §9/§19/§20: интеграционный тест боевой проводки DiagBundleService в
 * контейнере (прецедент container-privacy.int.test.ts).
 *
 *  - `diag/preview` на healthy-сборке (tmp-userData, реальные миграции): состав
 *    пакета — лог-фикстура из userData/logs, selfcheck-снимок, версии, журнал
 *    network_event, агрегаты app_event (окно 90 дней — старая запись не считается),
 *    список миграций == реестру; агрегаты только из метаданных;
 *  - PHI-скан (ГЛАВНЫЙ AC §20-1, end-to-end): синтетические измерения/заметки,
 *    СЕЯННЫЕ в зашифрованную БД (bp_measurement.note), и синтетика лог-фикстуры
 *    НЕ найдены в предпросмотре; пути userData тоже не текут;
 *  - ротационные задачи в scheduler (AC §20-4, проводка §5): tick(FixedClock)
 *    удаляет network_event 91д/app_event 181д и старый лог-файл, сохраняет 89д/
 *    179д и свежий.
 *
 * Vault — мок mode=none; адаптер updater'а — мок (сеть не выполняется, §19).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, ok, type Clock, type Result } from '@hl/kernel';

import type { ChannelName, DiagContent } from '@hl/contracts';

import { buildContainer, SEED_PROFILE_ID, type Container } from './container.js';
import { MIGRATIONS } from './shared/db/migrations/index.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';
import type { UpdatesAdapter } from './modules/platform-services/updates/updates-service.js';

const KEY_HEX = 'cd'.repeat(32);
const NOW_MS = 1_759_400_000_000;
const DAY_MS = 86_400_000;

/** Синтетика PHI (§13/§20-1): сеется в БД и в лог-фикстуру, НЕ должна попасть в пакет. */
const PHI_NOTE = 'Заметка-ПиАш-9977-голова-болит-фикстура';

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-diag-int-'));

class MockVault implements KeyVault {
  private ensured = 0;

  ensureKey(): Promise<Result<EnsuredKey, AppError>> {
    return Promise.resolve({
      ok: true,
      value: { keyHex: KEY_HEX, created: this.ensured++ === 0 },
    });
  }

  exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>> {
    return Promise.resolve({
      ok: false,
      error: AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY),
    });
  }

  setPassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  changePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  removePassphrase(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  unlock(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  lock(): void {}

  getMode(): 'none' {
    return 'none';
  }
}

/** Мок адаптера updater'а (§19, прецедент container-privacy): сеть не выполняется. */
class FakeAdapter implements UpdatesAdapter {
  getFeedUrl(): Promise<string> {
    return Promise.resolve('https://releases.example.com/latest');
  }

  checkForUpdates(): Promise<{ available: boolean }> {
    return Promise.resolve({ available: false });
  }

  downloadUpdate(): Promise<void> {
    return Promise.resolve();
  }

  quitAndInstall(): Promise<void> {
    return Promise.resolve();
  }

  onAvailable(): void {}

  onNotAvailable(): void {}

  onDownloadProgress(): void {}

  onDownloaded(): void {}

  onError(): void {}
}

/** FixedClock (NFR-10): детерминизм ротационных порогов и манифеста. */
const FIXED_CLOCK: Clock = { nowMs: () => NOW_MS, tzOffsetMin: () => 180 };

const deps = (dir: string) => ({
  userDataPath: dir,
  clock: FIXED_CLOCK,
  vault: () => new MockVault(),
  updatesAdapter: new FakeAdapter(),
});

const containers: Container[] = [];
const dirs: string[] = [];
afterAll(() => {
  // Сначала соединения (Windows: дескриптор держит файл), затем каталоги.
  for (const container of containers) {
    try {
      container.close();
    } catch {
      // закрыт самим сценарием — не важно для очистки
    }
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Конверт успеха с типизированными данными (dispatch — ApiEnvelope<unknown>). */
async function okData<T>(container: Container, channel: ChannelName, payload: unknown): Promise<T> {
  const envelope = await container.channels.dispatch({ channel, payload });
  if (!envelope.ok) {
    throw new Error(`канал ${channel}: ${JSON.stringify(envelope.error)}`);
  }
  return envelope.data as T;
}

/** Сеет измерение с PHI-заметкой в БД (v1: bp_measurement; профиль — seed v1). */
function seedMeasurement(container: Container, note: string, ageDays: number): void {
  const now = NOW_MS - ageDays * DAY_MS;
  container.db
    .prepare(
      `INSERT INTO bp_measurement
         (id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse, irregular_pulse, arm, note, source, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, 180, 125, 85, 70, 0, 'left', ?, 'manual', ?, ?)`,
    )
    .run(randomUUID(), SEED_PROFILE_ID, now, note, now, now);
}

/** Сеет строку network_event заданного возраста (дней). */
function seedNetworkEvent(container: Container, id: string, ageDays: number): void {
  container.db
    .prepare(
      'INSERT INTO network_event (id, kind, endpoint, status, bytes, at_utc) VALUES (?, ?, ?, ?, NULL, ?)',
    )
    .run(id, 'updates.check', 'https://releases.example.com/latest', 'ok', NOW_MS - ageDays * DAY_MS);
}

/** Сеет строку app_event заданного возраста (дней). */
function seedAppEvent(container: Container, id: string, kind: string, ageDays: number): void {
  container.db
    .prepare('INSERT INTO app_event (id, kind, payload_json, at_utc) VALUES (?, ?, ?, ?)')
    .run(id, kind, '{}', NOW_MS - ageDays * DAY_MS);
}

/** Пишет лог-фикстуру в каталог логов (redact-форма TASK-010: значения цензурены). */
function seedLogs(logsDir: string): void {
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, 'hl.1.log'),
    [
      '{"level":30,"msg":"container ready","schemaVersion":7}',
      '{"level":30,"msg":"measurement.add","sys":"[redacted]","note":"[redacted]"}',
    ].join('\n'),
  );
}

describe('container + DiagBundleService (TASK-103 §9/§19/§20)', () => {
  it('diag/preview: состав пакета, агрегаты 90д, миграции == реестру; PHI-скан (AC §20-1)', async () => {
    const dir = newUserDataDir();
    dirs.push(dir);
    const container = await buildContainer(deps(dir));
    containers.push(container);

    seedMeasurement(container, PHI_NOTE, 1);
    seedNetworkEvent(container, 'net-fresh', 1);
    seedAppEvent(container, 'app-start-1', 'app.start', 2);
    seedAppEvent(container, 'app-start-2', 'app.start', 3);
    seedAppEvent(container, 'app-ai', 'ai.summary.generate', 5);
    seedAppEvent(container, 'app-old', 'app.start', 120); // вне окна 90д — не считается
    seedLogs(join(dir, 'logs'));

    const content = await okData<DiagContent>(container, 'diag/preview', {});

    // Состав (§5): логи + сгенерированные файлы + манифест.
    const names = content.files.map((file) => file.name);
    expect(names).toContain('hl.1.log');
    for (const generated of [
      'versions.json',
      'selfcheck.json',
      'network-journal.json',
      'app-events.json',
      'migrations.json',
      'diag-manifest.json',
    ]) {
      expect(names).toContain(generated);
    }

    // Версии (app/meta): приложение/схема/шкала — из боевого графа.
    const versions = JSON.parse(
      content.files.find((file) => file.name === 'versions.json')?.preview ?? '',
    ) as { appVersion: string; schemaVersion: number; scale?: { code: string } };
    expect(versions.appVersion).toBe('0.0.0');
    expect(versions.schemaVersion).toBe(7);
    expect(versions.scale?.code).toBe('bp_office_esc2018');

    // Журнал сети: свежая запись присутствует (метаданные, 200 записей).
    const journalText =
      content.files.find((file) => file.name === 'network-journal.json')?.preview ?? '';
    expect(journalText).toContain('updates.check');

    // Агрегаты app_event за 90 дней: старая запись не считается (§5).
    expect(content.totals.eventsByKind['app.start']).toBe(2);
    expect(content.totals.eventsByKind['ai.summary.generate']).toBe(1);
    expect(content.totals.eventsByKind['app.start']).not.toBe(3);

    // Список миграций == боевому реестру (§5). preview — первые 20 строк (§7),
    // полный JSON из preview не спарсить: проводку реестра фиксируем точным
    // размером файла (полный контент реестра покрывает unit-int тест сервиса).
    const migrationsFile = content.files.find((file) => file.name === 'migrations.json');
    expect(migrationsFile?.preview).toContain('"version": 1');
    expect(migrationsFile?.sizeBytes).toBe(
      Buffer.byteLength(
        `${JSON.stringify(
          MIGRATIONS.map((migration) => ({ version: migration.version })),
          null,
          2,
        )}\n`,
        'utf8',
      ),
    );

    // ГЛАВНЫЙ AC §20-1 (end-to-end): синтетика БД/логов НЕ найдена в пакете.
    const allTexts = content.files.map((file) => file.preview ?? '').join('\n');
    expect(allTexts).not.toContain(PHI_NOTE);
    // но цензура TASK-010 в лог-фикстуре на месте — скан не «мимо».
    expect(allTexts).toContain('[redacted]');
    // §14: пути userData (с именем пользователя) не текут.
    expect(allTexts).not.toContain(dir);
  });

  it('ротационные задачи в scheduler (AC §20-4): tick удаляет 91д/181д/старый лог, сохраняет свежее', async () => {
    const dir = newUserDataDir();
    dirs.push(dir);
    const container = await buildContainer(deps(dir));
    containers.push(container);

    seedNetworkEvent(container, 'net-91', 91);
    seedNetworkEvent(container, 'net-89', 89);
    seedAppEvent(container, 'app-181', 'app.start', 181);
    seedAppEvent(container, 'app-179', 'app.start', 179);

    const logsDir = join(dir, 'logs');
    seedLogs(logsDir);
    writeFileSync(join(logsDir, 'hl.0.log'), 'old-rotated\n');
    utimesSync(join(logsDir, 'hl.0.log'), NOW_MS / 1000, (NOW_MS - 31 * DAY_MS) / 1000);

    await container.scheduler.tick({ utcMs: NOW_MS, tzOffsetMin: 180 });

    const netIds = (
      container.db.prepare('SELECT id FROM network_event').all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(netIds).not.toContain('net-91');
    expect(netIds).toContain('net-89');

    const appIds = (
      container.db.prepare('SELECT id FROM app_event').all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(appIds).not.toContain('app-181');
    expect(appIds).toContain('app-179');

    // Логи: старый файл удалён, активный цел.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(logsDir, 'hl.0.log'))).toBe(false);
    expect(existsSync(join(logsDir, 'hl.1.log'))).toBe(true);
  });
});
