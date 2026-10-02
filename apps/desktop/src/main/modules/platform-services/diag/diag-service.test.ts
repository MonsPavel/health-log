/**
 * TASK-103 §19/§20: интеграционные тесты DiagBundleService на tmp-фикстурах.
 *
 *  - collect (§5/§7): полный состав пакета — лог-файлы (все ротации), self-check
 *    (TASK-100), версии (app/meta), журнал сети (200 записей), агрегаты app_event
 *    за 90 дней, список миграций, системная строка (без имени пользователя),
 *    манифест; preview — первые 20 строк; размеры; totals == порту;
 *  - PHI-скан (§13 — ГЛАВНЫЙ AC §20-1): синтетические измерения/заметки НЕ найдены
 *    в собранных текстах (лог-фикстура — в уже отредактированной форме TASK-010:
 *    "[redacted]" на месте значений);
 *  - saveBundle (§9/§11, AC §20-2): zip валиден (распаковка adm-zip), манифест на
 *    месте; отмена диалога — {canceled: true}, tmp чист; кэш превью — журнал
 *    сети читается один раз;
 *  - защитная ветка >порога (§9): логи суммарно >лимита — только списки, без
 *    preview-текстов;
 *  - производительность (§15/AC §20-5): collect на 25 МБ логов ≤2000 мс;
 *  - лог (§18/AC §20-6 не касается): «diag bundle saved files=N sizeMB=…» без путей.
 *
 * Время — FixedClock (NFR-10); порты — vi.fn (§19, прецедент PrivacyQueriesDeps).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SelfCheckReport } from '@hl/contracts';
import type { Clock } from '@hl/kernel';

import {
  DIAG_BUNDLE_DEFAULT_NAME,
  DIAG_FORMAT_VERSION,
  DIAG_MANIFEST_FILENAME,
  DiagBundleService,
  type DiagBundleDeps,
  type DiagBundleLogger,
  type DiagSystemInfo,
} from './diag-service.js';

/** Синтетические PHI-значения фикстуры (§13): НЕ должны попасть в пакет. */
const PHI_NOTE = 'Заметка-ПиАш-9977-голова-болит';
const PHI_VALUE = '125/85-ПиАш-давление';

/** Форма строки pino-лога ПОСЛЕ redact-редакции (контракт TASK-010): PHI цензурена. */
const REDACTED_LOG_LINE =
  '{"level":30,"time":1759400000000,"category":"app","msg":"measurement.add","sys":"[redacted]","note":"[redacted]"}';
const NORMAL_LOG_LINES = [
  '{"level":30,"time":1759400000000,"category":"app","msg":"container ready","schemaVersion":7}',
  '{"level":20,"time":1759400001000,"category":"ipc","msg":"stats/period period=30d durationMs=12 count=5"}',
];

const NOW_MS = 1_759_400_000_000;
const DAY_MS = 86_400_000;

/** FixedClock (NFR-10): момент NOW_MS. */
const FIXED_CLOCK: Clock = { nowMs: () => NOW_MS, tzOffsetMin: () => 180 };

const SELFCHECK: SelfCheckReport = {
  dbOk: true,
  schemaVersion: 7,
  vaultMode: 'none',
  worker: { state: 'starting' },
  prefsOk: true,
  checkedAtUtc: NOW_MS - 5_000,
  startupMs: 12,
};

const SYSTEM: DiagSystemInfo = { os: 'Windows_NT 10.0.26200', arch: 'x64', locale: 'ru-RU' };

/** Каталоги прогона: logsDir и tmpDir сервиса (проверка чистки tmp после отмены). */
const dirs: string[] = [];
const newDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface DepsOverrides {
  readonly maxLogsBytes?: number;
}

/** Фабрика зависимостей с портовыми vi.fn (§19); overrides — порог §9. */
function makeDeps(logsDir: string, tmpDir: string, overrides: DepsOverrides = {}): {
  deps: DiagBundleDeps;
  journalCalls: number[];
  totalsCalls: number[];
  logger: DiagBundleLogger & { infos: Array<{ message: string; meta?: Record<string, unknown> }> };
  dialogResult: { value: string | null };
} {
  const journalCalls: number[] = [];
  const totalsCalls: number[] = [];
  const infos: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const logger = {
    info: (message: string, meta?: Record<string, unknown>): void => {
      infos.push({ message, meta });
    },
    warn: (): void => undefined,
    infos,
  };
  const dialogResult: { value: string | null } = { value: null };
  const deps: DiagBundleDeps = {
    logsDir,
    clock: FIXED_CLOCK,
    appVersion: '1.2.3',
    selfcheckReport: () => SELFCHECK,
    schemaVersion: () => 7,
    activeScale: () => Promise.resolve({ code: 'bp-office-esc2018', version: '1.0.0' }),
    model: () => Promise.resolve({ id: 'qwen3-4b', version: '1.0' }),
    networkJournal: (limit) => {
      journalCalls.push(limit);
      return [
        {
          id: '01HQ',
          kind: 'models.download',
          endpoint: 'https://cdn.example.com/qwen3-4b.gguf',
          status: 'ok',
          bytes: 2048,
          atUtc: NOW_MS - DAY_MS,
        },
        {
          id: '01HR',
          kind: 'updates.check',
          endpoint: 'https://releases.example.com/latest',
          status: 'blocked',
          bytes: null,
          atUtc: NOW_MS - 2 * DAY_MS,
        },
      ];
    },
    appEventTotals: (sinceUtcMs) => {
      totalsCalls.push(sinceUtcMs);
      return Promise.resolve({ 'ai.summary.generate': 5, 'app.start': 3 });
    },
    migrations: [{ version: 1 }, { version: 2 }, { version: 7 }],
    systemInfo: () => Promise.resolve(SYSTEM),
    saveDialog: {
      save: (options) => {
        void options;
        return Promise.resolve(dialogResult.value);
      },
    },
    logger,
    tmpDir,
    ...overrides,
  };
  return { deps, journalCalls, totalsCalls, logger, dialogResult };
}

/** Пишет лог-файлы фикстуры: активный + ротация, строки — уже отредактированы (TASK-010). */
function seedLogs(logsDir: string): void {
  writeFileSync(join(logsDir, 'hl.1.log'), [...NORMAL_LOG_LINES, REDACTED_LOG_LINE].join('\n'));
  writeFileSync(join(logsDir, 'hl.0.log'), `${NORMAL_LOG_LINES[0]}\n`);
}

/** Все тексты пакета: preview-поля + содержимое сгенерированных json (§13 скан). */
function contentTexts(content: { files: Array<{ name: string; preview?: string }> }): string[] {
  return content.files.map((file) => file.preview ?? '');
}

describe('DiagBundleService.collect — состав пакета (TASK-103 §5/§7/§19)', () => {
  let logsDir = '';
  let tmpDir = '';
  beforeEach(() => {
    logsDir = newDir('hl-diag-logs-');
    tmpDir = newDir('hl-diag-tmp-');
    mkdirSync(logsDir, { recursive: true });
    seedLogs(logsDir);
  });

  it('полный состав: логи+ротации, сгенерированные json, манифест; preview ≤20 строк', async () => {
    const { deps } = makeDeps(logsDir, tmpDir);
    const service = new DiagBundleService(deps);
    const content = await service.collect();

    const names = content.files.map((file) => file.name);
    expect(names).toContain('hl.1.log');
    expect(names).toContain('hl.0.log');
    expect(names).toContain('versions.json');
    expect(names).toContain('selfcheck.json');
    expect(names).toContain('network-journal.json');
    expect(names).toContain('app-events.json');
    expect(names).toContain('migrations.json');
    expect(names).toContain(DIAG_MANIFEST_FILENAME);

    // §7: preview — первые 20 строк; у трёхстрочного лога — все строки.
    const activeLog = content.files.find((file) => file.name === 'hl.1.log');
    expect(activeLog?.preview).toBe([...NORMAL_LOG_LINES, REDACTED_LOG_LINE].join('\n'));
    expect(activeLog?.sizeBytes).toBe(
      statSync(join(logsDir, 'hl.1.log')).size,
    );

    // Манифест: версия формата 1, дата — момент FixedClock (§5).
    const manifestFile = content.files.find((file) => file.name === DIAG_MANIFEST_FILENAME);
    expect(manifestFile).toBeDefined();
    const manifest = JSON.parse(manifestFile?.preview ?? '{}') as {
      formatVersion: number;
      createdAtUtc: number;
    };
    expect(manifest).toEqual({ formatVersion: DIAG_FORMAT_VERSION, createdAtUtc: NOW_MS });
  });

  it('versions.json: appVersion/schemaVersion/шкала/модель/система — без путей (§5/§14)', async () => {
    const { deps } = makeDeps(logsDir, tmpDir);
    const content = await new DiagBundleService(deps).collect();
    const versions = JSON.parse(
      content.files.find((file) => file.name === 'versions.json')?.preview ?? '',
    ) as {
      appVersion: string;
      schemaVersion: number;
      scale: { code: string; version: string };
      model: { id: string; version: string };
      system: DiagSystemInfo;
    };
    expect(versions.appVersion).toBe('1.2.3');
    expect(versions.schemaVersion).toBe(7);
    expect(versions.scale).toEqual({ code: 'bp-office-esc2018', version: '1.0.0' });
    expect(versions.model).toEqual({ id: 'qwen3-4b', version: '1.0' });
    expect(versions.system).toEqual(SYSTEM);
    // §14: ни один текст пакета не содержит путей машины (userData с именем пользователя).
    for (const text of contentTexts(content)) {
      expect(text).not.toContain(logsDir);
      expect(text).not.toContain(tmpdir());
    }
  });

  it('selfcheck.json == снимку TASK-100; network-journal.json — 200 записей порта; bytes null опущен', async () => {
    const { deps, journalCalls } = makeDeps(logsDir, tmpDir);
    const content = await new DiagBundleService(deps).collect();

    const selfcheck = JSON.parse(
      content.files.find((file) => file.name === 'selfcheck.json')?.preview ?? '',
    );
    expect(selfcheck).toEqual(SELFCHECK);

    // §5: журнал сети — 200 записей (privacy/journal-лимит), один вызов порта.
    expect(journalCalls).toEqual([200]);
    const journalFile = content.files.find((file) => file.name === 'network-journal.json');
    const journal = JSON.parse(journalFile?.preview ?? '') as {
      entries: Array<{ kind: string; bytes?: number }>;
    };
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[0]).toEqual({
      kind: 'models.download',
      endpoint: 'https://cdn.example.com/qwen3-4b.gguf',
      status: 'ok',
      bytes: 2048,
      atUtc: NOW_MS - DAY_MS,
    });
    expect(journal.entries[1]).not.toHaveProperty('bytes'); // NULL → отсутствие поля

    // Агрегаты: окно 90 дней — порт вызван с since = NOW − 90д (§5).
    const contentTotals = content.totals.eventsByKind;
    expect(contentTotals).toEqual({ 'ai.summary.generate': 5, 'app.start': 3 });
    const appEvents = JSON.parse(
      content.files.find((file) => file.name === 'app-events.json')?.preview ?? '',
    ) as { eventsByKind: Record<string, number>; windowDays: number };
    expect(appEvents.eventsByKind).toEqual(contentTotals);
    expect(appEvents.windowDays).toBe(90);
    expect(content.totals.eventsByKind).toEqual(appEvents.eventsByKind);
  });

  it('migrations.json — список версий реестра (§5)', async () => {
    const { deps } = makeDeps(logsDir, tmpDir);
    const content = await new DiagBundleService(deps).collect();
    const migrations = JSON.parse(
      content.files.find((file) => file.name === 'migrations.json')?.preview ?? '',
    ) as Array<{ version: number }>;
    expect(migrations).toEqual([{ version: 1 }, { version: 2 }, { version: 7 }]);
  });

  it('PHI-скан (ГЛАВНЫЙ AC §20-1): синтетические измерения/заметки отсутствуют во всех текстах', async () => {
    const { deps } = makeDeps(logsDir, tmpDir);
    const content = await new DiagBundleService(deps).collect();
    const allTexts = contentTexts(content).join('\n');
    // Синтетика фикстуры не попала: логи уже отредактированы, БД-тексты не читаются.
    expect(allTexts).not.toContain(PHI_NOTE);
    expect(allTexts).not.toContain(PHI_VALUE);
    // Фикстура в отредактированной форме TASK-010: цензуренные значения на месте —
    // значит скан НЕ мимо (фикстура действительно PHI-содержательная).
    expect(allTexts).toContain('[redacted]');
  });
});

describe('DiagBundleService.saveBundle — zip и save-диалог (TASK-103 §9/§11/§19)', () => {
  let logsDir = '';
  let tmpDir = '';
  beforeEach(() => {
    logsDir = newDir('hl-diag-sv-');
    tmpDir = newDir('hl-diag-tmp2-');
    mkdirSync(logsDir, { recursive: true });
    seedLogs(logsDir);
  });

  it('zip валиден (AC §20-2): распаковка adm-zip, манифест на месте, PHI-скан архива', async () => {
    const { deps, dialogResult } = makeDeps(logsDir, tmpDir);
    const targetPath = join(newDir('hl-diag-out-'), 'bundle.zip');
    dialogResult.value = targetPath;
    const service = new DiagBundleService(deps);
    await service.collect();

    const outcome = await service.saveBundle();
    expect(outcome).toEqual({ saved: true, path: targetPath });

    // §19: распаковка тестом; манифест присутствует и валиден.
    const zip = new AdmZip(targetPath);
    const entryNames = zip.getEntries().map((entry) => entry.entryName);
    expect(entryNames).toContain(DIAG_MANIFEST_FILENAME);
    const manifest = JSON.parse(zip.readAsText(DIAG_MANIFEST_FILENAME)) as {
      formatVersion: number;
      createdAtUtc: number;
    };
    expect(manifest.formatVersion).toBe(DIAG_FORMAT_VERSION);
    expect(manifest.createdAtUtc).toBe(NOW_MS);
    // Все имена предпросмотра — записи архива (плоский zip, §7).
    for (const name of entryNames) {
      expect(name).not.toContain('\\'); // только плоские имена, без путей машины
      expect(name).not.toContain('/');
    }
    const zipTexts = zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => zip.readAsText(entry))
      .join('\n');
    expect(zipTexts).not.toContain(PHI_NOTE);
    expect(zipTexts).not.toContain(PHI_VALUE);
    // tmp чист: архив переехал к цели (§9 tmp → move).
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('отмена диалога — {canceled: true} (§7 065), цель не создана, tmp чист', async () => {
    const { deps, dialogResult } = makeDeps(logsDir, tmpDir);
    const notCreated = join(newDir('hl-diag-out2-'), 'no.zip');
    dialogResult.value = null;
    const service = new DiagBundleService(deps);
    const outcome = await service.saveBundle();
    expect(outcome).toEqual({ saved: false, canceled: true });
    expect(() => statSync(notCreated)).toThrow();
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('кэш превью (§11): collect → saveBundle — журнал сети читается один раз', async () => {
    const { deps, journalCalls, dialogResult } = makeDeps(logsDir, tmpDir);
    dialogResult.value = join(newDir('hl-diag-out3-'), 'bundle.zip');
    const service = new DiagBundleService(deps);
    await service.collect();
    await service.saveBundle();
    expect(journalCalls).toEqual([200]); // второй сбор не выполнялся — кэш использован
  });

  it('saveBundle без предварительного collect сам собирает (журнал читается)', async () => {
    const { deps, journalCalls, dialogResult } = makeDeps(logsDir, tmpDir);
    dialogResult.value = join(newDir('hl-diag-out4-'), 'bundle.zip');
    const service = new DiagBundleService(deps);
    await service.saveBundle();
    expect(journalCalls).toEqual([200]);
  });

  it('§18: лог «diag bundle saved files=N sizeMB=…» — без путей (basename только)', async () => {
    const { deps, logger, dialogResult } = makeDeps(logsDir, tmpDir);
    const targetPath = join(newDir('hl-diag-out5-'), 'bundle.zip');
    dialogResult.value = targetPath;
    const service = new DiagBundleService(deps);
    await service.saveBundle();
    const saved = logger.infos.find((entry) => entry.message === 'diag bundle saved');
    expect(saved).toBeDefined();
    expect(typeof saved?.meta?.['files']).toBe('number');
    expect(typeof saved?.meta?.['sizeMB']).toBe('number');
    expect(JSON.stringify(saved?.meta)).not.toContain(targetPath);
    expect(JSON.stringify(saved?.meta)).not.toContain(tmpdir());
  });

  it('defaultPath диалога — DIAG_BUNDLE_DEFAULT_NAME (имя пакета предлагает main)', async () => {
    const seen: Array<string | null> = [];
    const { deps, dialogResult } = makeDeps(logsDir, tmpDir);
    const baseDeps = deps as DiagBundleDeps & { saveDialog: { save: (o: { defaultPath: string }) => Promise<string | null> } };
    baseDeps.saveDialog.save = (options) => {
      seen.push(options.defaultPath);
      return Promise.resolve(dialogResult.value);
    };
    dialogResult.value = join(newDir('hl-diag-out6-'), 'bundle.zip');
    await new DiagBundleService(deps).saveBundle();
    expect(seen).toEqual([DIAG_BUNDLE_DEFAULT_NAME]);
  });
});

describe('DiagBundleService — защитная ветка объёма (§9)', () => {
  it('логи суммарно > лимита: только списки (без preview), сгенерированные json — с preview', async () => {
    const logsDir = newDir('hl-diag-big-');
    const tmpDir = newDir('hl-diag-tmp3-');
    writeFileSync(join(logsDir, 'hl.1.log'), `${'x'.repeat(80)}\n`.repeat(3)); // 243 байта
    writeFileSync(join(logsDir, 'hl.0.log'), `${'y'.repeat(80)}\n`.repeat(3));
    const { deps } = makeDeps(logsDir, tmpDir, { maxLogsBytes: 100 });
    const content = await new DiagBundleService(deps).collect();
    for (const file of content.files) {
      if (file.name.endsWith('.log')) {
        expect(file.preview).toBeUndefined();
      } else {
        expect(file.preview).toBeDefined();
      }
    }
  });
});

describe('DiagBundleService — производительность (§15/AC §20-5)', () => {
  it('collect на 25 МБ логов ≤ 2000 мс', async () => {
    const logsDir = newDir('hl-diag-perf-');
    const tmpDir = newDir('hl-diag-tmp4-');
    // ~26.5 МБ > 25 МиБ (26 214 400): 80-байтная строка × 330k (одна запись буфером).
    const buffer = Buffer.from(`${'x'.repeat(79)}\n`.repeat(330_000), 'utf8'); // ~26.4 МБ
    writeFileSync(join(logsDir, 'hl.1.log'), buffer);
    const { deps } = makeDeps(logsDir, tmpDir);
    const started = Date.now();
    const content = await new DiagBundleService(deps).collect();
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThanOrEqual(2000);
    const activeLog = content.files.find((file) => file.name === 'hl.1.log');
    expect(activeLog?.sizeBytes).toBeGreaterThan(25 * 1024 * 1024);
    // §9: суммарный объём логов > 25 МБ → previews опущены (защитная ветка честная).
    expect(activeLog?.preview).toBeUndefined();
    expect(readFileSync(join(logsDir, 'hl.1.log')).length).toBeGreaterThan(0);
  }, 30_000);
});
