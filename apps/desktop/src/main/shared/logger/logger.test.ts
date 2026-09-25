/**
 * TASK-010 §19/§20: тесты логгера. Пути логов — только tmp (конвенция TASK-004):
 * каждый кейс получает свежий mkdtemp-каталог, синглтон-состояние модуля сбрасывается
 * resetLoggingForTests (§19: буфер до init требует «не инициализированного» старта).
 * Проверяются: назначение файла, категории (child-поля), редакция PHI в реальном файле
 * (§19 контракт, §20 grep), ротация (эмуляция превышения размера), уровни по окружению,
 * буферизация до инициализации, logDiagnostic (stack без PHI cause).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createLogger,
  initFileLogging,
  logDiagnostic,
  resetLoggingForTests,
  resolveLogLevel,
  type FileLoggingOptions,
} from './logger.js';
import { MAX_REDACT_DEPTH, PHI_CENSOR } from './redact.js';

/** Активный файл pino-roll v4 в свежем каталоге: номер вставляется перед расширением (hl.1.log). */
const ACTIVE = 'hl.1.log';

/** Активное содержимое лога — так его увидит grep диагпакета (§20). */
function readLog(dir: string): string {
  return readFileSync(join(dir, ACTIVE), 'utf8');
}

/**
 * Разбор JSON-строк лога. Значения PHI проверяем структурно (по разобранным полям),
 * а не подстрокой в сырой строке: числовые литералы вида «125» случайным образом
 * встречаются в pid/epoch-time самой строки лога.
 */
function parseLines(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Ожидание асинхронной ротации: roll планируется на drain (nextTick), удаление старых — промисом. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: условие не достигнуто за отведённое время');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Опции по умолчанию кейса: tmp-файл, dev-уровни. */
function options(dir: string, overrides: Partial<FileLoggingOptions> = {}): FileLoggingOptions {
  return { file: join(dir, 'hl.log'), dev: true, ...overrides };
}

describe('initFileLogging — назначение и формат (§5/§20)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hl-log-'));
  });
  afterEach(() => {
    resetLoggingForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('пишет JSON-строки с category (child-поле), msg и временем в файл (§19 категории)', async () => {
    await initFileLogging(options(dir));
    createLogger('ipc').info('op done', { durationMs: 12 });

    const parsed = JSON.parse(readLog(dir)) as Record<string, unknown>;
    expect(parsed['category']).toBe('ipc');
    expect(parsed['msg']).toBe('op done');
    expect(parsed['durationMs']).toBe(12);
    expect(typeof parsed['time']).toBe('number');
  });
});

describe('редакция PHI в реальном лог-файле (§19 контракт, §20 acceptance)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hl-log-'));
  });
  afterEach(() => {
    resetLoggingForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('фикстура §19: PHI-значения цензурены, есть durationMs:12 (рекурсивный слой)', async () => {
    await initFileLogging(options(dir));
    createLogger('app').info('addMeasurement', {
      measurement: { sys: 125, note: 'болит голова' },
      durationMs: 12,
    });

    const [line] = parseLines(readLog(dir));
    expect(line['measurement']).toBe(PHI_CENSOR);
    expect(line['durationMs']).toBe(12);
    expect(readLog(dir)).not.toContain('болит');
  });

  it('верхний уровень: pino.redact-слой цензурирует sys значением [redacted] (§14 двойной слой)', async () => {
    await initFileLogging(options(dir));
    createLogger('app').info('read', { sys: 125, op: 'read' });

    const [line] = parseLines(readLog(dir));
    expect(line['sys']).toBe(PHI_CENSOR);
    expect(line['op']).toBe('read');
  });
});

describe('ротация (§19: эмуляция превышения размера на tmp)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hl-log-'));
  });
  afterEach(() => {
    resetLoggingForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('превышение size создаёт ротированные файлы; limit удерживает count+1 (§5: 5 МБ × 5)', async () => {
    await initFileLogging(options(dir, { size: '1k', limitCount: 2 }));
    const log = createLogger('app');
    for (let i = 0; i < 40; i += 1) {
      log.info('line to fill rotation', { i, pad: 'x'.repeat(80) });
    }

    await waitFor(() => readdirSync(dir).length >= 2);
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    // §5: limit.count=2 ротированных + 1 активный — предел числа файлов на диске
    expect(files.length).toBeLessThanOrEqual(3);
    for (const name of files) {
      expect(name).toMatch(/^hl\.\d+\.log$/);
    }
  });
});

describe('уровни по окружению (§5, §20: prod без debug)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hl-log-'));
  });
  afterEach(() => {
    resetLoggingForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prod (эмуляция packaged): debug-сообщения отсутствуют, info пишется (§20)', async () => {
    await initFileLogging(options(dir, { dev: false }));
    const log = createLogger('app');
    log.debug('debug line');
    log.info('info line');

    const content = readLog(dir);
    expect(content).not.toContain('debug line');
    expect(content).toContain('info line');
  });

  it('prod игнорирует LOG_LEVEL — переопределение только в dev (§5)', async () => {
    await initFileLogging(options(dir, { dev: false, logLevel: 'debug' }));
    createLogger('app').debug('debug line');

    expect(readLog(dir)).not.toContain('debug line');
  });

  it('dev + LOG_LEVEL=warn: debug уходит, warn пишется', async () => {
    await initFileLogging(options(dir, { dev: true, logLevel: 'warn' }));
    const log = createLogger('app');
    log.debug('debug line');
    log.warn('warn line');

    const content = readLog(dir);
    expect(content).not.toContain('debug line');
    expect(content).toContain('warn line');
  });
});

describe('resolveLogLevel — матрица §5 (чистая функция)', () => {
  it('prod → info, независимо от LOG_LEVEL', () => {
    expect(resolveLogLevel(false)).toBe('info');
    expect(resolveLogLevel(false, 'debug')).toBe('info');
    expect(resolveLogLevel(false, 'trace')).toBe('info');
  });

  it('dev → debug по умолчанию; LOG_LEVEL переопределяет (в т.ч. в верхнем регистре)', () => {
    expect(resolveLogLevel(true)).toBe('debug');
    expect(resolveLogLevel(true, 'warn')).toBe('warn');
    expect(resolveLogLevel(true, ' WARN ')).toBe('warn');
  });

  it('некорректный LOG_LEVEL — откат к умолчанию окружения', () => {
    expect(resolveLogLevel(true, 'loud')).toBe('debug');
    expect(resolveLogLevel(false, 'loud')).toBe('info');
  });
});

describe('буфер до инициализации (§9, §20: ранние ошибки не теряются)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hl-log-'));
  });
  afterEach(() => {
    resetLoggingForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('записи до init держатся в памяти и попадают в файл после; логгер живёт дальше (ленивая фабрика §6)', async () => {
    const file = join(dir, 'hl.log');
    const earlyApp = createLogger('app');
    const earlyIpc = createLogger('ipc');
    earlyApp.error('early boom', { code: 'APP/INTERNAL' });
    earlyIpc.warn('early warn');

    expect(existsSync(join(dir, ACTIVE))).toBe(false);

    await initFileLogging(options(dir, { file }));

    const content = readLog(dir);
    expect(content).toContain('early boom');
    expect(content).toContain('"code":"APP/INTERNAL"');
    expect(content).toContain('"category":"app"');
    expect(content).toContain('"category":"ipc"');

    earlyApp.warn('after init');
    expect(readLog(dir)).toContain('after init');
  });
});

describe('logDiagnostic (§5, §20: stack без PHI cause)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hl-log-'));
  });
  afterEach(() => {
    resetLoggingForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('Error: пишет message и stack, PHI-ключи в cause цензурены (§20)', async () => {
    await initFileLogging(options(dir));
    logDiagnostic(createLogger('db'), new Error('boom', { cause: { sys: 125, hint: 'ctx' } }));

    const [line] = parseLines(readLog(dir));
    const err = line['err'] as {
      type: string;
      message: string;
      stack: string;
      cause: Record<string, unknown>;
    };
    expect(err.type).toBe('Error');
    expect(err.message).toBe('boom');
    expect(typeof err.stack).toBe('string');
    expect(err.cause).toEqual({ sys: PHI_CENSOR, hint: 'ctx' });
  });

  it('не-Error объект (AppError не наследует Error, TASK-006 §7): code/messageKey видны, cause-Error разворачивается, PHI в цепочке цензурены', async () => {
    await initFileLogging(options(dir));
    logDiagnostic(createLogger('ipc'), {
      code: 'DB/CORRUPT',
      messageKey: 'errors.db.corrupt',
      cause: new Error('inner', { cause: { note: 'секрет' } }),
    });

    const [line] = parseLines(readLog(dir));
    const err = line['err'] as {
      code: string;
      messageKey: string;
      cause: { message: string; stack: string; cause: { note: string } };
    };
    expect(err.code).toBe('DB/CORRUPT');
    expect(err.messageKey).toBe('errors.db.corrupt');
    expect(err.cause.message).toBe('inner');
    expect(typeof err.cause.stack).toBe('string');
    expect(err.cause.cause.note).toBe(PHI_CENSOR);
  });

  it('примитив логируется как есть', async () => {
    await initFileLogging(options(dir));
    logDiagnostic(createLogger('app'), 'plain failure');

    expect(readLog(dir)).toContain('plain failure');
  });

  // §14 fail-safe (ревью ветки): logDiagnostic обрабатывает ЧУЖИЕ ошибки — исключение
  // из логирующего вызова (RangeError при цикле cause) может уронить обработчик ошибки
  // в main. Циклы/бесконечная глубина цензурятся, а не бросают — по образцу redactPhi.
  it('самоциклическая cause-цепочка: logDiagnostic не бросает, цикл цензурен (§14)', async () => {
    await initFileLogging(options(dir));
    const cyclic: Error & { cause?: unknown } = new Error('outer');
    cyclic.cause = cyclic;

    expect(() => logDiagnostic(createLogger('app'), cyclic)).not.toThrow();

    const [line] = parseLines(readLog(dir));
    const err = line['err'] as { message: string; cause: unknown };
    expect(err.message).toBe('outer');
    expect(err.cause).toBe(PHI_CENSOR);
  });

  it('взаимный цикл через не-Error объекты: разворачивается до первой встречи, дальше цензура (§14)', async () => {
    await initFileLogging(options(dir));
    const a: { code: string; cause?: unknown } = { code: 'A/X' };
    const b: { code: string; cause?: unknown } = { code: 'B/Y' };
    a.cause = b;
    b.cause = a;
    logDiagnostic(createLogger('ipc'), a);

    const [line] = parseLines(readLog(dir));
    const err = line['err'] as { code: string; cause: { code: string; cause: unknown } };
    expect(err.code).toBe('A/X');
    expect(err.cause.code).toBe('B/Y');
    expect(err.cause.cause).toBe(PHI_CENSOR);
  });

  it(`цепочка глубже ${MAX_REDACT_DEPTH}: хвост цензурен вместо переполнения стека (§14)`, async () => {
    await initFileLogging(options(dir));
    let deep: Error = new Error(`level-${MAX_REDACT_DEPTH + 1}`);
    for (let i = MAX_REDACT_DEPTH; i >= 0; i -= 1) {
      deep = new Error(`level-${i}`, { cause: deep });
    }

    expect(() => logDiagnostic(createLogger('db'), deep)).not.toThrow();

    const [line] = parseLines(readLog(dir));
    let node = line['err'] as { message: string; cause?: unknown };
    // уровни 0..MAX_REDACT_DEPTH видны, хвост (глубже предела) — цензура
    for (let i = 0; i <= MAX_REDACT_DEPTH; i += 1) {
      expect(node.message).toBe(`level-${i}`);
      node = node['cause'] as { message: string; cause?: unknown };
    }
    expect(node).toBe(PHI_CENSOR);
  });
});
