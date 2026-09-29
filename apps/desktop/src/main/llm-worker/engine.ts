/**
 * TASK-077 §5/§6: движок llm-worker — управляемая обвязка реального инференса
 * (node-llama-cpp) за портом протокола 076 (LlmWorkerEngine).
 *
 * РАЗДЕЛЕНИЕ (прецедент порта движка 076): нативная граница — порт LlamaBackend
 * (loadModel → сессия generate/dispose); здесь — управление жизненным циклом
 * модели и маппинг ошибок в коды §13. Реальный адаптер node-llama-cpp —
 * llama-engine.ts (ленивый import — воркер грузит натив только при load);
 * тесты без модели подставляют мок-бэкенд (§19).
 *
 * ЖИЗНЕННЫЙ ЦИКЛ МОДЕЛИ (§5/§12): no-model → loaded → busy → loaded; load при
 * загруженной модели — ПЕРЕЗАГРУЗКА (прежняя сессия выгружается, §5); unload
 * идемпотентен; генерация при no-model → error AI/NO_MODEL.
 *
 * IDLE-UNLOAD (§5): 5 минут без генераций (константа IDLE_UNLOAD_MS; окно
 * перезапускается загрузкой и КАЖДОЙ генерацией) → авто-unload + лог с
 * reason: 'idle'. Сокращённое окно для ручного [model]-прогона §20 — env
 * HL_LLM_IDLE_UNLOAD_MS (целые мс > 0; парсинг — resolveIdleUnloadMs,
 * читается в llama-engine.ts, здесь — чистая функция для теста).
 *
 * КРАШ-ЗАЩИТА (§13): путь модели валидируется ДО передачи нативу —
 * существование/файл → AI/MODEL_FILE_MISSING, magic-заголовок «GGUF» →
 * AI/MODEL_INVALID; отказ нативного loadModel тоже оборачивается в
 * AI/MODEL_INVALID (битый GGUF после magic: маловероятно, но не краш-путь —
 * нативный краш остаётся на совести процессов-границ, клиент 076 перезапустит).
 *
 * ПАРАМЕТРЫ ГЕНЕРАЦИИ (§7 — дефолты, конфиг): temperature 0.3 (факты, не
 * креатив), maxTokens 1024, seed — опциональный параметр протокола (§7/§11,
 * повторяемость eval TASK-091).
 *
 * ЛОГ (§18): load/unload/idle-unload и построчно генерация
 * {requestId, tokens, tps, firstTokenMs} — текст промпта/ответа наружу не
 * идёт (§14); логгер структурный (прецедент LlmClientLogger 076 — shared
 * в воркер не импортируется), боевой — stdout-адаптер llama-engine.ts.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import type { ChatMessage, GenerationParams, LlmFinishReason } from '@hl/contracts';

import { EngineError, type LlmWorkerEngine, type WorkerCompleteParams } from './protocol.js';

/** Окно простоя до авто-выгрузки модели (§5: 5 минут). */
export const IDLE_UNLOAD_MS = 5 * 60 * 1000;

/** Дефолты генерации (§7 — конфиг; temperature «факты, не креатив»). */
export const GENERATION_DEFAULTS = {
  /** Контекст промпт+ответ, токены (§4). */
  contextSize: 4096,
  temperature: 0.3,
  maxTokens: 1024,
} as const;

/** Коды ошибок движка для wire-протокола (§13; клиент 076 кладёт их в params.code). */
export const LLM_ENGINE_ERROR = {
  /** Файла модели нет (или это не файл). */
  MODEL_FILE_MISSING: 'AI/MODEL_FILE_MISSING',
  /** Битый GGUF: magic-заголовок не «GGUF» или отказ нативной загрузки. */
  MODEL_INVALID: 'AI/MODEL_INVALID',
  /** Генерация при незагруженной модели. */
  NO_MODEL: 'AI/NO_MODEL',
} as const;

/** Magic-подпись GGUF: первые 4 байта файла (§13 — валидация до передачи нативу). */
const GGUF_MAGIC = Buffer.from('GGUF', 'ascii');

/** Структурный логгер движка (§18; боевой — stdout-адаптер llama-engine.ts). */
export interface LlmEngineLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Факт вызова логгера (тесты §19 — ассерты по структуре, не по строкам). */
export interface LlmEngineLogCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly meta: Record<string, unknown>;
}

/** Запрос генерации к сессии бэкенда (разрешённые дефолтами параметры §7). */
export interface LlamaGenerateRequest {
  readonly messages: readonly ChatMessage[];
  readonly temperature: number;
  readonly seed?: number;
  readonly maxTokens: number;
  /** Дельта стрима (движок считает токены для телеметрии §18). */
  readonly onToken: (delta: string) => void;
  /** Сигнал отмены (§13: cancel → abort, сессия завершается 'cancelled'). */
  readonly signal: AbortSignal;
}

/**
 * Сессия загруженной модели: генерация со стримом + освобождение памяти (§9:
 * unload возвращает RAM — dispose модели/контекста в адаптере llama-engine.ts).
 */
export interface LlamaModelSession {
  generate(request: LlamaGenerateRequest): Promise<LlmFinishReason>;
  dispose(): Promise<void>;
}

/** Порт нативной границы (§5 «loadModel(path) → context/session»). */
export interface LlamaBackend {
  loadModel(
    modelPath: string,
    config: { readonly contextSize: number },
  ): Promise<LlamaModelSession>;
}

/** Опции управляемого движка (§5; всё переопределяемо — тесты §19). */
export interface ManagedLlamaEngineOptions {
  readonly logger?: LlmEngineLogger;
  /** Окно idle-unload, мс; по умолчанию IDLE_UNLOAD_MS (§20 env — resolveIdleUnloadMs). */
  readonly idleUnloadMs?: number;
  /** Контекст генерации, токены (§4: 4096). */
  readonly contextSize?: number;
  /** Порт времени для телеметрии генерации (§18; по умолчанию Date.now). */
  readonly now?: () => number;
}

/** Молчун-логгер (дефолт; боевой внедряет llama-engine.ts). */
const SILENT_LOGGER: LlmEngineLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Валидация файла модели ДО передачи нативу (§13): существует И файл — иначе
 * AI/MODEL_FILE_MISSING; первые 4 байта — magic «GGUF» — иначе AI/MODEL_INVALID
 * (битый GGUF не доходит до нативной загрузки — воркер не крашится).
 */
export function validateModelFile(modelPath: string): void {
  let isFile = false;
  try {
    isFile = statSync(modelPath).isFile();
  } catch {
    isFile = false;
  }
  if (!existsSync(modelPath) || !isFile) {
    throw new EngineError(LLM_ENGINE_ERROR.MODEL_FILE_MISSING);
  }
  const fd = openSync(modelPath, 'r');
  try {
    const header = Buffer.alloc(GGUF_MAGIC.length);
    const read = readSync(fd, header, 0, header.length, 0);
    if (read < header.length || !header.equals(GGUF_MAGIC)) {
      throw new EngineError(LLM_ENGINE_ERROR.MODEL_INVALID);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Разрешение параметров генерации (§7): дефолты конфига там, где протокол не
 * передал значения; seed — только когда передан (повторяемость eval, TASK-091).
 */
export function resolveGenerationOptions(
  params: GenerationParams | undefined,
  maxTokens: number | undefined,
): { temperature: number; seed?: number; maxTokens: number } {
  const resolved: { temperature: number; seed?: number; maxTokens: number } = {
    temperature: params?.temperature ?? GENERATION_DEFAULTS.temperature,
    maxTokens: maxTokens ?? GENERATION_DEFAULTS.maxTokens,
  };
  if (params?.seed !== undefined) {
    resolved.seed = params.seed;
  }
  return resolved;
}

/**
 * Окно idle-unload из env (§20 «сокращённое время через env»): целое число мс
 * > 0 — значение; отсутствует/мусор/не-позитив — дефолт 5 минут (fail-safe).
 */
export function resolveIdleUnloadMs(raw: string | undefined): number {
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value > 0) {
      return value;
    }
  }
  return IDLE_UNLOAD_MS;
}

/**
 * Управляемый движок (§5): жизненный цикл модели + idle-unload + отмена +
 * телеметрия генерации над портом нативной границы. Внедряется в цикл
 * протокола 076 (startLlmWorkerLoop) — llama-engine.ts/main.ts.
 */
export function createManagedLlamaEngine(
  backend: LlamaBackend,
  options: ManagedLlamaEngineOptions = {},
): LlmWorkerEngine {
  const logger = options.logger ?? SILENT_LOGGER;
  const now = options.now ?? Date.now;
  const idleUnloadMs = options.idleUnloadMs ?? IDLE_UNLOAD_MS;
  const contextSize = options.contextSize ?? GENERATION_DEFAULTS.contextSize;

  /** Активная сессия (undefined = no-model, §12). */
  let session: LlamaModelSession | undefined;
  /** Активная генерация: запрос и его сигнал отмены (одновременно одна, §5). */
  let currentRequestId: string | undefined;
  let controller: AbortController | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  /** Освобождение сессии без отказа операции (§9: память вернётся; сбой — warn). */
  const disposeQuietly = async (stale: LlamaModelSession): Promise<void> => {
    try {
      await stale.dispose();
    } catch (cause) {
      logger.warn('llm engine: dispose сессии не удался', { cause });
    }
  };

  /** Окно простоя: перезапускается load'ом и КАЖДОЙ генерацией (§5). */
  const armIdleTimer = (): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (session === undefined || controller !== undefined) {
        return; // выгружать нечего или идёт генерация
      }
      const stale = session;
      session = undefined;
      logger.info('llm engine: авто-выгрузка модели по простою', { reason: 'idle', idleUnloadMs });
      void disposeQuietly(stale);
    }, idleUnloadMs);
  };

  const load = async (modelPath: string): Promise<void> => {
    // §13: валидация ДО натива — файл-миссинг/битый magic не доходят до бэкенда.
    validateModelFile(modelPath);
    if (session !== undefined) {
      // §5: двойной load — перезагрузка модели.
      const stale = session;
      session = undefined;
      await disposeQuietly(stale);
    }
    try {
      session = await backend.loadModel(modelPath, { contextSize });
    } catch (cause) {
      session = undefined;
      logger.error('llm engine: отказ загрузки модели', { model: basename(modelPath), cause });
      throw new EngineError(LLM_ENGINE_ERROR.MODEL_INVALID, { cause });
    }
    logger.info('llm engine: модель загружена', { model: basename(modelPath), idleUnloadMs });
    armIdleTimer();
  };

  const unload = async (): Promise<void> => {
    clearIdleTimer();
    const stale = session;
    session = undefined;
    if (stale !== undefined) {
      await disposeQuietly(stale);
      logger.info('llm engine: модель выгружена', { reason: 'manual' });
    }
  };

  const complete = async (
    request: WorkerCompleteParams,
    emit: (delta: string) => void,
  ): Promise<LlmFinishReason> => {
    const activeSession = session;
    if (activeSession === undefined) {
      throw new EngineError(LLM_ENGINE_ERROR.NO_MODEL);
    }
    clearIdleTimer(); // на время генерации окно простоя не тикает
    const abort = new AbortController();
    controller = abort;
    currentRequestId = request.requestId;
    const generationOptions = resolveGenerationOptions(request.params, request.maxTokens);
    const start = now();
    let firstTokenAt: number | undefined;
    let tokens = 0;
    try {
      const finishReason = await activeSession.generate({
        messages: request.messages,
        temperature: generationOptions.temperature,
        seed: generationOptions.seed,
        maxTokens: generationOptions.maxTokens,
        onToken: (delta) => {
          emit(delta);
          if (firstTokenAt === undefined) {
            firstTokenAt = now();
          }
          tokens += 1;
        },
        signal: abort.signal,
      });
      const elapsedMs = Math.max(1, now() - start);
      // §18: tokens=N tps=… firstTokenMs=… — без текста (§14).
      logger.info('llm engine: генерация завершена', {
        requestId: request.requestId,
        tokens,
        tps: Math.round((tokens / (elapsedMs / 1000)) * 100) / 100,
        firstTokenMs: firstTokenAt === undefined ? 0 : firstTokenAt - start,
      });
      return finishReason;
    } finally {
      controller = undefined;
      currentRequestId = undefined;
      armIdleTimer(); // модель загружена — окно простоя заново (и после отказа)
    }
  };

  const cancel = (requestId: string): void => {
    // Идемпотентность §13: незнакомый/повторный requestId — тихий no-op.
    if (currentRequestId === requestId && controller !== undefined) {
      controller.abort();
    }
  };

  return { load, unload, complete, cancel };
}
