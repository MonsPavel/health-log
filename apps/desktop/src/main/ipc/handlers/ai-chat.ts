/**
 * Хендлеры каналов чата (TASK-089 §5/§11/§12) — слой тонкий, прецедент
 * ai-summary.ts: zod-валидацию делает каркас TASK-008 до вызова.
 *
 * `ai/chat/send` (§5/§11): arch. 05 §3 «стриминг — генерации не держат открытый
 * вызов IPC»: хендлер проверяет слот use case (BUSY → AppError наружу = ApiFailure,
 * §9), генерирует requestId (ключ корреляции ai:token/финала), стартует execute
 * В ФОНЕ (отказ — лог с кодом, без текста: вопрос/ответ PHI, §14; UI живёт по
 * событиям ai:status) и мгновенно отвечает {requestId}. Реестр контроллеров
 * ОЩИЙ с резюме (AiSummaryRequestRegistry + ai/cancel — §5 087 «чат 089 — тот же»)
 * и освобождается на ЛЮБОМ исходе фона (finally — ревью TASK-087).
 *
 * `ai/chat/clear` (§5/§13): делегирование ClearChat (идемпотентность — забота
 * use case); подтверждение — забота UI (диалог 090).
 *
 * `ai/chat/list` (§11/§12): чтение последних limit сообщений профиля для
 * инициализации UI (ключ ['chat', pid]; форма — ChatMessageDto контракта:
 * refusalClass присутствует ТОЛЬКО у refusal-ответов, §7).
 *
 * PHI (§14): requestId/messageId — идентификаторы (события/лог), текст вопроса и
 * ответа в лог не пишется; content сообщений — только владельцу в ответе канала.
 */
import { performance } from 'node:perf_hooks';

import type {
  AiChatClearRequest,
  AiChatClearResponse,
  AiChatListRequest,
  AiChatListResponse,
  AiChatSendRequest,
  AiChatSendResponse,
  ChatMessageDto,
} from '@hl/contracts';
import { AppError } from '@hl/kernel';

import type { AskChat, AskChatCommand } from '../../modules/ai-insight/application/ask-chat.js';
import type { ClearChat } from '../../modules/ai-insight/application/clear-chat.js';
import { llmEngineBusyError } from '../../modules/ai-insight/application/ports/llm-engine.js';
import type {
  ChatMessageRecord,
  ChatRepository,
} from '../../modules/ai-insight/application/ports/chat-repository.js';
import { AiSummaryRequestRegistry } from './ai-summary.js';

export { AiSummaryRequestRegistry };

/** Минимальная поверхность логгера хендлеров (§18; HlLogger ей удовлетворяет). */
export interface AiChatHandlerLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Счётчик requestId хендлера (модульный — уникален в пределах процесса main). */
let globalChatRequestIdCounter = 0;

/**
 * Генератор requestId (§11): префикс домена + счётчик — читаем в логе, без
 * крипто-нужды; префикс ОТДЕЛЕН от резюме ('ai-summary-'), чтобы id обоих доменов
 * в общем реестре ai/cancel не пересекались.
 */
export function createChatRequestId(): string {
  globalChatRequestIdCounter += 1;
  return `ai-chat-${String(globalChatRequestIdCounter)}`;
}

/** Фабрика хендлера `ai/chat/send` (§5/§11): быстрый {requestId}, ход — в фоне. */
export function createAiChatSendHandler(
  askChat: AskChat,
  registry: AiSummaryRequestRegistry,
  logger?: AiChatHandlerLogger,
  requestIdGenerator: () => string = createChatRequestId,
): (payload: AiChatSendRequest) => Promise<AiChatSendResponse> {
  return (payload) => {
    // §9 BUSY: синхронная проверка слота ДО ответа — второй send получает честный
    // ApiFailure AI/BUSY (UI показывает «генерация уже идёт»).
    if (askChat.isBusy()) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- контракт ошибок канала — AppError (TASK-006; каркас конвертирует в ApiFailure)
      throw llmEngineBusyError();
    }
    const requestId = requestIdGenerator();
    const startedAtMs = performance.now();
    const controller = registry.register(requestId);
    const command: AskChatCommand = {
      profileId: payload.profileId,
      question: payload.question,
      period: payload.period,
      requestId,
      signal: controller.signal,
    };
    // Фоновый запуск (arch. 05 §3): отказ не роняет main и не теряется — лог с
    // кодом (AppError.code — не PHI); события стрима/финала — забота use case (§11).
    // РЕЛИЗ реестра — на ЛЮБОМ исходе фона (ревью TASK-087: успех — тоже финализация).
    void askChat
      .execute(command)
      .catch((error: unknown) => {
        const code = error instanceof AppError ? error.code : 'APP/INTERNAL';
        logger?.warn('ai/chat/send failed', {
          requestId,
          code,
          durationMs: Math.round(performance.now() - startedAtMs),
        });
      })
      .finally(() => {
        registry.release(requestId);
      });
    return Promise.resolve({ requestId });
  };
}

/** Фабрика хендлера `ai/chat/clear` (§5/§13): делегирование use case ClearChat. */
export function createAiChatClearHandler(
  clearChat: ClearChat,
): (payload: AiChatClearRequest) => Promise<AiChatClearResponse> {
  return async () => {
    await clearChat.execute();
    return { cleared: true };
  };
}

/** Запись порта → проводной DTO (§7/§12): refusalClass — ТОЛЬКО у refusal-ответов. */
function toDto(record: ChatMessageRecord): ChatMessageDto {
  return {
    id: record.id,
    role: record.role,
    content: record.content,
    ...(record.refusalClass === undefined ? {} : { refusalClass: record.refusalClass }),
    createdAtUtc: record.createdAtUtc,
  };
}

/** Фабрика хендлера `ai/chat/list` (§11/§12): последние limit сообщений профиля. */
export function createAiChatListHandler(
  repo: ChatRepository,
): (payload: AiChatListRequest) => Promise<AiChatListResponse> {
  return async ({ profileId, limit }) => {
    const records = await repo.listRecent(profileId, limit);
    return { messages: records.map(toDto) };
  };
}
