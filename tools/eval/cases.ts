/**
 * TASK-091 §5/§7: сборщик кейсов eval — ЕДИНЫЙ ИСТОЧНИК данных: красный набор —
 * redSetCases политики 082 (дословные строки AC-5.1), «фикстурные» кейсы — тексты
 * «красных ответов» 085 (реальные модели генерируют такое в обход system prompt;
 * в eval они идут вопросами чата — пользователь просит подтвердить/повторить
 * опасное утверждение). Кейсы НЕ копируют вопросы — собираются из данных
 * (GuardrailPolicy + UNSAFE_ANSWERS), синхронизация закреплена cases.test.ts.
 *
 * Модель кейса (§7): EvalCase {id, source: 'redSet'|'fixture', kind:
 * 'summary'|'chat', question/periodSetup, expect: predicate-name}.
 *  - kind: кейс «Резюме при <7 измерениях / <3 днях» — СЦЕНАРИЙ, а не вопрос
 *    (082 §7) — исполняется путём резюме (UC-03, порог малых данных — единственный
 *    отказ этого пути); остальные — чат (US-19, классификация вопроса 086).
 *  - periodSetup: 'insufficientWindow' — узкое окно периода, где сид-данные ниже
 *    порога kernel (AI_MIN_*); 'sufficient' — весь журнал (данные порога
 *    достигают); конкретные границы периода резолвит runner (Clock).
 *  - prefilterClass — classifyQuestion(question) 082: кейсы, ловимые детерминиро-
 *    ванным префильтром (эшелон 2), получают прецизионную проверку текста; кейсы
 *    LLM-пути (undefined) — маркерную (§13). Для фикстур класс guard-замены —
 *    fallback ожидания (модель может отказать формулировкой другого класса).
 */
import type { StatsPeriodParam } from '@hl/contracts';

import { UNSAFE_ANSWERS } from '../../apps/desktop/src/main/modules/ai-insight/application/__fixtures__/unsafe-answers.js';
import {
  DEFAULT_GUARDRAIL_POLICY,
  classifyQuestion,
  type RefusalClass,
} from '../../apps/desktop/src/main/modules/ai-insight/domain/guardrail-policy.js';

/** Ожидание кейса (§7 «expect: predicate-name» — имя предиката + его параметры). */
export type EvalExpectation =
  | { readonly kind: 'refusal'; readonly refusalClass: RefusalClass }
  | { readonly kind: 'emergency' }
  | { readonly kind: 'answerWithDisclaimer' };

/** Настройка периода кейса (см. шапку): runner резолвит в StatsPeriodParam. */
export type EvalPeriodSetup = 'sufficient' | 'insufficientWindow';

/** Кейс eval (§7 дословно). */
export interface EvalCase {
  /** Стабильный id: id строки красного набора / id фикстуры 085. */
  readonly id: string;
  /** Источник данных кейса (§7). */
  readonly source: 'redSet' | 'fixture';
  /** Путь генерации (§5: «резюме или чат-путь по типу кейса»). */
  readonly kind: 'summary' | 'chat';
  /** Вопрос чата (chat-кейсы; текст строки AC-5.1 или фикстуры 085). */
  readonly question?: string;
  /** Настройка периода (см. шапку). */
  readonly periodSetup: EvalPeriodSetup;
  /** Ожидаемая реакция (предикат отчёта). */
  readonly expect: EvalExpectation;
  /** Класс префильтра вопроса (classifyQuestion 082); undefined — LLM-путь. */
  readonly prefilterClass?: RefusalClass;
}

/**
 * Период «достаточных данных» для кейсов (§15: один движок, сид-фикстуры e2e):
 * весь журнал — сид runner'а гарантирует порог (≥ AI_MIN_MEASUREMENTS измерений
 * за ≥ AI_MIN_DAYS дней). Конкретные данные — seed в container.ts.
 */
export const SUFFICIENT_PERIOD: StatsPeriodParam = 'all';

/**
 * Сборка кейсов из политики 082 + фикстур 085 (§5 «генерация кейсов из
 * GuardrailPolicy+фикстуры 085»). Чистая функция: порядок и состав следуют
 * источникам; вопроса у summary-кейса нет (реакция — счётчиками данных).
 */
export function buildEvalCases(): readonly EvalCase[] {
  const redSetCases: readonly EvalCase[] = DEFAULT_GUARDRAIL_POLICY.redSetCases.map((redSet) => {
    const kind = redSet.expected.kind === 'insufficient' ? 'summary' : 'chat';
    const expect: EvalExpectation =
      redSet.expected.kind === 'refusal'
        ? { kind: 'refusal', refusalClass: redSet.expected.refusalClass }
        : redSet.expected.kind === 'emergency'
          ? { kind: 'emergency' }
          : // insufficient проверяется refusal-предикатом класса insufficientData
            // (текст порога детерминирован фабрикой 086, §13).
            redSet.expected.kind === 'insufficient'
            ? { kind: 'refusal', refusalClass: 'insufficientData' }
            : { kind: 'answerWithDisclaimer' };
    return {
      id: redSet.id,
      source: 'redSet',
      kind,
      ...(kind === 'chat' ? { question: redSet.question } : {}),
      periodSetup: redSet.expected.kind === 'insufficient' ? 'insufficientWindow' : 'sufficient',
      expect,
      ...(kind === 'chat'
        ? { prefilterClass: classifyQuestion(redSet.question) }
        : { prefilterClass: undefined }),
    };
  });

  const fixtureCases: readonly EvalCase[] = UNSAFE_ANSWERS.map((fixture) => {
    const prefilterClass = classifyQuestion(fixture.text);
    return {
      id: fixture.id,
      source: 'fixture',
      kind: 'chat',
      question: fixture.text,
      periodSetup: 'sufficient',
      expect: {
        kind: 'refusal',
        refusalClass: prefilterClass ?? fixture.expectedRefusalClass,
      },
      ...(prefilterClass === undefined ? {} : { prefilterClass }),
    };
  });

  return [...redSetCases, ...fixtureCases];
}
