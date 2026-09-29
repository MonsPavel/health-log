/**
 * TASK-078 §5/§7: application-порт движка LLM (арх. 02 §5 — порты application).
 * Потребители — use case'ы ai-insight (087+: guardrails, резюме, чат) и
 * dev-режим e2e; реализации (адаптеры): ProcessLlmEngine — тонкая обёртка
 * клиента llm-worker (TASK-076, реальный процесс) и FakeLlmEngine —
 * детерминированный генератор для юнит-тестов и e2e без модели (миллисекунды,
 * без сети, §3/арх. 10 §1).
 *
 * КОНТРАКТ ГЕНЕРАЦИИ (фиксация решений §5/§13):
 *  - complete() ленив: сам вызов не начинает работу и не бросает — ошибки
 *    ПОЛУЧЕНИЯ генерации (AI/BUSY второй параллельной, AI/WORKER_CRASHED и пр.)
 *    и ошибки стрима доставляются ПЕРВЫМ шагом итерации (единообразно для обоих
 *    адаптеров; потребитель for-await ловит их тем же try/catch);
 *  - поток — последовательность {delta} и РОВНО один финальный {done} последним
 *    чанком; причин две: 'stop' (успех) и 'cancelled' (отмена; ошибка — не чанк,
 *    а reject итератора, §7 контракта 076);
 *  - abort-семантика (§13): signal.aborted → поток завершается {done:'cancelled'}
 *    — единообразие с реальным движком; сигнал ДО старта — немедленный
 *    done(cancelled) без занятия слота генерации;
 *  - cancel() — кооперативная отмена БЕЗ сигнала: активная генерация завершится
 *    {done:'cancelled'}; идемпотентен, без активной — no-op;
 *  - BUSY (§13): вторая генерация до завершения первой → AppError AI/BUSY
 *    первым шагом итерации — тесты оркестрации честны, UI блокирует кнопку;
 *  - ensureModel(modelId) идемпотентен (§19): повторный вызов с тем же id —
 *    no-op; modelId абстрактен для порта (в ProcessLlmEngine это путь файла
 *    модели — валидируется клиентом 076).
 *
 * ОШИБКИ (TASK-006): наружу только AppError (AI/BUSY — ключ ниже; прочие —
 * карты адаптеров). Статус EngineStatus (§7): loaded/modelId — что ЗАГРУЖЕНО
 * движку, busy — идёт ли генерация.
 *
 * Форма messages — стандартный LLM-формат chat-сообщений {role, content}
 * (§7: совместим с node-llama-cpp) — переиспользован контракт TASK-076.
 */
import type { ChatMessage, GenerationParams, LlmFinishReason } from '@hl/contracts';
import { AppError } from '@hl/kernel';

/**
 * Ключ i18n для AI/BUSY (конвенция арх. 05 §29; тексты — TASK-101). Единственный
 * источник строки — порт: клиент 076 реэкспортирует его, fake использует прямо.
 */
export const AI_BUSY_MESSAGE_KEY = 'errors.AI_BUSY';

/** Статус движка (§7). */
export interface EngineStatus {
  /** Модель загружена (ensureModel дошёл до движка). */
  readonly loaded: boolean;
  /** Идентификатор загруженной модели; нет — загружать нечего/не загружена. */
  readonly modelId?: string;
  /** Идёт генерация (слот занят — следующая получит AI/BUSY). */
  readonly busy: boolean;
}

/** Запрос генерации (§5). maxTokens — деталь адаптеров (в порте нет по §5). */
export interface LlmEngineRequest {
  /** Chat-сообщения запроса (§7: {role, content}, стандартный LLM-формат). */
  readonly messages: readonly ChatMessage[];
  /** Параметры генерации (контракт 076); fake детерминирован и игнорирует. */
  readonly params?: GenerationParams;
  /** Кооперативная отмена (§13): aborted → поток завершится {done:'cancelled'}. */
  readonly signal: AbortSignal;
}

/** Элемент потока генерации (§5): токен-дельта или финальная причина. */
export type LlmEngineChunk =
  | { readonly delta: string }
  | { readonly done: LlmFinishReason };

/**
 * Порт движка LLM (§5): load/complete-stream/cancel/status. Fake и process —
 * поведенчески эквивалентны (§4: тесты ценности, не имплементации); общий
 * контрактный набор их юнит-тестов — см. адаптеры.
 */
export interface LlmEngine {
  /**
   * Гарантировать загруженность модели (§5). Идемпотентен: тот же modelId —
   * no-op. Отказ (файла нет — AI/MODEL_NOT_FOUND, краш воркера и пр.) —
   * AppError из промиса; модель остаётся прежней.
   */
  ensureModel(modelId: string): Promise<void>;

  /**
   * Генерация стримом (§5). Ленивый AsyncIterable: работа начинается с первого
   * шага итерации; ошибки — первым шагом (см. контракт в шапке). Досрочный
   * разрыв потребителем (break/return) прекращает генерацию у движка.
   */
  complete(request: LlmEngineRequest): AsyncIterable<LlmEngineChunk>;

  /** Кооперативная отмена активной генерации (без сигнала); идемпотентен. */
  cancel(): void;

  /** Текущий статус движка (§7). */
  status(): EngineStatus;
}

/** Ошибка занятости движка (§13) — единая фабрика порта для адаптеров. */
export function llmEngineBusyError(): AppError {
  return AppError.of('AI/BUSY', AI_BUSY_MESSAGE_KEY);
}
