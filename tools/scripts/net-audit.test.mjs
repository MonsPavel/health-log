/**
 * TASK-106 §19: юнит-тесты скрипта сетевого аудита (net-audit.mjs).
 *
 * Слои (прецедент size-audit.test.mjs — расчёты отделены от ФС/процессов):
 *  1. парсер вывода монитора Get-NetTCPConnection (фикстура-вывод JSONL:
 *     `{"ts":...,"conns":[...]}` с PascalCase-полями PowerShell) → нормализованные
 *     записи; ловит PS-кворк одиночного объекта вместо массива (ConvertTo-Json);
 *  2. классификация соединений: Listen/loopback/unspecified — не сетевые события
 *     аудита (шаблон §S1: «ожидание 0 соединений» считает только remote);
 *  3. дедуп соединений между poll-тиками (§19): один 4-tuple на N поллов → одна
 *     строка timeline (firstSeen/lastSeen/polls), смена state/localPort — отдельные;
 *  4. reverse-dns (инъекция резолвера — без сети в тестах, §14) и сводка;
 *  5. сценарии S1–S4 и timeline-отчёт (§5: скрипт пишет timeline по чек-листу);
 *  6. PowerShell-скрипты монитора (чистые строки: Get-NetTCPConnection, pid-фильтр,
 *     интервал 500 мс §4/§15);
 *  7. CLI: ошибки вызова → exit 2 ДО любых обращений к PowerShell (тесты идут и
 *     на CI-ubuntu, §24: автоматически зелёный — только чистые юниты).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_EXE_NAMES,
  POLL_INTERVAL_MS,
  SCENARIOS,
  buildTimelineMd,
  connectionKey,
  dedupConnections,
  isRemoteConnection,
  monitorScriptPs,
  normalizeJsonArray,
  parseMonitorOutput,
  parsePollLine,
  processListScriptPs,
  resolveHosts,
  run,
  summarizeConnections,
} from './net-audit.mjs';

/** Скрипт для CLI-тестов (§20: ошибки вызова — exit 2). */
const SCRIPT_PATH = fileURLToPath(new URL('./net-audit.mjs', import.meta.url));

/** Tmp-каталоги CLI-фикстур; удаляются после прогона. */
const tmpRoots = [];
afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Запуск CLI: {code, stdout, stderr} (прецедент copy-audit.test.mjs). */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Фикстура-строка poll-тика монитора: реальная форма вывода PowerShell
 * (ConvertTo-Json -Compress: PascalCase-поля Select-Object, порты — числа,
 * соединение установленное + слушающий сокет одним тиком).
 */
const POLL_LINE_ESTABLISHED = `{"ts":"2026-10-03T12:00:00.000Z","conns":[{"pid":4242,"LocalAddress":"192.168.1.2","LocalPort":52341,"RemoteAddress":"140.82.121.133","RemotePort":443,"State":"Established"},{"pid":4242,"LocalAddress":"0.0.0.0","LocalPort":52345,"RemoteAddress":"0.0.0.0","RemotePort":0,"State":"Bound"}]}`;

describe('parsePollLine (парсер фикстуры-вывода Get-NetTCPConnection, §19)', () => {
  it('разбирает poll-строку с двумя соединениями → нормализованные записи с ts', () => {
    const parsed = parsePollLine(POLL_LINE_ESTABLISHED);
    expect(parsed).not.toBeNull();
    expect(parsed.type).toBe('poll');
    expect(parsed.ts).toBe('2026-10-03T12:00:00.000Z');
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toEqual({
      ts: '2026-10-03T12:00:00.000Z',
      pid: 4242,
      localAddress: '192.168.1.2',
      localPort: 52341,
      remoteAddress: '140.82.121.133',
      remotePort: 443,
      state: 'Established',
    });
  });

  it('PS-кворк: conns одиночным объектом (не массивом) → массив из одной записи', () => {
    const line =
      '{"ts":"2026-10-03T12:00:01.000Z","conns":{"pid":7,"LocalAddress":"10.0.0.2","LocalPort":5000,"RemoteAddress":"93.184.216.34","RemotePort":80,"State":"TimeWait"}}';
    const parsed = parsePollLine(line);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].remoteAddress).toBe('93.184.216.34');
    expect(parsed.records[0].state).toBe('TimeWait');
  });

  it('пустой тик (0 соединений) → records: [] — ключевой кейс S1/S4', () => {
    const parsed = parsePollLine('{"ts":"2026-10-03T12:00:02.000Z","conns":[]}');
    expect(parsed.records).toEqual([]);
  });

  it('числовой State (PS-enum до каста) нормализуется к строке — живой прогон 2026-10-03', () => {
    const line =
      '{"ts":"2026-10-03T09:43:53.1781505Z","conns":[{"pid":29836,"LocalAddress":"10.0.0.1","LocalPort":49155,"RemoteAddress":"4.225.11.201","RemotePort":443,"State":5}]}';
    const parsed = parsePollLine(line);
    expect(parsed.records[0].state).toBe('5');
    expect(isRemoteConnection(parsed.records[0])).toBe(true);
  });

  it('мусорная/пустая строка → unknown/null (не роняет сборщик)', () => {
    expect(parsePollLine('не-JSON строка консоли')?.type).toBe('unknown');
    expect(parsePollLine('')).toBeNull();
    expect(parsePollLine('   ')).toBeNull();
  });

  it('нормализует PascalCase → lowerCamel и оставляет поля как есть по значению', () => {
    const parsed = parsePollLine(POLL_LINE_ESTABLISHED);
    expect(parsed.records[1]).toEqual({
      ts: '2026-10-03T12:00:00.000Z',
      pid: 4242,
      localAddress: '0.0.0.0',
      localPort: 52345,
      remoteAddress: '0.0.0.0',
      remotePort: 0,
      state: 'Bound',
    });
  });
});

describe('parseMonitorOutput (многострочный вывод монитора → записи, §19)', () => {
  it('собирает записи всех тиков, прикрепляя ts, и переживает CRLF/пустые строки', () => {
    const text = [
      POLL_LINE_ESTABLISHED,
      '',
      '{"ts":"2026-10-03T12:00:01.000Z","conns":[]}',
      '{"ts":"2026-10-03T12:00:02.000Z","conns":{"pid":7,"LocalAddress":"10.0.0.2","LocalPort":5000,"RemoteAddress":"93.184.216.34","RemotePort":80,"State":"TimeWait"}}',
      '',
    ].join('\r\n');
    const records = parseMonitorOutput(text);
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.ts)).toEqual([
      '2026-10-03T12:00:00.000Z',
      '2026-10-03T12:00:00.000Z',
      '2026-10-03T12:00:02.000Z',
    ]);
  });

  it('игнорирует неизвестные строки без падения', () => {
    const records = parseMonitorOutput('последовательность jsonl\r\n{"ts":"2026-10-03T12:00:00.000Z","conns":[]}');
    expect(records).toHaveLength(0);
  });
});

describe('isRemoteConnection (Listen/loopback — не сетевые события, §S1)', () => {
  const base = {
    ts: 't',
    pid: 1,
    localAddress: '192.168.1.2',
    localPort: 5000,
    remoteAddress: '140.82.121.133',
    remotePort: 443,
    state: 'Established',
  };

  it.each([
    ['внешний Established', { ...base }, true],
    ['внешний TimeWait (закрытое — тоже улика)', { ...base, state: 'TimeWait' }, true],
    ['слушающий сокет', { ...base, state: 'Listen', remoteAddress: '0.0.0.0', remotePort: 0 }, false],
    ['loopback IPv4', { ...base, remoteAddress: '127.0.0.1', remotePort: 8080 }, false],
    ['loopback IPv6', { ...base, remoteAddress: '::1', remotePort: 8080 }, false],
    ['unspecified', { ...base, remoteAddress: '0.0.0.0', remotePort: 0 }, false],
    ['IPv6 unspecified', { ...base, remoteAddress: '::', remotePort: 0 }, false],
  ])('%s → %j', (_name, record, expected) => {
    expect(isRemoteConnection(record)).toBe(expected);
  });
});

describe('connectionKey + dedupConnections (дедуп соединений, §19)', () => {
  const record = (over) => ({
    ts: '2026-10-03T12:00:00.000Z',
    pid: 4242,
    localAddress: '192.168.1.2',
    localPort: 52341,
    remoteAddress: '140.82.121.133',
    remotePort: 443,
    state: 'Established',
    ...over,
  });

  it('ключ различает endpoint, локальный порт и state', () => {
    const key = connectionKey(record());
    expect(key).toBe(connectionKey(record()));
    expect(key).not.toBe(connectionKey(record({ remotePort: 80 })));
    expect(key).not.toBe(connectionKey(record({ localPort: 52342 })));
    expect(key).not.toBe(connectionKey(record({ state: 'TimeWait' })));
  });

  it('один tuple на N тиков → одна строка с firstSeen/lastSeen/polls', () => {
    const rows = dedupConnections([
      record({ ts: '2026-10-03T12:00:00.000Z' }),
      record({ ts: '2026-10-03T12:00:01.000Z' }),
      record({ ts: '2026-10-03T12:00:02.000Z' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      remoteAddress: '140.82.121.133',
      remotePort: 443,
      localPort: 52341,
      state: 'Established',
      pid: 4242,
      firstSeen: '2026-10-03T12:00:00.000Z',
      lastSeen: '2026-10-03T12:00:02.000Z',
      polls: 3,
    });
  });

  it('разные локальные порты — разные соединения; смена state — отдельная фаза', () => {
    const rows = dedupConnections([
      record({ ts: '2026-10-03T12:00:00.000Z', localPort: 52341, state: 'Established' }),
      record({ ts: '2026-10-03T12:00:01.000Z', localPort: 52342, state: 'Established' }),
      record({ ts: '2026-10-03T12:00:02.000Z', localPort: 52341, state: 'TimeWait' }),
    ]);
    expect(rows).toHaveLength(3);
  });

  it('сортировка по firstSeen (детерминированный timeline)', () => {
    const rows = dedupConnections([
      record({ ts: '2026-10-03T12:00:05.000Z', remoteAddress: '1.1.1.1' }),
      record({ ts: '2026-10-03T12:00:01.000Z' }),
    ]);
    expect(rows.map((row) => row.firstSeen)).toEqual([
      '2026-10-03T12:00:01.000Z',
      '2026-10-03T12:00:05.000Z',
    ]);
  });

  it('только remote-соединения попадают в дедуп (Listen/Bound отфильтрованы)', () => {
    const rows = dedupConnections([
      record(),
      record({ state: 'Listen', remoteAddress: '0.0.0.0', remotePort: 0 }),
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('resolveHosts (reverse-dns, инъекция резолвера — без сети в тестах, §14)', () => {
  it('маппит ip → первый hostname; отказ резолвера → null', async () => {
    const hosts = await resolveHosts(['140.82.121.133', '93.184.216.34', '1.2.3.4'], {
      reverse: async (ip) => {
        if (ip === '140.82.121.133') {
          return ['cdn-140-82-121-133.github.com'];
        }
        throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      },
    });
    expect(hosts.get('140.82.121.133')).toBe('cdn-140-82-121-133.github.com');
    expect(hosts.get('93.184.216.34')).toBeNull();
    expect(hosts.get('1.2.3.4')).toBeNull();
  });

  it('пустой список ip — резолвер не вызывается', async () => {
    let calls = 0;
    const hosts = await resolveHosts([], {
      reverse: async () => {
        calls += 1;
        return [];
      },
    });
    expect(calls).toBe(0);
    expect(hosts.size).toBe(0);
  });
});

describe('summarizeConnections (сводка для сверки глазами, §5 «будущая работа»)', () => {
  it('уникальные endpoints/хосты/интервал наблюдения', () => {
    const rows = [
      {
        remoteAddress: '140.82.121.133',
        remotePort: 443,
        localPort: 52341,
        state: 'Established',
        pid: 1,
        firstSeen: '2026-10-03T12:00:00.000Z',
        lastSeen: '2026-10-03T12:00:02.000Z',
        polls: 3,
        host: 'cdn-140-82-121-133.github.com',
      },
      {
        remoteAddress: '93.184.216.34',
        remotePort: 443,
        localPort: 52344,
        state: 'Established',
        pid: 1,
        firstSeen: '2026-10-03T12:00:01.000Z',
        lastSeen: '2026-10-03T12:00:01.000Z',
        polls: 1,
        host: null,
      },
    ];
    const summary = summarizeConnections(rows);
    expect(summary.connections).toBe(2);
    expect(summary.endpoints).toEqual(['140.82.121.133:443', '93.184.216.34:443']);
    expect(summary.hosts).toEqual(['cdn-140-82-121-133.github.com']);
    expect(summary.spanMs).toBe(2000);
  });

  it('пустой набор — нули (кейс S1: «ожидание 0 соединений»)', () => {
    expect(summarizeConnections([])).toEqual({ connections: 0, endpoints: [], hosts: [], ips: [], spanMs: 0 });
  });
});

describe('SCENARIOS (чек-лист S1–S4 из шаблона, §5)', () => {
  it('четыре сценария с шагами и ожиданиями по заявленным хостам', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(['S1', 'S2', 'S3', 'S4']);
    for (const scenario of Object.values(SCENARIOS)) {
      expect(scenario.title.length).toBeGreaterThan(0);
      expect(scenario.steps.length).toBeGreaterThan(0);
      expect(Array.isArray(scenario.expectedHosts)).toBe(true);
    }
  });

  it('S1/S4 — ожидание нуля; S2 — хост манифеста моделей; S3 — github.com (обновления)', () => {
    expect(SCENARIOS.S1.expectedHosts).toEqual([]);
    expect(SCENARIOS.S4.expectedHosts).toEqual([]);
    expect(SCENARIOS.S2.expectedHosts).toEqual(['huggingface.co']);
    expect(SCENARIOS.S3.expectedHosts).toEqual(['github.com']);
  });

  it('S4 требует blocked-записи в журнале (§13: gateway не сработал = FAIL)', () => {
    expect(SCENARIOS.S4.expectation).toMatch(/blocked/i);
  });
});

describe('buildTimelineMd (timeline-отчёт, §5)', () => {
  const context = {
    scenario: 'S2',
    title: SCENARIOS.S2.title,
    expectation: SCENARIOS.S2.expectation,
    expectedHosts: SCENARIOS.S2.expectedHosts,
    startedAtUtc: '2026-10-03T12:00:00.000Z',
    finishedAtUtc: '2026-10-03T12:05:00.000Z',
    intervalMs: 500,
    polls: 600,
    processes: [{ pid: 4242, name: 'Health Log', path: 'C:\\app\\Health Log.exe' }],
    steps: [{ atUtc: '2026-10-03T12:01:00.000Z', text: 'шаг 2 выполнен оператором' }],
    connections: [
      {
        remoteAddress: '140.82.121.133',
        remotePort: 443,
        localPort: 52341,
        state: 'Established',
        pid: 4242,
        firstSeen: '2026-10-03T12:00:10.000Z',
        lastSeen: '2026-10-03T12:00:12.000Z',
        polls: 5,
        host: 'cdn-140-82-121-133.github.com',
      },
    ],
  };

  it('содержит сценарий, окно наблюдения, интервал, процессы и шаги', () => {
    const md = buildTimelineMd(context);
    expect(md).toContain('S2');
    expect(md).toContain('2026-10-03T12:00:00.000Z');
    expect(md).toContain('2026-10-03T12:05:00.000Z');
    expect(md).toContain('500 ms');
    expect(md).toContain('600');
    expect(md).toContain('Health Log');
    expect(md).toContain('4242');
    expect(md).toContain('шаг 2 выполнен оператором');
  });

  it('содержит строку соединения с reverse-dns и сводку endpoints/хостов', () => {
    const md = buildTimelineMd(context);
    expect(md).toContain('140.82.121.133:443');
    expect(md).toContain('Established');
    expect(md).toContain('cdn-140-82-121-133.github.com');
    expect(md).toContain('140.82.121.133:443');
  });

  it('пустой набор соединений — явный «0 соединений» (доказательство S1/S4)', () => {
    const md = buildTimelineMd({ ...context, scenario: 'S1', connections: [] });
    expect(md).toMatch(/0 connections/i);
  });

  it('фиксирует ожидание сценария (заявленные хосты) рядом с наблюдением', () => {
    const md = buildTimelineMd(context);
    expect(md).toContain('huggingface.co');
  });
});

describe('PowerShell-скрипты (чистые строки, §4: netsh не нужен — polling)', () => {
  it('монитор: Get-NetTCPConnection, фильтр по именам процессов, интервал 500 мс', () => {
    const script = monitorScriptPs(['Health Log'], 500);
    expect(script).toContain('Get-NetTCPConnection');
    expect(script).toContain('Get-Process');
    expect(script).toContain('-Name');
    expect(script).toContain("'Health Log'");
    expect(script).toContain('-Milliseconds 500');
    expect(script).toContain('[string]$_.State');
  });

  it('монитор: дефолтный интервал 500 мс (§4/§15)', () => {
    expect(POLL_INTERVAL_MS).toBe(500);
    expect(monitorScriptPs(['Health Log'])).toContain('-Milliseconds 500');
  });

  it('разовый список процессов: имена из аргументов, JSON-вывод', () => {
    const script = processListScriptPs(['Health Log', 'electron']);
    expect(script).toContain('Get-Process');
    expect(script).toContain("'Health Log'");
    expect(script).toContain("'electron'");
    expect(script).toContain('ConvertTo-Json');
  });

  it('дефолтные имена процессов — релизный exe (productName «Health Log»)', () => {
    expect(DEFAULT_EXE_NAMES).toEqual(['Health Log']);
  });
});

describe('run (драйвер: ошибки вызова — до обращения к ОС, §5)', () => {
  it('неизвестный сценарий → exit 2 без запуска монитора', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'hl-net-audit-'));
    tmpRoots.push(outDir);
    const result = await run({ scenario: 'S9', outDir });
    expect(result.exitCode).toBe(2);
    expect(result.error).toMatch(/scenario/i);
  });

  it('отсутствующий сценарий → exit 2 и usage', async () => {
    const result = await run({});
    expect(result.exitCode).toBe(2);
    expect(result.error).toMatch(/usage/i);
  });
});

describe('CLI (spawn node: usage-ошибки — exit 2, §20)', () => {
  it('без --scenario → exit 2 + usage в stderr', async () => {
    const { code, stderr } = await runCli([]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage/i);
  });

  it('с неизвестным --scenario → exit 2', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'hl-net-audit-'));
    tmpRoots.push(outDir);
    const { code, stderr } = await runCli(['--scenario', 'S9', '--out', outDir]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown scenario/i);
  });
});

describe('normalizeJsonArray (PS-кворк одиночного объекта)', () => {
  it('undefined/null → []; объект → [объект]; массив — как есть', () => {
    expect(normalizeJsonArray(undefined)).toEqual([]);
    expect(normalizeJsonArray(null)).toEqual([]);
    expect(normalizeJsonArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(normalizeJsonArray([1, 2])).toEqual([1, 2]);
    expect(normalizeJsonArray([])).toEqual([]);
  });
});
