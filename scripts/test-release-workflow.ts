/**
 * TASK-105 §19/§24: тест структурного контракта релизного пайплайна
 * `.github/workflows/release.yml` — по прецеденту test-pr-workflow.ts
 * (TASK-014): файл-конфиг обязан удовлетворять неизменяемым правилам спеки,
 * дрейф любого правила ловится раньше, чем красный прогон на GitHub.
 *
 *  - §5:  триггер — ТОЛЬКО пуш тега v* (workflow_dispatch/PR-триггеров нет —
 *         §22 «release только из main-тегов, защита trigger'ом»); job на
 *         windows-latest; шаги в порядке checkout → pnpm → install →
 *         lint/typecheck/depcruise → unit/integration (vitest) → dist
 *         (подпись из секретов TASK-104) → e2e (все спеки) → crash (N=10) →
 *         size:audit (гейт) → draft release с артефактами и notes;
 *  - §13: порядок гейтов, падение любого → draft не создаётся (fail-fast
 *         одного job'а); ретраи только у e2e (--retries=1), гейт-тесты без;
 *  - §14: секреты подписи — в release-окружении; permissions минимальные
 *         (contents: read на workflow, contents: write на job — черновик
 *         release); самопроверка подписи Get-AuthenticodeSignature до attach;
 *  - §15: бюджет прогона ≤40 мин (timeout-minutes: 40 — жёсткий предел);
 *  - §18: Job Summary — таблица гейтов (unit/e2e/crash/size/sign);
 *  - TASK-036 §20: size:audit с --json (вывод парсится в CI);
 *  - TASK-104 (certificates.md §2.1): подпись через env-секреты
 *         WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD; публикация всегда ручная —
 *         electron-builder вызывается с --publish never (на теге в CI
 *         electron-builder 26 неявно включает publish=onTag — проверено
 *         по исходнику PublishManager), draft: true у softprops.
 *
 * Electron-бинарник НЕ пропускается (нет ELECTRON_SKIP_BINARY_DOWNLOAD —
 * прецедент pr.yml): e2e/crash/dist требуют реального Electron.
 *
 * Синтаксис YAML отдельно не парсим: `pnpm lint` прогоняет prettier --check
 * по файлу, а структурные проверки ниже не зависят от пробелов. Успех:
 * «N checks passed», exit 0. Любое иное — exit 1.
 * Запуск: `pnpm run test:release-workflow`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));

/** Точечные требования к файлу: имя проверки → паттерн. */
const PRESENCE_CHECKS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '§5 имя workflow', re: /^name: Release$/m },
  {
    label: '§5 триггер — только пуш тега v*',
    re: /^on:\n {2}push:\n {4}tags:\n {6}- ['"]v\*['"]$/m,
  },
  { label: '§14 права workflow — contents: read', re: /^permissions:\n {2}contents: read$/m },
  {
    label: '§14 права job — contents: write (черновик релиза)',
    re: /^ {6}permissions:\n {8}contents: write$/m,
  },
  {
    label: '§14 секреты подписи — release-окружение',
    re: /^ {4}environment: release$/m,
  },
  { label: '§4/§5 runner windows-latest (целевая ОС)', re: /^ {4}runs-on: windows-latest$/m },
  { label: '§15 бюджет ≤40 мин: timeout-minutes', re: /^ {4}timeout-minutes: 40$/m },
  { label: '§5 concurrency-группа', re: /^concurrency:\n {2}group: release-/m },
  { label: '§5 cancel-in-progress', re: /^ {2}cancel-in-progress: true$/m },
  {
    label: '§5 bash — shell по умолчанию (Windows-раннер, POSIX-синтаксис шагов)',
    re: /^ {8}shell: bash$/m,
  },
  // Отклонение от §5 («Node 20»): dependency-cruiser 18 (TASK-005) требует node ^22||^24||>=26.
  {
    label: 'Node 24 (минимум depcruise 18, прецедент pr.yml)',
    re: /^ {10}node-version: ['"]24['"]$/m,
  },
  { label: '§5 corepack enable', re: /^ {10}corepack enable$/m },
  { label: '§5 corepack → pnpm 9', re: /^ {10}corepack prepare pnpm@9/m },
  {
    label: '§5 путь pnpm-store для кэша',
    re: /^ {10}path: \$\{\{ steps\.pnpm-store\.outputs\.STORE_PATH \}\}$/m,
  },
  { label: '§5 ключ кэша по pnpm-lock.yaml', re: /hashFiles\('pnpm-lock\.yaml'\)/m },
  { label: '§13.1 install --frozen-lockfile', re: /^ {8}run: pnpm install --frozen-lockfile$/m },
  { label: '§5 lint', re: /^ {8}run: pnpm lint$/m },
  { label: '§5 typecheck', re: /^ {8}run: pnpm typecheck$/m },
  { label: '§5 depcruise', re: /^ {8}run: pnpm depcruise$/m },
  {
    label: '§5 unit/integration (vitest) с junit-отчётом',
    re: /^ {8}run: pnpm test --reporter=default --reporter=junit --outputFile=test-results\/junit\.xml$/m,
  },
  {
    label: '§5 версия релиза = тег (npm pkg set в @hl/desktop)',
    re: /^ {10}pnpm --filter @hl\/desktop exec npm pkg set "version=\$version"$/m,
  },
  {
    label: '§14 секрет подписи WIN_CSC_LINK (TASK-104)',
    re: /^ {10}WIN_CSC_LINK: \$\{\{ secrets\.WIN_CSC_LINK \}\}$/m,
  },
  {
    label: '§14 секрет подписи WIN_CSC_KEY_PASSWORD (TASK-104)',
    re: /^ {10}WIN_CSC_KEY_PASSWORD: \$\{\{ secrets\.WIN_CSC_KEY_PASSWORD \}\}$/m,
  },
  {
    label: '§5/TASK-104 публикация выключена явно (--publish never)',
    re: /^ {10}pnpm --filter @hl\/desktop exec electron-builder --win --publish never$/m,
  },
  {
    label: '§14 самопроверка подписи Get-AuthenticodeSignature',
    re: /Get-AuthenticodeSignature/m,
  },
  {
    label: '§13 e2e с единственным разрешённым ретраем',
    re: /^ {8}run: pnpm test:e2e --retries=1$/m,
  },
  { label: '§5 crash-тест (N=10 — дефолт TASK-102)', re: /^ {8}run: pnpm test:crash$/m },
  {
    label: '§5 size:audit — гейт ≤200 МБ с JSON-выводом (TASK-036 §20)',
    re: /^ {8}run: pnpm size:audit --dist apps\/desktop\/dist --json$/m,
  },
  { label: '§5 notes из шаблона TASK-114', re: /\.github\/release-template\.md/m },
  { label: '§5 draft release через softprops', re: /^ {8}uses: softprops\/action-gh-release@v2$/m },
  { label: '§5 draft: true — публикация всегда ручная', re: /^ {10}draft: true$/m },
  { label: '§5 автоген changelog-коммитов', re: /^ {10}generate_release_notes: true$/m },
  {
    label: '§5 файлы-артефакты: установщик',
    re: /^ {12}apps\/desktop\/dist\/\*\.exe$/m,
  },
  {
    label: '§5 файлы-артефакты: update-feed (*.yml)',
    re: /^ {12}apps\/desktop\/dist\/\*\.yml$/m,
  },
  {
    label: '§5 draft не создаётся при отсутствии артефактов',
    re: /^ {10}fail_on_unmatched_files: true$/m,
  },
  { label: '§18 Job Summary (таблица гейтов)', re: /GITHUB_STEP_SUMMARY/m },
];

/** §5: шаги строго в этом порядке (индекс вхождения в текст строго растёт). */
const ORDER_CHECKS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'checkout', re: /^ {8}uses: actions\/checkout@v4$/m },
  { label: 'setup-node', re: /^ {8}uses: actions\/setup-node@v4$/m },
  { label: 'corepack', re: /^ {10}corepack enable$/m },
  { label: 'store path', re: /\$\(pnpm store path\)/ },
  { label: 'кэш store', re: /^ {8}uses: actions\/cache@v4$/m },
  { label: 'pnpm fetch', re: /^ {8}run: pnpm fetch$/m },
  { label: 'pnpm install --frozen-lockfile', re: /^ {8}run: pnpm install --frozen-lockfile$/m },
  { label: 'lint', re: /^ {8}run: pnpm lint$/m },
  { label: 'typecheck', re: /^ {8}run: pnpm typecheck$/m },
  { label: 'depcruise', re: /^ {8}run: pnpm depcruise$/m },
  { label: 'unit/integration (vitest)', re: /^ {8}run: pnpm test --reporter=default/m },
  { label: 'версия релиза из тега', re: /npm pkg set "version=\$version"/ },
  {
    label: 'сборка+подпись установщика (electron-builder --publish never)',
    re: /^ {10}pnpm --filter @hl\/desktop exec electron-builder --win --publish never$/m,
  },
  { label: 'самопроверка подписи', re: /Get-AuthenticodeSignature/ },
  { label: 'e2e (все спеки, retry 1)', re: /^ {8}run: pnpm test:e2e --retries=1$/m },
  { label: 'crash-тест', re: /^ {8}run: pnpm test:crash$/m },
  { label: 'size:audit', re: /^ {8}run: pnpm size:audit --dist apps\/desktop\/dist --json$/m },
  { label: 'release notes (шаблон TASK-114)', re: /release-template\.md/ },
  { label: 'draft release', re: /^ {8}uses: softprops\/action-gh-release@v2$/m },
  { label: 'job summary', re: /GITHUB_STEP_SUMMARY/ },
  { label: 'upload отчётов (диагностика)', re: /^ {12}test-results\/junit\.xml$/m },
];

/** §14: действия пинованы по мажорной версии. */
const ACTION_USE_RE = /^ {8}uses: (\S+)$/gm;
const PINNED_ACTION_RE = /^(actions|softprops)\/[a-z-]+@v\d+$/;
/** Каркас пайплайна §5: ровно эти пять действий. */
const EXPECTED_ACTIONS: ReadonlyArray<string> = [
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'actions/cache@v4',
  'actions/upload-artifact@v4',
  'softprops/action-gh-release@v2',
];

function loadWorkflowText(): string {
  try {
    // Переводы строк нормализуем: рабочая копия на Windows может быть CRLF.
    return readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    console.error(
      'test:release-workflow: FAIL: не читается .github/workflows/release.yml (RED без workflow — так и должно быть до GREEN)',
    );
    process.exit(1);
  }
}

function index(text: string, re: RegExp): number {
  const m = re.exec(text);
  return m === null ? -1 : m.index;
}

function collectFailures(text: string): string[] {
  const failures: string[] = [];

  // §22: release — только из тегов, PR-триггеров нет (код в привилегированном
  // контексте не исполняется для чужих веток; секреты подписи не утекают в fork-PR).
  if (text.includes('pull_request')) {
    failures.push('§22: найден PR-триггер pull_request* — release только из тегов v*');
  }
  if (text.includes('workflow_dispatch')) {
    failures.push('§5: найден workflow_dispatch — триггер только push тега v*');
  }
  // §5/§4: Electron нужен (e2e/crash/dist) — pr.yml-флаг ЭКОНОМИИ здесь запрещён.
  if (text.includes('ELECTRON_SKIP_BINARY_DOWNLOAD')) {
    failures.push('§5: ELECTRON_SKIP_BINARY_DOWNLOAD запрещён — Electron нужен e2e/crash/dist');
  }
  // §5: публикация — никогда автоматически (никаких политики publish кроме never).
  if (/--publish\s+(?!never\b)/.test(text)) {
    failures.push('§5: допустима только явная политика --publish never (публикация — вручную)');
  }

  for (const check of PRESENCE_CHECKS) {
    if (index(text, check.re) === -1) {
      failures.push(`${check.label}: паттерн не найден`);
    }
  }

  // §14: каждый uses — actions|softprops/<имя>@v<N> (пин по мажору).
  const usedActions: string[] = [];
  for (const m of text.matchAll(ACTION_USE_RE)) {
    const action = m[1];
    if (action === undefined) {
      continue;
    }
    usedActions.push(action);
    if (!PINNED_ACTION_RE.test(action)) {
      failures.push(`§14: действие не пиновано по мажору */<имя>@v<N>: ${action}`);
    }
  }
  for (const expected of EXPECTED_ACTIONS) {
    if (!usedActions.includes(expected)) {
      failures.push(`§5: каркасное действие отсутствует: ${expected}`);
    }
  }

  // §5: порядок шагов — гейты по §13: ранние дешёвые → dist/подпись → тяжёлые →
  // size → draft; лог читается сверху вниз без скачков.
  let prev = -1;
  for (const step of ORDER_CHECKS) {
    const at = index(text, step.re);
    if (at === -1) {
      failures.push(`§5: шаг не найден: ${step.label}`);
    } else if (at <= prev) {
      failures.push(`§5: шаг вне порядка: ${step.label}`);
    } else {
      prev = at;
    }
  }

  // §18/§5: job summary и upload отчётов выполняются и при красном гейте.
  const alwaysCount = (text.match(/^ {8}if: always\(\)$/gm) ?? []).length;
  if (alwaysCount !== 2) {
    failures.push(`§5: шагов с if: always() ожидалось 2, найдено ${String(alwaysCount)}`);
  }

  return failures;
}

function main(): number {
  const text = loadWorkflowText();
  const failures = collectFailures(text);

  if (failures.length > 0) {
    console.error('test:release-workflow: FAIL:');
    for (const failure of failures) {
      console.error(`    ${failure}`);
    }
    return 1;
  }
  console.log(
    `test:release-workflow: ${String(PRESENCE_CHECKS.length + ORDER_CHECKS.length)} checks passed, actions pinned, no PR-triggers, publish disabled`,
  );
  return 0;
}

process.exitCode = main();
