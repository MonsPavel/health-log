/**
 * TASK-002 §19/§24: тест-проверка строгости TypeScript-конфига.
 *
 * Запускает tsc на фикстуре `tools/tsconfig-fixture/` и требует одновременно:
 *  1. `safe.ts` компилируется без ошибок — базовый конфиг рабочий
 *     (позитивный контроль против «сломанный конфиг роняет всё подряд»);
 *  2. `unsafe.ts` отбракован, и среди кодов ошибок есть TS2532/TS18048
 *     — значит, strict + noUncheckedIndexedAccess реально действуют.
 *
 * Успех: печатает «fixture rejected as expected», exit 0. Любое иное — exit 1.
 * Запуск: `pnpm exec tsx scripts/check-strict.ts`.
 */
import * as ts from "typescript";

const FIXTURE_DIR = "tools/tsconfig-fixture";
/** TS2532 «Object is possibly 'undefined'»; TS18048 «'x' is possibly 'undefined'». */
const EXPECTED_CODES = new Set<number>([2532, 18048]);

function describeDiagnostic(diagnostic: ts.Diagnostic): string {
  const code = `TS${diagnostic.code}`;
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const file = diagnostic.file === undefined ? "(config)" : fileNameOf(diagnostic);
  const line = diagnostic.file === undefined ? "" : `:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}`;
  return `${file}${line}: ${code} ${text}`;
}

function fileNameOf(diagnostic: ts.Diagnostic): string {
  return diagnostic.file?.fileName.split(/[\\/]/).pop() ?? "(unknown)";
}

function main(): number {
  const configFile = ts.findConfigFile(FIXTURE_DIR, ts.sys.fileExists, "tsconfig.json");
  if (configFile === undefined) {
    console.error(`check-strict: FAIL: не найден tsconfig в ${FIXTURE_DIR}`);
    return 1;
  }

  const read = ts.readConfigFile(configFile, ts.sys.readFile);
  if (read.error !== undefined) {
    console.error("check-strict: FAIL: фикстурный tsconfig не читается:");
    console.error(describeDiagnostic(read.error));
    return 1;
  }

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, FIXTURE_DIR);
  if (parsed.errors.length > 0) {
    // Например: отсутствует tsconfig.base.json, на который ссылается extends.
    console.error("check-strict: FAIL: конфиг фикстуры невалиден:");
    for (const error of parsed.errors) {
      console.error(`  ${describeDiagnostic(error)}`);
    }
    return 1;
  }

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const unsafeDiagnostics = diagnostics.filter((d) => fileNameOf(d) === "unsafe.ts");
  const otherDiagnostics = diagnostics.filter((d) => fileNameOf(d) !== "unsafe.ts");

  if (otherDiagnostics.length > 0) {
    // Ошибки вне unsafe.ts (в т.ч. safe.ts) = базовый конфиг сломан, отбраковка ничего не доказывает.
    console.error("check-strict: FAIL: диагностика вне unsafe.ts — конфиг сломан:");
    for (const diagnostic of otherDiagnostics) {
      console.error(`  ${describeDiagnostic(diagnostic)}`);
    }
    return 1;
  }

  if (unsafeDiagnostics.length === 0) {
    console.error("check-strict: FAIL: unsafe.ts скомпилировался — строгие флаги не действуют");
    return 1;
  }

  const codes = unsafeDiagnostics.map((d) => d.code);
  if (!codes.some((code) => EXPECTED_CODES.has(code))) {
    console.error(`check-strict: FAIL: unsafe.ts отбракован, но нет ожидаемых кодов ${[...EXPECTED_CODES].map((c) => `TS${c}`).join("/")}:`);
    for (const diagnostic of unsafeDiagnostics) {
      console.error(`  ${describeDiagnostic(diagnostic)}`);
    }
    return 1;
  }

  console.log(`check-strict: коды отбраковки: ${codes.map((c) => `TS${c}`).join(", ")}`);
  console.log("fixture rejected as expected");
  return 0;
}

process.exitCode = main();
