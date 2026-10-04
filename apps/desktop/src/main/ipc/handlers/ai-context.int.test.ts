// TASK-083 §11/§19/§20: интеграционный тест канала `ai/context/preview` — полный
// путь «запрос рендерера → каркас (zod) → хендлер → AiContextBuilder → адаптеры
// (точки с заметками, stats 054, series 056, шкала 051) → шифрованная SQLite»
// через контейнер (прецедент stats.int.test.ts). Матрица:
//  1. записи с заметкой через measurements/add → preview includeNotes=true:
//     ответ парсится схемой канала, text содержит заметку и секции, hash — hex 64;
//  2. excludeNotes: секции 'notes' нет, ни байта заметки, hash изменился (§14/§20);
//  3. детерминизм: одинаковые запросы — байт-одинаковые ответы (§13);
//  4. modelId резолвится из prefs.aiSettings: смена модели меняет hash (§2/§5);
//  5. разрыв ≥7 дней сквозно от БД: текст содержит строку разрыва (EC-08);
//  6. каркас: мусорный payload → VALIDATION/FAILED до хендлера (§14);
//  7. лог §18 не содержит текста контекста (PHI, §14) — проверка spy-логгером.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA } from '@hl/contracts';
import { AppError, FixedClock, Instant, type Result, ok } from '@hl/kernel';

import { buildContainer } from '../../container.js';
import { createAiContextPreviewHandler } from './ai-context.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from '../../modules/security/application/ports/key-vault.js';

/** Фиксированный тестовый ключ мок-vault (§19). */
const KEY_HEX = 'ab'.repeat(32);

/** «Сейчас» FixedClock — после всех фикстурных дат. */
const NOW_MS = Instant.fromIso('2026-03-31T12:00:00.000+03:00').utcMs;
/** Пояс фикстур +03:00 → 180 минут. */
const TZ = 180;

/** Свежий tmp-userData; удаление — в конце кейса (§14). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-ai-context-int-'));

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

/** Запись одного измерения через канал measurements/add (полный путь записи). */
const addMeasurement = async (
  container: Awaited<ReturnType<typeof makeContainer>>,
  dayIso: string,
  wallTime: string,
  note?: string,
): Promise<void> => {
  const takenAt = Instant.fromIso(`${dayIso}T${wallTime}:00.000+03:00`);
  const envelope = await container.channels.dispatch({
    channel: 'measurements/add',
    payload: {
      profileId: 'profile-1',
      sys: 122,
      dia: 81,
      pulse: 64,
      irregularPulse: false,
      arm: 'left',
      takenAt: { utcMs: takenAt.utcMs, tzOffsetMin: takenAt.tzOffsetMin },
      ...(note !== undefined ? { note } : {}),
    },
  });
  expect(envelope).toMatchObject({ ok: true });
};

/** Вызов ai/context/preview через каркас. */
const preview = (
  container: Awaited<ReturnType<typeof makeContainer>>,
  payload: unknown,
): ReturnType<typeof container.channels.dispatch> =>
  container.channels.dispatch({ channel: 'ai/context/preview', payload });

describe('ai/context/preview через контейнер — полный путь (TASK-083 §20)', () => {
  it('(1) записи с заметкой → ответ по схеме: text+sections+hash, заметка в тексте (§11)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      await addMeasurement(container, '2026-03-02', '07:30', 'измерил после подъёма');
      await addMeasurement(container, '2026-03-03', '20:10');

      const envelope = await preview(container, {
        profileId: 'profile-1',
        period: 'all',
        includeNotes: true,
      });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.sections).toContain('notes');
      expect(parsed.sections).toContain('period');
      expect(parsed.text).toContain('# Период [period]');
      expect(parsed.text).toContain('02.03 — измерил после подъёма');
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(2) excludeNotes: секции нет, ни байта заметки, hash изменился (§14/§20)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      await addMeasurement(container, '2026-03-02', '07:30', 'измерил после подъёма');

      const withNotes = await preview(container, {
        profileId: 'profile-1',
        period: 'all',
        includeNotes: true,
      });
      const withoutNotes = await preview(container, {
        profileId: 'profile-1',
        period: 'all',
        includeNotes: false,
      });
      expect(withNotes).toMatchObject({ ok: true });
      expect(withoutNotes).toMatchObject({ ok: true });
      if (!withNotes.ok || !withoutNotes.ok) {
        return;
      }
      const a = AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA.parse(withNotes.data);
      const b = AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA.parse(withoutNotes.data);
      expect(b.sections).not.toContain('notes');
      expect(b.text).not.toContain('измерил после подъёма');
      expect(b.text).not.toContain('[notes]');
      expect(b.hash).not.toBe(a.hash);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(3) детерминизм: одинаковые запросы — байт-одинаковые ответы (§13)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      await addMeasurement(container, '2026-03-02', '07:30');
      const first = await preview(container, {
        profileId: 'profile-1',
        period: 'all',
        includeNotes: false,
      });
      const second = await preview(container, {
        profileId: 'profile-1',
        period: 'all',
        includeNotes: false,
      });
      expect(second).toEqual(first);
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(4) modelId из prefs.aiSettings: смена модели меняет hash (§2/§5)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      await addMeasurement(container, '2026-03-02', '07:30');
      const before = await preview(container, {
        profileId: 'profile-1',
        period: 'all',
        includeNotes: false,
      });
      const prefs = await container.channels.dispatch({
        channel: 'prefs/set',
        payload: { patch: { aiSettings: { modelId: 'model-a' } } },
      });
      expect(prefs).toMatchObject({ ok: true });
      const after = await preview(container, {
        profileId: 'profile-1',
        period: 'all',
        includeNotes: false,
      });
      expect(before).toMatchObject({ ok: true });
      expect(after).toMatchObject({ ok: true });
      if (!before.ok || !after.ok) {
        return;
      }
      expect((after.data as { hash: string }).hash).not.toBe(
        (before.data as { hash: string }).hash,
      );
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(5) разрыв 14 дней сквозно от БД: строка разрыва в тексте (EC-08)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      await addMeasurement(container, '2026-03-01', '08:00');
      await addMeasurement(container, '2026-03-22', '08:00');
      const envelope = await preview(container, {
        profileId: 'profile-1',
        period: 'all',
        includeNotes: false,
      });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const parsed = AI_CONTEXT_PREVIEW_RESPONSE_SCHEMA.parse(envelope.data);
      expect(parsed.sections).toContain('gaps');
      // Записи 01.03 и 22.03: дни без записей 02.03–21.03 = 20 (≥7 → разрыв, §13).
      expect(parsed.text).toContain('02.03–21.03 (20 дней)');
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(6) каркас: мусорный payload → VALIDATION/FAILED до хендлера (§14)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      for (const payload of [
        { period: 'all', includeNotes: true }, // нет profileId
        { profileId: 'profile-1', period: 'all' }, // нет includeNotes
        { profileId: 'profile-1', period: 'all', includeNotes: 'yes' }, // не boolean
        { profileId: 'profile-1', period: 'all', includeNotes: true, modelId: 'x' }, // лишнее (strict)
      ]) {
        const envelope = await preview(container, payload);
        expect(envelope).toMatchObject({ ok: false });
        if (!envelope.ok) {
          expect(envelope.error.code).toBe('VALIDATION/FAILED');
        }
      }
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(7) лог хендлера не содержит текста контекста — только агрегаты (§14/§18)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      await addMeasurement(container, '2026-03-02', '07:30', 'секретная заметка');
      // Хендлер напрямую со шпион-логгером: форма записи §18 без PHI (§14).
      const calls: Array<[string, Record<string, unknown> | undefined]> = [];
      const spyLogger = {
        info: (message: string, meta?: Record<string, unknown>) => {
          calls.push([message, meta]);
        },
      };
      const handler = createAiContextPreviewHandler(
        container.aiContext,
        () => Promise.resolve('test-model'),
        spyLogger,
      );
      const response = await handler({
        profileId: 'profile-1',
        period: 'all',
        includeNotes: true,
      });
      expect(response.text).toContain('секретная заметка');
      expect(calls.length).toBeGreaterThan(0);
      for (const [message, meta] of calls) {
        expect(message).not.toContain('секретная заметка');
        expect(JSON.stringify(meta ?? {})).not.toContain('секретная заметка');
      }
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
