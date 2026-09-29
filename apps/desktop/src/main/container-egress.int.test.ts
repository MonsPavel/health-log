/**
 * TASK-075 §9/§19/§20: интеграционный тест боевой проводки EgressGateway —
 * контейнер собирает singleton, согласия читает из РЕАЛЬНОГО PreferencesService
 * (дефолт схемы — согласия НЕ выданы, §14 «приватность first»), журнал — в боевой
 * БД контейнера (v5 network_event).
 *
 * Сценарий (ручная проверка §24 «revoke consent → попытка → BLOCKED», автоматизированная):
 *  - request('models.download') на сборке БЕЗ выданных согласий → AppError
 *    NET/BLOCKED_BY_POLICY {op} — быстрый отказ ДО сети (fetch-деп контейнера —
 *    globalThis.fetch-фолбэк, в тестах заблокирован guard'ом FR-7.2: любое обращение
 *    к сети упало бы громко);
 *  - в журнале контейнера появилась blocked-запись (kind/endpoint/status) —
 *    пользовательский журнал честен и про отказы (§9);
 *  - повторная сборка на том же userData: запись журнала цела (миграция v5
 *    идемпотентна, gateway не дублирует схему).
 *
 * Хелперы (мок-vault, tmp-userData) повторяют container.int.test.ts: импорт
 * тест-файла в тест-файл регистрировал бы его describe-блоки повторно — копия
 * (прецедент container-pdf.int.test.ts).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, FixedClock, type Clock, type Result } from '@hl/kernel';

import { buildContainer, DATABASE_FILENAME } from './container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';
import { EgressGateway } from './modules/platform-services/egress/egress-gateway.js';

const KEY_HEX = 'ab'.repeat(32);
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-egress-int-'));

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
}

const makeDeps = (dir: string, clock: Clock) => ({
  userDataPath: dir,
  clock,
  vault: () => new MockVault(KEY_HEX),
});

describe('container + EgressGateway (TASK-075 §9/§19/§20)', () => {
  const dir = newUserDataDir();
  const clock = new FixedClock(NOW_MS, TZ);

  /** Контейнеры сценария — закрываются в afterAll (крайний случай при падении теста). */
  let container1: Awaited<ReturnType<typeof buildContainer>> | undefined;
  let container2: Awaited<ReturnType<typeof buildContainer>> | undefined;

  afterAll(() => {
    try {
      container1?.close();
    } catch {
      // закрыт самим сценарием — не важно для очистки
    }
    try {
      container2?.close();
    } catch {
      // закрыт самим сценарием — не важно для очистки
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('первый старт: gateway singleton в контейнере; запрос без согласия → NET/BLOCKED_BY_POLICY + blocked-запись в журнале (быстрый отказ до сети)', async () => {
    container1 = await buildContainer(makeDeps(dir, clock));

    const egress: EgressGateway = container1.egress;
    expect(egress).toBeInstanceOf(EgressGateway);

    const error: AppError = await egress
      .request('models.download', { endpoint: 'https://cdn.example.com/llm.bin' })
      .then(
        () => {
          throw new Error('ожидался отказ NET/BLOCKED_BY_POLICY (согласия нет по умолчанию)');
        },
        (cause: unknown) => cause as AppError,
      );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('NET/BLOCKED_BY_POLICY');
    expect(error.params).toEqual({ op: 'models.download' });

    const blocked = container1.db
      .prepare('SELECT kind, endpoint, status, bytes FROM network_event')
      .all() as { kind: string; endpoint: string; status: string; bytes: number | null }[];
    expect(blocked).toEqual([
      {
        kind: 'models.download',
        endpoint: 'https://cdn.example.com/llm.bin',
        status: 'blocked',
        bytes: null,
      },
    ]);

    // §5: helper listRecent читает тот же журнал.
    expect(egress.listRecent(1)).toHaveLength(1);
    expect(egress.listRecent(1)[0]?.status).toBe('blocked');
  });

  it('повторный старт на том же userData: blocked-запись журнала цела, gateway работает дальше', async () => {
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true);
    container2 = await buildContainer(makeDeps(dir, clock));

    const error: AppError = await container2.egress
      .request('updates.check', { endpoint: 'https://releases.example.com/latest' })
      .then(
        () => {
          throw new Error('ожидался отказ NET/BLOCKED_BY_POLICY');
        },
        (cause: unknown) => cause as AppError,
      );
    expect(error.code).toBe('NET/BLOCKED_BY_POLICY');

    const events = container2.db
      .prepare('SELECT kind, status FROM network_event ORDER BY at_utc, id')
      .all() as { kind: string; status: string }[];
    expect(events).toEqual([
      { kind: 'models.download', status: 'blocked' },
      { kind: 'updates.check', status: 'blocked' },
    ]);
  });
});
