/**
 * TASK-003 §19/§24: тест зонных правил ESLint на фикстурах.
 *
 * Фикстуры `tools/lint-fixtures/**` исключены из основного линта (global ignores) и
 * проверяются ТОЛЬКО здесь — через ESLint API с реальным `eslint.config.js`.
 * Зоны в конфиге описаны путями реального приложения (`apps/desktop/**`), поэтому скрипт
 * ремапит пути конфига на зеркальную структуру фикстур (`apps/desktop/` → `tools/lint-fixtures/`):
 * правила и их параметры остаются в точности боевыми, меняются только паттерны зон.
 * Блоки-игнорирования конфига при этом отбрасываются (иначе ESLint отказался бы линтить фикстуры).
 *
 * Ожидания (§19, §20):
 *  - renderer импортирует node:fs            → error  (no-restricted-imports);
 *  - domain импортирует lodash               → error  (boundaries/external);
 *  - импорт чужого модуля через index.ts     → чисто;
 *  - явный any                               → error  (no-restricted-syntax, §20.3);
 *  - голый @ts-expect-error без пояснения    → error  (ban-ts-comment, §20.3).
 *
 * Успех: печатает «2 violations expected, ok-fixture clean», exit 0. Любое иное — exit 1.
 * Запуск: `pnpm run test:lint-rules`.
 */
import { ESLint } from "eslint";

const FIXTURE_PREFIX = "tools/lint-fixtures/";
const REAL_PREFIX = "apps/desktop/";

/** file → ожидаемый ruleId; null = файл обязан быть чистым. */
const EXPECTATIONS: ReadonlyArray<{ file: string; ruleId: string | null }> = [
  { file: `${FIXTURE_PREFIX}src-renderer/violation-renderer-node.ts`, ruleId: "no-restricted-imports" },
  { file: `${FIXTURE_PREFIX}src/main/modules/alpha/domain/violation-domain-npm.ts`, ruleId: "boundaries/dependencies" },
  { file: `${FIXTURE_PREFIX}src/main/modules/alpha/domain/ok-cross-module-index.ts`, ruleId: null },
  { file: `${FIXTURE_PREFIX}violation-any.ts`, ruleId: "no-restricted-syntax" },
  { file: `${FIXTURE_PREFIX}violation-ts-expect-error.ts`, ruleId: "@typescript-eslint/ban-ts-comment" },
];

interface ConfigBlock {
  files?: string[];
  ignores?: string[];
  settings?: { "boundaries/elements"?: Array<{ type: string; pattern: string }> };
  [key: string]: unknown;
}

/** Ремап зоны реального приложения на зеркальную структуру фикстур. */
function remapGlob(glob: string): string {
  return glob.split(REAL_PREFIX).join(FIXTURE_PREFIX);
}

/**
 * Поверхностный ремап конфига: cloning только scalars-полей (files/ignores/elements).
 * Глубокий клон невозможен: объекты плагинов в пресетах typescript-eslint цикличны.
 * Остальные значения разделяются по ссылке с боевым конфигом и не мутируют.
 */
function toFixtureConfig(raw: unknown[]): ConfigBlock[] {
  return raw.map((block) => {
    if (block === null || typeof block !== "object") return block as ConfigBlock;
    const source = block as ConfigBlock;
    const clone: ConfigBlock = { ...source };
    if (source.files !== undefined) clone.files = source.files.map(remapGlob);
    if (source.ignores !== undefined) clone.ignores = source.ignores.map(remapGlob);
    const elements = source.settings?.["boundaries/elements"];
    if (source.settings !== undefined && elements !== undefined) {
      clone.settings = {
        ...source.settings,
        "boundaries/elements": elements.map((el) => ({ ...el, pattern: remapGlob(el.pattern) })),
      };
    }
    return clone;
  });
}

function shortName(file: string): string {
  return file.split("/").pop() ?? file;
}

function formatMessages(messages: ReadonlyArray<{ ruleId: string | null; line?: number; message: string }>): string {
  return messages.map((m) => `    ${m.line !== undefined ? `:${m.line} ` : ""}[${m.ruleId ?? "parse"}] ${m.message}`).join("\n");
}

async function main(): Promise<number> {
  // Конфиг появляется на шаге GREEN; его отсутствие — честный RED-статус задачи, а не ошибка скрипта.
  let configModule: { default: unknown };
  try {
    configModule = (await import("../eslint.config.js")) as { default: unknown };
  } catch {
    console.error("test:lint-rules: FAIL: не читается eslint.config.js (RED без конфига ESLint — так и должно быть до GREEN)");
    return 1;
  }

  const raw = Array.isArray(configModule.default) ? configModule.default : [configModule.default];
  // Ремап зон реального приложения на зеркальную структуру фикстур; отбрасываем блоки-игнорирования
  // (иначе ESLint пропустит фикстуры как ignored).
  const fixtureConfig = toFixtureConfig(raw).filter((block) => !(block.ignores !== undefined && block.files === undefined));

  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: fixtureConfig as never });
  const results = await eslint.lintFiles(EXPECTATIONS.map((e) => e.file));
  // ESLint возвращает абсолютные пути (на Windows — с обратными слэшами); сопоставляем по имени файла.
  const byFile = new Map(results.map((r) => [shortName(r.filePath.replaceAll("\\", "/")), r]));

  let failed = false;
  for (const expectation of EXPECTATIONS) {
    const result = byFile.get(shortName(expectation.file));
    const messages = result?.messages ?? [];
    const errors = messages.filter((m) => m.severity === 2);
    const warnings = messages.filter((m) => m.severity === 1);

    if (expectation.ruleId === null) {
      if (messages.length > 0) {
        failed = true;
        console.error(`test:lint-rules: FAIL: ${shortName(expectation.file)} обязан быть чистым:`);
        console.error(formatMessages(messages));
      } else {
        console.log(`test:lint-rules: ok    ${shortName(expectation.file)} — чисто`);
      }
      continue;
    }

    const hit = errors.some((m) => m.ruleId === expectation.ruleId);
    if (!hit) {
      failed = true;
      console.error(`test:lint-rules: FAIL: ${shortName(expectation.file)} — ожидался error [${expectation.ruleId}]:`);
      console.error(formatMessages(messages));
    } else {
      const extras = messages.length - errors.filter((m) => m.ruleId === expectation.ruleId).length;
      console.log(
        `test:lint-rules: error ${shortName(expectation.file)} → ${expectation.ruleId}${extras > 0 ? ` (+${extras} доп. сообщений)` : ""}`,
      );
    }
    if (warnings.length > 0 && !failed) {
      // §13: предупреждения в скрипте недопустимы — только error или чисто.
      failed = true;
      console.error(`test:lint-rules: FAIL: ${shortName(expectation.file)} — есть warnings (§13: --max-warnings 0):`);
      console.error(formatMessages(warnings));
    }
  }

  if (failed) {
    console.error("test:lint-rules: FAIL: см. выше");
    return 1;
  }
  console.log("test:lint-rules: 2 violations expected, ok-fixture clean (плюс §20.3: any и голый @ts-expect-error — error)");
  return 0;
}

void main().then((code) => {
  process.exitCode = code;
});
