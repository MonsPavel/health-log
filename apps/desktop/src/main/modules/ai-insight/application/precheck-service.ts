/**
 * TASK-086 §4/§2: PrecheckService — детерминированный ПРЕФИЛЬТР (арх. 07 §4
 * эшелон 2): на входе вопрос + контекст-мета → готовый гарантированный ответ
 (отказ/срочность) ИЛИ undefined (обычный путь в LLM). LLM не используется там,
 * где текст должен быть гарантирован (AC-5.1); refusal-ответ формируется
 * мгновенно — движок не грузится, RAM не тратится (§9).
 *
 * ПРИОРИТЕТЫ (§4/§13, тест — precheck-service.test.ts):
 *  1. classifyQuestion (082 — единственный источник правил): emergency >
 *     dosage > treatment > diagnosis → готовый ответ;
 *  2. ЭСКАЛАЦИЯ ИЗ КОНТЕКСТА: критические high-значения в ПЕРИОДЕ
 *     (stats.critical.high, панель TASK-041) + вопрос О СОСТОЯНИИ
 *     (STATE_QUESTION_PATTERNS — решение §19: безобидный «какие тренды» идёт
 *     обычным путём, срочную приписку ответу обязан дать 087/084) → emergency.
 *     Раньше insufficientData — §13: «критический текст при малых данных +
 *     криз-значения = emergency, не insufficient» (duty-of-care §3);
 *  3. insufficientData — если нет других классов И пороги kernel TASK-006
 *     нарушены (stats.insufficientData, read model 052 — единое правило);
 *  4. undefined — идём в LLM (087: prompt 084 → стрим → ResponseGuard 085).
 *
 * Тексты — фабрика 086 (инъекция, §7: зависимость выражена типом
 * RefusalTextFactory, код-связь с 085 — интерфейсом). ЛОГ (§18): событие
 * `precheck.refusal` {class} — БЕЗ текста вопроса (PHI, §14 канала).
 *
 * ⚠️ low-критические (≤90/60) НЕ эскалируют до срочной панели FR-7.4 — мягкий
 * вариант low — зона панели/087; эскалация — только high (гипертонический криз).
 *
 * §15: чистые строковые операции над готовой статистикой — микросекунды; контекст
 * уже собран (087 строит AiContext до вызова). Интеграция-точка для 087: вызывается
 * ПЕРВЫМ в GenerateSummary/Chat (§9), refusal стримится как ответ без сохранения
 * (решение 087 §5).
 */
import type { PeriodStatisticsDto } from '@hl/contracts';

import { classifyQuestion } from '../domain/guardrail-policy.js';
import type { RefusalTextFactory } from './refusal-texts.js';

/**
 * Вопросы о состоянии (решение §19): при критических high-значениях в ПЕРИОДЕ
 * отказ-эскалация срабатывает ТОЛЬКО на них — безобидные/аналитические вопросы
 * («какие тренды», «сравни с нормой») идут обычным путём. Паттерны — ДАННЫЕ
 * (не if-лес, конвенция 082 §5); лукэраунды против ложных («как дела» ≠ «какие
 * тренды»: \w не покрывает кириллицу). Стартовый состав RU — пополнение по
 * находкам eval 091 (§23), как в 082/085.
 */
export const STATE_QUESTION_PATTERNS: readonly RegExp[] = [
  /(?<![а-яёa-z])как\s+(?:мои\s+)?дел[аи](?![а-яёa-z])/i, // «как дела», «как мои дела»
  /что\s+с\s+(?:моим\s+|моими\s+)?(?:давлени|пульс|показател|состояни|здоровь)/i, // «что с моим давлением»
  /вс[её]\s+ли\s+(?:у\s+меня\s+)?(?:в\s+порядке|нормально|хорошо)/i, // «всё ли в порядке»
  /(?<![а-яёa-z])(?:нормально|норм)\s+ли/i, // «нормально ли это»
  /стоит\s+ли\s+(?:беспокоит|волноват|переживат|обращат|паников)/i, // «стоит ли беспокоиться»
  /(?<![а-яёa-z])мне\s+(?:плохо|что-то\s+делат)/i, // «мне плохо?», «мне что-то делать?»
  /опасно\s+ли/i, // «опасно ли…»
  /угрожа/i, // «угрожает ли…», «что мне угрожает»
];

/** Есть ли вопрос о состоянии (первый совпавший паттерн — как в политике 082). */
export function isStateQuestion(question: string): boolean {
  return STATE_QUESTION_PATTERNS.some((pattern) => pattern.test(question));
}

/** Контекст-мета префильтра (§4): статистика периода + локаль номеров служб. */
export interface PrecheckContext {
  /** Read model 054 на проводе: пороги insufficientData + critical (052/054). */
  readonly stats: PeriodStatisticsDto;
  /** Локаль для номеров экстренных служб (§14: реестр 041); нет — ru (086). */
  readonly locale?: string;
}

/**
 * Результат префильтра (§5, дословно): refusal с классом и готовым текстом ИЛИ
 * emergency с полным текстом FR-7.4; undefined — обычный путь в LLM (087).
 */
export type PrecheckResult =
  | {
      readonly kind: 'refusal';
      /** Гарантированный текст отказа (фабрика 086, golden-снапшот §19). */
      readonly text: string;
      /** Машинный класс отказа (политика 082) — участник лога §18 и ответа 087. */
      readonly refusalClass: 'treatment' | 'dosage' | 'diagnosis' | 'insufficientData';
    }
  | {
      readonly kind: 'emergency';
      /** Полный текст срочности FR-7.4 (== панели 041, тест-сверка §20). */
      readonly text: string;
    };

/** Минимальная поверхность логгера (§18; прецедент ResponseGuardLogger 085). */
export interface PrecheckLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости (§7): фабрика текстов 086 + логгер; внедряет контейнер (087). */
export interface PrecheckServiceDeps {
  /** Фабрика отказ-текстов (086; единственный источник текстов). */
  readonly refusalText: RefusalTextFactory;
  /** Логгер события префильтра (§18; боевой — createLogger('ai')), по умолчанию молчун. */
  readonly logger?: PrecheckLogger;
}

/**
 * PrecheckService (§2): check(вопрос, контекст-мета) → гарантированный ответ ИЛИ
 * undefined. Синхронный чистый вызов над готовой статистикой (§15); единственный
 * побочный эффект — лог §18. Движок LLM сервису НЕ принадлежит: refusal не может
 * его затронуть (спай-тест §20 п.6 — контракт для интеграции 087).
 */
export class PrecheckService {
  private readonly refusalText: RefusalTextFactory;

  private readonly logger: PrecheckLogger | undefined;

  constructor(deps: PrecheckServiceDeps) {
    this.refusalText = deps.refusalText;
    this.logger = deps.logger;
  }

  /**
   * Префильтр (§4): классификация вопроса → эскалация криза периода на вопросы о
   * состоянии → пороги малых данных → undefined. Каждый исход — не позже своего
   * шага (приоритеты §13, тесты — таблица redSetCase и эскалация).
   */
  check(question: string, ctx: PrecheckContext): PrecheckResult | undefined {
    const textClass = classifyQuestion(question);
    if (textClass !== undefined) {
      return this.finish(
        textClass === 'emergency'
          ? { kind: 'emergency', text: this.refusalText('emergency', { locale: ctx.locale }) }
          : {
              kind: 'refusal',
              text: this.refusalText(textClass, { stats: ctx.stats, locale: ctx.locale }),
              refusalClass: textClass,
            },
      );
    }
    // Решение §19: криз в ПЕРИОДЕ эскалирует только вопросы о состоянии; §13:
    // раньше insufficientData («emergency, не insufficient» при малых данных).
    if (ctx.stats.critical.high && isStateQuestion(question)) {
      return this.finish({
        kind: 'emergency',
        text: this.refusalText('emergency', { locale: ctx.locale }),
      });
    }
    const insufficient = ctx.stats.insufficientData;
    if (insufficient.tooFewMeasurements || insufficient.tooFewDays) {
      return this.finish({
        kind: 'refusal',
        text: this.refusalText('insufficientData', { stats: ctx.stats, locale: ctx.locale }),
        refusalClass: 'insufficientData',
      });
    }
    return undefined;
  }

  /** Фиксация исхода (§18): событие с классом — без текста вопроса (PHI). */
  private finish(result: PrecheckResult): PrecheckResult {
    this.logger?.info('precheck.refusal', {
      class: result.kind === 'emergency' ? 'emergency' : result.refusalClass,
    });
    return result;
  }
}
