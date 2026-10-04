// TASK-045 §11/§19/§20: интеграционный тест канала `notes/search` — полный путь
// «запрос → каркас (zod) → use case SearchNotes → адаптер FTS5 → шифрованная SQLite»
// через контейнер (прецедент measurements.int.test.ts TASK-030). Матрица:
//  - добавил запись с заметкой (measurements/add) → notes/search находит её токеном
//    (доказывает и CRUD-синхронизацию индекса на живом контейнере — §20 AC2);
//  - мусорный запрос → конверт ok с пустым items — НЕ ошибка (§11/§20 AC5);
//  - инъекция `test" OR 1=1` → ok без ошибки SQL (§20 AC4);
//  - query >100 символов → VALIDATION/FAILED каркаса (§7);
//  - limit 201 → VALIDATION/FAILED (§11).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  API_ENVELOPE_VERSION,
  MEASUREMENT_ADD_RESPONSE_SCHEMA,
  NOTES_SEARCH_RESPONSE_SCHEMA,
} from '@hl/contracts';
import { AppError, FixedClock, type Result, ok } from '@hl/kernel';

import { buildContainer } from '../../container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from '../../modules/security/application/ports/key-vault.js';

/** Фиксированный тестовый ключ мок-vault (§19). */
const KEY_HEX = 'ab'.repeat(32);

/** Фиксированное «сейчас» FixedClock (2025-09-25T16:00:00Z). */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

/** Свежий tmp-userData; удаление — в конце кейса (§14). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-notes-search-int-'));

/** Мок-vault (§19): фиксированный ключ без safeStorage. */
class MockVault implements KeyVault {
  private ensured = 0;

  /** TASK-121 §3: импорт ключа из копии — мок-заглушка (сценарий восстановление не зовёт). */
  importKey(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

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

  // TASK-093 §5/§7: парольные режимы в этом сценарии не используются — нейтральные
  // заглушки контракта (сессия всегда разблокирована, mode='none').
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

  // TASK-094 §5: сброс сессии в mode=none — no-op (мок; см. порт key-vault).
  lock(): void {}

  getMode(): 'none' {
    return 'none';
  }
}

/** Контейнер на tmp-userData с профилем-владельцем (FK v1, прецедент TASK-030). */
const makeContainer = async (dir: string) => {
  const container = await buildContainer({
    userDataPath: dir,
    clock: new FixedClock(NOW_MS, TZ),
    vault: () => new MockVault(),
  });
  container.db
    .prepare(
      "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0)",
    )
    .run();
  return container;
};

describe('notes/search через контейнер — полный путь (TASK-045 §20)', () => {
  it('add с заметкой → поиск токена находит запись; ответ парсится схемой канала (§20 AC1/AC2)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const added = await container.channels.dispatch({
        channel: 'measurements/add',
        payload: {
          profileId: 'profile-1',
          sys: 125,
          dia: 82,
          irregularPulse: false,
          arm: 'left',
          note: 'болела голова после кофе',
          takenAt: { utcMs: NOW_MS, tzOffsetMin: TZ },
        },
      });
      expect(added).toMatchObject({ ok: true });
      if (!added.ok) {
        return;
      }
      const addedDto = MEASUREMENT_ADD_RESPONSE_SCHEMA.parse(added.data).measurement;

      const envelope = await container.channels.dispatch({
        channel: 'notes/search',
        payload: { query: 'голова' },
      });

      expect(envelope).toMatchObject({ v: API_ENVELOPE_VERSION, ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = NOTES_SEARCH_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]).toMatchObject({ note: 'болела голова после кофе', sys: 125 });
      expect(parsed.items[0]?.critical).toBeUndefined();

      // Обновление заметки (measurements/update) → поиск по НОВОЙ находит, по старой нет.
      // Схема update (TASK-028) — strict {id, …поля правки} без profileId.
      const id = addedDto.id;
      const updated = await container.channels.dispatch({
        channel: 'measurements/update',
        payload: {
          id,
          sys: 125,
          dia: 82,
          irregularPulse: false,
          arm: 'left',
          note: 'болит голова от экрана',
          takenAt: { utcMs: NOW_MS, tzOffsetMin: TZ },
        },
      });
      expect(updated).toMatchObject({ ok: true });

      const afterUpdate = await container.channels.dispatch({
        channel: 'notes/search',
        payload: { query: 'болит' },
      });
      if (!afterUpdate.ok) {
        return;
      }
      expect(NOTES_SEARCH_RESPONSE_SCHEMA.parse(afterUpdate.data).items.map((m) => m.id)).toEqual([
        id,
      ]);

      const oldNote = await container.channels.dispatch({
        channel: 'notes/search',
        payload: { query: 'кофе' },
      });
      if (!oldNote.ok) {
        return;
      }
      expect(NOTES_SEARCH_RESPONSE_SCHEMA.parse(oldNote.data).items).toEqual([]);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('мусорный и пустой запрос → ok с items: [] — не ошибка (§11/§20 AC5)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      for (const query of ['test" OR 1=1', '', '"""', '*']) {
        const envelope = await container.channels.dispatch({
          channel: 'notes/search',
          payload: { query },
        });
        expect(envelope).toMatchObject({ ok: true });
        if (!envelope.ok) {
          continue;
        }
        expect(envelope.data).toEqual({ items: [] });
      }
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('query >100 символов и limit 201 → VALIDATION/FAILED (§7/§11)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const long = await container.channels.dispatch({
        channel: 'notes/search',
        payload: { query: 'а'.repeat(101) },
      });
      expect(long).toMatchObject({ ok: false });
      if (!long.ok) {
        expect(long.error.code).toBe('VALIDATION/FAILED');
      }

      const limit = await container.channels.dispatch({
        channel: 'notes/search',
        payload: { query: 'кофе', limit: 201 },
      });
      expect(limit).toMatchObject({ ok: false });
      if (!limit.ok) {
        expect(limit.error.code).toBe('VALIDATION/FAILED');
      }
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
