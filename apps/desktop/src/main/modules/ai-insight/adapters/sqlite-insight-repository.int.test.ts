// TASK-087 §19: интеграционные тесты SQLite-адаптера SqliteInsightRepository над
// таблицей ai_summary миграции v6 (tmp-каталог, реальный SQLCipher-стек:
// openEncrypted → MigrationRunner(MIGRATIONS) — тот же путь, что у приложения,
// прецедент SqliteScaleRepository TASK-051 / SqliteBpMeasurementRepository TASK-026).
//
// Матрица:
//  1. save → findByContextHash возвращает запись целиком (все поля §7, включая
//     periodParam, служебные disclaimerText/periodText и dataVersion);
//  2. findByContextHash скоупится по профилю: тот же hash чужого профиля — undefined;
//     нет записи — undefined (не throw, §7);
//  3. latestForPeriod (§12/ревью TASK-087): пресет/'all' сопоставляется по
//     каноническому period_param (границы записи — метаданные, «движутся» с now
//     момента генерации), custom — по точным границам; новейшая по
//     (created_at_utc DESC, id DESC); чужой период/профиль/пустая таблица — undefined;
//  4. deleteAll очищает таблицу (кнопка «Очистить разборы», §8);
//  5. currentDataVersion читает meta.data_version (v1 сеет '1'); изменение строки
//     meta (bump мутаций данных) порт видит — основа stale-расчёта §7;
//  6. порт асинхронный — методы возвращают Promise (контракт порта, §19 051).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { SqliteInsightRepository } from './sqlite-insight-repository.js';
import type { SummaryRecord } from '../application/ports/insight-repository.js';

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
  periodParam: 'custom',
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

  it('(3) latestForPeriod: пресет по period_param (границы записи — метаданные), custom по границам; чужой период — undefined', async () => {
    const { db, repo } = await makeRepo('insight-latest.sqlite');
    // Пресет '30d': границы записи — от now момента ГЕНЕРАЦИИ (T1=1000..2000).
    await repo.save(
      record({
        id: 's-old',
        periodParam: '30d',
        period: { fromUtcMs: 1000, toUtcMs: 2000 },
        contextHash: 'a'.repeat(64),
        createdAtUtc: 1000,
      }),
    );
    await repo.save(
      record({
        id: 's-new',
        periodParam: '30d',
        period: { fromUtcMs: 1000, toUtcMs: 2000 },
        contextHash: 'b'.repeat(64),
        createdAtUtc: 9000,
      }),
    );
    // Другой пресет и custom — не матчатся '30d'.
    await repo.save(
      record({
        id: 's-7d',
        periodParam: '7d',
        period: { fromUtcMs: 5000, toUtcMs: 6000 },
        contextHash: 'c'.repeat(64),
      }),
    );
    await repo.save(
      record({
        id: 's-custom',
        periodParam: 'custom',
        period: { fromUtcMs: 7000, toUtcMs: 8000 },
        contextHash: 'd'.repeat(64),
      }),
    );

    // Ревью TASK-087: сопоставление по каноническому параметру — запрос при ДРУГОМ now
    // (запрос шлёт только '30d', никаких границ) находит запись, чьи границы от T1.
    const latest = await repo.latestForPeriod(PROFILE, '30d');
    expect(latest?.id).toBe('s-new'); // новейшая по created_at_utc DESC
    expect(latest?.period).toEqual({ fromUtcMs: 1000, toUtcMs: 2000 }); // метаданные T1

    // Чужой пресет — мимо; custom ищется ТОЛЬКО по точным границам.
    expect(await repo.latestForPeriod(PROFILE, '90d')).toBeUndefined();
    expect(await repo.latestForPeriod(PROFILE, 'all')).toBeUndefined();
    const custom = await repo.latestForPeriod(PROFILE, { fromUtcMs: 7000, toUtcMs: 8000 });
    expect(custom?.id).toBe('s-custom');
    // Границы «двинувшегося» пресета НЕ матчатся custom-запросом (пресет ≠ custom).
    expect(await repo.latestForPeriod(PROFILE, { fromUtcMs: 1000, toUtcMs: 2000 })).toBeUndefined();
    // Чужой профиль — мимо (скоуп §3).
    expect(await repo.latestForPeriod('ghost', '30d')).toBeUndefined();
    db.close();
  });

  it('(4) deleteAll очищает таблицу (кнопка «Очистить разборы», §8)', async () => {
    const { db, repo } = await makeRepo('insight-delete-all.sqlite');
    await repo.save(record({ id: 's-1', contextHash: 'a'.repeat(64) }));
    await repo.save(record({ id: 's-2', contextHash: 'b'.repeat(64) }));

    await repo.deleteAll();
    expect(await repo.findByContextHash(PROFILE, 'a'.repeat(64))).toBeUndefined();
    expect(await repo.latestForPeriod(PROFILE, '30d')).toBeUndefined();
    expect(await repo.latestForPeriod(PROFILE, { fromUtcMs: 1000, toUtcMs: 2000 })).toBeUndefined();
    db.close();
  });

  it('(5) currentDataVersion читает meta.data_version; мутация данных bump-ит общий счётчик', async () => {
    const { db, repo } = await makeRepo('insight-version.sqlite');
    expect(await repo.currentDataVersion()).toBe(1); // v1 сеет '1' (TASK-025 §8)

    // Мутация данных двигает ТОТ ЖЕ счётчик meta.data_version (атомарно с записью —
    // §13; сам bump мутаций — адаптер измерений, сквозной add-тест — full-cycle int
    // в корне main). Здесь — чтение порта после изменения строки meta.
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'data_version'").run();
    expect(await repo.currentDataVersion()).toBe(2);
    db.close();
  });

  it('(6) порт асинхронный — методы возвращают Promise (контракт порта)', async () => {
    const { db, repo } = await makeRepo('insight-async.sqlite');
    expect(repo.findByContextHash(PROFILE, 'a'.repeat(64))).toBeInstanceOf(Promise);
    expect(repo.latestForPeriod(PROFILE, '30d')).toBeInstanceOf(Promise);
    expect(repo.currentDataVersion()).toBeInstanceOf(Promise);
    expect(repo.deleteAll()).toBeInstanceOf(Promise);
    db.close();
  });
});
