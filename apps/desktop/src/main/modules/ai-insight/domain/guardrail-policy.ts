/**
 * TASK-082 §2/§5: GuardrailPolicy — доменная политика guardrails (арх. 02 §3.3).
 * Машинные классы запретов (RefusalClass), паттерны-описания классов (RU + базовые
 * EN — §5: RU приоритет, EN-состав фиксируется тестами), обязательные элементы
 * ответа (ResponseObligation) и красный набор AC-5.1 как данные (red-set.ts).
 * Политика — ЕДИНСТВЕННЫЙ источник правил для потребителей: system-prompt
 * (TASK-084), пост-фильтр (TASK-085), отказ-шаблоны (TASK-086); исполнение —
 * application/adapters (арх. 07 §4, три эшелона), здесь его нет (§5).
 *
 * ⚠️ §14: политика — юридическая рамка продукта (не-медицинское изделие, SRS 01
 * §8, R-1/R-2). Изменение классов, паттернов или красного набора = ревизия SRS;
 * состав зафиксирован тестами (red-set.test.ts, guardrail-policy.test.ts) —
 * регресс-щит против случайной правки.
 *
 * classifyQuestion — первичный текстовый маршрутизатор вопроса (§13), приоритет:
 * emergency (критические значения + симптомы) > dosage > treatment > diagnosis.
 * insufficientData текстом не определяется — только счётчиками данных (порог
 * kernel TASK-006: AI_MIN_MEASUREMENTS/AI_MIN_DAYS; исполнение — TASK-086), поэтому
 * patterns.insufficientData пуст, а classifyQuestion его не возвращает; undefined =
 * обычный вопрос (ответ с обязательствами obligations).
 *
 * Паттерны — стемы; флага g нет (stateful .test), регистр не важен (/i). Словесные
 * границы для кириллицы — лукэраунды (?<!)/(?!) (JS \b не работает с кириллицей —
 * \w только ASCII). Сужение против ложных срабатываний (§22): «пить/принимать» без
 * существителя лекарства НЕ матчатся — витамины/образ жизни не refusal (кейс в
 * тестах); пополнение — по находкам eval TASK-091 (§23: находка → кейс в red-set +
 * паттерн). Regex на вопрос ~мкс (§15).
 */
import { RED_SET_CASES } from './red-set.js';

/**
 * Машинный класс запрета (§5): 'diagnosis' — постановка диагноза, 'treatment' —
 * рекомендации лечения/приёма препаратов, 'dosage' — подбор/изменение дозы,
 * 'emergency' — критические значения + симптомы (срочная помощь, FR-5.3/FR-7.4),
 * 'insufficientData' — отказ от обобщений при малых данных (FR-5.4, порог TASK-006).
 */
export type RefusalClass =
  | 'diagnosis'
  | 'treatment'
  | 'dosage'
  | 'emergency'
  | 'insufficientData';

/**
 * Обязательные элементы ответа ИИ (§5): дисклеймер и указание периода — всегда
 * (FR-5.6, AC-5.2, литералы true — несъёмные), упоминание разрывов —
 * boolean-обязательство (FR-5.4: называть разрывы, когда они есть в периоде;
 * фактическое наличие разрывов определяет AiContextBuilder, TASK-085).
 */
export interface ResponseObligation {
  /** Несъёмный дисклеймер «не является медицинской консультацией» (FR-5.6). */
  readonly disclaimer: true;
  /** Указание периода анализа в ответе (FR-5.5, AC-5.2). */
  readonly periodMention: true;
  /** Явное называние разрывов наблюдений (FR-5.4, AC-5.1 «данных нет»). */
  readonly gapsMention: boolean;
}

/**
 * Ожидаемая реакция на кейс красного набора (§5): 'refusal' — отказ с классом
 * (шаблон TASK-086), 'emergency' — срочная помощь с локализованными номерами
 * (FR-7.4), 'insufficient' — честный отказ от обобщений при малых данных (FR-5.4),
 * 'answerWithDisclaimer' — обычный ответ с обязательствами (AC-5.1 «сравни с
 * нормой», «что было в разрыв»).
 */
export type RedSetExpectation =
  | { readonly kind: 'refusal'; readonly refusalClass: RefusalClass }
  | { readonly kind: 'emergency' }
  | { readonly kind: 'insufficient' }
  | { readonly kind: 'answerWithDisclaimer' };

/** Кейс красного набора AC-5.1 (§5/§7): вопрос (или формулировка строки таблицы — кейс «малых данных») + ожидаемая реакция. */
export interface RedSetCase {
  /** Стабильный id кейса (ссылка в тестах/eval TASK-091). */
  readonly id: string;
  /** Дословная формулировка строки таблицы AC-5.1 (SRS 08). */
  readonly question: string;
  /** Обязательная реакция (гейт релиза, арх. 07 §7). */
  readonly expected: RedSetExpectation;
}

/**
 * Доменная политика guardrails (§5, арх. 02 §3.3): классы запретов, паттерны как
 * данные (не if-лес потребителя — AC §20 п.4), обязательства ответа, красный набор.
 */
export interface GuardrailPolicy {
  /** Все машинные классы запретов политики (§5: пять классов). */
  readonly refusals: readonly RefusalClass[];
  /** Паттерны-описания классов (RU + базовые EN); insufficientData — пуст (не текст). */
  readonly patterns: Readonly<Record<RefusalClass, readonly RegExp[]>>;
  /** Обязательные элементы каждого ответа (FR-5.4/5.5/5.6). */
  readonly obligations: ResponseObligation;
  /** Красный набор AC-5.1 как данные политики (red-set.ts). */
  readonly redSetCases: readonly RedSetCase[];
}

/**
 * Дефолтная политика (§5): состав запретов и паттернов — по SRS 01 §8 / FR-5.3 /
 * AC-5.1; изменение составов = ревизия SRS (§14, см. шапку файла).
 */
export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  refusals: ['diagnosis', 'treatment', 'dosage', 'emergency', 'insufficientData'],
  patterns: {
    // Diagnosis: постановка диагноза («поставь диагноз», «диагностируй», «у меня
    // гипертония?» — §13). «Что такое гипертония?» — НЕ матчится (образовательный
    // вопрос): только связка «у меня» или глагол диагноза.
    diagnosis: [
      /(?<![а-яёa-z])диагноз/i,
      /диагностир/i,
      /у меня\s+(?:гипертони|гипотони|аритми)/i,
      /гипертони[яию]\s+у\s+меня/i,
      /\bdiagnos\w*/i,
      /\bdo i have (?:hypertension|high blood pressure|hypotension)\b/i,
      /\bam i (?:hypertensive|hypotensive)\b/i,
    ],
    // Treatment: рекомендации лечения/препаратов (§13: «таблетк», « назнач», «прекрат»).
    // Существители лекарств, не голые «пить/принимать» (§22: витамины — не refusal).
    treatment: [
      /таблетк/i,
      /лекарств/i,
      /препарат/i,
      /медикамент/i,
      /укол/i,
      /капельниц/i,
      /назнач/i,
      /прекрат/i,
      /\bpills?\b/i,
      /\bmedicin\w*/i,
      /\bmedication\w*/i,
      /\bdrugs?\b/i,
      /\bprescrib\w*/i,
    ],
    // Dosage: доза/дозировка, единицы («сколько мг» — §19). Границы — лукэраунды
    // (JS \b не работает с кириллицей): «мг» не матчится внутри «мгновенно» и т.п.
    dosage: [
      /(?<![а-яёa-z])доз/i,
      /(?<![а-яёa-z0-9])(?:мг|мкг|миллиграмм|микрограмм)(?![а-яёa-z0-9])/i,
      /\bdos(?:e|age|ing)\b/i,
      /\bmg\b/i,
    ],
    // Emergency: ТОЛЬКО конъюнкция «критическое значение + симптом» (§13): sys≥180/
    // dia≥120 (пороги TASK-020) в формах «190/120», «200 на 130» И симптом (болит,
    // тошнит, …). Значение без симптома — не emergency здесь (криз в данных ловит
    // панель TASK-041; текст вопроса «сравни с нормой» — answerWithDisclaimer).
    emergency: [
      /(?=.*(?:1[89]\d|2\d\d)\s*(?:\/|на)\s*(?:1[2-9]\d|2\d\d))(?=.*(?:болит|боль|головокруж|тошн|рвот|рвёт|неме|обморок|в груди|скорая))/i,
      /(?=.*\b(?:1[89]\d|2\d\d)\s*\/\s*(?:1[2-9]\d|2\d\d)\b)(?=.*(?:headache|chest pain|dizzy|vomiting|numb|faint|shortness of breath))/i,
    ],
    // Не текстовый класс (§13): определяется счётчиками данных TASK-086, порог TASK-006.
    insufficientData: [],
  },
  obligations: { disclaimer: true, periodMention: true, gapsMention: true },
  redSetCases: RED_SET_CASES,
};

/** Порядок текстовой маршрутизации (§13): первый совпавший класс побеждает. */
const CLASSIFICATION_ORDER: readonly RefusalClass[] = [
  'emergency',
  'dosage',
  'treatment',
  'diagnosis',
];

/**
 * Первичный маршрутизатор вопроса (§5/§13): первый класс, чей паттерн совпал, по
 * приоритету emergency > dosage > treatment > diagnosis; insufficientData не
 * возвращается (определяется данными, TASK-086); undefined — обычный вопрос
 * (ответ с обязательствами obligations). Чистая функция над данными политики.
 */
export function classifyQuestion(question: string): RefusalClass | undefined {
  for (const cls of CLASSIFICATION_ORDER) {
    if (DEFAULT_GUARDRAIL_POLICY.patterns[cls].some((pattern) => pattern.test(question))) {
      return cls;
    }
  }
  return undefined;
}
