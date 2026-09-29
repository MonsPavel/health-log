// TASK-068 §5/§9/§11: интеграционный тест боевой проводки — контейнер собирает
// use case BuildPdfReport (адаптеры точек/статистики над боевой БД, рендер — через
// WorkerPool, запись — через ОБЩУЮ fileOpQueue) и регистрирует каналы
// `report/pdf` и `app/reveal-path` в реестре каркаса (§11 — регистрация при сборке).
//
// Диалог Electron в node-окружении недоступен — до записи файла здесь не доходит:
// на ПУСТОЙ БД канал честно отвечает REPORT/EMPTY_PERIOD (count-запрос §9 — полный
// боевой путь схемы → хендлера → use case → адаптера точек), битый payload —
// VALIDATION/FAILED (схема strict §14). reveal — fire-and-forget: боевой адаптер
// (ленивый electron) отказ глушится обвязкой — канал отвечает ok null (§9).
//
// Хелперы (мок-vault, tmp-userData) повторяют container-report.int.test.ts: импорт
// тест-файла в тест-файл регистрировал бы его describe-блоки повторно — копия.
//
// §20-6 (автоматический эквивалент): electron мокается на уровне модуля
// (прецедент report.int.test.ts) — канал app/reveal-path проверяется ДО боевого
// shell.showItemInFolder: путь из save-диалога доходит до shell БЕЗ изменений.
// Сам эффект ОС (окно проводника с подсвеченным файлом) — ручная приёмка §20-6/§24.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { showItemInFolder } = vi.hoisted(() => ({ showItemInFolder: vi.fn() }));
vi.mock('electron', () => ({ shell: { showItemInFolder } }));

import { AppError, FixedClock, type Result } from '@hl/kernel';

import { buildContainer } from './container.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

const KEY_HEX = 'ab'.repeat(32);
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-pdf-int-'));

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

describe('container + каналы report/pdf и app/reveal-path (TASK-068 §9/§11)', () => {
  const dir = newUserDataDir();
  let container: Awaited<ReturnType<typeof buildContainer>> | undefined;

  afterAll(() => {
    try {
      container?.close();
    } catch {
      // повторное закрытие — no-op (§8 идемпотентность)
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('report/pdf зарегистрирован: пустая БД → REPORT/EMPTY_PERIOD (полный путь до use case, §9)', async () => {
    container = await buildContainer({
      userDataPath: dir,
      clock: new FixedClock(NOW_MS, TZ),
      vault: () => new MockVault(),
    });

    const envelope = await container.channels.dispatch({
      channel: 'report/pdf',
      payload: {
        profileId: 'seed-profile-0001',
        period: { fromUtcMs: NOW_MS - 86_400_000 * 30, toUtcMs: NOW_MS },
        includeAiSection: false,
      },
    });
    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'REPORT/EMPTY_PERIOD' } });
  });

  it('битый payload (нет includeAiSection) → VALIDATION/FAILED, хендлер не зовётся (§14)', async () => {
    const envelope = await container!.channels.dispatch({
      channel: 'report/pdf',
      payload: {
        profileId: 'seed-profile-0001',
        period: { fromUtcMs: NOW_MS - 86_400_000, toUtcMs: NOW_MS },
      },
    });
    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'VALIDATION/FAILED' } });
  });

  it('путь файла от renderer НЕ принимается схемой report/pdf (§14: путь выбирает main-диалог)', async () => {
    const envelope = await container!.channels.dispatch({
      channel: 'report/pdf',
      payload: {
        profileId: 'seed-profile-0001',
        period: { fromUtcMs: NOW_MS - 86_400_000, toUtcMs: NOW_MS },
        includeAiSection: false,
        path: 'C:/evil/x.pdf',
      },
    });
    expect(envelope).toMatchObject({ v: 1, ok: false, error: { code: 'VALIDATION/FAILED' } });
  });

  it('app/reveal-path: {path} → ok null И путь доходит до shell.showItemInFolder без изменений (§20-6, §9 fire-and-forget)', async () => {
    const path = 'C:/out/health-log-export-20250925-1900.pdf';
    const envelope = await container!.channels.dispatch({
      channel: 'app/reveal-path',
      payload: { path },
    });
    expect(envelope).toEqual({ v: 1, ok: true, data: null });
    // Полная цепочка UI-кнопки: канал → хендлер → electronRevealPath → shell.
    // reveal — fire-and-forget (§9): ответ канала не ждёт его — ждём тестом.
    await vi.waitFor(() => expect(showItemInFolder).toHaveBeenCalledWith(path));
  });
});
