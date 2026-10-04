// TASK-051 §11/§19/§20: интеграционный тест канала `scales/active` — полный путь
// «запрос рендерера → каркас (zod) → ScaleService → SqliteScaleRepository →
// шифрованная SQLite» через контейнер (прецедент prefs.int.test.ts TASK-047).
// Матрица:
//  1. сборка контейнера на свежем userData = «первый старт» (AC2): в БД ровно одна
//     активированная строка reference_scale (версия данных пакета);
//  2. scales/active → полная форма ActiveScale; golden-сверка с пакетом (AC4):
//     категории (пары границ) и обе заметки равны BP_OFFICE_ESC2018;
//  3. перезапуск контейнера (close → build на том же userData) — идемпотентность
//     полного пути: ответ тот же, строк в reference_scale по-прежнему одна (AC2);
//  4. повреждённый data_json (UPDATE напрямую SQL, до первого чтения — кэш пуст)
//     → ok:false, error.code = STORAGE/CORRUPT (AC5: понятная ошибка, не тихий
//     дефолт);
//  5. каркас: невалидный payload ({code:…}) → VALIDATION/FAILED до хендлера.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SCALES_ACTIVE_RESPONSE_SCHEMA } from '@hl/contracts';
import { BP_OFFICE_ESC2018 } from '@hl/scales-data';
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

/** Фиксированное «сейчас» FixedClock. */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

/** Свежий tmp-userData; удаление — в конце кейса (§14). */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-scales-int-'));

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

const makeContainer = async (dir: string) =>
  buildContainer({
    userDataPath: dir,
    clock: new FixedClock(NOW_MS, TZ),
    vault: () => new MockVault(),
  });

describe('scales/active через контейнер — полный путь (TASK-051 §20)', () => {
  it('(1) первый старт: шкала активирована при сборке — одна активная строка версии пакета (AC2)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const rows = container.db
        .prepare(
          'SELECT code, version, source_label, activated_at_utc FROM reference_scale ' +
            'WHERE activated_at_utc IS NOT NULL',
        )
        .all() as {
        code: string;
        version: string;
        source_label: string;
        activated_at_utc: number;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        code: BP_OFFICE_ESC2018.code,
        version: BP_OFFICE_ESC2018.version,
        source_label: BP_OFFICE_ESC2018.sourceLabel,
      });
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(2) scales/active → полная форма; golden-сверка с пакетом: категории и обе заметки (AC4)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const envelope = await container.channels.dispatch({ channel: 'scales/active', payload: {} });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const active = SCALES_ACTIVE_RESPONSE_SCHEMA.parse(envelope.data);
      expect(active).toEqual({
        code: BP_OFFICE_ESC2018.code,
        version: BP_OFFICE_ESC2018.version,
        sourceLabel: BP_OFFICE_ESC2018.sourceLabel,
        categories: BP_OFFICE_ESC2018.categories,
        homeBPNote: BP_OFFICE_ESC2018.homeBPNote,
        specialGroupsNote: BP_OFFICE_ESC2018.specialGroupsNote,
      });
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(3) перезапуск контейнера — идемпотентность: строка одна, ответ тот же (AC2)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    let rebuilt: Awaited<ReturnType<typeof makeContainer>> | undefined;
    try {
      container.close();
      rebuilt = await makeContainer(dir);

      const rows = rebuilt.db.prepare('SELECT count(*) AS n FROM reference_scale').get() as {
        n: number;
      };
      expect(rows.n).toBe(1);

      const envelope = await rebuilt.channels.dispatch({
        channel: 'scales/active',
        payload: {},
      });
      expect(envelope).toMatchObject({ ok: true });
      if (!envelope.ok) {
        return;
      }
      const active = SCALES_ACTIVE_RESPONSE_SCHEMA.parse(envelope.data);
      expect(active.version).toBe(BP_OFFICE_ESC2018.version);
      expect(active.categories).toHaveLength(6);
    } finally {
      rebuilt?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(4) повреждённый data_json → ok:false STORAGE/CORRUPT, не тихий дефолт (AC5)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      container.db.prepare("UPDATE reference_scale SET data_json = '{not json'").run();

      const envelope = await container.channels.dispatch({ channel: 'scales/active', payload: {} });
      expect(envelope).toMatchObject({ ok: false });
      if (envelope.ok) {
        return;
      }
      expect(envelope.error.code).toBe('STORAGE/CORRUPT');
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(5) каркас: непустой payload → VALIDATION/FAILED до хендлера (§14)', async () => {
    const dir = newUserDataDir();
    const container = await makeContainer(dir);
    try {
      const envelope = await container.channels.dispatch({
        channel: 'scales/active',
        payload: { code: 'bp_office_esc2018' },
      });
      expect(envelope).toMatchObject({ ok: false });
      if (envelope.ok) {
        return;
      }
      expect(envelope.error.code).toBe('VALIDATION/FAILED');
    } finally {
      container.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
