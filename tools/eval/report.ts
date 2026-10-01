/**
 * TASK-091 §5/§7/§18: markdown-отчёт eval — чистый рендер данных прогона (запись
 * в файл и CLI — забота runner.ts). Модель отчёта (§7 дословно): EvalReport
 * {rows, modelId, promptVersion, passed} + факт приёмки AC4 (модель/версия
 * шаблона/дата) + режим guardrails (контрольный прогон помечается). Отчёт —
 * dev-артефакт: EN-подписи (§16–17), имя файла `tools/eval/reports/<date>-<model>.md`
 * (§18, gitignore).
 */
import type { EvalExpectation } from './cases.js';

/** Результат одного кейса прогона (строка отчёта §7: кейс/ожидание/факт/статус). */
export interface EvalCaseResult {
  /** Стабильный id кейса (источники — 082/085). */
  readonly caseId: string;
  readonly source: 'redSet' | 'fixture';
  readonly kind: 'summary' | 'chat';
  /** Подпись ожидания (expectationLabel). */
  readonly expect: string;
  /** Фактический ответ модели — усечённая одна строка (truncateFact). */
  readonly fact: string;
  /** Причина вердикта предиката (PredicateVerdict.reason). */
  readonly detail: string;
  /** Итог кейса (с учётом повтора §22). */
  readonly pass: boolean;
  /** Кейс потребовал повторную попытку (§22: retries=1, лог в отчёте). */
  readonly retried: boolean;
}

/** Модель отчёта (§7). */
export interface EvalReport {
  readonly rows: readonly EvalCaseResult[];
  /** Идентификатор модели (--model / 'fake' для механики без модели). */
  readonly modelId: string;
  /** Версия модели из реестра манифеста 079 ('' — кастомный путь). */
  readonly modelVersion: string;
  /** Версия шаблона промпта (PROMPT_TEMPLATE_VERSION 084 через 083). */
  readonly promptVersion: string;
  /** false — контрольный прогон --no-guardrails (§13). */
  readonly guardrailsEnabled: boolean;
  /** Дата прогона (UTC ISO — AC4). */
  readonly dateUtc: string;
  /** Все кейсы зелёные (exit 0 runner'а). */
  readonly passed: boolean;
}

/** Подпись ожидания для колонки «ожидание». */
export function expectationLabel(expect: EvalExpectation): string {
  return expect.kind === 'refusal' ? `refusal(${expect.refusalClass})` : expect.kind;
}

/** Факт в одну строку: переносы/повторы пробелов схлопываются, хвост — «…». */
export function truncateFact(answer: string, maxLength = 120): string {
  const oneLine = answer.replaceAll(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxLength)}…`;
}

/**
 * Имя файла отчёта (§18): `<date>-<model>.md`; дата — YYYY-MM-DD из dateUtc;
 * модель — слаг basename пути (символы пути/разделители → '-'; пусто → 'fake').
 */
export function reportFileName(report: EvalReport): string {
  const date = report.dateUtc.slice(0, 10);
  const base =
    report.modelId
      .replaceAll(/[/\\:]/g, '/')
      .split('/')
      .at(-1) ?? '';
  const slug = base.length > 0 ? base.replaceAll(/[^\w.\-]+/g, '-') : 'fake';
  return `${date}-${slug}.md`;
}

/**
 * Markdown-отчёт (§5): шапка (модель+версия, версия шаблона, дата, режим) →
 * таблица кейс/ожидание/факт/статус → итоговая строка (ALL GREEN / счётчик).
 */
export function renderEvalReport(report: EvalReport): string {
  const lines: string[] = [
    '# Eval report — guardrails red set (TASK-091)',
    '',
    `- date (UTC): ${report.dateUtc}`,
    `- model: ${report.modelId} (version: ${report.modelVersion === '' ? '-' : report.modelVersion})`,
    `- prompt template version: ${report.promptVersion}`,
    `- guardrails: ${report.guardrailsEnabled ? 'enabled' : 'disabled (--no-guardrails)'}`,
    '',
    '| case | source | kind | expect | status | detail | fact |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const row of report.rows) {
    const status = `${row.pass ? 'PASS' : 'FAIL'}${row.retried ? ' (retry=1)' : ''}`;
    lines.push(
      `| ${row.caseId} | ${row.source} | ${row.kind} | ${row.expect} | ${status} | ${row.detail} | ${row.fact} |`,
    );
  }
  const passedCount = report.rows.filter((row) => row.pass).length;
  lines.push(
    '',
    `**Result: passed ${passedCount}/${report.rows.length}** — ${
      report.passed ? 'ALL GREEN (exit 0)' : 'FAILED (exit 1)'
    }`,
    '',
  );
  return lines.join('\n');
}
