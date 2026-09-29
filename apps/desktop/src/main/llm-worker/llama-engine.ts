/**
 * TASK-077 §5/§6: адаптер node-llama-cpp — нативная граница движка воркера.
 *
 * ЛЕНИВЫЙ NATIV (§22/§19): node-llama-cpp импортируется ДИНАМИЧЕСКИ внутри
 * loadModel — модуль (и каркас main.ts, и тесты) грузится без натива; .node
 * загружается только при реальной загрузке модели. Типы — статические
 * import type (стираются). Пробная загрузка натива пройдена (node 24,
 * prebuilt win-x64 3.22.1; SAC не блокирует).
 *
 * КОНФИГ (§4/§7): контекст 4096 (движок, engine.ts), threads = физические
 * ядра−1 (resolveThreads: логические/2 округление вверх — честной цифры
 * физических нет в node; НЕ авто-тюнинг, фикс на старте), getLlama
 * {maxThreads: 0} — контекстные потоки всегда фактические; logLevel error —
 * свои логи ведёт движок (§18). Инстанс llama кэшируется на процесс: unload
 * выгружает МОДЕЛЬ/контекст (RAM возвращается, §9), инстанс живёт для
 * быстрой перезагрузки.
 *
 * ГЕНЕРАЦИЯ (§5): LlamaChat.loadChatAndCompleteUserMessage — история chat-
 * сообщений протокола целиком, ответ — стрим onTextChunk → emit; отмена —
 * AbortSignal + stopOnAbortSignal (§13: частичный текст отбрасывается
 * клиентом по done(cancelled)); stopReason 'abort' → finishReason
 * 'cancelled', прочий (eogToken/maxTokens/stopTrigger) → 'stop'.
 *
 * БЕЗОПАСНОСТЬ (§14): путь модели приходит из протокола (main валидирует
 * существование, движок — GGUF-magic до передачи сюда, §13); сети нет
 * (depcruise-зона воркера); getLlama без скачивания в рантайме — prebuilt
 * ставится пакетом (postinstall), CI моделей не грузит.
 *
 * ЛОГ (§18): stdout-адаптер JSON-строками (pino-корень в воркере не
 * инициализирован; stdio UtilityProcess наследует stdout main-процесса).
 */
import { cpus } from 'node:os';

import type { ChatMessage, LlmFinishReason } from '@hl/contracts';

import {
  createManagedLlamaEngine,
  resolveIdleUnloadMs,
  type LlamaBackend,
  type LlamaModelSession,
  type LlmEngineLogger,
} from './engine.js';
import type { LlmWorkerEngine } from './protocol.js';

/** env-переменная окна idle-unload (§20: сокращённое время для ручного прогона). */
export const IDLE_UNLOAD_ENV = 'HL_LLM_IDLE_UNLOAD_MS';

/** Модуль node-llama-cpp (типы; сам модуль — только динамический import). */
type NodeLlamaCppModule = typeof import('node-llama-cpp');

/** Инстанс llama (нативная библиотека на процесс воркера). */
type LlamaInstance = Awaited<ReturnType<NodeLlamaCppModule['getLlama']>>;

/** Опции адаптера (§5; всё переопределяемо — тесты §19). */
export interface LlamaEngineOptions {
  /** Логгер движка; по умолчанию — stdout-адаптер (§18). */
  readonly logger?: LlmEngineLogger;
  /** Окно idle-unload, мс; по умолчанию — env HL_LLM_IDLE_UNLOAD_MS, иначе 5 мин. */
  readonly idleUnloadMs?: number;
  /** Контекст генерации, токены (§4: 4096 — дефолт движка). */
  readonly contextSize?: number;
  /** Потоки инференса; по умолчанию resolveThreads(cpus().length) (§4). */
  readonly threads?: number;
}

/** Кэш нативного инстанса на процесс воркера (§15: перезагрузка модели без реинициализации). */
let llamaPromise: Promise<LlamaInstance> | undefined;

function getLlamaOnce(nlc: NodeLlamaCppModule): Promise<LlamaInstance> {
  llamaPromise ??= nlc.getLlama({
    // §4: threads — конфиг на контексте, не авто-тюнинг: maxThreads 0 отключает
    // лимит инстанса, чтобы контекстные потоки были всегда фактическими.
    maxThreads: 0,
    // §18: llama.cpp-логи глушим (свои — уровневые, без текста генерации).
    logLevel: nlc.LlamaLogLevel.error,
  });
  return llamaPromise;
}

/**
 * Потоки инференса (§4): «физические ядра−1». Числа физических ядер в node нет —
 * оценка логические/2 (округление вверх), SMT-машины; минимум 1 (защитный).
 */
export function resolveThreads(logicalCores: number): number {
  const physical = Math.max(1, Math.ceil(logicalCores / 2));
  return Math.max(1, physical - 1);
}

/**
 * Окно idle-unload из окружения процесса (§20): только env-слой — чистая
 * функция парсинга в engine.ts (resolveIdleUnloadMs, fail-safe на дефолт).
 */
export function resolveDefaultIdleUnloadMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolveIdleUnloadMs(env[IDLE_UNLOAD_ENV]);
}

/**
 * История протокола → история node-llama-cpp (§7 TASK-078: стандартный chat-
 * формат совместим). loadChatAndCompleteUserMessage завершает ПОСЛЕДНЕЕ user-
 * сообщение — если история им не кончается (защитная ветка), добавляется
 * пустое user-сообщение.
 */
function toChatHistory(messages: readonly ChatMessage[]): import('node-llama-cpp').ChatHistoryItem[] {
  const history = messages.map((message): import('node-llama-cpp').ChatHistoryItem => {
    switch (message.role) {
      case 'system':
        return { type: 'system', text: message.content };
      case 'assistant':
        return { type: 'model', response: [message.content] };
      case 'user':
        return { type: 'user', text: message.content };
    }
  });
  const last = history.at(-1);
  if (last === undefined || last.type !== 'user') {
    history.push({ type: 'user', text: '' });
  }
  return history;
}

/** Создаёт сессию модели над нативными объектами (generate + dispose, §9). */
function createSession(
  nlc: NodeLlamaCppModule,
  llama: LlamaInstance,
  modelPath: string,
  config: { readonly contextSize: number; readonly threads: number },
): Promise<LlamaModelSession> {
  return (async () => {
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext({
      contextSize: config.contextSize,
      threads: config.threads,
      sequences: 1, // §23: параллельные сессии не планируются
    });
    const chat = new nlc.LlamaChat({
      contextSequence: context.getSequence(),
      autoDisposeSequence: true,
    });
    return {
      async generate(request: {
        readonly messages: readonly ChatMessage[];
        readonly temperature: number;
        readonly seed?: number;
        readonly maxTokens: number;
        readonly onToken: (delta: string) => void;
        readonly signal: AbortSignal;
      }): Promise<LlmFinishReason> {
        try {
          const response = await chat.loadChatAndCompleteUserMessage(
            toChatHistory(request.messages),
            {
              temperature: request.temperature,
              maxTokens: request.maxTokens,
              ...(request.seed !== undefined ? { seed: request.seed } : {}),
              onTextChunk: (chunk: string) => {
                request.onToken(chunk);
              },
              signal: request.signal,
              // §13: отмена завершает генерацию ответом (частичный текст
              // отбрасывается клиентом по done(cancelled)), а не исключением.
              stopOnAbortSignal: true,
            },
          );
          return response.metadata.stopReason === 'abort' ? 'cancelled' : 'stop';
        } catch (cause) {
          if (request.signal.aborted) {
            return 'cancelled'; // abort до старта оценки — натив бросает: это отмена
          }
          throw cause;
        }
      },
      async dispose(): Promise<void> {
        // §9: освобождение памяти — чат/контекст/модель; инстанс llama живёт.
        chat.dispose();
        context.dispose();
        await model.dispose();
      },
    };
  })();
}

/**
 * Боевой LlamaBackend над node-llama-cpp (§5 «loadModel(path) → context/session»).
 * Нативный import — при ПЕРВОЙ загрузке модели (см. шапку).
 */
export function createNodeLlamaBackend(options: LlamaEngineOptions = {}): LlamaBackend {
  return {
    loadModel: async (modelPath, config) => {
      const nlc = (await import('node-llama-cpp')) as NodeLlamaCppModule;
      const llama = await getLlamaOnce(nlc);
      const threads = options.threads ?? resolveThreads(cpus().length);
      return createSession(nlc, llama, modelPath, {
        contextSize: config.contextSize,
        threads,
      });
    },
  };
}

/**
 * Дефолтный движок воркера (§6 «подключение движка за протоколом»):
 * управляемая обвязка (engine.ts) над боевым адаптером; окно idle-unload —
 * env HL_LLM_IDLE_UNLOAD_MS с дефолтом 5 минут (§5/§20).
 */
export function createDefaultLlmEngine(options: LlamaEngineOptions = {}): LlmWorkerEngine {
  return createManagedLlamaEngine(createNodeLlamaBackend(options), {
    logger: options.logger ?? createStdoutLogger(),
    idleUnloadMs: options.idleUnloadMs ?? resolveDefaultIdleUnloadMs(),
    ...(options.contextSize !== undefined ? { contextSize: options.contextSize } : {}),
  });
}

/** Метаданные без потери диагностики: Error → {name, message} (§18 без стека воркера). */
function serializeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
  }
  return out;
}

/** Stdout-логгер воркера (§18): JSON-строки; stdio UtilityProcess → stdout main. */
function createStdoutLogger(): LlmEngineLogger {
  const write =
    (level: string) =>
    (message: string, meta: Record<string, unknown> = {}): void => {
      try {
        process.stdout.write(
          `${JSON.stringify({ level, category: 'ai', message, ...serializeMeta(meta) })}\n`,
        );
      } catch {
        // stdout закрыт — лог не рвёт работу движка
      }
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}
