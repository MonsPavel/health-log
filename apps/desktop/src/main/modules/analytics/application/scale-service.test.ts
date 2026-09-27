// TASK-051 §19: юнит-тесты ScaleService (fake-репозиторий, без БД — прецедент
// use case'ов TASK-029/047). Матрица:
//  1. первый старт: активной записи нет → INSERT + activate ровно по одному разу,
//     data_json = JSON данных пакета, лог 'scale activated' (AC);
//  2. повторный старт (та же версия активна) — no-op: вставок нет, дублей нет
//     (§9 идемпотентность; §20 AC-аналог UNIQUE), лог 'scale active (cached)';
//  3. смена версии данных пакета (мок с version 1.1.0) → INSERT новой версии +
//     переключение активности, старая версия остаётся в истории с ПРЕЖНИМ
//     activated_at_utc (§13 — активность = max activated_at_utc, обнуления нет);
//  4. getActiveScale → полная форма ActiveScale (проекция: без language/$comment);
//     кэш в памяти: повторный вызов НЕ читает репозиторий (§15);
//  5. повреждённый data_json (не JSON) → AppError STORAGE/CORRUPT + лог error,
//     НЕ тихий дефолт — шкала критична (§7, AC);
//  6. data_json валидный JSON, но вне схемы → STORAGE/CORRUPT + лог (§7);
//  7. активной записи нет (инициализации не было) → STORAGE/CORRUPT + лог (§7);
//  8. зеркало контракта совместимо с типами пакета: SCALE_DATA_SCHEMA парсит
//     BP_OFFICE_ESC2018 в ScaleData (golden-сверка формы, §7).
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { BP_OFFICE_ESC2018, type ScaleData } from '@hl/scales-data';
import { SCALE_DATA_SCHEMA, type ActiveScale, type ScaleDataFile } from '@hl/contracts';
import { AppError } from '@hl/kernel';

import type { ScaleRecord, ScaleRecordInput, ScaleRepository } from './ports/scale-repository.js';
import { ScaleService } from './scale-service.js';

/** Тикающие часы: активации получают разные моменты (§13: max activated_at_utc). */
const makeClock = (): { nowMs: () => number; tzOffsetMin: () => number } => {
  let current = 1_758_816_000_000;
  return {
    nowMs: () => {
      const value = current;
      current += 1;
      return value;
    },
    tzOffsetMin: () => 180,
  };
};

/** Записи лога по уровням (§18-проверки). */
type LogEntry = { level: 'info' | 'warn' | 'error'; message: string; meta?: Record<string, unknown> };

/** Fake-репозиторий: семантика активности как у SQLite-адаптера (max activated_at_utc). */
class FakeScaleRepository implements ScaleRepository {
  readonly rows = new Map<string, ScaleRecord>();

  /** Счётчики вызовов — для идемпотентности (§9) и кэша (§15). */
  inserts: ScaleRecordInput[] = [];

  activations: string[] = [];

  finds = 0;

  findActiveByCode(): Promise<ScaleRecord | undefined> {
    this.finds += 1;
    const active = [...this.rows.values()]
      .filter((row) => row.activatedAtUtc !== null)
      .sort((a, b) => (b.activatedAtUtc as number) - (a.activatedAtUtc as number))[0];
    return Promise.resolve(active);
  }

  insert(input: ScaleRecordInput): Promise<void> {
    this.inserts.push(input);
    this.rows.set(input.id, { ...input, activatedAtUtc: null });
    return Promise.resolve();
  }

  activate(id: string): Promise<void> {
    this.activations.push(id);
    const row = this.rows.get(id);
    if (row !== undefined) {
      this.rows.set(id, { ...row, activatedAtUtc: 1_758_816_000_000 + this.activations.length });
    }
    return Promise.resolve();
  }
}

const makeService = (
  data: ScaleData = BP_OFFICE_ESC2018,
): { repo: FakeScaleRepository; logs: LogEntry[]; service: ScaleService } => {
  const repo = new FakeScaleRepository();
  const logs: LogEntry[] = [];
  const service = new ScaleService({
    repo,
    clock: makeClock(),
    logger: {
      info: (message, meta) => logs.push({ level: 'info', message, meta }),
      warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
      error: (message, meta) => logs.push({ level: 'error', message, meta }),
    },
    data,
  });
  return { repo, logs, service };
};

describe('ScaleService.ensureActivated — активация при старте (TASK-051 §5/§9/§13)', () => {
  it('(1) первый старт: INSERT + activate ровно по разу, data_json — JSON данных пакета; лог scale activated', async () => {
    const { repo, logs, service } = makeService();

    await service.ensureActivated();

    expect(repo.inserts).toHaveLength(1);
    expect(repo.activations).toHaveLength(1);
    const insert = repo.inserts[0];
    expect(insert?.code).toBe('bp_office_esc2018');
    expect(insert?.version).toBe('1.0.0');
    expect(insert?.sourceLabel).toBe('ESC/ESH 2018');
    expect(insert?.dataJson).toBe(JSON.stringify(BP_OFFICE_ESC2018));
    expect(repo.activations[0]).toBe(insert?.id);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'info', message: 'scale activated', meta: { code: 'bp_office_esc2018', version: '1.0.0' } }),
    );
  });

  it('(2) повторный старт с той же версией — no-op: вставок нет, дублей нет; лог scale active (cached)', async () => {
    const { repo, logs, service } = makeService();
    await service.ensureActivated();

    // Тот же репозиторий, «второй запуск» — новый экземпляр сервиса (перезапуск приложения).
    const second = new ScaleService({
      repo,
      clock: makeClock(),
      logger: {
        info: (message, meta) => logs.push({ level: 'info', message, meta }),
        warn: () => {},
        error: () => {},
      },
      data: BP_OFFICE_ESC2018,
    });
    await second.ensureActivated();

    expect(repo.inserts).toHaveLength(1); // дубля нет (§9, UNIQUE-аналог §20)
    expect(repo.activations).toHaveLength(1);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'info', message: 'scale active (cached)' }),
    );
  });

  it('(3) смена версии данных пакета (мок 1.1.0) → новая версия активна, старая в истории с прежним activated_at_utc (§13)', async () => {
    const { repo, logs, service } = makeService();
    await service.ensureActivated();
    const oldActivatedAt = [...repo.rows.values()].find((row) => row.version === '1.0.0')
      ?.activatedAtUtc;
    expect(oldActivatedAt).not.toBeNull();

    const upgraded = makeService({ ...BP_OFFICE_ESC2018, version: '1.1.0' });
    await upgraded.service.ensureActivated();

    // Новая версия записана и активирована.
    expect(upgraded.repo.inserts).toHaveLength(1);
    expect(upgraded.repo.inserts[0]?.version).toBe('1.1.0');
    const active = await upgraded.repo.findActiveByCode('bp_office_esc2018');
    expect(active?.version).toBe('1.1.0');

    // Старая версия — в истории, момент активации НЕ обнулён (правило §13).
    const history = [...upgraded.repo.rows.values()].filter((row) => row.version === '1.0.0');
    expect(history).toHaveLength(1);
    expect(history[0]?.activatedAtUtc).toEqual(oldActivatedAt);

    expect(upgraded.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'scale activated',
        meta: { code: 'bp_office_esc2018', version: '1.1.0' },
      }),
    );
  });
});

describe('ScaleService.getActiveScale — чтение с валидацией и кэшем (§7/§15)', () => {
  it('(4) полная форма ActiveScale (проекция без language/$comment); кэш — повторный вызов не читает репозиторий', async () => {
    const { repo, service } = makeService();
    await service.ensureActivated();

    const active = await service.getActiveScale();
    expect(active).toEqual({
      code: BP_OFFICE_ESC2018.code,
      version: BP_OFFICE_ESC2018.version,
      sourceLabel: BP_OFFICE_ESC2018.sourceLabel,
      categories: BP_OFFICE_ESC2018.categories,
      homeBPNote: BP_OFFICE_ESC2018.homeBPNote,
      specialGroupsNote: BP_OFFICE_ESC2018.specialGroupsNote,
    } satisfies ActiveScale);
    expect(active).not.toHaveProperty('language');
    expect(active).not.toHaveProperty('$comment');

    // §15: после первого чтения — кэш в памяти, репозиторий не трогается.
    const findsAfterFirst = repo.finds;
    await service.getActiveScale();
    await service.getActiveScale();
    expect(repo.finds).toBe(findsAfterFirst);
  });

  it('(5) повреждённый data_json (не JSON) → STORAGE/CORRUPT + лог error, не тихий дефолт (AC)', async () => {
    const { repo, logs, service } = makeService();
    await service.ensureActivated();
    const record = repo.rows.get(repo.activations[0] as string);
    repo.rows.set(record?.id as string, { ...(record as ScaleRecord), dataJson: '{not json' });

    let error: unknown;
    try {
      await service.getActiveScale();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STORAGE/CORRUPT');
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error', message: expect.stringContaining('scale') }));
  });

  it('(6) data_json вне схемы (нет specialGroupsNote) → STORAGE/CORRUPT + лог error (§7)', async () => {
    const { repo, logs, service } = makeService();
    await service.ensureActivated();
    const record = repo.rows.get(repo.activations[0] as string);
    const withoutNote: unknown = JSON.parse(record?.dataJson as string);
    delete (withoutNote as Record<string, unknown>).specialGroupsNote;
    repo.rows.set(record?.id as string, {
      ...(record as ScaleRecord),
      dataJson: JSON.stringify(withoutNote),
    });

    let error: unknown;
    try {
      await service.getActiveScale();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STORAGE/CORRUPT');
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error' }));
  });

  it('(7) активной записи нет (инициализации не было) → STORAGE/CORRUPT + лог error (§7: шкала критична)', async () => {
    const { logs, service } = makeService();

    let error: unknown;
    try {
      await service.getActiveScale();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STORAGE/CORRUPT');
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error' }));
  });
});

describe('Контракт файла данных — golden-сверка с пакетом (§7/§20 AC4)', () => {
  it('(8) SCALE_DATA_SCHEMA парсит BP_OFFICE_ESC2018 в ScaleData (зеркало совместимо с типами пакета)', () => {
    const parsed: ScaleData = SCALE_DATA_SCHEMA.parse(BP_OFFICE_ESC2018);
    expect(parsed.version).toBe(BP_OFFICE_ESC2018.version);
    expectTypeOf<ScaleDataFile>().toExtend<ScaleData>();
  });
});
