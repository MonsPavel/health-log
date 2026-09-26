/**
 * TASK-027 §19/§20: интеграционный тест composition root — buildContainer на
 * tmp-userData с FixedClock и мок-vault (§19: без safeStorage — фабрика vault
 * переопределяема; тест идёт в node-окружении vitest, критерий §20 п. 4).
 *
 * Матрица:
 *  - полный цикл (§19): пустой tmp-userData → buildContainer → файл БД существует,
 *    schema_version=1; ping-вызов через зарегистрированный каркас (§11 — registry
 *    TASK-008 внутри контейнера) → конверт {v:1, ok:true, data:{pong:true, ts}} с
 *    временем FixedClock (внедрение порта проверено фактом);
 *  - повторный buildContainer на том же userData (§19): миграций нет (schema_version
 *    прежняя, data_version не сброшен), данные сохранены; контейнер полнофункционален
 *    (вторая запись проходит);
 *  - will-quit-симуляция (§8/§19): container.close() → wal_checkpoint(TRUNCATE) +
 *    close → файлы -wal/-shm отсутствуют, файл БД остался; повторный close — no-op;
 *  - отказ vault (§13/§9): ensureKey → err → buildContainer reject с AppError
 *    VAULT/KEY_MISSING — контейнер не создаётся, файл БД не создан;
 *  - сборка без фабрики vault в node-окружении (Electron недоступен) → честная
 *    VAULT/UNAVAILABLE (§13 кейс 5) — ленивая загрузка safeStorage не падает молча;
 *  - §14: keyHex живёт только внутри buildContainer — на объекте Container поля нет;
 *  - §15: ориентир инициализации (decrypt ключа + миграции + подготовка statements)
 *    — менее 100 мс (замер, тест-ориентир).
 *
 * Сценарий §19 последовательный (первый старт → данные → повторный старт → закрытие):
 * тесты первого describe шарят tmp-каталог и идут в порядке объявления; независимые
 * кейсы — в отдельных describe со своим tmp-каталогом. Каталоги удаляются в afterAll
 * (§14: ФС пользователя тестами не затрагивается).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';

import { API_ENVELOPE_VERSION } from '@hl/contracts';
import { AppError, FixedClock, unsafeUnwrap, type Clock, type Result } from '@hl/kernel';

import { buildContainer, DATABASE_FILENAME } from './container.js';
import { EventBus } from './events/event-bus.js';
import { BpMeasurement } from './modules/measurement/domain/bp-measurement.js';
import {
  VAULT_KEY_MISSING_MESSAGE_KEY,
  type EnsuredKey,
  type KeyVault,
  type WrappedKeyBlob,
} from './modules/security/application/ports/key-vault.js';

/** Фиксированный тестовый ключ (§19: мок-vault отдаёт стабильный hex) — 32 байта. */
const KEY_HEX = 'ab'.repeat(32);

/** Фиксированное «сейчас» FixedClock — как в контрактных наборах (2025-09-25T16:00:00Z). */
const NOW_MS = 1_758_816_000_000;
const TZ = 180;

/** Свежий tmp-userData (каталог БД и vault.key); удаление — в конце каждого кейса. */
const newUserDataDir = (): string => mkdtempSync(join(tmpdir(), 'hl-container-int-'));

/**
 * Мок-vault (§19): без safeStorage — ensureKey отдаёт фиксированный ключ; created=true
 * только на первом вызове (имитация кейсов §13 1/2). Отказ задаётся конструктором.
 */
class MockVault implements KeyVault {
  private ensured = 0;

  constructor(
    private readonly keyHex: string,
    private readonly failure?: AppError,
  ) {}

  async ensureKey(_dbExists: boolean): Promise<Result<EnsuredKey, AppError>> {
    if (this.failure !== undefined) {
      return { ok: false, error: this.failure };
    }
    return { ok: true, value: { keyHex: this.keyHex, created: this.ensured++ === 0 } };
  }

  async exportKeyForBackup(): Promise<Result<WrappedKeyBlob, AppError>> {
    return { ok: false, error: AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY) };
  }
}

/** deps сборки в сценарии: реальный путь — tmp, время — FixedClock, vault — мок (§19). */
const makeDeps = (dir: string, clock: Clock) => ({
  userDataPath: dir,
  clock,
  vault: () => new MockVault(KEY_HEX),
});

describe('buildContainer — полный цикл §19 (последовательный сценарий)', () => {
  /** Один tmp-userData на сценарий: первый старт → повторный старт на том же userData. */
  const dir = newUserDataDir();
  const clock = new FixedClock(NOW_MS, TZ);

  /** Контейнеры сценария — закрываются в afterAll (крайний случай при падении теста). */
  let container1: Awaited<ReturnType<typeof buildContainer>> | undefined;
  let container2: Awaited<ReturnType<typeof buildContainer>> | undefined;
  let measurement: BpMeasurement;
  let dataVersionAfterFirstSession = 0;

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

  it('1. первый старт: БД создана, schema_version=1, ping через каркас отвечает (§19)', async () => {
    container1 = await buildContainer(makeDeps(dir, clock));

    // Файл БД по пути §8 существует.
    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true);
    // Миграция v1 применена контейнером: schema_version=1.
    const version = container1.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe('1');
    // ping через зарегистрированный каркас (§11): конверт TASK-008 + ts из FixedClock.
    const envelope = await container1.channels.dispatch({ channel: 'app/ping', payload: {} });
    expect(envelope).toEqual({
      v: API_ENVELOPE_VERSION,
      ok: true,
      data: { pong: true, ts: NOW_MS },
    });
    // Зависимости-параметры реально вошли в граф (§5: переопределяемо для тестов).
    expect(container1.clock).toBe(clock);
    expect(container1.vault).toBeInstanceOf(MockVault);
    expect(container1.events).toBeInstanceOf(EventBus);
    // §14: keyHex живёт только внутри сборки — на контейнере его нет.
    expect(Object.keys(container1)).not.toContain('keyHex');
  });

  it('2. данные пишутся через репозиторий контейнера (подготовка повторного старта)', async () => {
    // v1 имеет FK bp_measurement.profile_id → profile(id): профиль — подготовка окружения
    // (прецедент sqlite-measurement-repository.int.test.ts, §19).
    container1!.db
      .prepare(
        "INSERT OR IGNORE INTO profile (id, name, created_at_utc) VALUES ('profile-1', 'Тест', 0)",
      )
      .run();

    measurement = unsafeUnwrap(
      BpMeasurement.create(
        {
          profileId: 'profile-1',
          sys: 120,
          dia: 80,
          pulse: 70,
          irregularPulse: false,
          arm: 'left',
          note: 'утром',
          takenAt: { utcMs: NOW_MS - 60_000, tzOffsetMin: TZ },
        },
        clock,
      ),
    );
    expect(unsafeUnwrap(await container1!.measurementRepo.add(measurement))).toBeUndefined();
    expect(await container1!.measurementRepo.getById(measurement.id)).toEqual(measurement);
    // data_version после первой записи: 1 (сид v1) → 2 (bump мутации, §13 TASK-026).
    dataVersionAfterFirstSession = await container1!.measurementRepo.currentDataVersion();
    expect(dataVersionAfterFirstSession).toBe(2);
  });

  it('3. повторный старт на том же userData: миграций нет, данные сохранены (§19)', async () => {
    // Конец «первой сессии»; на Windows повторное открытие требует освобождения файла.
    container1!.close();

    container2 = await buildContainer(makeDeps(dir, clock));

    // Данные пережили перезапуск (ключ мок-vault стабилен — БД расшифровалась).
    expect(await container2.measurementRepo.getById(measurement.id)).toEqual(measurement);
    // data_version не сброшен: повторных (деструктивных) миграций не было, сеяная v1 '1' → 2.
    expect(await container2.measurementRepo.currentDataVersion()).toBe(
      dataVersionAfterFirstSession,
    );
    const version = container2.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe('1');
    // Контейнер полнофункционален: вторая запись проходит (готовит содержательный WAL
    // для следующего кейса — закрытие с чекпоинтом).
    const second = unsafeUnwrap(
      BpMeasurement.create(
        {
          profileId: 'profile-1',
          sys: 130,
          dia: 85,
          irregularPulse: false,
          arm: 'right',
          takenAt: { utcMs: NOW_MS - 30_000, tzOffsetMin: TZ },
        },
        clock,
      ),
    );
    expect(unsafeUnwrap(await container2.measurementRepo.add(second))).toBeUndefined();
    expect(await container2.measurementRepo.currentDataVersion()).toBe(
      dataVersionAfterFirstSession + 1,
    );
  });

  it('4. will-quit-симуляция: close → -wal/-shm отсутствуют, файл БД остался (§8/§19)', () => {
    container2!.close();

    expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(true);
    expect(existsSync(join(dir, `${DATABASE_FILENAME}-wal`))).toBe(false);
    expect(existsSync(join(dir, `${DATABASE_FILENAME}-shm`))).toBe(false);
    // Идемпотентность: повторный close (повторный will-quit/зависание) — no-op.
    expect(() => container2!.close()).not.toThrow();
  });
});

describe('buildContainer — отказ vault: контейнер не создаётся (§13/§9)', () => {
  it('ensureKey → err → reject с AppError VAULT/KEY_MISSING; файл БД не создан', async () => {
    const dir = newUserDataDir();
    try {
      const promise = buildContainer({
        userDataPath: dir,
        clock: new FixedClock(NOW_MS, TZ),
        vault: () =>
          new MockVault(KEY_HEX, AppError.of('VAULT/KEY_MISSING', VAULT_KEY_MISSING_MESSAGE_KEY)),
      });

      await expect(promise).rejects.toBeInstanceOf(AppError);
      await expect(promise).rejects.toMatchObject({ code: 'VAULT/KEY_MISSING' });
      // Контейнер не собран — БД даже не открывалась (§13: не «полуживое» состояние).
      expect(existsSync(join(dir, DATABASE_FILENAME))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildContainer — сборка без фабрики vault в node-окружении (§20 п. 4)', () => {
  it('Electron недоступен → честная VAULT/UNAVAILABLE (§13 кейс 5), не тихий сбой', async () => {
    const dir = newUserDataDir();
    try {
      const promise = buildContainer({ userDataPath: dir, clock: new FixedClock(NOW_MS, TZ) });

      await expect(promise).rejects.toBeInstanceOf(AppError);
      await expect(promise).rejects.toMatchObject({ code: 'VAULT/UNAVAILABLE' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildContainer — ориентир производительности (§15)', () => {
  it('инициализация (decrypt ключа + миграции + statements) — менее 100 мс', async () => {
    const dir = newUserDataDir();
    try {
      const startedAtMs = performance.now();
      const container = await buildContainer(makeDeps(dir, new FixedClock(NOW_MS, TZ)));
      const elapsedMs = performance.now() - startedAtMs;
      container.close();

      expect(elapsedMs).toBeLessThan(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
