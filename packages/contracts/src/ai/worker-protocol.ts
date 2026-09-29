/**
 * TASK-076 §5/§6: контракт MessagePort-протокола llm-worker (UtilityProcess) —
 * единый источник форм сообщений для main-клиента (LlmProcessClient, TASK-076)
 * и воркера (llm-worker/main.ts + движок TASK-077).
 *
 * Направления:
 *   main → worker: {type:'load', modelPath} | {type:'unload'} |
 *                  {type:'complete', requestId, messages, params, maxTokens} |
 *                  {type:'cancel', requestId};
 *   worker → main: {type:'ready'|'unloaded'} | {type:'token', requestId, delta} |
 *                  {type:'done', requestId, finishReason} |
 *                  {type:'error', requestId|global, code}.
 *
 * Семантика (фиксация решений §5, потребители — клиент 076 и use case'ы 087+):
 *  - 'ready' воркер шлёт ДВАЖДЫ: сразу после открытия порта (процесс поднят,
 *    handshake-критерий клиента) и как подтверждение load (модель загружена);
 *  - генераций одновременно ОДНА (§5 «не включено»: очередь — не в MVP): второй
 *    complete → error {code:'BUSY'};
 *  - cancel идемпотентен (§13): незнакомый requestId воркер молча игнорирует;
 *    отмена потока завершается done(cancelled);
 *  - ошибки кодом-строкой: известные 'BUSY' и 'ENGINE_NOT_CONFIGURED' (заглушка
 *    движка до TASK-077); движок 077 вправе добавлять свои — клиент маппит
 *    известные в AppError AI/*, неизвестные — APP/INTERNAL с code в params.
 *
 * Провайдер транспорта — Electron MessagePortMain (main) / переданный порт
 * (воркер); структуры здесь транспортно-нейтральны. Guard'ы — защита в глубине
 * от повреждённого канала (§14; прецедент workerpool/protocol.ts TASK-066).
 */

/** Роль chat-сообщения (стандартный LLM-формат, §7 TASK-076/078). */
export type ChatRole = 'system' | 'user' | 'assistant';

/** Chat-сообщение запроса генерации. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/**
 * Параметры генерации (§5 «params»); минимум, движок 077 расширит осознанно.
 * TASK-077 §7/§11: seed — опциональный параметр протокола (фиксация для
 * повторяемости eval, TASK-091); дефолт temperature — движок (0.3, §7 077).
 */
export interface GenerationParams {
  readonly temperature?: number;
  /** Фиксация случайности сэмплинга (повторяемость eval); не передан — эпоха. */
  readonly seed?: number;
}

/** Причина завершения генерации (§7: done|cancelled — ошибка идёт отдельным error). */
export type LlmFinishReason = 'stop' | 'cancelled';

/** main → worker: загрузить модель (§14: путь валидируется main-стороной ДО отправки). */
export interface WorkerLoadRequest {
  readonly type: 'load';
  readonly modelPath: string;
}

/** main → worker: выгрузить модель (отклоняется при активной генерации — BUSY). */
export interface WorkerUnloadRequest {
  readonly type: 'unload';
}

/** main → worker: начать генерацию (одновременно одна — иначе error BUSY). */
export interface WorkerCompleteRequest {
  readonly type: 'complete';
  readonly requestId: string;
  readonly messages: readonly ChatMessage[];
  readonly params?: GenerationParams;
  readonly maxTokens: number;
}

/** main → worker: отменить генерацию (идемпотентен — незнакомый requestId игнор). */
export interface WorkerCancelRequest {
  readonly type: 'cancel';
  readonly requestId: string;
}

/** Сообщения main → worker. */
export type WorkerRequest =
  WorkerLoadRequest | WorkerUnloadRequest | WorkerCompleteRequest | WorkerCancelRequest;

/**
 * Код ошибки в ответе worker → main. Строка (движок 077 расширит): известные
 * каркасу — 'BUSY' (вторая генерация / unload-load при активной) и
 * 'ENGINE_NOT_CONFIGURED' (заглушка до TASK-077).
 */
export type WorkerErrorCode = string;

/** worker → main: процесс поднят и/или модель загружена (см. семантику в шапке). */
export interface WorkerReadyResponse {
  readonly type: 'ready';
}

/** worker → main: модель выгружена (подтверждение unload). */
export interface WorkerUnloadedResponse {
  readonly type: 'unloaded';
}

/** worker → main: очередной токен генерации (клиент батчит — flush 50 мс, §11). */
export interface WorkerTokenResponse {
  readonly type: 'token';
  readonly requestId: string;
  readonly delta: string;
}

/** worker → main: генерация завершена (успех или отмена; ошибки — отдельным error). */
export interface WorkerDoneResponse {
  readonly type: 'done';
  readonly requestId: string;
  readonly finishReason: LlmFinishReason;
}

/**
 * worker → main: ошибка. Адресная — с requestId (отклоняется конкретная
 * генерация), глобальная — без (load/unload/состояние движка).
 */
export interface WorkerErrorResponse {
  readonly type: 'error';
  readonly requestId?: string;
  readonly code: WorkerErrorCode;
}

/** Сообщения worker → main. */
export type WorkerResponse =
  | WorkerReadyResponse
  | WorkerUnloadedResponse
  | WorkerTokenResponse
  | WorkerDoneResponse
  | WorkerErrorResponse;

/** Известные каркасу коды ошибок воркера (маппинг клиента 076 в AppError AI/*). */
export const KNOWN_WORKER_ERROR_CODES = ['BUSY', 'ENGINE_NOT_CONFIGURED'] as const;

const CHAT_ROLES: ReadonlySet<string> = new Set<ChatRole>(['system', 'user', 'assistant']);

/** Сужение unknown → record без any (§5: any запрещён; прецедент workerpool guard). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isChatMessage(value: unknown): value is ChatMessage {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record['role'] === 'string' &&
    CHAT_ROLES.has(record['role']) &&
    typeof record['content'] === 'string'
  );
}

/**
 * Runtime-guard запросов main → worker (§14): воркер обязан проверять форму
 * перед исполнением — повреждённый/чужой канал не управляет процессом.
 * Посторонние поля отклоняются (строгая форма — контракт обеих сторон одной сборки).
 */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
  const record = asRecord(value);
  if (record === undefined) {
    return false;
  }
  const keys = Object.keys(record);
  switch (record['type']) {
    case 'load':
      return keys.length === 2 && isNonEmptyString(record['modelPath']);
    case 'unload':
      return keys.length === 1;
    case 'complete': {
      if (!isNonEmptyString(record['requestId']) || keys.length < 4 || keys.length > 5) {
        return false;
      }
      const params = record['params'];
      const paramsOk =
        params === undefined ||
        (asRecord(params) !== undefined &&
          (asRecord(params)?.['temperature'] === undefined ||
            typeof asRecord(params)?.['temperature'] === 'number'));
      const maxTokens = record['maxTokens'];
      return (
        Array.isArray(record['messages']) &&
        record['messages'].every(isChatMessage) &&
        typeof maxTokens === 'number' &&
        Number.isInteger(maxTokens) &&
        maxTokens > 0 &&
        paramsOk
      );
    }
    case 'cancel':
      return keys.length === 2 && isNonEmptyString(record['requestId']);
    default:
      return false;
  }
}

/**
 * Runtime-guard ответов worker → main (§14): main обязан проверять форму перед
 * диспетчеризацией — защита от повреждённого канала (§14, прецедент TASK-066).
 */
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  const record = asRecord(value);
  if (record === undefined) {
    return false;
  }
  const keys = Object.keys(record);
  switch (record['type']) {
    case 'ready':
      return keys.length === 1;
    case 'unloaded':
      return keys.length === 1;
    case 'token':
      return (
        keys.length === 3 &&
        isNonEmptyString(record['requestId']) &&
        typeof record['delta'] === 'string'
      );
    case 'done':
      return (
        keys.length === 3 &&
        isNonEmptyString(record['requestId']) &&
        (record['finishReason'] === 'stop' || record['finishReason'] === 'cancelled')
      );
    case 'error': {
      if (!isNonEmptyString(record['code']) || keys.length < 2 || keys.length > 3) {
        return false;
      }
      return record['requestId'] === undefined || isNonEmptyString(record['requestId']);
    }
    default:
      return false;
  }
}
