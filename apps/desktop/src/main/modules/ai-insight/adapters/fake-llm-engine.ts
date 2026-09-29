/**
 * TASK-078 §5: FakeLlmEngine — in-process реализация порта LlmEngine:
 * детерминированный сценарный генератор текста-«токенов» для юнит-тестов
 * guardrails/резюме/чата (087+) и dev-режима e2e (HL_FAKE_LLM=1 — контейнер,
 * тесты 088/090). Без процессов и сети (§3/§14): мс-стрим, таймеры только при
 * delayMs > 0 (§9: в тестах задержка 0 — стрим на микро-тактах, §15 <50 мс
 * за 1000 токенов).
 *
 * ПОВЕДЕНИЕ КАК У РЕАЛЬНОГО (§4 — тесты ценности, не имплементации):
 *  - стрим по словам (дельта = слово с хвостовым пробелом; конкатенация дельт
 *    восстанавливает ответ байт-в-байт), финал {done:'stop'};
 *  - abort посреди → {done:'cancelled'} немедленно на следующем шаге; abort до
 *    старта → done(cancelled) без занятия слота; контракт доставки — порт
 *    (llm-engine.ts, шапка);
 *  - BUSY (§13): вторая генерация до завершения первой → AppError AI/BUSY
 *    первым шагом итерации;
 *  - ensureModel идемпотентен; статус EngineStatus §7.
 *
 * СЦЕНАРНАЯ ТАБЛИЦА (§5): ответы по ключевым словам запроса — вхождение
 * ключа (lowercase) в текст СООБЩЕНИЙ запроса (все роли). Фикстура по умолчанию:
 * «средн*» → текст-резюме из константы (стем покрывает «среднее/средние/средним»
 * — разумное толкование §5 «„среднее“ → текст-резюме»), иначе — безопасный
 * нейтральный текст. Таблица переопределяется опцией (§23: расширение под
 * eval-регрессии 091). Отказы guardrail'ов fake НЕ имитирует (§5 «не включено»
 * — домен 086).
 *
 * ПРЕФИКС [FAKE] (§16–17/§22): обязательная пометка в начале КАЖДОГО ответа —
 * защита от спутывания fake-ответов с реальным ИИ на скриншотах; движок
 * проставляет его сам (первым «словом» стрима) — записи таблицы не могут
 * забыть.
 *
 * УПРОЩЕНИЯ fake (документированные расхождения с реальным — тесты aware):
 *  - params/maxTokens игнорируются (детерминизм важнее реализма);
 *  - ensureModel ничего не «грузит» — только фиксирует модель в статусе;
 *  - досрочный разрыв потока потребителем (break/return for-await) освобождает
 *    слот генерации, как отмена (у реального движка разрыв = утечка слота до
 *    cancel/abort — потребитель обязан завершать поток явно).
 *
 * БЕЗОПАСНОСТЬ (§14): никаких БД/сети/процессов — только константы и промисы.
 */
import {
  type EngineStatus,
  type LlmEngine,
  type LlmEngineChunk,
  type LlmEngineRequest,
  llmEngineBusyError,
} from '../application/ports/llm-engine.js';

/** Обязательная пометка fake-ответов (§16–17/§22): первый «токен» стрима. */
export const FAKE_LLM_PREFIX = '[FAKE]';

/** Текст-резюме по «средним» (§5: фикстура-таблица; RU-константа, без префикса). */
export const FAKE_AVERAGE_SUMMARY_RESPONSE =
  'Среднее систолическое давление за период — 124 мм рт. ст., диастолическое — 79 мм рт. ст., ' +
  'средний пульс — 66 уд/мин. Значения удерживаются в целевой зоне, выраженной динамики не ' +
  'зафиксировано. Резюме подготовлено без реальной модели.';

/** Безопасный нейтральный текст (§5: ответ вне сценариев; RU-константа, без префикса). */
export const FAKE_NEUTRAL_RESPONSE =
  'Запрос принят. Это детерминированный ответ fake-движка: реальная модель не загружена, ' +
  'генерация имитируется для разработки и проверки интерфейса.';

/** Строка сценарной таблицы (§5): ключевые слова запроса → текст ответа. */
export interface FakeLlmScenario {
  /** Ключевые слова (lowercase-вхождение в текст сообщений запроса). */
  readonly keywords: readonly string[];
  /** Текст ответа БЕЗ префикса [FAKE] — его проставляет движок. */
  readonly response: string;
}

/** Стем ключа сценария по умолчанию: «средн» покрывает «среднее/средние/средним». */
const AVERAGE_KEYWORD_STEM = 'средн';

/** Фикстура-таблица по умолчанию (§5): «средн*» → резюме, иначе — нейтральный. */
const DEFAULT_SCENARIOS: readonly FakeLlmScenario[] = [
  { keywords: [AVERAGE_KEYWORD_STEM], response: FAKE_AVERAGE_SUMMARY_RESPONSE },
];

/** Опции fake-движка (§5: всё переопределяемо — тесты). */
export interface FakeLlmEngineOptions {
  /** Микро-задержка между «словами», мс (§5: 0 в тестах — без таймеров). */
  readonly delayMs?: number;
  /** Сценарная таблица (§23: расширение под eval); по умолчанию — фикстура §5. */
  readonly scenarios?: readonly FakeLlmScenario[];
  /** Нейтральный ответ вне сценариев; по умолчанию — константа. */
  readonly neutralResponse?: string;
}

/** Ожидание (только при delayMs > 0; в тестах путь не выполняется — §9/§15). */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Детерминированный fake-движок LLM (§5) — реализация порта. */
export class FakeLlmEngine implements LlmEngine {
  private readonly delayMs: number;
  private readonly scenarios: readonly FakeLlmScenario[];
  private readonly neutralResponse: string;

  private modelId: string | undefined;
  /** Активная генерация: флаг отмены; вторая параллельная — AI/BUSY (§13). */
  private active: { cancelled: boolean } | undefined;

  constructor(options: FakeLlmEngineOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.scenarios = options.scenarios ?? DEFAULT_SCENARIOS;
    this.neutralResponse = options.neutralResponse ?? FAKE_NEUTRAL_RESPONSE;
  }

  /** Идемпотентная фиксация модели (§19): тот же id — no-op, другой — замена. */
  ensureModel(modelId: string): Promise<void> {
    this.modelId = modelId;
    return Promise.resolve();
  }

  /** Статус (§7): loaded — модель фиксирована; busy — слот занят. */
  status(): EngineStatus {
    return {
      loaded: this.modelId !== undefined,
      modelId: this.modelId,
      busy: this.active !== undefined,
    };
  }

  /** Кооперативная отмена активной генерации; идемпотентна, без активной — no-op. */
  cancel(): void {
    if (this.active !== undefined) {
      this.active.cancelled = true;
    }
  }

  /**
   * Генерация (ленивый AsyncIterable — контракт доставки в шапке порта):
   * префикс [FAKE], затем слова сценарного текста; финал {done:'stop'}, при
   * отмене/abort — {done:'cancelled'}.
   */
  complete(request: LlmEngineRequest): AsyncIterable<LlmEngineChunk> {
    return this.generate(request);
  }

  private async *generate(request: LlmEngineRequest): AsyncIterableIterator<LlmEngineChunk> {
    if (this.active !== undefined) {
      // §13: вторая генерация до завершения первой — AI/BUSY (первый шаг итерации).
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт ошибок порта — AppError (TASK-006; прецедент llm-process-client)
      throw llmEngineBusyError();
    }
    if (request.signal.aborted) {
      // §13: abort до старта — немедленный done(cancelled), слот не занимался.
      yield { done: 'cancelled' };
      return;
    }

    const generation = { cancelled: false };
    this.active = generation;
    const onAbort = (): void => {
      generation.cancelled = true;
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      // Префикс [FAKE] обязателен (§16–17): первым словом, с хвостовым пробелом.
      const text = `${FAKE_LLM_PREFIX} ${this.selectResponse(request.messages)}`;
      // Слово = не-пробелы + хвостовые пробелы: конкатенация дельт = исходный текст.
      const words = text.match(/\S+\s*/g) ?? [];
      for (const word of words) {
        if (generation.cancelled) {
          yield { done: 'cancelled' };
          return;
        }
        if (this.delayMs > 0) {
          await sleep(this.delayMs);
        }
        yield { delta: word };
      }
      yield { done: 'stop' };
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (this.active === generation) {
        this.active = undefined; // отмена/дочитка/разрыв потребителя — слот свободен
      }
    }
  }

  /** Сценарный выбор ответа (§5): вхождение ключа в текст сообщений запроса. */
  private selectResponse(messages: LlmEngineRequest['messages']): string {
    const prompt = messages
      .map((message) => message.content)
      .join('\n')
      .toLowerCase();
    const scenario = this.scenarios.find((entry) =>
      entry.keywords.some((keyword) => prompt.includes(keyword.toLowerCase())),
    );
    return scenario !== undefined ? scenario.response : this.neutralResponse;
  }
}
