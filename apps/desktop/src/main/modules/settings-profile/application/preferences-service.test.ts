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
      netConsents: { updatesCheck: false },
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
      netConsents: { updatesCheck: true },
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
      netConsents: { updatesCheck: true },
    });
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

    expect(result.netConsents).toEqual({ updatesCheck: false });
  });
});
