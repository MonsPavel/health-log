/**
 * TASK-014 §19/§24: тест контракта PR-пайплайна `.github/workflows/pr.yml`.
 *
 * Пайплайн сам по себе тестируется на реальных PR (§19 — контрольные прогоны на
 * GitHub), но его СТРУКТУРНЫЙ контракт проверяем локально, по прецеденту
 * test-depcruise-rules.ts: файл-конфиг обязан удовлетворять неизменяемым правилам
 * спеки, и дрейф любого правила ловится раньше, чем красный прогон на GitHub:
 *
 *  - §5:  триггеры pull_request + workflow_dispatch; concurrency по ветке с
 *         cancel-in-progress; ubuntu-latest; Node 20 через corepack (pnpm 9);
 *         кэш pnpm-store ключом по pnpm-lock.yaml; шаги строго в порядке
 *         checkout → setup → кэш → fetch → install → lint → i18n → typecheck →
 *         depcruise → test(coverage) → build:renderer → upload артефактов;
 *  - §13: install только --frozen-lockfile; секретов нет (нечему утекать);
 *  - §14: permissions: contents: read; действия пинованы по мажору
 *         (actions/*, @v<N>); никаких pull_request_target;
 *  - §16: check:i18n включён в workflow (файл tools/scripts/check-i18n.mjs есть);
 *  - §20: coverage/lcov.info и junit-отчёт vitest доступны как артефакты.
 *
 * Синтаксис YAML отдельно не парсим: `pnpm lint` прогоняет prettier --check по
 * файлу, а структурные проверки ниже не зависят от пробелов (преттиер-формат
 * стабилен). Успех: «N checks passed», exit 0. Любое иное — exit 1.
 * Запуск: `pnpm run test:pr-workflow`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/pr.yml', import.meta.url));

/** Точечные требования к файлу: имя проверки → паттерн (или парный предикат). */
const PRESENCE_CHECKS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '§5 имя workflow', re: /^name: PR$/m },
  { label: '§5 триггеры pull_request + workflow_dispatch', re: /^on:\n {2}pull_request:\n {2}workflow_dispatch:$/m },
  { label: '§5 concurrency-группа', re: /^concurrency:\n {2}group: /m },
  { label: '§5 cancel-in-progress', re: /^ {2}cancel-in-progress: true$/m },
  { label: '§4 runner ubuntu-latest', re: /^ {4}runs-on: ubuntu-latest$/m },
  { label: '§15/§22 бюджет времени: timeout-minutes', re: /^ {4}timeout-minutes: \d+$/m },
  { label: '§5 Electron-бинарник на PR-шагах не скачивается', re: /^ {6}ELECTRON_SKIP_BINARY_DOWNLOAD: ['"]1['"]$/m },
  { label: '§14 минимальные права: contents: read', re: /^permissions:\n {2}contents: read$/m },
  { label: '§5 Node 20', re: /^ {8}node-version: ['"]20['"]$/m },
  { label: '§5 corepack enable', re: /^ {10}corepack enable$/m },
  { label: '§5 corepack → pnpm 9', re: /^ {10}corepack prepare pnpm@9/m },
  { label: '§5 путь pnpm-store для кэша', re: /^ {8}path: \$\{\{ steps\.pnpm-store\.outputs\.STORE_PATH \}\}$/m },
  { label: '§5 ключ кэша по pnpm-lock.yaml', re: /hashFiles\('pnpm-lock\.yaml'\)/m },
  { label: '§13.1 install --frozen-lockfile', re: /^ {8}run: pnpm install --frozen-lockfile$/m },
  { label: '§20 артефакт coverage/lcov.info', re: /^ {8}path: coverage\/lcov\.info$/m },
  { label: '§5/§20 артефакт junit-отчёта vitest', re: /^ {8}path: test-results\/junit\.xml$/m },
];

/** §14: действия пинованы по мажорной версии и только из actions/*. */
const ACTION_USE_RE = /^ {8}uses: (\S+)$/gm;
const PINNED_ACTION_RE = /^actions\/[a-z-]+@v\d+$/;
/** Каркас пайплайна §5: ровно эти четыре действия. */
const EXPECTED_ACTIONS: ReadonlyArray<string> = [
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'actions/cache@v4',
  'actions/upload-artifact@v4',
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
  { label: 'pnpm lint', re: /^ {8}run: pnpm lint$/m },
  { label: 'pnpm check:i18n (§16)', re: /^ {8}run: pnpm check:i18n$/m },
  { label: 'pnpm typecheck', re: /^ {8}run: pnpm typecheck$/m },
  { label: 'pnpm depcruise', re: /^ {8}run: pnpm depcruise$/m },
  { label: 'pnpm test:coverage', re: /^ {8}run: pnpm test:coverage/m },
  { label: 'pnpm build:renderer', re: /^ {8}run: pnpm build:renderer$/m },
  { label: 'upload coverage', re: /^ {8}path: coverage\/lcov\.info$/m },
  { label: 'upload vitest-отчёт', re: /^ {8}path: test-results\/junit\.xml$/m },
];

function loadWorkflowText(): string {
  try {
    // Переводы строк нормализуем: рабочая копия на Windows может быть CRLF.
    return readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    console.error(
      'test:pr-workflow: FAIL: не читается .github/workflows/pr.yml (RED без workflow — так и должно быть до GREEN)',
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

  // §14: никаких pull_request_target — код PR не исполняется в привилегированном контексте.
  if (text.includes('pull_request_target')) {
    failures.push('§14: найден pull_request_target — запрещён (OWASP CI/CD)');
  }
  // §13.4: секреты на PR-этапе не используются.
  if (text.includes('secrets.')) {
    failures.push('§13.4: найдено использование secrets.* — на PR-этапе секретов нет');
  }

  for (const check of PRESENCE_CHECKS) {
    if (index(text, check.re) === -1) {
      failures.push(`${check.label}: паттерн не найден`);
    }
  }

  // §14: каждый uses — actions/<имя>@v<N>.
  const usedActions: string[] = [];
  for (const m of text.matchAll(ACTION_USE_RE)) {
    const action = m[1];
    if (action === undefined) {
      continue;
    }
    usedActions.push(action);
    if (!PINNED_ACTION_RE.test(action)) {
      failures.push(`§14: действие не пиновано по мажору actions/*@v<N>: ${action}`);
    }
  }
  for (const expected of EXPECTED_ACTIONS) {
    if (!usedActions.includes(expected)) {
      failures.push(`§5: каркасное действие отсутствует: ${expected}`);
    }
  }

  // §5: порядок шагов — лог читается сверху вниз без скачков (§24).
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

  // Артефакты грузятся и при красном шаге тестов (диагностика), статус это не меняет.
  const alwaysCount = (text.match(/^ {8}if: always\(\)$/gm) ?? []).length;
  if (alwaysCount !== 2) {
    failures.push(`§5: upload-шагов с if: always() ожидалось 2, найдено ${String(alwaysCount)}`);
  }

  return failures;
}

function main(): number {
  const text = loadWorkflowText();
  const failures = collectFailures(text);

  if (failures.length > 0) {
    console.error('test:pr-workflow: FAIL:');
    for (const failure of failures) {
      console.error(`    ${failure}`);
    }
    return 1;
  }
  console.log(
    `test:pr-workflow: ${String(PRESENCE_CHECKS.length + ORDER_CHECKS.length)} checks passed, actions pinned, no secrets`,
  );
  return 0;
}

void main().then((code) => {
  process.exitCode = code;
});
