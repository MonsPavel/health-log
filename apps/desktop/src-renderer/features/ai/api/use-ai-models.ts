/**
 * TASK-081 §10/§11/§12: api-слой витрины моделей — useQuery ['ai','models'] поверх
 * канала `ai/models/list` + мутации download/pause/resume/reset/select (§5/§11).
 *
 * СОБЫТИЕ ai:progress (§12): обновление карточки БЕЗ рефетча — setQueryData точечно
 * меняет state/bytesLoaded модели из payload (ход загрузки — throttle 250 мс на
 * main, §15 080); авторитетное перечитывание — инвалидация по завершении мутаций.
 *
 * IpcApiError — свой класс (прецедент use-preferences §15: изоляция чанков фич —
 * ai не тянет settings). Ошибки use case (AI/DISK_FULL и др.) попадают в мутации —
 * карточка остаётся в состоянии из list, текст ошибки придёт со следующим list
 * (error-состояние store), тост не нужен (§18: логи ModelStore; UI ничего не шлёт).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ApiResult, AppErrorDto, AiModelsListResponse, ModelStatusInfo } from '@hl/contracts';

import { call } from '../../../src/lib/ipc';
import { useHlEvent } from '../../../lib/events';
import { PREFS_QUERY_KEY } from '../../settings/model/use-preferences';

/** Ключ запроса витрины (§12); инвалидация — завершение мутаций. */
export const AI_MODELS_QUERY_KEY = ['ai', 'models'] as const;

/** Ошибка IPC-канала с dto (ok:false конверт) — данные, не технический краш. */
export class AiModelsIpcError extends Error {
  /** DTO ошибки из конверта (code/messageKey/params — TASK-008 §7). */
  readonly dto: AppErrorDto;

  constructor(dto: AppErrorDto) {
    super(`IPC: ${dto.code} (${dto.messageKey})`);
    this.name = 'AiModelsIpcError';
    this.dto = dto;
  }
}

/** Чтение витрины (§7): одним вызовом всё для экрана. */
async function loadAiModels(): Promise<AiModelsListResponse> {
  const result = await call('ai/models/list', {});
  if (!result.ok) {
    throw new AiModelsIpcError(result.error);
  }
  return result.data;
}

/** Вызов канала действия {modelId} (§11); разворот конверта, failure → AiModelsIpcError. */
async function modelAction(
  channel:
    | 'ai/models/download'
    | 'ai/models/pause'
    | 'ai/models/resume'
    | 'ai/models/reset'
    | 'ai/models/select',
  modelId: string,
): Promise<ModelStatusInfo | { modelId: string }> {
  // Формы запросов пяти каналов идентичны ({modelId}, контракты 081): дженерик call
  // не распределяет union — сужаем к одной форме; union ответа восстанавливаем
  // приведением (форма каждого ответа валидна схемой реестра каркаса).
  const result = (await call(channel as 'ai/models/download', { modelId })) as ApiResult<
    ModelStatusInfo | { modelId: string }
  >;
  if (!result.ok) {
    throw new AiModelsIpcError(result.error);
  }
  return result.data;
}

/** API витрины моделей (§10): список + события прогресса + мутации состояний. */
export function useAiModels() {
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: AI_MODELS_QUERY_KEY, queryFn: loadAiModels });

  // §12: ai:progress → точечное обновление карточки (state + bytesLoaded) в кэше —
  // прогресс живой без рефетча (троттлинг обеспечен на main, §15 080).
  useHlEvent('ai:progress', (payload) => {
    queryClient.setQueryData<AiModelsListResponse>(AI_MODELS_QUERY_KEY, (current) => {
      if (current === undefined) {
        return current;
      }
      return {
        ...current,
        models: current.models.map((model) =>
          model.descriptor.id === payload.modelId
            ? { ...model, state: payload.state, bytesLoaded: payload.downloadedBytes }
            : model,
        ),
      };
    });
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: AI_MODELS_QUERY_KEY });
  };

  /**
   * §12: select пишет prefs.aiSettings в main — кэш ['prefs'] рендерера устарел.
   * Инвалидация здесь (а не по prefs:changed): канал select отвечает {modelId},
   * а не документом prefs, как prefs/set (у того кэш обновляет onSuccess).
   */
  const invalidatePrefs = (): void => {
    void queryClient.invalidateQueries({ queryKey: PREFS_QUERY_KEY });
  };

  const download = useMutation({
    mutationFn: (modelId: string) => modelAction('ai/models/download', modelId),
    onSuccess: invalidate,
    onError: invalidate,
  });
  const pause = useMutation({
    mutationFn: (modelId: string) => modelAction('ai/models/pause', modelId),
    onSuccess: invalidate,
  });
  const resume = useMutation({
    mutationFn: (modelId: string) => modelAction('ai/models/resume', modelId),
    onSuccess: invalidate,
    onError: invalidate,
  });
  const reset = useMutation({
    mutationFn: (modelId: string) => modelAction('ai/models/reset', modelId),
    onSuccess: invalidate,
  });
  const select = useMutation({
    mutationFn: (modelId: string) => modelAction('ai/models/select', modelId),
    onSuccess: () => {
      invalidate();
      invalidatePrefs();
    },
  });

  return {
    data: query.data,
    isLoading: query.isPending,
    isError: query.isError,
    download,
    pause,
    resume,
    reset,
    select,
  };
}
