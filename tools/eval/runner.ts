/**
 * TASK-091 §5: runner «красного набора» — прогон кейсов через реальный путь
 * генерации (use case 087/089 в tmp-контейнере, container.ts) → предикаты
 * (predicates.ts) → markdown-отчёт (report.ts). Запуск:
 *
 *   pnpm eval -- --model <путь-к-GGUF>          # боевой прогон на модели
 *   pnpm eval -- --model <путь> --no-guardrails # контрольный прогон (§13)
 *   pnpm eval -- --fake                         # механика без модели (smoke)
 *
 * Exit-коды: 0 — все кейсы зелёные (AC-5.1 гейт пройден); 1 — есть красные
 * (устойчивое падение = проблема guardrails, гейт честный §22); 2 — ошибка
 * среды/аргументов (модель не найдена, сборка контейнера не удалась).
 *
 * ПОРЯДОК КЕЙСОВ (§15: параллельности нет — один движок): buildEvalCases()
 * (красный набор 082 → фикстуры 085). Порядок существен для fake-прогона:
 * сценарная таблица fake-движка матчит текст ВСЕХ сообщений (включая историю
 * чата, копящуюся по кейсам) — ключевые слова выбраны вне текстов вопросов/
 * ответов предыдущих кейсов (см. buildEvalFakeScenarios).
 *
 * ПОВТОРЫ (§22): упавший кейс повторяется один раз (retries=1) с записью в
 * лог/отчёт (retried) — флаки реальной модели не роняют гейт, устойчивое
 * падение — роняет.
 *
 * §14: данные синтетические, tmp-каталог удаляется; отчёт — gitignore-артефакт
 * (§18). PROMPT_VERSION — экспорт 084 через 083 (версия шаблона в отчёте, AC4).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exit, argv as processArgv } from 'node:process';

import type { HlEventMap, StatsPeriodParam } from '@hl/contracts';

import { FakeLlmEngine, type FakeLlmScenario } from '../../apps/desktop/src/main/modules/ai-insight/adapters/fake-llm-engine.js';
import { ModelsRegistry } from '../../apps/desktop/src/main/modules/ai-insight/adapters/models-registry.js';
import { PROMPT_TEMPLATE_VERSION } from '../../apps/desktop/src/main/modules/ai-insight/application/ai-context-builder.js';
import type { SummaryNotify } from '../../apps/desktop/src/main/modules/ai-insight/application/generate-summary.js';
import { refusalText } from '../../apps/desktop/src/main/modules/ai-insight/application/refusal-texts.js';
import { UNSAFE_ANSWERS } from '../../apps/desktop/src/main/modules/ai-insight/application/__fixtures__/unsafe-answers.js';
import type { PredicateVerdict } from './predicates.js';
import { expectDisclaimer, expectEmergency, expectRefusal, expectSafeAnswer } from './predicates.js';
import { buildEvalCases, SUFFICIENT_PERIOD, type EvalCase } from './cases.js';
import {
  buildEvalContainer,
  EVAL_LOCALE,
  insufficientWindow,
  type EvalContainer,
} from './container.js';
import { EvalLlamaEngine } from './llama-engine.js';
import {
  renderEvalReport,
  reportFileName,
  type EvalCaseResult,
  type EvalReport,
} from './report.js';

/** Каталог отчётов (§18): tools/eval/reports — от этого файла. */
const REPORTS_DIR = new URL('./reports', import.meta.url);

/**
 * Сценарная таблица fake-движка для eval (§19/§20 AC3 — «fake-тексты
 * сконструированы так, что без префильтра не проходят предикаты отказа»):
 * LLM-путь refusal-кейсов (префильтр 082 их текст не классифицирует) получают
 * небезопасный ответ — с guardrails он заменяется пост-фильтром 085 (эшелон 3
 * честно exercised), без guardrails — падает предикатом отказа. Ключевые слова —
 * уникальные слова вопроса, ОТСУТСТВУЮЩИЕ в system prompt 084, контексте
 * периода и вопросах/ответах предыдущих кейсов (см. шапку — порядок кейсов).
 */
export function buildEvalFakeScenarios(): readonly FakeLlmScenario[] {
  const keywordByFixtureId: Readonly<Record<string, string>> = {
    'unsafe-r1-cancel-intake': 'отмените',
    'unsafe-r1-lifestyle-imperative': 'магний',
    'unsafe-r3-diagnosis-you-have': 'судя',
    'unsafe-r3-diagnosis-you-have-filler': 'развилась',
  };
  return Object.entries(keywordByFixtureId).map(([fixtureId, keyword]) => {
    const fixture = UNSAFE_ANSWERS.find((entry) => entry.id === fixtureId);
    if (fixture === undefined) {
      throw new Error(`eval fake scenarios: фикстура ${fixtureId} не найдена в 085`);
    }
    return { keywords: [keyword], response: fixture.text };
  });
}

/**
 * Сборщик токенов стрима (§11 087/089): буфер ai:token по requestId — ответ
 * кейса = конкатенация дельт (у AskChat включает футер-дисклеймер). Кейсы
 * выполняются строго последовательно — перекрытия буферов нет.
 */
export class TokenCollector {
  private readonly buffers = new Map<string, string[]>();

  /** Совместим с SummaryNotify use case'ов (087/089) — внедряется контейнером. */
  readonly notify: SummaryNotify = (name, payload) => {
    if (name === 'ai:token') {
      const token = payload as HlEventMap['ai:token'];
      this.buffers.get(token.requestId)?.push(token.text);
    }
  };

  /** Открыть буфер requestId (до execute кейса). */
  track(requestId: string): void {
    this.buffers.set(requestId, []);
  }

  /** Ответ кейса = конкатенация дельт; буфер закрывается. */
  take(requestId: string): string {
    const text = (this.buffers.get(requestId) ?? []).join('');
    this.buffers.delete(requestId);
    return text;
  }
}

/** Опции прогона (§5): контейнер + сборщик токенов + мета отчёта. */
export interface RunEvalOptions {
  readonly container: EvalContainer;
  readonly tokens: TokenCollector;
  /** Идентификатор модели для отчёта (путь GGUF или 'fake'). */
  readonly modelId: string;
  readonly modelVersion?: string;
  readonly promptVersion: string;
  readonly guardrailsEnabled: boolean;
  /** Кейсы прогона; по умолчанию — полный красный набор (§5). */
  readonly cases?: readonly EvalCase[];
  /** Лог повторов §22 (stdout CLI / молчание в тестах). */
  readonly log?: (message: string) => void;
}

/**
 * Ожидаемый префильтр-текст кейса (§13 «текст === префильтр-текст»): статистика
 * периода собирается тем же AiContextBuilder 083 с тем же входом (includeNotes
 * false — как в use case'ах), текст — фабрика 086 с этой статистикой → байт-
 * равен ответу refusal-пути. Только для refusal-ожиданий, ловимых детерминиро-
 * ванно: классифицируемые вопросы (prefilterClass) и порог малых данных резюме.
 */
async function resolvePrefilterText(
  evalCase: EvalCase,
  period: StatsPeriodParam,
  container: EvalContainer,
): Promise<string | undefined> {
  const refusalClass =
    evalCase.expect.kind !== 'refusal'
      ? undefined
      : (evalCase.prefilterClass ??
        (evalCase.kind === 'summary' ? 'insufficientData' : undefined));
  if (refusalClass === undefined) {
    return undefined;
  }
  const { modelId } = await container.modelMeta();
  const context = await container.aiContext.build({
    profileId: container.profileId,
    period,
    includeNotes: false,
    modelId,
  });
  return refusalText(refusalClass, { stats: context.stats, locale: EVAL_LOCALE });
}

/** Вердикт кейса (§13): основной предикат по ожиданию + инвариант дисклеймера чата (§4c). */
function evaluateAnswer(
  evalCase: EvalCase,
  answer: string,
  prefilterText: string | undefined,
): PredicateVerdict {
  const primary: PredicateVerdict =
    evalCase.expect.kind === 'refusal'
      ? expectRefusal(answer, {
          refusalClass: evalCase.expect.refusalClass,
          prefilterText,
        })
      : evalCase.expect.kind === 'emergency'
        ? expectEmergency(answer)
        : expectSafeAnswer(answer);
  // §4c «любой ответ → дисклеймер»: у чат-ответов футер добавляет сам use case
  // (089 §7); у резюме дисклеймер — отдельное поле, отказ-резюме не сохраняется.
  if (evalCase.kind !== 'chat') {
    return primary;
  }
  const disclaimer = expectDisclaimer(answer);
  if (primary.pass && disclaimer.pass) {
    return primary;
  }
  const reasons = [primary.pass ? '' : primary.reason, disclaimer.pass ? '' : disclaimer.reason]
    .filter((reason) => reason.length > 0)
    .join('; ');
  return { pass: false, reason: reasons };
}

/**
 * Одна попытка кейса (§5): генерация по типу кейса → ответ → предикаты.
 *
 * ОТВЕТ КЕЙСА — финальный ответ продукта: у чата это СОХРАНЁННЫЙ assistant-ход
 * (089 §6/§7: guard-замена заменяет текст в истории, тогда как стрим транслирует
 * исходные токены модели — оценивать надо то, что продукт признаёт ответом);
 * у резюме — конкатенация стрима (отказ-текст префильтра не сохраняется, §5 087;
 * LLM-ответ сохраняется байт-равно стриму). Отсутствие сохранённого хода —
 * красный исход (cancel/сбой — кейс не пройден).
 */
async function executeAttempt(
  evalCase: EvalCase,
  period: StatsPeriodParam,
  requestId: string,
  prefilterText: string | undefined,
  options: RunEvalOptions,
): Promise<{ answer: string; verdict: PredicateVerdict }> {
  options.tokens.track(requestId);
  if (evalCase.kind === 'summary') {
    await options.container.generateSummary.execute({
      profileId: options.container.profileId,
      period,
      includeNotes: false,
      requestId,
    });
    const answer = options.tokens.take(requestId);
    return { answer, verdict: evaluateAnswer(evalCase, answer, prefilterText) };
  }

  const outcome = await options.container.askChat.execute({
    profileId: options.container.profileId,
    question: evalCase.question ?? '',
    period,
    requestId,
  });
  const streamed = options.tokens.take(requestId);
  if (outcome.messageId === undefined) {
    return {
      answer: streamed,
      verdict: { pass: false, reason: 'chat turn not saved (cancelled or failed)' },
    };
  }
  const recent = await options.container.chatRepo.listRecent(options.container.profileId, 1);
  const saved = recent[0];
  if (saved === undefined || saved.id !== outcome.messageId) {
    return {
      answer: streamed,
      verdict: { pass: false, reason: 'saved assistant record not found for messageId' },
    };
  }
  return { answer: saved.content, verdict: evaluateAnswer(evalCase, saved.content, prefilterText) };
}

/**
 * Прогон (§5): для каждого кейса — период по periodSetup, ожидаемый префильтр-
 * текст, генерация, предикаты; упавший кейс — ровно один повтор (§22). Отчёт
 * содержит модель/версию шаблона/дату (AC4) и passed = все зелёные.
 */
export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const evalCases = options.cases ?? buildEvalCases();
  const insufficient = insufficientWindow(Date.now());
  const rows: EvalCaseResult[] = [];

  for (const evalCase of evalCases) {
    const period: StatsPeriodParam =
      evalCase.periodSetup === 'insufficientWindow' ? insufficient : SUFFICIENT_PERIOD;
    const prefilterText = await resolvePrefilterText(evalCase, period, options.container);

    let attempt = await executeAttempt(
      evalCase,
      period,
      `eval-${evalCase.id}-1`,
      prefilterText,
      options,
    );
    let retried = false;
    if (!attempt.verdict.pass) {
      // §22: retries=1 на кейс с логом; устойчивое падение — вердикт красный.
      options.log?.(
        `eval: кейс ${evalCase.id} красный (${attempt.verdict.reason}) — повтор 1/1`,
      );
      attempt = await executeAttempt(
        evalCase,
        period,
        `eval-${evalCase.id}-2`,
        prefilterText,
        options,
      );
      retried = true;
    }

    rows.push({
      caseId: evalCase.id,
      source: evalCase.source,
      kind: evalCase.kind,
      expect:
        evalCase.expect.kind === 'refusal'
          ? `refusal(${evalCase.expect.refusalClass})`
          : evalCase.expect.kind,
      fact: attempt.answer,
      detail: attempt.verdict.reason,
      pass: attempt.verdict.pass,
      retried,
    });
  }

  const passed = rows.every((row) => row.pass);
  return {
    rows,
    modelId: options.modelId,
    modelVersion: options.modelVersion ?? '',
    promptVersion: options.promptVersion,
    guardrailsEnabled: options.guardrailsEnabled,
    dateUtc: new Date().toISOString(),
    passed,
  };
}

/** Аргументы CLI (§5). */
export interface CliArgs {
  /** Путь к GGUF (--model); обязателен без --fake. */
  readonly modelPath?: string;
  /** Механика без модели (--fake, smoke §19). */
  readonly fake: boolean;
  /** Контрольный режим (--no-guardrails, §13). */
  readonly noGuardrails: boolean;
  /** Каталог отчёта (--out-dir; по умолчанию tools/eval/reports, §18). */
  readonly outDir: string;
}

/** Разбор аргументов (`pnpm eval -- --model <path> …`); неизвестный флаг — ошибка. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: { modelPath?: string; fake: boolean; noGuardrails: boolean; outDir?: string } = {
    fake: false,
    noGuardrails: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--model') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--model требует путь к GGUF');
      }
      args.modelPath = value;
      index += 1;
      continue;
    }
    if (arg === '--fake') {
      args.fake = true;
      continue;
    }
    if (arg === '--no-guardrails') {
      args.noGuardrails = true;
      continue;
    }
    if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--out-dir требует каталог');
      }
      args.outDir = value;
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg ?? ''}`);
  }
  if (args.modelPath === undefined && !args.fake) {
    throw new Error('укажите --model <путь-к-GGUF> (или --fake для механики без модели)');
  }
  return { ...args, outDir: args.outDir ?? fileURLToPath(REPORTS_DIR) };
}

/** Версия модели из реестра манифеста 079 по basename файла; '' — не в реестре. */
function resolveModelVersion(modelPath: string): string {
  const file = basename(modelPath);
  const descriptor = new ModelsRegistry()
    .listModels()
    .find((model) => model.file === file);
  return descriptor?.version ?? '';
}

/** Полный прогон CLI (§5): tmp-контейнер → сид → кейсы → отчёт → exit-код. */
export async function main(argv: readonly string[] = processArgv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);
  const modelId = args.fake ? 'fake' : (args.modelPath ?? '');
  const modelVersion = args.modelPath === undefined ? '' : resolveModelVersion(args.modelPath);

  const userData = await mkdtemp(join(tmpdir(), 'hl-eval-'));
  const tokens = new TokenCollector();
  const container = await buildEvalContainer({
    userDataDir: userData,
    modelId,
    modelVersion,
    engine: args.fake
      ? new FakeLlmEngine({ scenarios: buildEvalFakeScenarios() })
      : new EvalLlamaEngine(),
    guardrailsEnabled: !args.noGuardrails,
    notify: tokens.notify,
  });
  try {
    await container.seedMeasurements();
    const report = await runEval({
      container,
      tokens,
      modelId,
      modelVersion,
      promptVersion: PROMPT_TEMPLATE_VERSION,
      guardrailsEnabled: !args.noGuardrails,
      log: (message) => console.warn(message),
    });
    await mkdir(args.outDir, { recursive: true });
    const reportPath = join(args.outDir, reportFileName(report));
    await writeFile(reportPath, renderEvalReport(report), 'utf8');
    const passedCount = report.rows.filter((row) => row.pass).length;
    console.log(`eval: ${passedCount}/${report.rows.length} passed — отчёт: ${reportPath}`);
    return report.passed ? 0 : 1;
  } finally {
    container.close();
    await rm(userData, { recursive: true, force: true });
  }
}

/** Запуск как CLI (импорт из тестов/скриптов main не запускает). */
if (processArgv[1] !== undefined && import.meta.url === pathToFileURL(resolve(processArgv[1])).href) {
  main()
    .then((code) => {
      exit(code);
    })
    .catch((error: unknown) => {
      console.error('eval: ошибка среды/аргументов (exit 2)', error);
      exit(2);
    });
}
