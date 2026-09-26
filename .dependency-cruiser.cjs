'use strict';

/**
 * TASK-005: dependency-cruiser — «архитектурный тест» и вторая сеть защиты после
 * зон ESLint (TASK-003): ESLint ловит файловые зоны, cruiser — межпакетные
 * направления (§3 задачи). Семантика — матрица зависимостей
 * docs/architecture/03-modules.md §4 (единственный источник семантики, §4 задачи).
 * severity: error → непустой вывод означает ненулевой exit code, то есть ошибку сборки.
 *
 * Правила (§5; имена правил — контракт со скриптом test:depcruise-rules):
 *  1. renderer-not-node  — из apps/desktop/src-renderer запрещены node:*, electron,
 *                          better-sqlite3, @hl/* кроме @hl/contracts;
 *  2. domain-purity      — из src/main/modules/<модуль>/domain разрешены только файлы
 *                          своего домена и @hl/kernel;
 *  3. application-ports  — application не импортирует adapters (свой модуль)
 *                          и чужие модули;
 *  4. module-public-api  — чужой модуль импортируется только через его index.ts;
 *  5. packages-layering  — kernel/scales-data ни от чего не зависят; contracts→kernel
 *                          разрешён (запрещающего правила на это направление нет).
 *
 * Механика `$1`: первая capture-group из `from.path` подставляется в `to.path*`
 * (replaceGroupPlaceholders dependency-cruiser 18) — так выражается «свой модуль»:
 * pathNot с `$1` исключает рёбра внутри своего модуля, на чужих правило срабатывает.
 *
 * Фикстуры tools/depcruise-fixtures (§19) проверяются отдельным прогоном
 * `pnpm run test:depcruise-rules`; в основном прогоне они исключены через
 * .dependency-cruiser-ignore. Визуализация графа (§5: не автоматизируется):
 * `pnpm exec depcruise . --config .dependency-cruiser.cjs --output-type dot`.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * §6: exclude из основного прогона — единственный источник — .dependency-cruiser-ignore
 * (строки-regex; '#' — комментарий). Нативного ignore-файла у dependency-cruiser нет,
 * поэтому конфиг читает его сам.
 */
function readIgnorePatterns() {
  const raw = fs.readFileSync(path.join(__dirname, '.dependency-cruiser-ignore'), 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Зона renderer (§5.1) + её зеркальная фикстура bad-renderer-node.ts (§19, §22). */
const RENDERER_FROM =
  '^(?:apps/desktop/src-renderer/|tools/depcruise-fixtures/bad-renderer-node\\.ts$)';

/** Зона модулей main-процесса (арх. 03 §3). */
const MODULES = 'apps/desktop/src/main/modules';

/** Зона модулей main-процесса (§13) + каталог фикстур для bad-cross-module-internal.ts. */
const MODULE_PUBLIC_API_FROM = `^(?:${MODULES}/(?<module>[^/]+)/|tools/depcruise-fixtures/)(?!index\\.ts$)`;
/** Ребро «внутрь модуля» — реальный каталог модулей или стаб чужого модуля в фикстурах. */
const MODULE_PUBLIC_API_TO = `^(?:${MODULES}/|tools/depcruise-fixtures/fixture-module-beta/)`;

module.exports = {
  forbidden: [
    // --- §5.1: renderer-not-node (арх. 03 §4: renderer — только @hl/contracts через
    // preload-мост; арх. 08 §4: renderer — недоверенная зона без Node-доступа).
    // OR-условий в правилах нет, поэтому запрет выражен двумя вхождениями с ОДНИМ
    // именем правила: core-билдены (включая legacy-голый `fs` — делегировано сюда
    // конфигом ESLint TASK-003) и именованные запрещённые пакеты.
    {
      name: 'renderer-not-node',
      severity: 'error',
      comment:
        'арх. 03 §4, арх. 08 §4: renderer без Node-библиотек (node:* и legacy-голые имена). Проверяется фикстурой bad-renderer-node.ts (§19). Тесты (*.test.ts) исключены: матрица про production-код — тестам нужен тестовый инструментарий (fs фикстуры, child_process для CLI-теста check-i18n, TASK-013 §19; прецедент packages-layering ниже).',
      from: { path: RENDERER_FROM, pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'renderer-not-node',
      severity: 'error',
      comment:
        'арх. 03 §4, арх. 08 §4: renderer без electron/better-sqlite3 и без @hl/* кроме @hl/contracts (пакеты @hl/* резолвятся через symlink в realpath packages/<name> — ловим обе формы).',
      from: { path: RENDERER_FROM },
      to: {
        path: '^(?:electron(?:/|$)|better-sqlite3(?:/|$)|@hl/|packages/(?:kernel|scales-data)(?:/|$))',
        pathNot: '^(?:packages/contracts|@hl/contracts)(?:/|$)',
      },
    },

    // --- §5.2: domain-purity (арх. 03 §4: module/domain — свой domain и @hl/kernel).
    {
      name: 'domain-purity',
      severity: 'error',
      comment:
        'арх. 03 §4: из domain разрешены только файлы СВОЕГО домена ($1 = модуль из from.path) и @hl/kernel; node:*, npm и чужие внутренности — нарушение (ср. boundaries/dependencies TASK-003). Тесты (*.test.ts) исключены: матрица про production-код — colocated-тестам домена нужен сам тестовый фреймворк (vitest, fast-check; прецеденты renderer-not-node и packages-layering, TASK-003 §19; первые domain-тесты — TASK-016).',
      from: { path: `^${MODULES}/(?<module>[^/]+)/domain/`, pathNot: '\\.test\\.ts$' },
      to: {
        path: '.',
        pathNot: [`^${MODULES}/$1/domain/`, '^packages/kernel/'],
      },
    },

    // --- §5.3: application-ports (арх. 03 §4: module/application — свой domain;
    // adapters и чужие модули запрещены; kernel и npm разрешены — to.path их не матчит).
    {
      name: 'application-ports',
      severity: 'error',
      comment:
        'арх. 03 §4: application не импортирует adapters СВОЕГО модуля ($1) и чужие модули — только свой domain/application.',
      from: { path: `^${MODULES}/(?<module>[^/]+)/application/` },
      to: {
        path: `^${MODULES}/`,
        pathNot: [`^${MODULES}/$1/(?:domain|application)/`],
      },
    },

    // --- §5.4: module-public-api (арх. 03 §1/§2/§4: межмодульно — только публичный
    // index.ts; паттерн §13: from — не-index файл модуля, to — чужой не-index файл).
    {
      name: 'module-public-api',
      severity: 'error',
      comment:
        'арх. 03 §4: импорт чужого модуля минуя его index.ts запрещён; рёбра внутри СВОЕГО модуля ($1) и на index.ts исключены. Проверяется фикстурой bad-cross-module-internal.ts (§19).',
      from: { path: MODULE_PUBLIC_API_FROM },
      to: {
        path: MODULE_PUBLIC_API_TO,
        pathNot: [`^${MODULES}/$1/`, `^${MODULES}/[^/]+/index\\.ts$`],
      },
    },

    // --- §5.5: packages-layering (арх. 03 §4: kernel — ничего; scales-data — ничего
    // (чистые данные); contracts→kernel разрешён — запрещающего правила на это
    // направление нет, чистоту направления проверяет ok-фикстура §19).
    {
      name: 'packages-layering',
      severity: 'error',
      comment:
        'арх. 03 §4: kernel и scales-data зависят только от себя ($1 = имя пакета из from.path): ни от других пакетов, ни от npm, ни от node:*. Тесты (*.test.ts) исключены: матрица про production-код, тестам нужен сам тестовый фреймворк (прецедент TASK-003 §19).',
      from: { path: '^packages/(?<pkg>kernel|scales-data)/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^(?:packages/|node_modules/|node:)',
        pathNot: ['^packages/$1/'],
      },
    },
  ],
  options: {
    // В воркспейс-пакеты не заходим (канон из `depcruise --init`); рёбра в npm
    // остаются в графе и проверяются правилами, но не раскрываются дальше.
    doNotFollow: { path: 'node_modules' },
    exclude: { path: readIgnorePatterns() },
  },
};
