// TASK-087 §19: интеграционные тесты SQLite-адаптера SqliteInsightRepository над
// таблицей ai_summary миграции v6 (tmp-каталог, реальный SQLCipher-стек:
// openEncrypted → MigrationRunner(MIGRATIONS) — тот же путь, что у приложения,
// прецедент SqliteScaleRepository TASK-051 / SqliteBpMeasurementRepository TASK-026).
//
// Матрица:
//  1. save → findByContextHash возвращает запись целиком (все поля §7, включая
//     служебные disclaimerText/periodText и dataVersion);
//  2. findByContextHash скоупится по профилю: тот же hash чужого профиля — undefined;
//     нет записи — undefined (не throw, §7);
//  3. latestForPeriod: новейшая по (created_at_utc DESC, id DESC) среди совпавших
//     границ периода; чужой период/пустая таблица — undefined;
//  4. deleteAll очищает таблицу (кнопка «Очистить разборы», §8);
//  5. currentDataVersion читает meta.data_version (v1 сеет '1'); мутация измерений
//     через боевой SqliteBpMeasurementRepository bump'ит тот же счётчик — порт видит
//     рост (основа stale-расчёта §7);
//  6. порт асинхронный — методы возвращают Promise (контракт порта, §19 051).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { type Clock } from '@hl/kernel';

import { BpMeasurement } from '../../measurement/domain/bp-measurement.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { SqliteBpMeasurementRepository } from '../../measurement/adapters/sqlite-measurement-repository.js';
import { SqliteInsightRepository } from './sqlite-insight-repository.js';
import type { SummaryRecord } from '../application/ports/insight-repository.js';

/** Фиксированное «сейчас» для боевой мутации (§19: детерминизм времени). */
const NOW_MS = 1_758_816_000_000;

const FIXED_CLOCK: Clock = {
  nowMs: () => NOW_MS,
  tzOffsetMin: () => 180,
};

/** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** БД на актуальной схеме + адаптер (§19). */
const makeRepo = async (
  name: string,
): Promise<{ db: EncryptedDatabase; repo: SqliteInsightRepository }> => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-insight-repo-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);
  return { db, repo: new SqliteInsightRepository(db) };
};

const PROFILE = 'seed-profile-0001';

/** Фикстура записи резюме (§7) с переопределяемыми полями. */
const record = (over: Partial<SummaryRecord> = {}): SummaryRecord => ({
  id: 's-1',
  profileId: PROFILE,
  period: { fromUtcMs: 1000, toUtcMs: 2000 },
  contextHash: 'a'.repeat(64),
  modelId: 'test-model',
  modelVersion: '1.0.0',
  dataVersion: 3,
  contentMd: 'Разбор периода',
  disclaimerText: 'Это не медицинская консультация.',
  periodText: 'последние 7 дней',
  createdAtUtc: 5000,
  ...over,
});

describe('SqliteInsightRepository — ai_summary v6 (TASK-087 §19)', () => {
  it('(1) save → findByContextHash возвращает запись целиком (все поля §7)', async () => {
    const { db, repo } = await makeRepo('insight-save.sqlite');
    const original = record();
    await repo.save(original);

    const found = await repo.findByContextHash(PROFILE, original.contextHash);
    expect(found).toEqual(original);
    db.close();
  });

  it('(2) findByContextHash скоупится по профилю; нет записи — undefined (не throw)', async () => {
    const { db, repo } = await makeRepo('insight-scope.sqlite');
    await repo.save(record());

    // Чужой профиль с тем же hash — не видит чужое резюме (принудительный скоуп, арх. 08 §3).
    expect(await repo.findByContextHash('other-profile', 'a'.repeat(64))).toBeUndefined();
    // Свои hash/профиль, но записи нет — undefined.
    expect(await repo.findByContextHash(PROFILE, 'b'.repeat(64))).toBeUndefined();
    db.close();
  });

  it('(3) latestForPeriod — новейшая по created_at_utc DESC среди совпавших границ; чужой период — undefined', async () => {
    const { db, repo } = await makeRepo('insight-latest.sqlite');
    await repo.save(record({ id: 's-old', contextHash: 'a'.repeat(64), createdAtUtc: 1000 }));
    await repo.save(record({ id: 's-new', contextHash: 'b'.repeat(64), createdAtUtc: 9000 }));
    await repo.save(
      record({ id: 's-other', contextHash: 'c'.repeat(64), period: { fromUtcMs: 5, toUtcMs: 6 } }),
    );

    const latest = await repo.latestForPeriod(PROFILE, { fromUtcMs: 1000, toUtcMs: 2000 });
    expect(latest?.id).toBe('s-new');
    expect(await repo.latestForPeriod(PROFILE, { fromUtcMs: 777, toUtcMs: 888 })).toBeUndefined();
    expect(await repo.latestForPeriod('ghost', { fromUtcMs: 1000, toUtcMs: 2000 })).toBeUndefined();
    db.close();
  });

  it('(4) deleteAll очищает таблицу (кнопка «Очистить разборы», §8)', async () => {
    const { db, repo } = await makeRepo('insight-delete-all.sqlite');
    await repo.save(record({ id: 's-1', contextHash: 'a'.repeat(64) }));
    await repo.save(record({ id: 's-2', contextHash: 'b'.repeat(64) }));

    await repo.deleteAll();
    expect(await repo.findByContextHash(PROFILE, 'a'.repeat(64))).toBeUndefined();
    expect(await repo.latestForPeriod(PROFILE, { fromUtcMs: 1000, toUtcMs: 2000 })).toBeUndefined();
    db.close();
  });

  it('(5) currentDataVersion читает meta.data_version; мутация измерений bump-ит общий счётчик', async () => {
    const { db, repo } = await makeRepo('insight-version.sqlite');
    expect(await repo.currentDataVersion()).toBe(1); // v1 сеет '1' (TASK-025 §8)

    // Боевая мутация данных — атомарный bump того же meta.data_version (§13).
    const measurement = BpMeasurement.create(
      {
        profileId: PROFILE,
        sys: 120,
        dia: 80,
        pulse: 60,
        irregularPulse: false,
        arm: 'left',
        takenAt: { utcMs: NOW_MS - 60_000, tzOffsetMin: 180 },
      },
      FIXED_CLOCK,
    );
    if (!measurement.ok) {
      throw new Error('фикстура измерения невалидна');
    }
    const added = await new SqliteBpMeasurementRepository(db).add(measurement.value);
    expect(added.ok).toBe(true);
    expect(await repo.currentDataVersion()).toBe(2);
    db.close();
  });

  it('(6) порт асинхронный — методы возвращают Promise (контракт порта)', async () => {
    const { db, repo } = await makeRepo('insight-async.sqlite');
    expect(repo.findByContextHash(PROFILE, 'a'.repeat(64))).toBeInstanceOf(Promise);
    expect(repo.latestForPeriod(PROFILE, { fromUtcMs: 1, toUtcMs: 2 })).toBeInstanceOf(Promise);
    expect(repo.currentDataVersion()).toBeInstanceOf(Promise);
    expect(repo.deleteAll()).toBeInstanceOf(Promise);
    db.close();
  });
});
