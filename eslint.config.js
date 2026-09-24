/**
 * TASK-003: ESLint flat-config — качество TypeScript + зонные правила границ.
 *
 * Зоны и матрица зависимостей — единственный источник семантики:
 * docs/architecture/03-modules.md §4. dependency-cruiser (TASK-005) дублирует те же
 * правила по графу пакетов — две сети защиты (§4 задачи). Нарушение зоны = error (§13).
 *
 * Зоны (§7; «module» — apps/desktop/src/main/modules):
 *  - renderer      apps/desktop/src-renderer          — без node:*, electron, better-sqlite3 (арх. 08 §4);
 *  - domain        (module)/domain                    — только @hl/kernel и type-only @hl/contracts;
 *  - application   (module)/application               — свой domain + kernel;
 *  - adapters      (module)/adapters                  — свой application + kernel + внешние npm;
 *  - module-root   (module)/                          — корень модуля (index.ts = публичный API);
 *  - межмодульно:  только module-root соседнего модуля, не его domain/application/adapters.
 *
 * Реализация — eslint-plugin-boundaries v7, правило boundaries/dependencies (современный
 * синтаксис): checkAllOrigins покрывает и внешние npm (domain — только @hl/*), internal-импорты
 * внутри одной зоны не проверяются (checkInternals: false по умолчанию). Захват модуля —
 * шаблоны from.element.captured.module. Внешние npm по умолчанию разрешены всем зонам,
 * кроме domain (только @hl/*) и kernel/contracts/scales-data (матрица арх. 03 §4).
 *
 * Фикстуры tools/lint-fixtures исключены из основного линта (§19) и проверяются
 * скриптом `pnpm run test:lint-rules` (scripts/test-lint-rules.ts).
 */
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const MODULE_ROOT = 'apps/desktop/src/main/modules';

/** Селектор зоны-элемента. */
const el = (type) => ({ element: { type } });
/** Селектор той же зоны, но в СВОЁМ модуле (захват §7: запрет чужих внутренностей). */
const ownModule = (type) => ({
  element: { type, captured: { module: '{{ from.element.captured.module }}' } },
});
/** Разрешение внутреннего элемента (для списков allow). */
const allowEl = (type) => ({ to: el(type) });
/** Разрешение внешних модулей: npm («external») и Node-библиотек («core» — так boundaries v7
 *  классифицирует node:*; main-процесс по арх. 03 §4 обязан использовать Node API). */
const allowExternal = { to: { origin: ['external', 'core'] } };
/** Разрешение внешнего npm по имени пакета (origin external: воркспейс-пакеты; домен остаётся
 *  закрыт и для «core» — module-шаблон @hl/* его не пропускает). */
const allowExternalModule = (name) => ({
  to: { origin: 'external' },
  dependency: { module: name },
});

/** Элементы зон; пути от корня репозитория, anchored (partialMatch: false).
 *  Порядок важен: частные зоны раньше catch-all (single-match — первый совпавший). */
const elements = [
  { type: 'renderer', pattern: 'apps/desktop/src-renderer/**', partialMatch: false },
  { type: 'shared', pattern: 'apps/desktop/src/main/shared/**', partialMatch: false },
  {
    type: 'domain',
    pattern: `${MODULE_ROOT}/*/domain/**`,
    capture: ['module'],
    partialMatch: false,
  },
  {
    type: 'application',
    pattern: `${MODULE_ROOT}/*/application/**`,
    capture: ['module'],
    partialMatch: false,
  },
  {
    type: 'adapters',
    pattern: `${MODULE_ROOT}/*/adapters/**`,
    capture: ['module'],
    partialMatch: false,
  },
  // остаток папки модуля: index.ts (публичный API) и корневые файлы модуля
  { type: 'module-root', pattern: `${MODULE_ROOT}/*`, capture: ['module'], partialMatch: false },
  // catch-all остатка main-процесса (container, events, llm-worker)
  { type: 'main-app', pattern: 'apps/desktop/src/main/**', partialMatch: false },
  { type: 'kernel', pattern: 'packages/kernel/**', partialMatch: false },
  { type: 'contracts', pattern: 'packages/contracts/**', partialMatch: false },
  { type: 'scales-data', pattern: 'packages/scales-data/**', partialMatch: false },
  { type: 'tools', pattern: 'tools/**', partialMatch: false },
  { type: 'scripts', pattern: 'scripts/**', partialMatch: false },
];

const EVERYTHING_INTERNAL = [
  'renderer',
  'shared',
  'domain',
  'application',
  'adapters',
  'module-root',
  'main-app',
  'kernel',
  'contracts',
  'scales-data',
  'tools',
  'scripts',
].map(allowEl);

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'docs/**',
      '.zcode/**',
      // §19: фикстуры зон исключены из основного линта — их проверяет pnpm run test:lint-rules.
      'tools/lint-fixtures/**',
      // TASK-002: компиляционная фикстура tsc — обязана оставаться небезопасной, линтить её нельзя.
      'tools/tsconfig-fixture/**',
      'pnpm-lock.yaml',
    ],
  },

  // Блоки пресета без files применяются ко всем файлам (включая этот JS-конфиг),
  // где typed-правила падают без type-info — скоупим весь пресет к TS.
  ...tseslint.configs.recommendedTypeChecked.map((block) =>
    block.files === undefined ? { ...block, files: ['**/*.ts'] } : block,
  ),

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // §15: projectService быстрее parserOptions.project на больших деревьях.
        // Каждый .ts обязан принадлежать проекту: пакеты — свои tsconfig, scripts —
        // scripts/tsconfig.json, фикстуры — свои.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      // Ключи настроек плагина — плоские (settings.boundaries.elements не читается).
      'boundaries/elements': elements,
      'boundaries/root-path': import.meta.dirname,
      // Современный синтаксис шаблонов захвата (без legacy-подстановок).
      'boundaries/legacy-templates': false,
      // Проверяем статические импорты и re-export'ы (обход границ через export-from — тоже утечка).
      'boundaries/dependency-nodes': ['import', 'export', 'dynamic-import'],
    },
    plugins: { boundaries },
    rules: {
      // §5/§20.3: any и голый @ts-expect-error — error; §14: eval/new Function — error.
      // (ts-expect-error проверяется ban-ts-comment: allow-with-description — комментарии
      // не являются узлами AST, селектором no-restricted-syntax их не поймать.)
      'no-restricted-syntax': [
        'error',
        { selector: 'TSAnyKeyword', message: 'any запрещён: опишите точный тип (§5, §13)' },
        {
          selector:
            "CallExpression[callee.name='eval'], CallExpression[callee.property.name='eval']",
          message: 'eval() запрещён во всех зонах (§14)',
        },
        {
          selector: "NewExpression[callee.name='Function'], CallExpression[callee.name='Function']",
          message: 'new Function() запрещён во всех зонах (§14)',
        },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, 'ts-nocheck': true },
      ],
      // Дубль селектора TSAnyKeyword выше — оставляем один механизм (§5).
      '@typescript-eslint/no-explicit-any': 'off',

      // §7 + матрица арх. 03 §4. default: disallow — «разрешено только то, что в матрице».
      // checkAllOrigins — проверять и внешние npm, не только внутренние элементы.
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          checkAllOrigins: true,
          policies: [
            // --- матрица арх. 03 §4: внутренние элементы ---
            {
              from: el('renderer'),
              to: el('contracts'),
              allow: [allowEl('contracts')],
              message: 'renderer импортирует только @hl/contracts через preload-мост (арх. 03 §4)',
            },
            {
              from: el('shared'),
              to: [el('kernel'), el('contracts')],
              allow: [allowEl('kernel'), allowEl('contracts')],
            },
            {
              // type-only @hl/contracts (value-импорт контрактов из domain запрещён)
              from: el('domain'),
              to: el('contracts'),
              allow: [{ to: el('contracts'), dependency: { kind: 'type' } }],
              message: '@hl/contracts из domain — только type-only (арх. 03 §4)',
            },
            {
              from: el('domain'),
              to: [el('kernel'), el('module-root')],
              allow: [allowEl('kernel'), allowEl('module-root')],
            },
            {
              from: el('application'),
              to: ownModule('domain'),
              allow: [allowEl('domain')],
              message: 'application импортирует только domain СВОЕГО модуля (арх. 03 §4)',
            },
            {
              from: el('application'),
              to: [el('kernel'), el('module-root')],
              allow: [allowEl('kernel'), allowEl('module-root')],
            },
            {
              from: el('adapters'),
              to: ownModule('application'),
              allow: [allowEl('application')],
              message: 'adapters импортирует только application СВОЕГО модуля (арх. 03 §4)',
            },
            {
              from: el('adapters'),
              to: [el('kernel'), el('module-root')],
              allow: [allowEl('kernel'), allowEl('module-root')],
            },
            {
              from: el('module-root'),
              to: [ownModule('domain'), ownModule('application'), ownModule('adapters')],
              allow: [allowEl('domain'), allowEl('application'), allowEl('adapters')],
              message: 'module-root собирает публичный API только СВОЕГО модуля (арх. 03 §4)',
            },
            {
              from: el('module-root'),
              to: [el('kernel'), el('contracts'), el('shared'), el('module-root')],
              allow: [
                allowEl('kernel'),
                allowEl('contracts'),
                allowEl('shared'),
                allowEl('module-root'),
              ],
            },
            // main/app: application + adapters модулей (любых), contracts, shared
            {
              from: el('main-app'),
              to: [
                el('application'),
                el('adapters'),
                el('module-root'),
                el('contracts'),
                el('shared'),
                el('kernel'),
              ],
              allow: [
                allowEl('application'),
                allowEl('adapters'),
                allowEl('module-root'),
                allowEl('contracts'),
                allowEl('shared'),
                allowEl('kernel'),
              ],
            },
            { from: el('contracts'), to: el('kernel'), allow: [allowEl('kernel')] },
            // kernel и scales-data ни от чего не зависят: политик нет — default disallow
            // (внутренние импорты той же зоны не проверяются — checkInternals: false)
            // инструменты и сборочные скрипты видят всё внутреннее монорепо
            {
              from: [el('tools'), el('scripts')],
              to: EVERYTHING_INTERNAL.map((e) => e.to),
              allow: EVERYTHING_INTERNAL,
            },

            // --- внешние модули (checkAllOrigins; «external» = npm, «core» = node:*) ---
            {
              from: el('domain'),
              allow: [allowExternalModule(['@hl/kernel', '@hl/contracts'])],
              message:
                'domain импортирует только @hl/kernel (и type-only @hl/contracts) — арх. 03 §4',
            },
            // неразрешённый воркспейс до сборки dist трактуется как external (@hl/* по имени)
            { from: el('contracts'), allow: [allowExternalModule('@hl/kernel')] },
            // renderer — только npm («external»): node:* ему запрещены §7/арх. 08 §4, и boundaries
            // здесь вторая сеть поверх no-restricted-imports ниже
            { from: el('renderer'), allow: [{ to: { origin: 'external' } }] },
            // main-процесс, инструменты и скрипты: npm + Node-библиотеки («core») — арх. 03 §4
            {
              from: [
                el('shared'),
                el('application'),
                el('adapters'),
                el('module-root'),
                el('main-app'),
                el('tools'),
                el('scripts'),
              ],
              allow: [allowExternal],
            },
          ],
        },
      ],
    },
  },

  {
    // §7: зона renderer — без Node-библиотек. «Голые» билдены вроде `fs` (legacy-CJS стиль)
    // не ловятся намеренно: канон импорта в репо — `node:*`, а вторую сеть даёт TASK-005.
    files: ['apps/desktop/src-renderer/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'renderer не импортирует electron напрямую — только @hl/contracts через preload-мост (арх. 03 §4, арх. 08 §4)',
            },
            {
              name: 'better-sqlite3',
              message:
                'SQLite живёт в main-процессе (арх. 04); renderer работает через IPC и @hl/contracts',
            },
          ],
          patterns: [
            {
              group: ['node', 'node:*'],
              message:
                'renderer без Node (арх. 08 §4); данные — через preload-мост и @hl/contracts',
            },
          ],
        },
      ],
    },
  },

  {
    // §5: оверрайд для тестов и tools. any в тестах/инструментах разрешён; фикстуры линта
    // исключены — они обязаны оставаться под боевыми запретами (их проверяет test:lint-rules).
    files: ['**/*.test.ts', 'tools/**/*.ts'],
    ignores: ['tools/lint-fixtures/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='eval'], CallExpression[callee.property.name='eval']",
          message: 'eval() запрещён во всех зонах (§14)',
        },
        {
          selector: "NewExpression[callee.name='Function'], CallExpression[callee.name='Function']",
          message: 'new Function() запрещён во всех зонах (§14)',
        },
      ],
    },
  },
);
