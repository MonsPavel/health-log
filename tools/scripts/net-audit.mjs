/**
 * TASK-106: скрипт сетевого аудита релизной сборки (AC-4.1, BG-2). Обёртка над
 * polling Get-NetTCPConnection (Windows-native, без установки, §4): фильтр по
 * процессам приложения → JSONL-лог соединений (ts, remote-ip:port, reverse-dns
 * host, state) → дедуп → timeline-отчёт. Сценарный драйвер: шаги выполняются
 * вручную оператором по чек-листу (S1–S4 шаблона docs/architecture/audits/
 * audit-template.md), скрипт пишет timeline и raw-лог; скрипт — СБОРЩИК ДАННЫХ,
 * вердикт PASS/FAIL и сверка журнал↔наблюдения — за оператором по шаблону
 * (авто-дифф — будущая работа, §5).
 *
 * Запуск: `node tools/scripts/net-audit.mjs --scenario S1 [--exe "Health Log"]
 * [--interval 500] [--out <dir>] [--duration <sec>] [--wait-app <sec>]`.
 * Интерактив: Enter — отметить шаг чек-листа выполненным, `q`+Enter — завершить.
 * Артефакты (данные только метаданные соединений — безопасно прикладывать, §14):
 * connections-raw.jsonl (тик за тиком) + timeline-<S>.md (дедуп + reverse-dns).
 * По умолчанию артефакты пишутся в tools/audit-results/<UTC-дата>-<S>/.
 *
 * Коды возврата: 0 — прогон завершён (артефакты записаны); 1 — ошибка прогона
 * (монитор/ОС); 2 — ошибка вызова (сценарий/флаги) — ДО любых обращений к ОС
 * (юнит-тесты выполняются и на CI-ubuntu, §24: автоматически зелёный только
 * чистый слой).
 *
 * Чистые функции (§19) — parse/normalize/classify/dedup/hosts/summary/timeline —
 * тестируются на фикстурах вывода PowerShell (net-audit.test.mjs); ФС и процессы
 * — только в run()/CLI. Отчёт — английский (§16: dev-инструмент, прецедент
 * size-audit). Ограничение TASK-096 §22: байты updater'а журнал фиксирует
 * приблизительно — в аудите updater-соединения сверяются по факту проверки, не
 * по байтам.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { argv, cwd, exit, platform } from 'node:process';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';

/** Интервал polling (§4/§15: 500 мс — ловит секундные updater-сессии). */
export const POLL_INTERVAL_MS = 500;

/** Имена процессов приложения по умолчанию: релизный exe (productName, electron-builder). */
export const DEFAULT_EXE_NAMES = ['Health Log'];

/** Remote-адреса, не являющиеся сетевым событием: unspecified + loopback. */
export const NON_REMOTE_ADDRESSES = new Set(['', '0.0.0.0', '::', '127.0.0.1', '::1']);

/** Таймаут reverse-dns на IP, мс (DNS-затык не должен висеть аудитом). */
export const REVERSE_DNS_TIMEOUT_MS = 2000;

/**
 * Сценарии чек-листа (§5/шаблон): title/expectation — тексты для timeline;
 * steps — чек-лист оператора; expectedHosts — заявленные хосты (§13: сверка
 * глазами по шаблону, допуск по CDN/IP-диапазонам зафиксирован в шаблоне).
 */
export const SCENARIOS = {
  S1: {
    title: 'Clean install, no consents',
    expectation: '0 outbound connections during the whole scenario',
    expectedHosts: [],
    steps: [
      'Install/launch the release build with a FRESH user-data profile (clean install)',
      'Confirm NO network consents are granted (Privacy section: both switches off)',
      'Work 5 minutes with the full functionality except network (measurements, history, stats, reports, export, settings)',
      'Verify OS-level connections stayed at zero (timeline) and the journal has no new network entries',
    ],
  },
  S2: {
    title: 'Models consent granted, model download',
    expectation: 'only the manifest-declared model host (huggingface.co) and its CDN redirects',
    expectedHosts: ['huggingface.co'],
    steps: [
      'Open Settings → Privacy, enable the "models download" consent (UI confirm dialog)',
      'Start downloading the Llama 3.2 1B model from the Models screen',
      'Wait until the download reaches the installed state (sha256 verified)',
      'Verify only declared hosts appeared (timeline) and journal records models.download with byte counts',
    ],
  },
  S3: {
    title: 'Updates consent granted, update check',
    expectation: 'only the update feed host (github.com, generic provider over GitHub Releases)',
    expectedHosts: ['github.com'],
    steps: [
      'Open Settings → Privacy, enable the "updates check" consent (UI confirm dialog)',
      'Trigger "Check for updates" in Settings → Updates',
      'Wait until the check completes (result shown, even "no updates"/error is a completed check)',
      'Verify only declared hosts appeared (timeline) and journal records updates.check (updater bytes are approximate — TASK-096 §22)',
    ],
  },
  S4: {
    title: 'Consents revoked, repeated attempts',
    expectation: '0 outbound connections; journal shows blocked attempts (gateway refused)',
    expectedHosts: [],
    steps: [
      'Open Settings → Privacy, revoke BOTH consents (models download, updates check)',
      'Attempt a model download again (expect visible NET/BLOCKED_BY_POLICY error, no download)',
      'Trigger "Check for updates" again (expect visible block, no network activity)',
      'Verify timeline stays at 0 outbound connections and the journal has blocked entries for both attempts',
    ],
  },
};

/** Результат разбора строки вывода монитора (см. parsePollLine). */

/**
 * PS-кворк ConvertTo-Json: одиночный элемент сериализуется объектом, не массивом.
 * Нормализация: undefined/null → []; объект → [объект]; массив — как есть.
 */
export function normalizeJsonArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * Нормализация записи соединения из PowerShell (PascalCase-поля Select-Object)
 * в lowerCamel с ts тика. Неизвестные поля отбрасываются — фикстура-парсер §19.
 */
export function normalizeRecord(raw, ts) {
  return {
    ts,
    pid: raw['pid'] ?? raw['Pid'] ?? raw['OwningProcess'] ?? null,
    localAddress: raw['LocalAddress'] ?? raw['localAddress'] ?? '',
    localPort: raw['LocalPort'] ?? raw['localPort'] ?? null,
    remoteAddress: raw['RemoteAddress'] ?? raw['remoteAddress'] ?? '',
    remotePort: raw['RemotePort'] ?? raw['remotePort'] ?? null,
    // State — строка (монитор кастует [string]$_ .State; PS-enum может прийти
    // числом — нормализуем к строке, чтобы ключи дедупа были консистентны).
    state:
      raw['State'] === undefined || raw['State'] === null
        ? String(raw['state'] ?? '')
        : String(raw['State']),
  };
}

/**
 * Строка вывода монитора → {type:'poll', ts, records} | {type:'unknown'} | null
 * (пустая). Формат тика — JSONL `{"ts":"…","conns":[{PascalCase-поля}, …]}`
 * (см. monitorScriptPs: массив собирается в PS вручную из одиночных
 * ConvertTo-Json — кворк 5.1 с одиночными массивами исключён, но парсер его
 * терпит — normalizeJsonArray).
 */
export function parsePollLine(line) {
  if (line.trim() === '') {
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return { type: 'unknown', line };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.ts === undefined) {
    return { type: 'unknown', line };
  }
  const records = normalizeJsonArray(raw.conns).map((item) => normalizeRecord(item, raw.ts));
  return { type: 'poll', ts: String(raw.ts), records };
}

/** Весь вывод монитора → плоский список записей (ts прикреплён); мусор — игнор. */
export function parseMonitorOutput(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parsePollLine(line);
    if (parsed !== null && parsed.type === 'poll') {
      records.push(...parsed.records);
    }
  }
  return records;
}

/**
 * Соединение — сетевое событие аудита? Слушающие сокеты и loopback/unspecified
 * remote — нет (шаблон S1: «0 соединений» считает только remote-соединения).
 * Закрытые фазы (TimeWait/CloseWait) с внешним remote — улики, считаются.
 */
export function isRemoteConnection(record) {
  if (record.state === 'Listen') {
    return false;
  }
  return !NON_REMOTE_ADDRESSES.has(record.remoteAddress);
}

/** Ключ дедупа: endpoint + локальный порт + state (смена state — отдельная фаза). */
export function connectionKey(record) {
  return `${record.remoteAddress}|${record.remotePort}|${record.localPort}|${record.state}`;
}

/**
 * Дедуп соединений между тиками (§19): один 4-tuple на N поллов → одна строка
 * {remote, localPort, state, pid, firstSeen, lastSeen, polls}. Только remote-
 * соединения (isRemoteConnection). Сортировка по firstSeen — детерминизм.
 */
export function dedupConnections(records) {
  const byKey = new Map();
  for (const record of records) {
    if (!isRemoteConnection(record)) {
      continue;
    }
    const key = connectionKey(record);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        remoteAddress: record.remoteAddress,
        remotePort: record.remotePort,
        localPort: record.localPort,
        state: record.state,
        pid: record.pid,
        firstSeen: record.ts,
        lastSeen: record.ts,
        polls: 1,
        host: null,
      });
      continue;
    }
    existing.lastSeen = record.ts;
    existing.polls += 1;
  }
  return [...byKey.values()].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
}

/**
 * Reverse-dns для уникальных IP (§5: reverse-dns host в логе). Резолвер —
 * параметр (§19/§14: тесты без сети); дефолт — dns.promises.reverse с таймаутом
 * (DNS-затык не подвешивает аудит). Отказ → null (не ошибка: аудит фиксирует
 * и «хоста нет»).
 */
export async function resolveHosts(ips, resolver = defaultReverseResolver()) {
  const hosts = new Map();
  for (const ip of new Set(ips)) {
    hosts.set(ip, await resolveHostIp(ip, resolver));
  }
  return hosts;
}

/** Дефолтный резолвер: reverse с таймаутом REVERSE_DNS_TIMEOUT_MS. */
function defaultReverseResolver() {
  return {
    reverse: (ip) =>
      new Promise((resolveIp, reject) => {
        const timer = setTimeout(
          () => reject(Object.assign(new Error(`reverse timeout: ${ip}`), { code: 'ETIMEDOUT' })),
          REVERSE_DNS_TIMEOUT_MS,
        );
        dns.promises
          .reverse(ip)
          .then((names) => {
            clearTimeout(timer);
            resolveIp(names);
          })
          .catch((cause) => {
            clearTimeout(timer);
            reject(cause);
          });
      }),
  };
}

/** Один IP → первый hostname или null (ENOTFOUND/таймаут/пустой ответ). */
async function resolveHostIp(ip, resolver) {
  try {
    const names = await resolver.reverse(ip);
    return Array.isArray(names) && names.length > 0 ? String(names[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Сводка для сверки глазами (§5: авто-дифф — будущая работа): количество
 * соединений, уникальные endpoints/хосты/IP и окно наблюдения (мс).
 */
export function summarizeConnections(rows) {
  const endpoints = [...new Set(rows.map((row) => `${row.remoteAddress}:${row.remotePort}`))];
  const ips = [...new Set(rows.map((row) => row.remoteAddress))];
  const hosts = [...new Set(rows.map((row) => row.host).filter((host) => host !== null))];
  const times = rows.flatMap((row) => [row.firstSeen, row.lastSeen]).filter((ts) => ts !== '');
  const spanMs =
    times.length === 0
      ? 0
      : new Date(Math.max(...times.map((ts) => Date.parse(ts)))).getTime() -
        new Date(Math.min(...times.map((ts) => Date.parse(ts)))).getTime();
  return { connections: rows.length, endpoints, hosts, ips, spanMs };
}

/** PowerShell-скрипт монитора: JSONL-тик каждые intervalMs (§4). См. шапку. */
export function monitorScriptPs(exeNames, intervalMs = POLL_INTERVAL_MS) {
  const names = exeNames.map((name) => `'${name}'`).join(',');
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    `$names=@(${names})`,
    'while($true) {',
    "  $ts=[DateTime]::UtcNow.ToString('o')",
    "  $ids=@(Get-Process -Name $names -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)",
    '  $conns=@()',
    '  if($ids.Count -gt 0) {',
    '    $conns=@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess })',
    '  }',
    "  $parts=foreach($c in $conns) { $c | Select-Object @{n='pid';e={$_.OwningProcess}},LocalAddress,LocalPort,RemoteAddress,RemotePort,@{n='State';e={[string]$_.State}} | ConvertTo-Json -Compress }",
    '  [Console]::WriteLine(\'{"ts":"\' + $ts + \'","conns":[\' + ($parts -join \',\') + \']}\')',
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    '}',
  ].join('\n');
}

/** PowerShell-разовый скрипт: список процессов приложения (pid/name/path). */
export function processListScriptPs(exeNames) {
  const names = exeNames.map((name) => `'${name}'`).join(',');
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    `Get-Process -Name @(${names}) -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress`,
  ].join('\n');
}

/**
 * Timeline-отчёт сценария (markdown, §5: скрипт пишет timeline). Английский
 * (§16, прецедент size-audit); ожидание сценария фиксируется рядом с фактом —
 * вердикт PASS/FAIL остаётся за оператором в отчёте-шаблоне.
 */
export function buildTimelineMd(context) {
  const {
    scenario,
    title,
    expectation,
    expectedHosts,
    startedAtUtc,
    finishedAtUtc,
    intervalMs,
    polls,
    processes,
    steps,
    connections,
    summary: summaryInput,
  } = context;
  // Сводка — производные данные соединений: если не передана (тесты, ручной
  // вызов), считается на месте (единый источник — summarizeConnections).
  const summary = summaryInput ?? summarizeConnections(connections);
  const lines = [
    `# net-audit timeline — ${scenario}: ${title}`,
    '',
    `- window (UTC): ${startedAtUtc} → ${finishedAtUtc}`,
    `- polling: every ${intervalMs} ms, ${polls} polls (Get-NetTCPConnection, OS-level)`,
    '- app processes: ' +
      (processes.length === 0
        ? 'NONE FOUND (check --exe)'
        : processes.map((proc) => `pid ${proc.pid} (${proc.name})`).join(', ')),
    `- expectation (declared): ${expectation}`,
    `- expected hosts: ${expectedHosts.length === 0 ? '(none — must stay silent)' : expectedHosts.join(', ')}`,
    '',
    '## Steps (operator checklist)',
    '',
  ];
  if (steps.length === 0) {
    lines.push('(no steps recorded)');
  } else {
    for (const step of steps) {
      lines.push(`- ${step.atUtc} — ${step.text}`);
    }
  }
  lines.push('', '## Connections (deduplicated)', '');
  if (connections.length === 0) {
    lines.push('0 connections observed.');
  } else {
    lines.push(
      '| first seen | last seen | remote | state | reverse-dns host | pid | polls |',
      '|---|---|---|---|---|---|---|',
    );
    for (const row of connections) {
      lines.push(
        `| ${row.firstSeen} | ${row.lastSeen} | ${row.remoteAddress}:${row.remotePort} | ${row.state} | ${row.host ?? '(no PTR)'} | ${row.pid} | ${row.polls} |`,
      );
    }
  }
  lines.push(
    '',
    '## Summary',
    '',
    `- connections: ${summary.connections}`,
    `- endpoints: ${summary.endpoints.length === 0 ? '(none)' : summary.endpoints.join(', ')}`,
    `- reverse-dns hosts: ${summary.hosts.length === 0 ? '(none)' : summary.hosts.join(', ')}`,
    `- observed span: ${summary.spanMs} ms`,
    '',
    'Raw poll log: connections-raw.jsonl (metadata only — no TLS content, spec §14).',
    'Verdict (PASS/FAIL) and journal reconciliation: see audit-template.md.',
  );
  return lines.join('\n');
}

/** Запуск powershell с -Command (Windows PowerShell 5.1 — есть на любой Windows). */
function runPowerShell(command, options = {}) {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    windowsHide: true,
    ...options,
  });
}

/**
 * Разовый список процессов приложения (JSON PS-кворка нормализуется) →
 * [{pid, name, path}]. Ошибка ОС/парсинга → [] (драйвер подскажет --exe).
 */
export async function listAppProcesses(exeNames) {
  return new Promise((resolvePromise) => {
    const child = runPowerShell(processListScriptPs(exeNames));
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolvePromise([]));
    child.on('close', () => {
      try {
        const parsed = normalizeJsonArray(JSON.parse(stdout));
        resolvePromise(
          parsed
            .filter((item) => item !== null && typeof item === 'object')
            .map((item) => ({
              pid: item['Id'] ?? null,
              name: item['ProcessName'] ?? '',
              path: item['Path'] ?? '',
            })),
        );
      } catch {
        resolvePromise([]);
      }
    });
  });
}

/**
 * Полный прогон сценария (§5 драйвер): ожидание процессов → монитор-JSONL →
 * шаги оператора (Enter/q либо --duration) → reverse-dns → timeline + raw-лог.
 * Опции — точки ввода тестов (§19: чистые слои покрыты отдельно; run() с
 * невалидными опциями тестируется до обращений к ОС).
 */
export async function run(options = {}) {
  const scenarioKey = options.scenario;
  if (scenarioKey === undefined) {
    return {
      exitCode: 2,
      error:
        'usage: node tools/scripts/net-audit.mjs --scenario <S1|S2|S3|S4> [--exe "Health Log"] [--interval 500] [--out <dir>] [--duration <sec>] [--wait-app <sec>]',
    };
  }
  const scenario = SCENARIOS[scenarioKey];
  if (scenario === undefined) {
    return { exitCode: 2, error: `unknown scenario: ${scenarioKey} (expected S1|S2|S3|S4)` };
  }

  // Далее — обращения к ОС: только Windows (§5: Linux/macOS — пост-MVP).
  if (platform !== 'win32') {
    return { exitCode: 2, error: `net-audit is Windows-only (Get-NetTCPConnection); platform: ${platform}` };
  }

  const exeNames = options.exeNames ?? DEFAULT_EXE_NAMES;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const durationMs = options.durationMs ?? null;
  const waitAppMs = options.waitAppMs ?? 60_000;
  const outRoot = resolve(options.outDir ?? resolve(cwd(), 'tools', 'audit-results'));

  // 1. Ждём процессы приложения (оператор запускает сборку; §5: шаги — вручную).
  const deadline = Date.now() + waitAppMs;
  let processes = [];
  while (processes.length === 0) {
    processes = await listAppProcesses(exeNames);
    if (processes.length > 0 || Date.now() > deadline) {
      break;
    }
    console.log(
      `Waiting for app process(es) ${exeNames.join(', ')}… launch the release build now (${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} s left)`,
    );
    await sleep(1000);
  }
  if (processes.length === 0) {
    return {
      exitCode: 1,
      error: `app process(es) not found within ${Math.round(waitAppMs / 1000)} s: ${exeNames.join(', ')}`,
    };
  }
  console.log(`Monitoring ${processes.length} process(es): ${processes.map((proc) => `pid ${proc.pid}`).join(', ')}`);

  // 2. Каталог артефактов + raw-лог.
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${scenarioKey}`;
  const outDir = resolve(outRoot, options.outDir === undefined ? runId : '');
  await mkdir(outDir, { recursive: true });
  const rawLogPath = resolve(outDir, 'connections-raw.jsonl');

  // 3. Монитор: JSONL-тик → raw-лог + счётчик поллов (сборщик, не анализатор).
  let polls = 0;
  const monitor = runPowerShell(monitorScriptPs(exeNames, intervalMs));
  const monitorReady = new Promise((resolvePromise, rejectPromise) => {
    monitor.on('error', rejectPromise);
    monitor.stdout.setEncoding('utf8');
    let buffer = '';
    monitor.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') {
          continue;
        }
        polls += 1;
        void appendFile(rawLogPath, `${line}\n`, 'utf8').catch(() => undefined);
      }
    });
    monitor.on('close', (code) => resolvePromise(code));
  });

  const startedAtUtc = new Date().toISOString();

  // 4. Шаги чек-листа: интерактив (Enter — шаг, q — финиш) либо --duration.
  const steps = [];
  const scenarioSteps = scenario.steps;
  console.log(`\nScenario ${scenarioKey}: ${scenario.title}`);
  console.log(`Expectation: ${scenario.expectation}\n`);
  for (let index = 0; index < scenarioSteps.length; index += 1) {
    console.log(`  ${index + 1}. ${scenarioSteps[index]}`);
  }
  console.log('');

  if (durationMs !== null) {
    console.log(`Non-interactive mode: --duration ${Math.round(durationMs / 1000)} s (operator acts meanwhile).`);
    steps.push({ atUtc: new Date().toISOString(), text: `non-interactive run (--duration ${Math.round(durationMs / 1000)} s); operator performed the scenario manually` });
    await sleep(durationMs);
  } else {
    const rl = createInterface({ input: process.stdin });
    let finished = false;
    for (let index = 0; index < scenarioSteps.length && !finished; index += 1) {
      await new Promise((resolveStep) => {
        rl.question(`Step ${index + 1} done? [Enter=done / q=finish] `, (answer) => {
          if (answer.trim().toLowerCase() === 'q') {
            finished = true;
          } else {
            steps.push({ atUtc: new Date().toISOString(), text: scenarioSteps[index] });
          }
          resolveStep();
        });
      });
    }
    rl.close();
  }

  const finishedAtUtc = new Date().toISOString();

  // 5. Стоп монитора → дедуп → reverse-dns → timeline.
  monitor.kill();
  await monitorReady;

  const raw = await import('node:fs/promises').then((fs) => fs.readFile(rawLogPath, 'utf8').catch(() => ''));
  const records = parseMonitorOutput(raw);
  const deduped = dedupConnections(records);
  const hosts = await resolveHosts(deduped.map((row) => row.remoteAddress));
  for (const row of deduped) {
    row.host = hosts.get(row.remoteAddress) ?? null;
  }
  const summary = summarizeConnections(deduped);

  const timelinePath = resolve(outDir, `timeline-${scenarioKey}.md`);
  const timeline = buildTimelineMd({
    scenario: scenarioKey,
    title: scenario.title,
    expectation: scenario.expectation,
    expectedHosts: scenario.expectedHosts,
    startedAtUtc,
    finishedAtUtc,
    intervalMs,
    polls,
    processes,
    steps,
    connections: deduped,
    summary,
  });
  await writeFile(timelinePath, `${timeline}\n`, 'utf8');

  console.log(`\nTimeline: ${timelinePath}`);
  console.log(`Raw log:  ${rawLogPath}`);
  console.log(`Polls: ${polls}; connections: ${summary.connections}`);
  console.log(`Endpoints: ${summary.endpoints.length === 0 ? '(none)' : summary.endpoints.join(', ')}`);
  console.log(
    `Next: reconcile with the app journal (Settings → Privacy / Diagnostics export) per audit-template.md — verdict is manual (§5).`,
  );

  return { exitCode: 0, outDir, timelinePath, rawLogPath, summary };
}

/** sleep — единственная задержка драйвера (интервал — в PowerShell). */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** CLI-вызов (node tools/scripts/net-audit.mjs): разбор флагов, exit-коды §13. */
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const invokedPath = argv[1] === undefined ? undefined : realpathSync(argv[1]);
if (invokedPath === scriptPath) {
  let scenarioKey;
  let cliOut;
  let cliInterval;
  let cliDurationSec;
  let cliWaitSec;
  let cliExe;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scenario') {
      scenarioKey = argv[index + 1];
      index += 1;
    } else if (arg === '--exe') {
      cliExe = argv[index + 1];
      index += 1;
    } else if (arg === '--interval') {
      cliInterval = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--out') {
      cliOut = argv[index + 1];
      index += 1;
    } else if (arg === '--duration') {
      cliDurationSec = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--wait-app') {
      cliWaitSec = Number(argv[index + 1]);
      index += 1;
    } else {
      console.error(`unknown flag: ${arg}`);
      console.error('usage: node tools/scripts/net-audit.mjs --scenario <S1|S2|S3|S4> [--exe "Health Log"] [--interval 500] [--out <dir>] [--duration <sec>] [--wait-app <sec>]');
      exit(2);
    }
  }
  const result = await run({
    scenario: scenarioKey,
    exeNames:
      cliExe === undefined
        ? undefined
        : cliExe
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name !== ''),
    intervalMs: Number.isFinite(cliInterval) && cliInterval > 0 ? cliInterval : undefined,
    durationMs: Number.isFinite(cliDurationSec) && cliDurationSec > 0 ? cliDurationSec * 1000 : null,
    waitAppMs: Number.isFinite(cliWaitSec) && cliWaitSec > 0 ? cliWaitSec * 1000 : undefined,
    outDir: cliOut,
  });
  if (result.error !== undefined) {
    console.error(result.error);
  }
  exit(result.exitCode);
}
