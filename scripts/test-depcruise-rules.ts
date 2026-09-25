/**
 * TASK-005 §19/§24: тест правил dependency-cruiser на фикстурах.
 *
 * Фикстуры `tools/depcruise-fixtures/**` исключены из основного прогона
 * `pnpm depcruise` (.dependency-cruiser-ignore) и проверяются ТОЛЬКО здесь:
 * прогон cruiser на каталоге фикстур с ожиданием конкретных violated-rule-имён.
 * Правила берутся из боевого `.dependency-cruiser.cjs` — правила и их параметры
 * остаются в точности боевыми, меняется только набор просканированных модулей.
 *
 * Ожидания (§19, §20):
 *  - bad-renderer-node.ts            → renderer-not-node;
 *  - bad-cross-module-internal.ts    → module-public-api;
 *  - fixture-module-beta/internal.ts → чисто (внутренность модуля сама не нарушитель);
 *  - ok-contracts-to-kernel.ts       → чисто (contracts→kernel разрешён, арх. 03 §4).
 *
 * Успех: «2 violations expected, ok-fixtures clean», exit 0. Любое иное — exit 1.
 * Запуск: `pnpm run test:depcruise-rules`.
 */
import { cruise } from 'dependency-cruiser';
import type { ICruiseResult, IFlattenedRuleSet } from 'dependency-cruiser';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = 'tools/depcruise-fixtures';
const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

/** file (posix-путь от корня репо) → ожидаемое имя правила; null = файл обязан быть чистым. */
const EXPECTATIONS: ReadonlyArray<{ file: string; rule: string | null }> = [
  { file: `${FIXTURE_DIR}/bad-renderer-node.ts`, rule: 'renderer-not-node' },
  { file: `${FIXTURE_DIR}/bad-cross-module-internal.ts`, rule: 'module-public-api' },
  { file: `${FIXTURE_DIR}/fixture-module-beta/internal.ts`, rule: null },
  { file: `${FIXTURE_DIR}/ok-contracts-to-kernel.ts`, rule: null },
];

interface DepcruiseConfig {
  forbidden: IFlattenedRuleSet['forbidden'];
}

interface ViolationLike {
  rule: { name: string };
  from: string;
  to: string;
}

function shortName(file: string): string {
  return file.split('/').pop() ?? file;
}

async function loadForbiddenRules(): Promise<IFlattenedRuleSet['forbidden']> {
  // Конфиг появляется на шаге GREEN; его отсутствие — честный RED-статус задачи, а не ошибка скрипта.
  try {
    const imported: unknown = await import('../.dependency-cruiser.cjs');
    const config = (imported as { default: DepcruiseConfig }).default;
    return config.forbidden;
  } catch {
    console.error(
      'test:depcruise-rules: FAIL: не читается .dependency-cruiser.cjs (RED без конфига — так и должно быть до GREEN)',
    );
    process.exit(1);
  }
}

async function main(): Promise<number> {
  const forbidden = await loadForbiddenRules();

  // Прогон строго на каталоге фикстур; node_modules не раскрываем (боевая опция конфига).
  // validate: true обязателен — в API без него ruleSet не применяется (в CLI его
  // неявно ставит --config).
  const { output } = await cruise([FIXTURE_DIR], {
    baseDir: ROOT_DIR,
    ruleSet: { forbidden },
    validate: true,
    doNotFollow: { path: 'node_modules' },
    outputType: 'json',
  });
  // json-репортер отдаёт строку (тип IReporterOutput.output — string | ICruiseResult).
  const report: ICruiseResult =
    typeof output === 'string' ? (JSON.parse(output) as ICruiseResult) : output;
  // summary.violations — канонический плоский список нарушений (их же печатает err-репортер).
  const violations: ViolationLike[] = report.summary.violations ?? [];

  let failed = false;
  for (const expectation of EXPECTATIONS) {
    // Фикстура оценивается по её СВОИМ импортам: нарушение привязано к файлу,
    // если файл — from ребра (быть адресатом чужого нарушения — не нарушение).
    const hits = violations.filter((v) => v.from === expectation.file);

    if (expectation.rule === null) {
      if (hits.length > 0) {
        failed = true;
        console.error(
          `test:depcruise-rules: FAIL: ${shortName(expectation.file)} обязан быть чистым:`,
        );
        for (const v of hits) {
          console.error(`    [${v.rule.name}] ${v.from} → ${v.to}`);
        }
      } else {
        console.log(`test:depcruise-rules: ok    ${shortName(expectation.file)} — чисто`);
      }
      continue;
    }

    const hit = hits.some((v) => v.rule.name === expectation.rule);
    if (!hit) {
      failed = true;
      console.error(
        `test:depcruise-rules: FAIL: ${shortName(expectation.file)} — ожидалось нарушение [${expectation.rule}]`,
      );
      for (const v of hits) {
        console.error(`    найдено: [${v.rule.name}] ${v.from} → ${v.to}`);
      }
    } else {
      console.log(
        `test:depcruise-rules: error ${shortName(expectation.file)} → ${expectation.rule}`,
      );
    }
  }

  if (failed) {
    console.error('test:depcruise-rules: FAIL: см. выше');
    return 1;
  }
  console.log('test:depcruise-rules: 2 violations expected, ok-fixtures clean');
  return 0;
}

void main().then((code) => {
  process.exitCode = code;
});
