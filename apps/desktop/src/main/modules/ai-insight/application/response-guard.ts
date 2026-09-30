/**
 * TASK-085 §2/§5: ResponseGuard — пост-фильтр ОТВЕТОВ модели (арх. 07 §4, эшелон 3,
 * финальный): эвристики запрещённых паттернов; срабатывание → ПОЛНАЯ замена на
 * отказ-шаблон + лог-событие. Промпт (084) — мягкий контроль; релизный гейт AC-5.1
 * требует гарантий на каждой модели (R-12): пост-фильтр ловит нарушения,
 * проскочившие промпт. Паттерны — на ОТВЕТ (вопрос классифицирует префильтр 086
 * по политике 082 — единственному источнику правил).
 *
 * ПРАВИЛА — ДАННЫЕ, не if-лес (§5): RESPONSE_GUARD_RULES, состав:
 *  R2 — конкретная доза+единица, срабатывает ТОЛЬКО при императив-контексте в том
 *       же предложении (§13): императив R1 ИЛИ «рекомендую|стоит принять|
 *       назначьте себе» → dosage;
 *  R1 — императивы приёма («принимайте», «прекратите приём», «отмените»…) → treatment;
 *  R3 — «диагноз: …» / «у вас <название-болезни>» → diagnosis;
 *  R4 — «вам нужно лекарств…» → treatment.
 * Порядок оценки — порядок массива: R2 раньше R1, чтобы «увеличьте дозу до 20 мг»
 * получил точный класс dosage (§4: эвристика императивов рядом с дозой), а не
 * общий treatment. Различение §4: «врач назначил 5 мг» / «вы отметили приём 5 мг»
 * — пересказ заметок БЕЗ императива в предложении → pass (ключевой негативный
 * кейс §13); AUX-контекст — только 1-е лицо («рекомендую»): пересказ врача
 * («врач рекомендует/назначил») — pass.
 *
 * ЗАМЕНА — интерфейсная зависимость (§7): refusalTextFactory(RefusalClass) → text
 * внедряется зависимостью (шаблоны — TASK-086; инъекция, чтобы не циклиться).
 * Результат: GuardResult = {action:'pass'} | {action:'replace', text, ruleId,
 * refusalClass} — заменённый текст сохраняется как ответ (пользователь видит
 * отказ, §9); обязательства (дисклеймер/период) здесь НЕ добавляются — их
 * добавляет 087 при сборке (§5: разделение).
 *
 * ⚠️ FAIL-SAFE (§14): правило «СОМНЕНИЕ = ЗАМЕНА». Любой сбой при вычислении
 * совпадения (regex-катастрофа/исключение паттерна) трактуется как СОВПАДЕНИЕ →
 * replace, никогда не pass (обёртки try — см. matchedRule/hasImperativeContext).
 *
 * §15: регексы на ответ ≤2 КБ — микросекунды; вызов раз на генерацию (после
 * завершения стрима, 087 — не по токенам). §18: лог `guardrail.replace`
 * {ruleId, refusalClass, note} — БЕЗ текста ответа (PHI, §14 канала). §17: тексты
 * отказов — фабрика 086; паттерны RU — продолжение решения 082 (лукэраунды вместо
 * \b: JS \w не покрывает кириллицу; без флага g — stateful .test).
 *
 * Пополнение (§23): находка eval 091 → правило в RESPONSE_GUARD_RULES + фикстура
 * в __fixtures__/unsafe-answers.ts («находка → правило+фикстура»).
 */
import type { RefusalClass } from '../domain/guardrail-policy.js';

/**
 * Правило пост-фильтра (§5/§7): данные, не if-лес. Все правила — замена
 * («не включено»: редактирование текста, §5).
 */
export interface GuardRule {
  /** Стабильный id (R1–R4, §5) — участник лог-события §18. */
  readonly id: string;
  /** Паттерн на ОТВЕТ модели; без флага g (stateful .test — конвенция 082 §4). */
  readonly pattern: RegExp;
  /** Единственное действие пост-фильтра — полная замена (§5: «только полная замена»). */
  readonly action: 'replace';
  /** Класс отказа (RefusalClass политики 082) — выбирает текст фабрики 086. */
  readonly refusalClass: RefusalClass;
  /** Ключ-идентификатор правила для логов/диагностики P6 (§18), не PHI. */
  readonly noteKey: string;
  /**
   * Условное правило (§13, только R2): срабатывает, если в ПРЕДЛОЖЕНИИ с дозой
   * есть императив (R1) ИЛИ «рекомендую|стоит принять|назначьте себе». Без флага
   * правило срабатывает на любое совпадение паттерна.
   */
  readonly requireImperativeContext?: boolean;
}

/**
 * Фабрика отказ-текстов (§7): интерфейсная зависимость на TASK-086 (инъекция —
 * «принимает фабрику шаблонов параметром, чтобы не циклиться», §5). Единый тон
 * отказов гарантирует 086 (§17).
 */
export type RefusalTextFactory = (refusalClass: RefusalClass) => string;

/** Результат проверки (§7, дословно): pass без текста — 087 вернёт исходный ответ. */
export type GuardResult =
  | { readonly action: 'pass' }
  | {
      readonly action: 'replace';
      /** Полный отказ-текст фабрики (не обрезка исходного ответа, §5/AC §20 п.3). */
      readonly text: string;
      readonly ruleId: string;
      readonly refusalClass: RefusalClass;
    };

/** Минимальная поверхность логгера (§18; прецедент AddMeasurementLogger): HlLogger контейнера ей удовлетворяет. */
export interface ResponseGuardLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости (§5/§7): внедряет контейнер (087), тесты — подстановки (§19). */
export interface ResponseGuardDeps {
  /** Фабрика отказ-текстов класса (TASK-086; §7 — инъекция). */
  readonly refusalText: RefusalTextFactory;
  /** Логгер события замены (§18; боевой — createLogger('ai')), по умолчанию молчун. */
  readonly logger?: ResponseGuardLogger;
  /** Состав правил (§5); по умолчанию — стартовый состав RESPONSE_GUARD_RULES. */
  readonly rules?: readonly GuardRule[];
}

// --- паттерны стартового состава (§5; RU, лукэраунды вместо \b — см. шапку §17) ---

/**
 * R1 (§5): императивы приёма. Состав — дословно §5 («принимай\w*|пейте|пей|
 * начните принимать|увеличьте дозу|уменьшите дозу|отмените|прекратите прием»):
 * «принимай\w*» — стем ПОВЕЛИТЕЛЬНОГО наклонения (принимай/принимайте; \w не
 * покрывает кириллицу), инфинитив «принимать» им не покрывается — как и в
 * спецификации, где «начните принимать» вынесен отдельной альтернативой.
 * [а-яё]* вместо \w, [её] — обе графики «приём/прием». Состав — стартовый (§5):
 * пополнение по находкам eval 091 (§23), не по вкусам.
 */
const IMPERATIVE_PATTERN =
  /(?<![а-яёa-z])(?:принимай[а-яё]*|пейте|пей|начните\s+принимать|увеличьте\s+доз[а-яё]*|уменьшите\s+доз[а-яё]*|отмените|прекратите\s+при[её]м)(?![а-яёa-z])/i;

/**
 * R2 (§5): конкретная доза+единица «\d+([\.,]\d+)?\s?(мг|мл|мкг|таблетк)». После
 * единиц объёма/массы — лукэраунд (иначе «5 мгновенно»); «таблетк» — стем
 * (таблетка/таблетки/таблетке), как «таблетк» в политике 082.
 */
const DOSE_PATTERN = /\d+(?:[.,]\d+)?\s*(?:м(?:г|л|кг)(?![а-яёa-z])|таблетк)/i;

/**
 * R3 (§5): «диагноз: <что-либо>» ИЛИ «у вас <название-болезни>» (формат отказа
 * от постановки диагноза). Стемы болезней — класс домена (давление: 082 «у меня
 * гипертони|гипотони|аритми»); между «у вас» и стемом — ограниченный зазор
 * (≤40 символов, без выхода за конец предложения): вводные слова и знаки
 * («У вас, вероятно, аритмия»). Опровержение тоже матчится — 084 запрещает
 * и подтверждать, и опровергать диагноз («у вас нет гипертонии» → замена).
 */
const DIAGNOSIS_PATTERN =
  /(?<![а-яёa-z])диагноз\s*:|(?<![а-яёa-z])у вас[^.!?…\n]{0,40}?(?:диагностирован|гипертони|гипотони|аритми|тахикарди|брадикарди)/i;

/** R4 (§5): «вам нужно лекарств…» (нужно/нужны + существительное лекарства/приёма). */
const NEED_MEDICINE_PATTERN =
  /(?<![а-яёa-z])вам\s+(?:нужно|нужны)\s+(?:лекарств|таблетк|медикамент|принимать|лечени)/i;

/**
 * Императив-контекст дозы (§13): императив R1 ИЛИ «рекомендую|стоит принять|
 * назначьте себе» — в ТОМ ЖЕ предложении, что и доза.
 */
const AUX_IMPERATIVE_PATTERN = /(?:рекомендую|стоит принять|назначьте себе)/i;

/** Разделитель предложений (§13: «в том же предложении»): [.!?…] + пробел или перенос. */
const SENTENCE_SPLIT = /(?<=[.!?…])\s+|\n+/;

/**
 * Стартовый состав правил (§5) — ДАННЫЕ. Порядок массива = порядок оценки:
 * условный R2 первым (см. шапку — точный класс dosage для «увеличьте дозу до 20 мг»),
 * затем R1, R3, R4. Первый совпавший побеждает.
 */
export const RESPONSE_GUARD_RULES: readonly GuardRule[] = [
  {
    id: 'R2',
    pattern: DOSE_PATTERN,
    action: 'replace',
    refusalClass: 'dosage',
    noteKey: 'dose-with-imperative-context',
    requireImperativeContext: true,
  },
  {
    id: 'R1',
    pattern: IMPERATIVE_PATTERN,
    action: 'replace',
    refusalClass: 'treatment',
    noteKey: 'intake-imperative',
  },
  {
    id: 'R3',
    pattern: DIAGNOSIS_PATTERN,
    action: 'replace',
    refusalClass: 'diagnosis',
    noteKey: 'diagnosis-statement',
  },
  {
    id: 'R4',
    pattern: NEED_MEDICINE_PATTERN,
    action: 'replace',
    refusalClass: 'treatment',
    noteKey: 'need-medicine',
  },
];

/** Предложения ответа (§13): склейка разделителей, пустые/пробельные — мимо. */
function sentencesOf(text: string): readonly string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * ResponseGuard (§2): check(ответ) → pass | полная замена на отказ-текст фабрики.
 * Контекст из §2 («check(answer, ctx)») — внедрённые зависимости конструктора
 * (§7: фабрика 086 — инъекция; прецедент AiContextBuilder/AddMeasurement):
 * код-зависимость 085 ← 086 выражена интерфейсом, а не импортом. Чистый вызов:
 * «сейчас»/внешних источников нет; единственный побочный эффект — лог §18.
 */
export class ResponseGuard {
  private readonly refusalText: RefusalTextFactory;

  private readonly logger: ResponseGuardLogger | undefined;

  private readonly rules: readonly GuardRule[];

  constructor(deps: ResponseGuardDeps) {
    this.refusalText = deps.refusalText;
    this.logger = deps.logger;
    this.rules = deps.rules ?? RESPONSE_GUARD_RULES;
  }

  /**
   * Проверка ответа (§2/§5): первое сработавшее правило → replace с текстом
   * фабрики; иначе pass. Вызывается 087 один раз после завершения стрима (§9).
   */
  check(answer: string): GuardResult {
    const rule = this.matchedRule(answer);
    if (rule === undefined) {
      return { action: 'pass' };
    }
    const text = this.refusalText(rule.refusalClass);
    // §18: событие замены — id/класс/ключ правила, БЕЗ текста ответа (PHI, §14 канала).
    this.logger?.info('guardrail.replace', {
      ruleId: rule.id,
      refusalClass: rule.refusalClass,
      note: rule.noteKey,
    });
    return { action: 'replace', text, ruleId: rule.id, refusalClass: rule.refusalClass };
  }

  /**
   * Первое сработавшее правило или undefined. Сбй .test → правило считается
   * СРАБОТАВШИМ (§14: regex-катастрофа → replace, не pass; сомнение = замена).
   */
  private matchedRule(answer: string): GuardRule | undefined {
    for (const rule of this.rules) {
      let hit: boolean;
      try {
        hit = rule.pattern.test(answer);
      } catch {
        hit = true; // §14 FAIL-SAFE: сомнение = замена
      }
      if (!hit) {
        continue;
      }
      if (rule.requireImperativeContext === true && !this.hasImperativeContext(answer, rule)) {
        continue;
      }
      return rule;
    }
    return undefined;
  }

  /**
   * Императив-контекст дозы (§13): в предложении, где нашлась доза, есть императив
   * R1 ИЛИ AUX («рекомендую|стоит принять|назначьте себе»). Пересказ заметок без
   * императива («вы отметили приём 5 мг», «врач назначил 5 мг») → false → pass.
   */
  private hasImperativeContext(answer: string, rule: GuardRule): boolean {
    for (const sentence of sentencesOf(answer)) {
      let hasDose: boolean;
      try {
        hasDose = rule.pattern.test(sentence);
      } catch {
        hasDose = true; // §14 FAIL-SAFE: сомнение = замена — пусть решит контекст
      }
      if (hasDose && (IMPERATIVE_PATTERN.test(sentence) || AUX_IMPERATIVE_PATTERN.test(sentence))) {
        return true;
      }
    }
    return false;
  }
}
