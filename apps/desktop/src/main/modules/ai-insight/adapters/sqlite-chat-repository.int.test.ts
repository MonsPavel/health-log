// TASK-089 §19: интеграционные тесты SQLite-адаптера SqliteChatRepository над
// таблицей chat_message миграции v7 (tmp-каталог, реальный SQLCipher-стек:
// openEncrypted → MigrationRunner(MIGRATIONS) — тот же путь, что у приложения,
// прецедент SqliteInsightRepository TASK-087 / SqliteScaleRepository TASK-051).
//
// Матрица:
//  1. append → listRecent возвращает запись целиком (все поля §7: role, content,
//     refusalClass-пометка refusal-ответов, createdAtUtc);
//  2. listRecent скоупится по профилю (принудительный скоуп, арх. 08 §3); пустая
//     история — пустой массив (не throw);
//  3. listRecent — последние N в ХРОНОЛОГИЧЕСКОМ порядке (старые → новые), N
//     уважается: 8-е сообщение вытесняет старейшее из окна (глубина — константа
//     use case, адаптер честно отдаёт limit);
//  4. порядок пары в ОДНУ миллисекунду сохраняется (insertion order — rowid
//     тай-брейк при равных created_at_utc: user до assistant);
//  5. clearAll очищает ВСЮ историю (все профили); повторный clear — ok (§13);
//  6. мусорный refusal_class в БД трактуется как «нет пометки» (undefined, §8);
//  7. сбой хранилища (закрытая БД) → AppError STORAGE/FAILED (контракт ошибок §7).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { SqliteChatRepository } from './sqlite-chat-repository.js';
import type { ChatMessageRecord } from '../application/ports/chat-repository.js';

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
): Promise<{ db: EncryptedDatabase; repo: SqliteChatRepository }> => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-chat-repo-int-'));
  dirs.push(dir);
  const db = openEncrypted(join(dir, name), randomBytes(32).toString('hex'));
  await new MigrationRunner({ migrations: [...MIGRATIONS] }).migrate(db);
  return { db, repo: new SqliteChatRepository(db) };
};

const PROFILE = 'seed-profile-0001';

/** Фикстура сообщения истории (§7) с переопределяемыми полями. */
const message = (over: Partial<ChatMessageRecord> = {}): ChatMessageRecord => ({
  id: 'm-1',
  profileId: PROFILE,
  role: 'user',
  content: 'Почему вечером выше?',
  createdAtUtc: 1000,
  ...over,
});

describe('SqliteChatRepository — chat_message v7 (TASK-089 §19)', () => {
  it('(1) append → listRecent возвращает запись целиком (все поля §7)', async () => {
    const { db, repo } = await makeRepo('chat-save.sqlite');
    const userMessage = message();
    const refusal = message({
      id: 'm-2',
      role: 'assistant',
      content: 'Я не определяю заболевания.',
      refusalClass: 'diagnosis',
      createdAtUtc: 1001,
    });
    await repo.append(userMessage);
    await repo.append(refusal);

    const recent = await repo.listRecent(PROFILE, 10);
    expect(recent).toEqual([userMessage, refusal]);
    db.close();
  });

  it('(2) listRecent скоупится по профилю; пустая история — пустой массив (не throw)', async () => {
    const { db, repo } = await makeRepo('chat-scope.sqlite');
    await repo.append(message());

    // Чужой профиль не видит чужую историю (принудительный скоуп, арх. 08 §3).
    expect(await repo.listRecent('other-profile', 10)).toEqual([]);
    expect(await repo.listRecent(PROFILE, 10)).toHaveLength(1);
    db.close();
  });

  it('(3) listRecent — последние N хронологически; 8-е сообщение вытесняет старейшее из окна', async () => {
    const { db, repo } = await makeRepo('chat-window.sqlite');
    for (let i = 1; i <= 8; i += 1) {
      await repo.append(message({ id: `m-${i}`, content: `ход ${i}`, createdAtUtc: 1000 + i }));
    }

    const window6 = await repo.listRecent(PROFILE, 6);
    // Порядок хронологический (старые → новые — как в промпте диалога, §4).
    expect(window6.map((row) => row.id)).toEqual(['m-3', 'm-4', 'm-5', 'm-6', 'm-7', 'm-8']);
    // Окно уважает limit и при меньшей истории.
    expect((await repo.listRecent(PROFILE, 2)).map((row) => row.id)).toEqual(['m-7', 'm-8']);
    // limit больше размера истории — вся история.
    expect((await repo.listRecent(PROFILE, 100)).map((row) => row.id)).toEqual([
      'm-1',
      'm-2',
      'm-3',
      'm-4',
      'm-5',
      'm-6',
      'm-7',
      'm-8',
    ]);
    db.close();
  });

  it('(4) пара в ОДНУ миллисекунду: порядок insertion (user до assistant) сохраняется', async () => {
    const { db, repo } = await makeRepo('chat-pair-order.sqlite');
    const userMessage = message({ id: 'm-u', createdAtUtc: 5000 });
    const assistant = message({
      id: 'm-a',
      role: 'assistant',
      content: 'Ответ.',
      createdAtUtc: 5000, // та же мс, что у вопроса (use case пишет пару одним ходом)
    });
    await repo.append(userMessage);
    await repo.append(assistant);

    const recent = await repo.listRecent(PROFILE, 10);
    expect(recent.map((row) => row.id)).toEqual(['m-u', 'm-a']);
    db.close();
  });

  it('(5) clearAll очищает ВСЮ историю (все профили); повторный clear — ok (§13 идемпотентность)', async () => {
    const { db, repo } = await makeRepo('chat-clear.sqlite');
    // Второй профиль — реальная строка profile (FK chat_message → profile, v7 DDL).
    db.prepare('INSERT INTO profile (id, name, created_at_utc) VALUES (?, ?, ?)').run(
      'other-profile',
      'Другой',
      1,
    );
    await repo.append(message());
    await repo.append(message({ id: 'm-2', profileId: 'other-profile' }));

    try {
      await repo.clearAll();
      expect(await repo.listRecent(PROFILE, 10)).toEqual([]);
      expect(await repo.listRecent('other-profile', 10)).toEqual([]);
      const rows = db.prepare('SELECT count(*) AS n FROM chat_message').get() as { n: number };
      expect(rows.n).toBe(0);

      // Повторный clear на пустой таблице — успех без ошибки (§13).
      await expect(repo.clearAll()).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('(6) мусорный refusal_class в БД трактуется как «нет пометки» (undefined, §8)', async () => {
    const { db, repo } = await makeRepo('chat-garbage-class.sqlite');
    db.prepare(
      'INSERT INTO chat_message (id, profile_id, role, content, refusal_class, created_at_utc) ' +
        "VALUES ('m-g', ?, 'assistant', 'ответ', 'medication', 1)",
    ).run(PROFILE);

    const recent = await repo.listRecent(PROFILE, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.refusalClass).toBeUndefined();
    db.close();
  });

  it('(7) сбой хранилища (закрытая БД) → AppError STORAGE/FAILED (контракт ошибок §7)', async () => {
    const { db, repo } = await makeRepo('chat-closed.sqlite');
    db.close();

    await expect(repo.append(message())).rejects.toMatchObject({ code: 'STORAGE/FAILED' });
    await expect(repo.listRecent(PROFILE, 6)).rejects.toMatchObject({ code: 'STORAGE/FAILED' });
    await expect(repo.clearAll()).rejects.toMatchObject({ code: 'STORAGE/FAILED' });
  });
});
