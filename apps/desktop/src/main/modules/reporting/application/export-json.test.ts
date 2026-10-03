// TASK-064 §19: юниты use case ExportJson на подстановочных источниках (порты §8:
// measurement/settings/scale — минимальные структурные поверхности reporting).
// Матрица:
//  - сборка слепка (§5): профиль + замеры + prefs + активные шкалы → JSON.stringify(…, 2);
//  - хронология asc (§13, паритет CSV): источник отдаёт пачку в контракте репозитория
//    (takenAt desc) — use case разворачивает;
//  - counts ИЗ ФАКТОВ (§9/AC2): counts === длинам массивов (тест);
//  - корневые ключи — точный список (§14: секретов нет; prefs опционально — §13);
//  - профиль отсутствует → пустой слепок ok: profiles [], counts 0 (не ошибка, §9);
//  - сбой источника → err EXPORT/FAILED значением Result + error-лог (§5, паритет CSV);
//  - пустой profileId → TypeError в точке вызова (dev-контракт скоупа, §14);
//  - лог §18: info `exportJson` {count, durationMs} — без значений измерений (PHI);
//  - производительность §15/AC: 5k измерений ≤300 мс (тест-таймер).
import { performance } from 'node:perf_hooks';

import { describe, expect, it, vi, type Mock } from 'vitest';

import type {
  JsonSnapshotProfile,
  JsonSnapshotScaleRef,
  MeasurementDto,
  Prefs,
} from '@hl/contracts';
import { FixedClock, unsafeUnwrap, type AppError, type Clock, type Result } from '@hl/kernel';

import {
  ExportJsonUseCase,
  type ExportJsonDeps,
  type ExportJsonLogger,
  type ExportJsonPrefsSource,
  type ExportJsonScalesSource,
  type ExportJsonSource,
} from './export-json.js';

/** База моментов фикстур: 2026-09-24T05:12:00Z (= 08:12:00+03:00), шаг 1 минута. */
const BASE_MS = 1_790_226_720_000;
/** Фиксированное «сейчас» — позже всех фикстур. */
const NOW_MS = BASE_MS + 3_600_000;

/** DTO фикстур: пульс через раз (не измерен — ключ отсутствует), эмодзи в заметке. */
const dto = (i: number): MeasurementDto => ({
  id: `id-${i}`,
  profileId: 'profile-1',
  sys: 120 + i,
  dia: 80,
  pulse: i % 2 === 0 ? 72 : undefined,
  irregularPulse: i % 3 === 0,
  arm: 'left',
  note: i === 1 ? 'Заметка 😊 «ёлочки»' : undefined,
  takenAtUtcMs: BASE_MS + i * 60_000,
  tzOffsetMin: 180,
  source: 'manual',
  createdAtUtcMs: BASE_MS,
  updatedAtUtcMs: BASE_MS,
});

/** Профиль фикстур (§5: id, name, createdAtUtc в мс эпохи). */
const profile: JsonSnapshotProfile = {
  id: 'profile-1',
  name: 'Основной',
  createdAtUtc: BASE_MS - 7_776_000_000,
};

/** Активная шкала (§7: только код/версия). */
const scaleRef: JsonSnapshotScaleRef = { code: 'bp-office-esc2018', version: '1.0.0' };

/** Документ prefs фикстур (TASK-047). */
const prefs: Prefs = {
  theme: 'dark',
  textScale: '100',
  dateFormat: 'dmy',
  advancedMode: false,
  netConsents: { updatesCheck: false, modelsDownload: false },
  jobState: { jobs: {}, shown: {} },
  aiSettings: { dismissed: false, includeNotes: false },
  // TASK-094: порог автоблока — новое поле документа (дефолт схемы 5).
  autoLockMin: 5,
  updateChannel: 'stable', // TASK-107: дефолт схемы
};

/**
 * Подстановочные зависимости (§19): источники — vi.fn-шпионы с боевой семантикой
 * (замеры desc — контракт listByPeriod); частичная подмена — заменой целиком.
 */
const makeLogger = (): {
  debug: Mock<ExportJsonLogger['debug']>;
  info: Mock<ExportJsonLogger['info']>;
  error: Mock<ExportJsonLogger['error']>;
} => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });

const makeDeps = (over?: {
  source?: ExportJsonSource;
  prefs?: ExportJsonPrefsSource;
  scales?: ExportJsonScalesSource;
  appVersion?: string;
}): { deps: ExportJsonDeps; logger: ReturnType<typeof makeLogger>; source: ExportJsonSource } => {
  const logger = makeLogger();
  const clock: Clock = new FixedClock(NOW_MS, 180);
  const source: ExportJsonSource = {
    getProfile: vi.fn(() => Promise.resolve(profile)),
    listMeasurements: vi.fn(() => Promise.resolve([dto(2), dto(1), dto(0)])),
    ...over?.source,
  };
  const prefsSource: ExportJsonPrefsSource = {
    getPrefs: vi.fn(() => Promise.resolve(prefs)),
    ...over?.prefs,
  };
  const scalesSource: ExportJsonScalesSource = {
    listActiveScales: vi.fn(() => Promise.resolve([scaleRef])),
    ...over?.scales,
  };
  return {
    deps: {
      source,
      prefs: prefsSource,
      scales: scalesSource,
      clock,
      appVersion: over?.appVersion ?? '1.2.3-test',
      logger,
    },
    logger,
    source,
  };
};

/** Extract err-ветки для assert'ов; ok — ошибка теста (прецедент export-csv.test.ts). */
const errOf = (result: Result<{ json: string; count: number }, AppError>): AppError => {
  if (result.ok) {
    throw new Error('ожидалась err-ветка Result, получена ok');
  }
  return result.error;
};

describe('ExportJsonUseCase — сборка слепка (§5/§9)', () => {
  it('профиль + 3 замера + prefs + шкала → JSON.stringify(obj, null, 2); count=3 (§5)', async () => {
    const { deps } = makeDeps();
    const useCase = new ExportJsonUseCase(deps);

    const result = await useCase.execute('profile-1');

    const { json, count } = unsafeUnwrap(result);
    expect(count).toBe(3);
    // Формат §5: человекочитаемый JSON с отступом 2 (§24: читаемо в редакторе).
    expect(json.startsWith('{\n  "formatVersion": 1,')).toBe(true);
    const snapshot: unknown = JSON.parse(json);
    expect(snapshot).toEqual({
      formatVersion: 1,
      appVersion: '1.2.3-test',
      createdAtUtc: NOW_MS, // время — из инъекционного Clock (NFR-10)
      counts: { measurements: 3, profiles: 1 },
      profiles: [profile],
      // Хронология asc (§13): источник отдал desc (контракт listByPeriod) — разворот.
      measurements: [dto(0), dto(1), dto(2)],
      prefs,
      scales: [scaleRef],
    });
  });

  it('counts ИЗ ФАКТОВ (§9/AC2): counts.measurements/profiles === длинам массивов', async () => {
    const { deps } = makeDeps();
    const useCase = new ExportJsonUseCase(deps);

    const { json } = unsafeUnwrap(await useCase.execute('profile-1'));

    const snapshot = JSON.parse(json) as {
      counts: { measurements: number; profiles: number };
      measurements: unknown[];
      profiles: unknown[];
    };
    expect(snapshot.counts.measurements).toBe(snapshot.measurements.length);
    expect(snapshot.counts.profiles).toBe(snapshot.profiles.length);
  });

  it('корневые ключи — точный список (§14: секретов нет); prefs нет → ключа нет (§13)', async () => {
    const { deps } = makeDeps();
    const useCase = new ExportJsonUseCase(deps);

    const { json } = unsafeUnwrap(await useCase.execute('profile-1'));
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      'formatVersion',
      'appVersion',
      'createdAtUtc',
      'counts',
      'profiles',
      'measurements',
      'prefs',
      'scales',
    ]);

    const { deps: noPrefsDeps } = makeDeps({
      prefs: { getPrefs: () => Promise.resolve(undefined) },
    });
    const { json: noPrefsJson } = unsafeUnwrap(
      await new ExportJsonUseCase(noPrefsDeps).execute('profile-1'),
    );
    expect(Object.keys(JSON.parse(noPrefsJson) as object)).toEqual([
      'formatVersion',
      'appVersion',
      'createdAtUtc',
      'counts',
      'profiles',
      'measurements',
      'scales',
    ]);
  });

  it('профиль отсутствует в хранилище → ok: пустой слепок, profiles=[], counts 0 (§9, паритет CSV)', async () => {
    const { deps } = makeDeps({
      source: {
        getProfile: () => Promise.resolve(undefined),
        listMeasurements: () => Promise.resolve([]),
      },
    });
    const useCase = new ExportJsonUseCase(deps);

    const result = await useCase.execute('profile-unknown');

    const { json, count } = unsafeUnwrap(result);
    expect(count).toBe(0);
    const snapshot = JSON.parse(json) as { counts: { measurements: number; profiles: number } };
    expect(snapshot.counts).toEqual({ measurements: 0, profiles: 0 });
  });
});

describe('ExportJsonUseCase — отказы и скоуп (§9/§14)', () => {
  it('сбой источника → err EXPORT/FAILED, messageKey errors.EXPORT_FAILED (§5); error-лог, info нет', async () => {
    const { deps, logger } = makeDeps({
      source: {
        getProfile: () => Promise.resolve(profile),
        listMeasurements: () => Promise.reject(new Error('db gone')),
      },
    });
    const useCase = new ExportJsonUseCase(deps);

    const result = await useCase.execute('profile-1');

    const error = errOf(result);
    expect(error.code).toBe('EXPORT/FAILED');
    expect(error.messageKey).toBe('errors.EXPORT_FAILED');
    expect(logger.error).toHaveBeenCalledWith(
      'exportJson: не удалось собрать выгрузку',
      expect.objectContaining({ code: 'EXPORT/FAILED' }),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('пустой profileId → TypeError в точке вызова (dev-контракт скоупа, §14)', async () => {
    const { deps } = makeDeps();

    await expect(new ExportJsonUseCase(deps).execute('')).rejects.toThrow(TypeError);
  });
});

describe('ExportJsonUseCase — телеметрия (§18)', () => {
  it('успех → info `exportJson` {count, durationMs} — без значений измерений (PHI, TASK-010)', async () => {
    const { deps, logger } = makeDeps();
    const useCase = new ExportJsonUseCase(deps);

    await useCase.execute('profile-1');

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [message, meta] = vi.mocked(logger.info).mock.calls[0] ?? [];
    expect(message).toBe('exportJson');
    expect(meta?.['count']).toBe(3);
    expect(typeof meta?.['durationMs']).toBe('number');
    expect(JSON.stringify(meta)).not.toContain('id-0');
  });
});

describe('ExportJsonUseCase — производительность (§15/AC)', () => {
  it('5k измерений: сборка+stringify ≤300 мс (тест-таймер, прецедент csv.test.ts)', async () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => dto(i % 64));
    const deps: ExportJsonDeps = {
      source: {
        getProfile: () => Promise.resolve(profile),
        listMeasurements: () => Promise.resolve(rows),
      },
      prefs: { getPrefs: () => Promise.resolve(prefs) },
      scales: { listActiveScales: () => Promise.resolve([scaleRef]) },
      clock: new FixedClock(NOW_MS, 180),
      appVersion: '1.2.3-test',
      logger: { debug: () => {}, info: () => {}, error: () => {} },
    };

    const startedAtMs = performance.now();
    const { json, count } = unsafeUnwrap(await new ExportJsonUseCase(deps).execute('profile-1'));
    const elapsedMs = performance.now() - startedAtMs;

    expect(count).toBe(5_000);
    expect(json.length).toBeGreaterThan(500_000);
    expect(elapsedMs).toBeLessThanOrEqual(300);
  });
});
