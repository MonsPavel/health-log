/**
 * TASK-090 §10/§11/§12: api-слой чата —
 *  - useChatHistory — `ai/chat/list` (§11 089): инициализация ленты, ключ
 *    ['chat', pid] (§12); limit — верхняя граница канала (лента без
 *    виртуализации, глубина контекста 6+новые — маленькая, §4);
 *  - useChatGeneration — мутация `ai/chat/send` со СТРИМ-подпиской через
 *    useHlEvent (прецедент useSummaryGeneration 088): ответ {requestId},
 *    данные — события ai:token (delta-append в виртуальный assistant-бабл),
 *    финал — событие 'ai/chat/result' ровно один (§11 089). Оптимистичная пара
 *    user+assistant (§12): user-бабл отображается сразу, финал подтверждает —
 *    invalidate + refetch заменяет виртуальную пару сохранённой; при ошибке
 *    канала/отмене (финал без messageId) пара удаляется из ленты;
 *  - useClearChat — `ai/chat/clear` (§5/§13 089): инвалидация ['chat'] →
 *    лента пустеет, empty-state (§13).
 *
 * ПРЕРЫВАНИЕ (прецедент 088 §5): сбой движка/репо отклоняет execute — финал НЕ
 * эмитится; UI узнаёт по ai:status ready/failed СВОЕГО requestId без финала →
 * interrupted=true → блок ошибки с «Повторить» (повторная отправка того же
 * вопроса с тем же периодом). Финал и ready в одном тике: финал побеждает
 * (очищает requestId — ready игнорируется).
 *
 * ГОНКИ (§13): BUSY — отказ канала AI/BUSY (двойная защита с disabled ввода —
 * §10); уход с экрана во время генерации → cancel (cleanup, прецедент 088).
 *
 * ChatIpcError — свой класс (прецедент SummaryIpcError/AiModelsIpcError:
 * изоляция чанков фич); PROFILE_ID — общий источник (прецедент use-summary).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AiChatListResponse, AppErrorDto, StatsPeriodParam } from '@hl/contracts';

import { useHlEvent } from '../../../lib/events';
import { call } from '../../../src/lib/ipc';
import { PROFILE_ID } from '../../measurement/api/use-add-measurement';

/** Корень ключей истории (§12): точка инвалидаций (финал/очистка). */
export const CHAT_KEY_ROOT = ['chat'] as const;

/** Ключ запроса истории (§12: ['chat', pid]). */
export function chatHistoryKey(profileId: string): readonly ['chat', string] {
  return [CHAT_KEY_ROOT[0], profileId];
}

/**
 * Лимит ленты UI (§11 089: max канала list): локальная история чата маленькая
 * (без виртуализации, §4) — читаем максимум одним дешёвым IPC-чтением.
 */
export const CHAT_HISTORY_LIMIT = 200;

/** Ошибка IPC-канала с dto (ok:false конверт) — данные, не технический краш. */
export class ChatIpcError extends Error {
  /** DTO ошибки из конверта (code/messageKey/params — TASK-008 §7). */
  readonly dto: AppErrorDto;

  constructor(dto: AppErrorDto) {
    super(`IPC: ${dto.code} (${dto.messageKey})`);
    this.name = 'ChatIpcError';
    this.dto = dto;
  }
}

/** Разворот конверта list: failure → ChatIpcError (§11). */
async function fetchHistory(profileId: string): Promise<AiChatListResponse> {
  const result = await call('ai/chat/list', { profileId, limit: CHAT_HISTORY_LIMIT });
  if (!result.ok) {
    throw new ChatIpcError(result.error);
  }
  return result.data;
}

/** История чата профиля (§5/§12): инициализация ленты при монтировании экрана. */
export function useChatHistory(profileId: string) {
  return useQuery({
    queryKey: chatHistoryKey(profileId),
    queryFn: () => fetchHistory(profileId),
    staleTime: 0,
  });
}

/** Параметры отправки вопроса (§11): вопрос (валидацию ≥2 ≤500 сделает канал) + период контекста. */
export interface ChatSendParams {
  readonly question: string;
  readonly period: StatsPeriodParam;
}

/** Состояние генерации для экрана (§10/§12): виртуальная пара + стрим + финал. */
export interface ChatGeneration {
  /** 'streaming' — requestId активен (ввод disabled, «Стоп» виден); иначе 'idle'. */
  readonly phase: 'idle' | 'streaming';
  /** Оптимистичный вопрос (user-бабл сразу, §12); undefined — виртуальной пары нет. */
  readonly question: string | undefined;
  /** Накопленный текст виртуального assistant-бабла (delta-append, §10). */
  readonly text: string;
  /** true — ход прерван без финала (сбой) → блок ошибки с «Повторить». */
  readonly interrupted: boolean;
  /** Отправить вопрос; отказ канала (BUSY и пр.) — reject с ChatIpcError (§13). */
  readonly send: (params: ChatSendParams) => Promise<void>;
  /** «Стоп»: ai/cancel по активному requestId (частичный ответ не сохранится). */
  readonly stop: () => void;
  /** Повтор последнего прерванного вопроса (тем же периодом). */
  readonly retry: () => void;
  /** Сброс виртуального состояния + cancel активной (уход с экрана, §13). */
  readonly reset: () => void;
}

/** Генерация хода чата со стрим-подпиской (§10: мутация + useHlEvent). */
export function useChatGeneration(): ChatGeneration {
  const queryClient = useQueryClient();
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [question, setQuestion] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [interrupted, setInterrupted] = useState(false);
  // Зеркала для обработчиков событий: финал и ready в одном тике разрешаются
  // по ref, а не по batch-состоянию (прецедент use-summary).
  const requestIdRef = useRef<string | undefined>(undefined);
  // Последние параметры хода — для «Повторить» после прерывания (§5 088).
  const lastParamsRef = useRef<ChatSendParams | undefined>(undefined);

  /** Сброс виртуальной пары (user-бабл + стрим-бабл) — финал/отмена/прерывание. */
  const clearVirtual = useCallback((): void => {
    setQuestion(undefined);
    setText('');
  }, []);

  // Стрим (§11/§15): токены чужих requestId игнорируем; батчинг ≤20 Гц уже на main.
  useHlEvent('ai:token', (payload) => {
    if (payload.requestId !== requestIdRef.current) {
      return;
    }
    setText((previous) => previous + payload.text);
  });

  // Финал (§11 089, ровно один): с messageId — пара сохранена: invalidate
  // ['chat', pid] и ПОСЛЕ refetch заменить виртуальную пару сохранённой (§12,
  // без вспышки дубля); без messageId (cancel) — пара не сохранена: удалить.
  useHlEvent('ai/chat/result', (payload) => {
    if (payload.requestId !== requestIdRef.current) {
      return;
    }
    requestIdRef.current = undefined;
    setRequestId(undefined);
    setInterrupted(false);
    if (payload.messageId !== undefined) {
      void queryClient
        .invalidateQueries({ queryKey: CHAT_KEY_ROOT })
        .then(() => clearVirtual())
        .catch(() => clearVirtual());
    } else {
      clearVirtual();
    }
  });

  // Прерывание (§5): ready/failed СВОЕГО requestId без финала — execute отклонён
  // (краш воркера/сбой) — финала не будет; виртуальная пара не сохранится.
  useHlEvent('ai:status', (payload) => {
    if (payload.requestId !== requestIdRef.current) {
      return;
    }
    if (payload.state === 'ready' || payload.state === 'failed') {
      requestIdRef.current = undefined;
      setRequestId(undefined);
      setInterrupted(true);
      clearVirtual();
    }
  });

  const send = useCallback(
    async (params: ChatSendParams): Promise<void> => {
      // Оптимистичный user-бабл сразу (§12); при отказе канала — удаляется ниже.
      lastParamsRef.current = params;
      setInterrupted(false);
      setQuestion(params.question);
      setText('');
      let id: string;
      try {
        const result = await call('ai/chat/send', {
          profileId: PROFILE_ID,
          question: params.question,
          period: params.period,
        });
        if (!result.ok) {
          throw new ChatIpcError(result.error);
        }
        id = result.data.requestId;
      } catch (error: unknown) {
        // Отказ канала: оптимистичный user-бабл удаляется из ленты (§12).
        lastParamsRef.current = undefined;
        clearVirtual();
        throw error;
      }
      requestIdRef.current = id;
      setRequestId(id);
    },
    [clearVirtual],
  );

  const stop = useCallback((): void => {
    const id = requestIdRef.current;
    if (id === undefined) {
      return;
    }
    void call('ai/cancel', { requestId: id }).catch(() => undefined);
    // requestId живёт до финала done(cancelled) — «Стоп» остаётся до завершения.
  }, []);

  const retry = useCallback((): void => {
    const params = lastParamsRef.current;
    if (params !== undefined) {
      void send(params).catch(() => undefined);
    }
  }, [send]);

  const reset = useCallback((): void => {
    const id = requestIdRef.current;
    if (id !== undefined) {
      void call('ai/cancel', { requestId: id }).catch(() => undefined);
    }
    requestIdRef.current = undefined;
    lastParamsRef.current = undefined;
    setRequestId(undefined);
    setInterrupted(false);
    clearVirtual();
  }, [clearVirtual]);

  // §13: уход с экрана во время генерации → cancel (abort в main; состояние
  // экрана уже не нужно — прецедент use-summary 088).
  useEffect(() => {
    return () => {
      const id = requestIdRef.current;
      if (id !== undefined) {
        void call('ai/cancel', { requestId: id }).catch(() => undefined);
      }
    };
  }, []);

  return {
    phase: requestId === undefined ? 'idle' : 'streaming',
    question,
    text,
    interrupted,
    send,
    stop,
    retry,
    reset,
  };
}

/** Мутация «Очистить чат» (§5): clear → инвалидация ['chat'] (лента пустеет). */
export function useClearChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<{ cleared: true }> => {
      const result = await call('ai/chat/clear', {});
      if (!result.ok) {
        throw new ChatIpcError(result.error);
      }
      return result.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CHAT_KEY_ROOT });
    },
  });
}
