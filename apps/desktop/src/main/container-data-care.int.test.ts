// TASK-073 §5/§11/§19: интеграционный тест боевой проводки Data Care — контейнер
// собирает use case'ы 070/071/072 (CreateBackup — с TASK-070; RestoreBackup/
// WipeAllData — эта задача) и регистрирует каналы `backup/create`, `backup/restore`,
// `data/wipe`, `file/open-dialog` в реестре каркаса (§11 — регистрация в конце
// buildContainer). Хелперы (мок-vault, tmp-userData) повторяют container.int.test.ts
// (импорт тест-файла в тест-файл регистрировал бы его describe-блоки повторно —
// копия, прецедент container-report.int.test.ts).
//
// Диалог Electron мокается на уровне модуля (прецедент report.int.test.ts):
// showSaveDialog отдаёт путь в tmp — через канал создаётся РЕАЛЬНАЯ шифрованная
// копия (argon2 + VACUUM INTO + HLBK1), затем РЕАЛЬНЫЙ план восстановления по ней.
// showOpenDialog в mock НЕ включён — боевой OpenFileDialog вне Electron честно
// падает (ленивый import есть, метода нет) → APP/INTERNAL: канал зарегистрирован,
// цепочка пройдена до адаптера (§9; ручная приёмка диалога ОС — §24).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { API_ENVELOPE_VERSION } from '@hl/contracts';
import { AppError, FixedClock, type Result } from '@hl/kernel';

// Шпион диалога — vi.hoisted (фабрика vi.mock поднимается выше const);
// отдельная функция, а не member-ссылка dialog.showSaveDialog (unbound-method).
const { showSaveDialog } = vi.hoisted(() => ({ showSaveDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showSaveDialog } }));

import { buildContainer } from './container.js';
import { MIGRATIONS } from './shared/db/migrations/index.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

const KEY_HEX = 'ab'.repeat(32);
const NOW_MS = 1_758_816_000_000;
const TZ = 180;
const PASSPHRASE = 'пароль-копии-073';

const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-datacare-int-'));

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

describe('container + каналы Data Care (TASK-073 §9/§11)', () => {
  const dir = newUserDataDir();
  /** Путь, который «выбрал пользователь» в save-диалоге (мок диалога). */
  const chosenPath = join(dir, 'мои-измерения.hlbackup');
  let container: Awaited<ReturnType<typeof buildContainer>> | undefined;

  afterAll(() => {
    try {
      container?.close();
    } catch {
      // закрыт самим сценарием — не важно для очистки
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. backup/create (mode ask): РЕАЛЬНАЯ шифрованная копия на диске; в ответе basename, не полный путь (§14)', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosenPath });
    container = await buildContainer({
      userDataPath: dir,
      clock: new FixedClock(NOW_MS, TZ),
      vault: () => new MockVault(),
    });

    const envelope = await container.channels.dispatch({
      channel: 'backup/create',
      payload: { mode: 'ask', passphrase: PASSPHRASE },
    });

    expect(envelope).toMatchObject({ v: API_ENVELOPE_VERSION, ok: true });
    const data = envelope.data as { file: string; sizeBytes: number; manifest: unknown };
    expect(data.file).toBe('мои-измерения.hlbackup');
    expect(data.sizeBytes).toBeGreaterThan(1);
    expect(data.manifest).toMatchObject({ formatVersion: 1, schemaVersion: MIGRATIONS.at(-1)?.version });
    expect(JSON.stringify(envelope.data)).not.toContain(dir); // полный путь наружу не идёт (§14)
    expect(existsSync(chosenPath)).toBe(true);
  });

  it('2. backup/create: отмена save-диалога → BACKUP/CANCELED, файл не создан (§7)', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true });

    const envelope = await container!.channels.dispatch({
      channel: 'backup/create',
      payload: { mode: 'ask', passphrase: PASSPHRASE },
    });

    expect(envelope).toMatchObject({ v: API_ENVELOPE_VERSION, ok: false, error: { code: 'BACKUP/CANCELED' } });
  });

  it('3. backup/restore фаза 1: РЕАЛЬНЫЙ план по копии из шага 1 (counts/currentCounts, предупреждение замены)', async () => {
    const envelope = await container!.channels.dispatch({
      channel: 'backup/restore',
      payload: { file: chosenPath, passphrase: PASSPHRASE, confirmed: false },
    });

    expect(envelope).toMatchObject({ v: API_ENVELOPE_VERSION, ok: true });
    const plan = (envelope.data as { plan: Record<string, unknown> }).plan;
    expect(plan).toMatchObject({
      schemaVersion: MIGRATIONS.at(-1)?.version,
      schemaDelta: 'equal',
      createdAtUtc: NOW_MS,
      counts: { measurements: 0 },
      currentCounts: { measurements: 0 },
      warnings: ['replaces-current'],
    });
    expect(JSON.stringify(envelope.data)).not.toContain('saltB64'); // манифест схлопнут (§14)
  });

  it('4. backup/restore: неверный пароль → BACKUP/WRONG_PASSPHRASE (боевая криптография, инлайн-ошибка UI)', async () => {
    const envelope = await container!.channels.dispatch({
      channel: 'backup/restore',
      payload: { file: chosenPath, passphrase: 'неверный-пароль', confirmed: false },
    });

    expect(envelope).toMatchObject({
      v: API_ENVELOPE_VERSION,
      ok: false,
      error: { code: 'BACKUP/WRONG_PASSPHRASE' },
    });
  });

  it('5. data/wipe plan: план строится из фактических каталогов, НИЧЕГО не удаляет (§5)', async () => {
    const envelope = await container!.channels.dispatch({
      channel: 'data/wipe',
      payload: { phase: 'plan' },
    });

    expect(envelope).toMatchObject({ v: API_ENVELOPE_VERSION, ok: true });
    const plan = (envelope.data as { plan: { files: { path: string; category: string }[] } }).plan;
    // Копии hook'а миграций + БД — в плане; полный путь наружу не идёт (§14).
    expect(plan.files.some((file) => file.category === 'backups')).toBe(true);
    expect(plan.files.some((file) => file.path === 'health-log.db' && file.category === 'db')).toBe(true);
    expect(plan.files.every((file) => !file.path.includes(dir))).toBe(true);
    // План не удаляет (§5): файл БД на месте, соединение живо (ping отвечает).
    expect(existsSync(join(dir, 'health-log.db'))).toBe(true);
    const ping = await container!.channels.dispatch({ channel: 'app/ping', payload: {} });
    expect(ping).toMatchObject({ ok: true });
  });

  it('6. file/open-dialog: канал зарегистрирован; боевой адаптер вне Electron честно APP/INTERNAL', async () => {
    const bad = await container!.channels.dispatch({
      channel: 'file/open-dialog',
      payload: { path: 'C:/evil/x.hlbackup' },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'VALIDATION/FAILED' } });

    const honest = await container!.channels.dispatch({
      channel: 'file/open-dialog',
      payload: { filters: [{ name: 'Health Log Backup', extensions: ['hlbackup'] }] },
    });
    // Вне Electron showOpenDialog недоступен — необработанное исключение адаптера
    // каркас конвертирует в APP/INTERNAL (§13 п. 4). Канал НЕ «неизвестный».
    expect(honest).toMatchObject({ ok: false, error: { code: 'APP/INTERNAL' } });
  });

  it('7. data/wipe: пустой payload и лишние поля отвергнуты схемой (§14)', async () => {
    const empty = await container!.channels.dispatch({ channel: 'data/wipe', payload: {} });
    expect(empty).toMatchObject({ ok: false, error: { code: 'VALIDATION/FAILED' } });

    const extra = await container!.channels.dispatch({
      channel: 'data/wipe',
      payload: { phase: 'plan', path: 'C:/evil' },
    });
    expect(extra).toMatchObject({ ok: false, error: { code: 'VALIDATION/FAILED' } });
  });
});
