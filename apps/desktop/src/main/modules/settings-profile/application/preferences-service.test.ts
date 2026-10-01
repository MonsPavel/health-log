/**
 * TASK-047 §5/§7/§9/§11/§13/§18/§19: тесты use case PreferencesService — get/set
 * единого документа prefs (не по-ключево: атомарные чтения, §5) над портом
 * SettingsStorePort. Матрица (§19):
 *  - get: пустое хранилище → DEFAULT_PREFS (§8: дефолты в коде — источник правды);
 *  - get: сохранённый валидный документ → как есть;
 *  - get: хранилище отдало undefined (повреждение отсекает адаптер) → DEFAULT_PREFS
 *    + warn (§20 AC3 — полный путь повреждения в int-тестах адаптера/контейнера);
 *  - set: merge с текущими — частичный patch сохраняет остальные поля;
 *  - set: неизвестные ключи отброшены, валидные применены (§20 AC5 strict-merge);
 *  - set: неверный ТИП значения → AppError VALIDATION/FAILED, запись НЕ выполнялась;
 *  - set: порядок §9 — запись → событие prefs:changed {patchKeys} → лог prefs.set;
 *  - set: отказ записи → err STORAGE/* наверх, события нет (§9);
 *  - set: вложенные netConsents заменяются объектом целиком.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

import type { Prefs, PrefsPatch } from '@hl/contracts';
import { AppError } from '@hl/kernel';

import { PreferencesService, PREFS_STORAGE_KEY } from './preferences-service.js';
import type { SettingsStorePort } from './ports/settings-store.js';

/** Fake-хранилище (§19): карта «ключ → JSON-текст»; управляемость отказами/порчей. */
class FakeStore implements SettingsStorePort {
  readonly rows = new Map<string, string>();
  readonly setCalls: { key: string; valueJson: string }[] = [];
  setFailure: AppError | undefined;

  get<T>(key: string, schema: ZodType<T>): T | undefined {
    const raw = this.rows.get(key);
    if (raw === undefined) {
      return undefined;
    }
    // Как боевой адаптер: повреждённый JSON → undefined (решение сервису), не throw.
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    const parsed = schema.safeParse(parsedRaw);
    return parsed.success ? parsed.data : undefined;
  }

  set(key: string, valueJson: string): Promise<void> {
    if (this.setFailure !== undefined) {
      // Имитация боевого адаптера: наружу AppError (не Error) — контракт порта §9.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(this.setFailure);
    }
    this.setCalls.push({ key, valueJson });
    this.rows.set(key, valueJson);
    return Promise.resolve();
  }
}

/** Сервис с фиктивными шиной/логгером-шпионами (§19). */
const makeService = (store: SettingsStorePort) => {
  const events = { emit: vi.fn() };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { service: new PreferencesService({ store, events, logger }), events, logger };
};

const stored = (store: FakeStore, prefs: Prefs): void => {
  store.rows.set(PREFS_STORAGE_KEY, JSON.stringify(prefs));
};

describe('PreferencesService — getPrefs (§5/§8/§19)', () => {
  it('пустое хранилище → DEFAULT_PREFS (без записи: дефолты в коде, §8)', async () => {
    const store = new FakeStore();
    const { service } = makeService(store);

    await expect(service.getPrefs()).resolves.toEqual({
      theme: 'system',
      textScale: '100',
      dateFormat: 'auto',
      advancedMode: false,
      // TASK-075: modelsDownload — новое согласие схемы, дефолт false (§5).
      netConsents: { updatesCheck: false, modelsDownload: false },
      jobState: { jobs: {}, shown: {} },
      // TASK-081/088: aiSettings — модели нет, «позже» не нажат, заметки выключены.
      aiSettings: { dismissed: false, includeNotes: false },
    });
    expect(store.setCalls).toHaveLength(0);
  });

  it('сохранённый валидный документ читается как есть', async () => {
    const store = new FakeStore();
    stored(store, {
      theme: 'dark',
      textScale: '125',
      dateFormat: 'mdy',
      advancedMode: true,
      netConsents: { updatesCheck: true },
    });
    const { service } = makeService(store);

    await expect(service.getPrefs()).resolves.toEqual({
      theme: 'dark',
      textScale: '125',
      dateFormat: 'mdy',
      advancedMode: true,
      // TASK-075: усечённый netConsents (до расширения схемы) — modelsDownload из
      // zod-дефолта, выданный updatesCheck сохранён (обратная совместимость §5).
      netConsents: { updatesCheck: true, modelsDownload: false },
      // Усечённый документ (до расширения TASK-074) — jobState из zod-дефолта (§22).
      jobState: { jobs: {}, shown: {} },
      // Усечённый документ (до TASK-088) — aiSettings из zod-дефолта (§22).
      aiSettings: { dismissed: false, includeNotes: false },
    });
  });

  it('хранилище отдало undefined (повреждение отсек адаптер) → DEFAULT_PREFS + warn (AC3)', async () => {
    const store = new FakeStore();
    store.rows.set(PREFS_STORAGE_KEY, '{broken'); // адаптер вернёт undefined на таком
    const { service, logger } = makeService(store);

    const prefs = await service.getPrefs();
    expect(prefs.theme).toBe('system');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('PreferencesService — setPrefs (§7/§9/§11/§20)', () => {
  it('merge с текущими: частичный patch сохраняет остальные поля (§9)', async () => {
    const store = new FakeStore();
    stored(store, {
      theme: 'light',
      textScale: '112.5',
      dateFormat: 'dmy',
      advancedMode: true,
      netConsents: { updatesCheck: true },
    });
    const { service } = makeService(store);

    const result = await service.setPrefs({ theme: 'dark' });

    expect(result).toEqual({
      theme: 'dark',
      textScale: '112.5',
      dateFormat: 'dmy',
      advancedMode: true,
      // TASK-088: includeNotes — дефолт схемы для усечённого документа.
      aiSettings: { dismissed: false, includeNotes: false },
      netConsents: { updatesCheck: true, modelsDownload: false },
      jobState: { jobs: {}, shown: {} },
    });
  });

  it('jobState (TASK-074) — объектом целиком: scheduler-запись сохраняется при чужих patch', async () => {
    const store = new FakeStore();
    const { service, events } = makeService(store);

    // 1. Запись планировщика: jobState заменяется целиком, patchKeys содержит имя.
    await service.setPrefs({
      jobState: {
        lastBackup: { path: String.raw`D:\copy.hlbackup`, at: 1_700_000_000_000 },
        jobs: { 'backup.reminder': 1_700_000_000_000 },
        shown: { 'backup-reminder': 1_700_000_000_000 },
      },
    });
    expect(JSON.parse(store.rows.get(PREFS_STORAGE_KEY) as string)).toMatchObject({
      jobState: {
        lastBackup: { path: String.raw`D:\copy.hlbackup`, at: 1_700_000_000_000 },
        jobs: { 'backup.reminder': 1_700_000_000_000 },
        shown: { 'backup-reminder': 1_700_000_000_000 },
      },
    });

    // 2. Чужой patch (theme) не затирает jobState (merge §9).
    await service.setPrefs({ theme: 'dark' });
    expect(JSON.parse(store.rows.get(PREFS_STORAGE_KEY) as string)).toMatchObject({
      theme: 'dark',
      jobState: { lastBackup: { path: String.raw`D:\copy.hlbackup` } },
    });
    expect(events.emit).toHaveBeenLastCalledWith('prefs:changed', { patchKeys: ['theme'] });
  });

  it('aiSettings (TASK-081) — объектом целиком: select пишет modelId, «позже» — dismissed', async () => {
    const store = new FakeStore();
    const { service, events } = makeService(store);

    // 1. Select (use case 081): aiSettings заменяется целиком — modelId внутри,
    //    dismissed из zod-дефолта (выбор не сбрасывает решение «позже»).
    await service.setPrefs({ aiSettings: { dismissed: false, modelId: 'dev-ru' } });
    expect(JSON.parse(store.rows.get(PREFS_STORAGE_KEY) as string)).toMatchObject({
      aiSettings: { modelId: 'dev-ru', dismissed: false, includeNotes: false },
    });

    // 2. «Настроить позже»: dismissed=true целиком (modelId при отсутствии — нет).
    await service.setPrefs({ aiSettings: { dismissed: true } });
    expect(JSON.parse(store.rows.get(PREFS_STORAGE_KEY) as string)).toMatchObject({
      aiSettings: { dismissed: true, includeNotes: false },
    });

    // 3. Чужой patch (theme) не затирает aiSettings (merge §9).
    await service.setPrefs({ theme: 'dark' });
    expect(JSON.parse(store.rows.get(PREFS_STORAGE_KEY) as string)).toMatchObject({
      theme: 'dark',
      aiSettings: { dismissed: true, includeNotes: false },
    });
    expect(events.emit).toHaveBeenLastCalledWith('prefs:changed', { patchKeys: ['theme'] });
  });

  it('AC5: неизвестные ключи patch отброшены, валидные применены (strict-merge, §7)', async () => {
    const store = new FakeStore();
    const { service } = makeService(store);

    const result = await service.setPrefs({
      theme: 'dark',
      unknownField: 'мусор',
    } as PrefsPatch);

    expect(result.theme).toBe('dark');
    expect(result).not.toHaveProperty('unknownField');
    // В хранилище — чистый документ без мусора.
    expect(JSON.parse(store.rows.get(PREFS_STORAGE_KEY) as string)).not.toHaveProperty(
      'unknownField',
    );
  });

  it('неверный ТИП значения → AppError VALIDATION/FAILED, запись не выполнялась (§11)', async () => {
    const store = new FakeStore();
    const { service, events } = makeService(store);

    const error = await service
      .setPrefs({ theme: 123 } as unknown as PrefsPatch)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION/FAILED');
    expect(store.setCalls).toHaveLength(0);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('порядок §9: после записи — событие prefs:changed {patchKeys} и лог prefs.set keys=[…]', async () => {
    const store = new FakeStore();
    stored(store, {
      theme: 'system',
      textScale: '100',
      dateFormat: 'auto',
      advancedMode: false,
      netConsents: { updatesCheck: false },
    });
    const { service, events, logger } = makeService(store);

    await service.setPrefs({ textScale: '125', theme: 'dark' });

    expect(store.setCalls).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('prefs:changed', {
      patchKeys: ['textScale', 'theme'],
    });
    expect(logger.info).toHaveBeenCalledWith(
      'prefs.set',
      expect.objectContaining({ keys: ['textScale', 'theme'] }),
    );
  });

  it('отказ записи → AppError STORAGE/* наверх, события нет (§9)', async () => {
    const store = new FakeStore();
    store.setFailure = AppError.of('STORAGE/FAILED', 'errors.STORAGE_FAILED');
    const { service, events } = makeService(store);

    const error = await service.setPrefs({ theme: 'dark' }).catch((e: unknown) => e);

    expect(error).toBe(store.setFailure);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('вложенные netConsents заменяются объектом целиком (без deep-merge, §5)', async () => {
    const store = new FakeStore();
    stored(store, {
      theme: 'system',
      textScale: '100',
      dateFormat: 'auto',
      advancedMode: false,
      netConsents: { updatesCheck: true },
    });
    const { service } = makeService(store);

    const result = await service.setPrefs({ netConsents: { updatesCheck: false } });

    // TASK-075: patch заменяет объект целиком; недостающий modelsDownload — дефолт.
    expect(result.netConsents).toEqual({ updatesCheck: false, modelsDownload: false });
  });
});
