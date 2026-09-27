// TASK-051 §19: интеграционные тесты SQLite-адаптера SqliteScaleRepository над
// таблицей reference_scale миграции v4 (tmp-каталог, реальный SQLCipher-стек:
// openEncrypted → MigrationRunner(MIGRATIONS) — тот же путь, что у приложения,
// прецедент sqlite-measurement-repository TASK-026).
//
// Матрица:
//  1. insert + activate → findActiveByCode возвращает запись целиком (data_json,
//     source_label, activated_at_utc = момент из Clock — время через инъекцию, §13);
//  2. активность = max activated_at_utc на code (§13): новая версия активна,
//     старая остаётся в истории; записи с activated_at_utc NULL активными не
//     считаются; нет записей → undefined;
//  3. insert дубля (code, version) → AppError STORAGE/CONSTRAINT (§8 UNIQUE —
//     защита от дублей при повторной активации);
//  4. activate несуществующего id — no-op без ошибки (0 строк — контракт сервиса:
//     activate вызывается сразу после insert);
//  5. порт асинхронный — методы возвращают Promise (контракт порта, прецедент
//     SettingsStore TASK-047: better-sqlite3 синхронный, Promise-обёртка).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, type Clock } from '@hl/kernel';

import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { SqliteScaleRepository } from './sqlite-scale-repository.js';

const NOW_MS = 1_758_816_000_000;

/** Тикающие часы: первый nowMs() = NOW_MS, каждый следующий +1 мс — разные активации имеют разные моменты. */
class TickingClock implements Clock {
  private current = NOW_MS;

  nowMs(): number {
    const value = this.current;
    this.current += 1;
    return value;
  }

  tzOffsetMin(): number {
    return 180;
  }
}

/** tmp-каталоги этой сессии — удаляются в afterAll (§14). */
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** БД на актуальной схеме + адаптер с FixedClock (§19: детерминизм времени). */
const makeRepo = async (
  name: string,
): Promise<{ db: EncryptedDatabase; repo: SqliteScaleRepository }> => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-scale-repo-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);
  return { db, repo: new SqliteScaleRepository(db, { clock: new TickingClock() }) };
};

const CODE = 'bp_office_esc2018';

const insertVersion = (
  repo: SqliteScaleRepository,
  id: string,
  version: string,
  dataJson = '{"code":"bp_office_esc2018"}',
): Promise<void> => repo.insert({ id, code: CODE, version, sourceLabel: 'ESC/ESH 2018', dataJson });

describe('SqliteScaleRepository — reference_scale v4 (TASK-051 §19)', () => {
  it('(1) insert + activate → findActiveByCode возвращает запись с activatedAtUtc из Clock', async () => {
    const { db, repo } = await makeRepo('scale-repo-insert.sqlite');

    await insertVersion(repo, 's-1', '1.0.0', '{"code":"bp_office_esc2018","version":"1.0.0"}');
    await repo.activate('s-1');

    const active = await repo.findActiveByCode(CODE);
    expect(active).toEqual({
      id: 's-1',
      code: CODE,
      version: '1.0.0',
      sourceLabel: 'ESC/ESH 2018',
      dataJson: '{"code":"bp_office_esc2018","version":"1.0.0"}',
      activatedAtUtc: NOW_MS,
    });
    db.close();
  });

  it('(2) активность = max activated_at_utc на code; NULL-записи не активны; пусто → undefined (§13)', async () => {
    const { db, repo } = await makeRepo('scale-repo-activity.sqlite');

    expect(await repo.findActiveByCode(CODE)).toBeUndefined();

    await insertVersion(repo, 's-1', '1.0.0');
    await repo.activate('s-1');
    await insertVersion(repo, 's-2', '1.1.0');

    // С NULL-activated запись не считается активной; после активации — побеждает max.
    const before = await repo.findActiveByCode(CODE);
    expect(before?.version).toBe('1.0.0');

    await repo.activate('s-2');
    const after = await repo.findActiveByCode(CODE);
    expect(after?.id).toBe('s-2');
    expect(after?.version).toBe('1.1.0');

    // История цела: обе версии в таблице.
    const history = db.prepare('SELECT count(*) AS n FROM reference_scale').get() as { n: number };
    expect(history.n).toBe(2);

    // Чужой code — пусто.
    expect(await repo.findActiveByCode('bp_home_esc2018')).toBeUndefined();
    db.close();
  });

  it('(3) дубль (code, version) → AppError STORAGE/CONSTRAINT (§8 UNIQUE)', async () => {
    const { db, repo } = await makeRepo('scale-repo-unique.sqlite');
    await insertVersion(repo, 's-1', '1.0.0');

    let error: unknown;
    try {
      await insertVersion(repo, 's-2', '1.0.0');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STORAGE/CONSTRAINT');
    db.close();
  });

  it('(4) activate несуществующего id — no-op без ошибки; таблица не меняется', async () => {
    const { db, repo } = await makeRepo('scale-repo-activate-noop.sqlite');
    await insertVersion(repo, 's-1', '1.0.0');

    await expect(repo.activate('no-such-id')).resolves.toBeUndefined();

    const rows = db
      .prepare('SELECT count(*) AS n FROM reference_scale WHERE activated_at_utc IS NOT NULL')
      .get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  it('(5) порт асинхронный: методы возвращают Promise (контракт порта)', async () => {
    const { db, repo } = await makeRepo('scale-repo-async.sqlite');
    expect(repo.findActiveByCode(CODE)).toBeInstanceOf(Promise);
    await Promise.all([
      repo.findActiveByCode(CODE),
      insertVersion(repo, 's-1', '1.0.0'),
      repo.activate('s-1'),
    ]);
    db.close();
  });
});
