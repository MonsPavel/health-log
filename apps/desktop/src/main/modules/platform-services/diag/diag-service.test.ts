/**
 * TASK-103 §5/§13/§15/§19/§20: интеграционные тесты DiagBundleService (tmp-каталоги,
 * реальная БД: openEncrypted + полный реестр MIGRATIONS — прецедент v5-network-event
 * .int.test.ts; реальный логгер TASK-010 для лог-фикстуры).
 *
 * Матрица (§19):
 *  - collect на seeded-данных: полный набор файлов пакета, агрегаты app_event за
 *    окно 90 дней (свежая считана, 91 день — вне окна), журнал сети DTO-метаданными,
 *    selfcheck/versions/migrations/system — факты без PHI;
 *  - PHI-скан (ГЛАВНЫЙ AC §20-1): маркер PHI из payload_json app_event (худший
 *    случай — кто-то записал измерение в журнал событий) и заметка лог-фикстуры
 *    отсутствуют во ВСЕХ текстах пакета; лог-файл при этом в пакете ЕСТЬ (скан
 *    честный), а его содержимое — уже редактировано логгером [redacted] (контракт
 *    TASK-010, на который опирается сборка);
 *  - защитная ветка §9: логи > порога — без preview-текстов, только списки;
 *  - замер §15/§20-5: сборка 25 МБ логов ≤2 с;
 *  - saveBundle: zip валиден (extract-zip), манифест diag-manifest.json на месте
 *    (AC §20-2), распакованные тексты без PHI; отмена диалога — {canceled:true} и
 *    гигиена tmp; лог §18 `diag bundle saved files=N sizeMB=…`; кэш сборки —
 *    повторного collect после preview нет (§5).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import extract from 'extract-zip';
import { FixedClock } from '@hl/kernel';
import type { SelfCheckReport } from '@hl/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initFileLogging, resetLoggingForTests } from '../../../shared/logger/logger.js';
import { openEncrypted, type EncryptedDatabase } from '../../../shared/db/sqlite.js';
import { MigrationRunner } from '../../../shared/db/migration-runner.js';
import { MIGRATIONS } from '../../../shared/db/migrations/index.js';
import type { NetworkEventRow } from '../egress/egress-gateway.js';
import { DiagBundleService, DIAG_JOURNAL_LIMIT } from './diag-service.js';

/** Уникальный PHI-маркер фикстуры (заметка «измерения» — скан-цель §20-1). */
const PHI_NOTE = 'болит-голова-diag-phi-маркер';
/** Синтетическое значение давления фикстуры (в payload_json app_event). */
const PHI_SYS = 125;

const DAY = 24 * 60 * 60 * 1000;
/** Фиксированное «сейчас» (2026-10-02 UTC) — детерминизм окон/дат, NFR-10. */
const NOW_MS = Date.UTC(2026, 9, 2, 12, 0, 0);

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly db: EncryptedDatabase;
  readonly service: DiagBundleService;
  readonly logsDir: string;
  readonly tmpDir: string;
  readonly journalCalls: number[];
  readonly saver: ReturnType<typeof vi.fn>;
  readonly infoLogs: Array<{ message: string; meta?: Record<string, unknown> }>;
}

let current: Fixture | undefined;

/** Свежая зашифрованная БД с полным реестром миграций (путь приложения, §19). */
const openFreshDb = (dir: string): EncryptedDatabase => {
  const db = openEncrypted(join(dir, 'diag.sqlite'), randomBytes(32).toString('hex'));
  void new MigrationRunner({ migrations: MIGRATIONS }).migrate(db);
  return db;
};

const id = (): string => randomBytes(8).toString('hex');

/**
 * Собирает фикстуру: tmp-userData (logs/, tmp/), БД с событиями (свежие и вне
 * окна), лог-файл (реальный логгер, PHI-фикстура), fake-порты journal/saver.
 */
async function makeFixture(
  options: {
    maxLogBytesForPreview?: number;
    selfcheck?: { readonly report: SelfCheckReport | undefined };
  } = {},
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'hl-diag-'));
  dirs.push(root);
  const logsDir = join(root, 'logs');
  const tmpDir = join(root, 'tmp');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const db = openFreshDb(root);
  const insertAppEvent = db.prepare(
    'INSERT INTO app_event (id, kind, payload_json, at_utc) VALUES (?, ?, ?, ?)',
  );
  // Свежая запись — в окне агрегатов 90 дней; вторая (91 день) — вне окна (§8).
  insertAppEvent.run(id(), 'models.download', JSON.stringify({ modelId: 'm1' }), NOW_MS - DAY);
  insertAppEvent.run(
    id(),
    'test.phi',
    JSON.stringify({ sys: PHI_SYS, note: PHI_NOTE }),
    NOW_MS - 2 * DAY,
  );
  insertAppEvent.run(id(), 'updates.check', '{}', NOW_MS - 91 * DAY);
  const insertNetEvent = db.prepare(
    'INSERT INTO network_event (id, kind, endpoint, status, bytes, at_utc) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertNetEvent.run(id(), 'models.download', 'https://cdn.example/m1', 'ok', 1024, NOW_MS - DAY);
  insertNetEvent.run(id(), 'updates.check', 'https://updates.example/feed', 'blocked', null, NOW_MS - DAY);

  // Лог-фикстура РЕАЛЬНЫМ логгером (TASK-010): PHI в мету — в файле [redacted]
  // (контракт, на который опирается сборка; аналогично тесту логгера).
  await initFileLogging({ file: join(logsDir, 'hl.log'), dev: true });
  const { createLogger } = await import('../../../shared/logger/logger.js');
  createLogger('app').info('addMeasurement', {
    measurement: { sys: PHI_SYS, note: PHI_NOTE },
    durationMs: 12,
  });
  resetLoggingForTests();
  // Пре-условие контракта TASK-010: лог на диске уже редактирован.
  const activeLog = readdirSync(logsDir).find((name) => /^hl\.\d+\.log$/.test(name));
  expect(activeLog).toBeDefined();
  const { readFileSync } = await import('node:fs');
  const logText = readFileSync(join(logsDir, activeLog as string), 'utf8');
  expect(logText).not.toContain(PHI_NOTE);
  expect(logText).toContain('[redacted]');

  const journalCalls: number[] = [];
  const infoLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const saver = vi.fn<(defaultName: string) => Promise<{ path: string } | { canceled: true }>>();

  const service = new DiagBundleService({
    db,
    clock: new FixedClock(NOW_MS, 180),
    logsDir,
    selfcheck:
      options.selfcheck ??
      ({
        report: {
          dbOk: true,
          schemaVersion: MIGRATIONS.at(-1)?.version ?? 0,
          vaultMode: 'none',
          prefsOk: true,
          checkedAtUtc: NOW_MS - 60_000,
          startupMs: 42,
        } satisfies SelfCheckReport,
      } as const),
    journal: (limit) => {
      journalCalls.push(limit);
      const row = (
        statement: string,
        ...params: (string | number | null)[]
      ): NetworkEventRow[] => db.prepare(statement).all(...params) as NetworkEventRow[];
      return row(
        'SELECT id, kind, endpoint, status, bytes, at_utc FROM network_event ORDER BY at_utc DESC, id DESC LIMIT ?',
        limit,
      );
    },
    versions: async () => ({
      appVersion: '9.9.9-test',
      schemaVersion: MIGRATIONS.at(-1)?.version ?? 0,
      scale: { code: 'BP_OFFICE_ESC2018', version: '1.0.0' },
    }),
    system: () => ({ os: 'Linux Test', arch: 'x64', locale: 'ru-RU' }),
    saver: (defaultName) => saver(defaultName),
    tmpDir,
    logger: {
      info: (message, meta) => infoLogs.push({ message, meta }),
      warn: (message, meta) => infoLogs.push({ message, meta }),
    },
    ...(options.maxLogBytesForPreview === undefined
      ? {}
      : { maxLogBytesForPreview: options.maxLogBytesForPreview }),
  });

  current = { db, service, logsDir, tmpDir, journalCalls, saver, infoLogs };
  return current;
}

afterEach(() => {
  if (current !== undefined) {
    try {
      current.db.close();
    } catch {
      // уже закрыто — не важно для очистки
    }
    current = undefined;
  }
  vi.restoreAllMocks();
});

/** Все preview-тексты пакета одной строкой — цель PHI-скана (§13/§19). */
function bundleTexts(files: Array<{ name: string; preview?: string }>): string {
  return files.map((file) => `${file.name}\n${file.preview ?? ''}`).join('\n');
}

describe('DiagBundleService.collect — полный набор файлов (§5/§7/§19)', () => {
  it('собирает логи, selfcheck, версии, журнал сети, агрегаты app_event, миграции, системную строку', async () => {
    const { service } = await makeFixture();
    const content = await service.collect();

    const names = content.files.map((file) => file.name);
    expect(names).toContain('selfcheck.json');
    expect(names).toContain('versions.json');
    expect(names).toContain('network-events.json');
    expect(names).toContain('events.json');
    expect(names).toContain('migrations.json');
    expect(names).toContain('system.txt');
    expect(names.some((name) => /^logs\/hl\.\d+\.log$/.test(name))).toBe(true);

    // Агрегаты app_event за окно 90 дней: свежие kind'ы посчитаны, 91 день — вне окна.
    expect(content.totals.eventsByKind['models.download']).toBe(1);
    expect(content.totals.eventsByKind['test.phi']).toBe(1);
    expect(content.totals.eventsByKind['updates.check']).toBeUndefined();

    // Preview — первые строки соответствующих файлов (парсим JSON-превью).
    const eventsFile = content.files.find((file) => file.name === 'events.json');
    expect(JSON.parse(eventsFile?.preview ?? '{}')).toEqual({
      windowDays: 90,
      eventsByKind: { 'models.download': 1, 'test.phi': 1 },
    });
    const versionsFile = content.files.find((file) => file.name === 'versions.json');
    expect(JSON.parse(versionsFile?.preview ?? '{}')).toMatchObject({ appVersion: '9.9.9-test' });
    const selfcheckFile = content.files.find((file) => file.name === 'selfcheck.json');
    expect(JSON.parse(selfcheckFile?.preview ?? '{}')).toMatchObject({ dbOk: true, startupMs: 42 });
    const netFile = content.files.find((file) => file.name === 'network-events.json');
    const net = JSON.parse(netFile?.preview ?? '[]') as Array<Record<string, unknown>>;
    expect(net).toHaveLength(2);
    expect(net[0]).toMatchObject({ kind: 'models.download', status: 'ok', bytes: 1024 });
    expect(Object.keys(net[0] as object)).not.toContain('id');

    // Миграции — версии реестра; системная строка — факты без окружения пользователя.
    const migrationsFile = content.files.find((file) => file.name === 'migrations.json');
    expect(JSON.parse(migrationsFile?.preview ?? '{}')).toMatchObject({
      versions: MIGRATIONS.map((migration) => migration.version),
    });
    const systemFile = content.files.find((file) => file.name === 'system.txt');
    expect(systemFile?.preview).toContain('os=Linux Test');
    expect(systemFile?.preview).toContain('arch=x64');
    expect(systemFile?.preview).toContain('locale=ru-RU');

    // Порт журнала вызван боевым лимитом 200 (§5).
    expect(current?.journalCalls).toEqual([DIAG_JOURNAL_LIMIT]);
  });

  it('PHI-инвариант: измерения/заметки НЕ найдены ни в одном тексте пакета (главный AC §20-1)', async () => {
    const { service } = await makeFixture();
    const content = await service.collect();

    const texts = bundleTexts(content.files);
    expect(texts).not.toContain(PHI_NOTE);
    expect(texts).not.toContain('болит');
    // Лог-файл в пакете есть — скан не пустой (иначе гарантия фиктивна).
    expect(content.files.some((file) => /^logs\/hl\.\d+\.log$/.test(file.name))).toBe(true);
  });

  it('selfcheck ещё не выполнялся — selfcheck.json честный null (без выдумки статуса)', async () => {
    const { service } = await makeFixture({ selfcheck: { report: undefined } });
    const content = await service.collect();
    // Порт отдаёт report: undefined — файл содержит null (JSON), а не выдуманный отчёт.
    const selfcheckFile = content.files.find((file) => file.name === 'selfcheck.json');
    expect(selfcheckFile?.preview?.trim()).toBe('null');
  });

  it('защитная ветка (§9): логи больше порога — без preview-текстов, только списки', async () => {
    const { service, logsDir } = await makeFixture({ maxLogBytesForPreview: 10 });
    // Дописываем второй (ротированный) файл крупнее порога.
    writeFileSync(join(logsDir, 'hl.2.log'), 'x'.repeat(64), 'utf8');

    const content = await service.collect();
    const names = content.files.map((file) => file.name);
    expect(names).toContain('logs/hl.1.log');
    expect(names).toContain('logs/hl.2.log');
    // Ни один файл пакета не несёт preview-текст лога…
    const logFiles = content.files.filter((file) => file.name.startsWith('logs/'));
    for (const file of logFiles) {
      expect(file.preview).toBeUndefined();
      expect(file.sizeBytes).toBeGreaterThan(0);
    }
    // …но сгенерированные тексты (маленькие, не логи) предпросмотр сохраняют.
    expect(content.files.find((file) => file.name === 'selfcheck.json')?.preview).toBeDefined();
  });

  it('сборка 25 МБ логов ≤2 с (замер §15/§20-5)', async () => {
    const { service, logsDir } = await makeFixture();
    const line = `${'x'.repeat(120)}\n`;
    let blob = '';
    while (blob.length < 25 * 1024 * 1024) {
      blob += line;
    }
    writeFileSync(join(logsDir, 'hl.3.log'), blob, 'utf8');
    expect(statSync(join(logsDir, 'hl.3.log')).size).toBeGreaterThanOrEqual(25 * 1024 * 1024);

    const started = Date.now();
    await service.collect();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThanOrEqual(2000);
  });
});

describe('DiagBundleService.saveBundle — zip, диалог, лог (§5/§9/§11/§18/§20-2)', () => {
  it('zip валиден: распаковывается, манифест diag-manifest.json на месте (AC §20-2)', async () => {
    const fixture = await makeFixture();
    const target = join(fixture.tmpDir, 'out', 'diag.zip');
    mkdirSync(join(fixture.tmpDir, 'out'), { recursive: true });
    fixture.saver.mockResolvedValue({ path: target });

    const result = await fixture.service.saveBundle();
    expect(result).toEqual({ path: target });
    expect(existsSync(target)).toBe(true);

    const unpackDir = join(fixture.tmpDir, 'unpack');
    await extract(target, { dir: unpackDir });
    const extracted = readdirSync(unpackDir);
    expect(extracted).toContain('diag-manifest.json');
    expect(extracted).toContain('selfcheck.json');
    expect(extracted).toContain('events.json');
    const { readFileSync: read } = await import('node:fs');
    const manifest = JSON.parse(read(join(unpackDir, 'diag-manifest.json'), 'utf8')) as {
      formatVersion: number;
      createdAtUtc: number;
    };
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.createdAtUtc).toBe(NOW_MS);
  });

  it('PHI-скан итогового артефакта: распакованный zip без измерений/заметок (AC §20-1)', async () => {
    const fixture = await makeFixture();
    const target = join(fixture.tmpDir, 'diag-phi.zip');
    fixture.saver.mockResolvedValue({ path: target });

    await fixture.service.saveBundle();
    const unpackDir = join(fixture.tmpDir, 'unpack-phi');
    await extract(target, { dir: unpackDir });
    const { readFileSync: read, readdirSync: list } = await import('node:fs');
    for (const name of list(unpackDir)) {
      const text = read(join(unpackDir, name), 'utf8');
      expect(text).not.toContain(PHI_NOTE);
      expect(text).not.toContain('болит');
    }
  });

  it('отмена диалога → {canceled: true}; tmp-файл удалён (гигиена §9)', async () => {
    const fixture = await makeFixture();
    fixture.saver.mockResolvedValue({ canceled: true });

    const result = await fixture.service.saveBundle();
    expect(result).toEqual({ canceled: true });
    const leftovers = readdirSync(fixture.tmpDir).filter((name) => name.endsWith('.zip'));
    expect(leftovers).toEqual([]);
    expect(fixture.saver).toHaveBeenCalledWith(expect.stringMatching(/\.zip$/));
  });

  it('успех: файл по выбранному пути + лог diag bundle saved files=N sizeMB=… (§18)', async () => {
    const fixture = await makeFixture();
    const target = join(fixture.tmpDir, 'saved.zip');
    fixture.saver.mockResolvedValue({ path: target });

    await fixture.service.saveBundle();
    expect(existsSync(target)).toBe(true);
    expect(fixture.infoLogs.map((entry) => entry.message).join('\n')).toContain(
      'diag bundle saved',
    );
    const savedLog = fixture.infoLogs.find((entry) => entry.message.includes('diag bundle saved'));
    expect(savedLog?.meta).toMatchObject({ files: expect.any(Number) });
    expect(typeof savedLog?.meta?.['sizeMB']).toBe('number');
  });

  it('кэш сборки: после preview сохранение НЕ пересобирает; без preview — собирает само (§5)', async () => {
    const fixture = await makeFixture();
    const target = join(fixture.tmpDir, 'cached.zip');
    fixture.saver.mockResolvedValue({ path: target });

    await fixture.service.collect();
    expect(fixture.journalCalls).toHaveLength(1);
    await fixture.service.saveBundle();
    // Кэш: второй сборки нет (journal-порт вызван ровно один раз).
    expect(fixture.journalCalls).toHaveLength(1);

    // Новый сервис без предшествующего preview — save собирает сам.
    const fresh = await makeFixture();
    const freshTarget = join(fresh.tmpDir, 'fresh.zip');
    fresh.saver.mockResolvedValue({ path: freshTarget });
    await fresh.service.saveBundle();
    expect(fresh.journalCalls).toHaveLength(1);
    expect(existsSync(freshTarget)).toBe(true);
  });
});
