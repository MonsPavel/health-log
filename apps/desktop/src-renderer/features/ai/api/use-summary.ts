/**
 * TASK-088 §5/§11/§12/§13: api-слой резюме периода —
 *  - useContextPreview — превью контекста `ai/context/preview` (083): точный текст,
 *    который уйдёт в модель; ключ включает includeNotes — тумблер мгновенно
 *    перечитывает проекцию (AC-5.5);
 *  - useLatestSummary — `ai/summary/latest` (087): сохранённый разбор периода +
 *    готовый stale-флаг (§12: бейдж рендерер получает готовым);
 *  - useSummaryGeneration — мутация `ai/summary/generate` со СТРИМ-подпиской через
 *    useHlEvent (§5): генерация не держит открытый вызов IPC (арх. 05 §3) —
 *    ответ {requestId}, данные — события ai:token (delta-append), финал —
 *    'ai/summary/result' ровно один (087);
 *  - useDeleteSummaries — `ai/summary/delete-all` («Очистить разборы», §5).
 *
 * КЭШ (§12): ['summary-latest', profileId, period]; инвалидация — финал генерации,
 * события measurement:changed / data:versionBumped (обновить stale-бейдж — refetch
 * latest) и onSuccess delete-all. STALETIME 0 у latest/preview — чтения дешёвые
 * (IPC ≈2 мс, прецедент use-stats), экран обязан показывать актуальное.
 *
 * ПРЕРЫВАНИЕ (§5 «WORKER_CRASHED с повтором»): сбой стрима/движка отклоняет execute
 * — финал НЕ эмитится (087); UI узнаёт по ai:status ready/failed СВОЕГО requestId
 * без финала (076: клиент шлёт ready при отказе генерации) → interrupted=true →
 * «Повторить». Финал и прерывание в одном тике: финал побеждает (он очищает
 * interrupted — порядок ready→final после успешного done не ломает состояние).
 *
 * ГОНКИ (§13): смена периода/уход с экрана во время генерации → cancel (abort в
 * main — частичный ответ не сохраняется); BUSY — отказ канала AI/BUSY, текст —
 * по dto вызывающего (тост).
 *
 * SummaryIpcError — свой класс (прецедент AiModelsIpcError: изоляция чанков фич —
 * ai не тянет measurement-модуль ради IpcApiError); PROFILE_ID — общий источник
 * (прецедент use-stats: reuse строки seed-профиля, копий не создавать).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AiContextPreviewResponse,
  AiSummaryLatestResponse,
  AppErrorDto,
  StatsPeriodParam,
} from '@hl/contracts';

import { useHlEvent } from '../../../lib/events';
import { call } from '../../../src/lib/ipc';
import { PROFILE_ID } from '../../measurement/api/use-add-measurement';

/** Корень ключей latest (§12): точка инвалидаций (финал/события/удаление). */
export const SUMMARY_LATEST_KEY_ROOT = ['summary-latest'] as const;

/** Ключ запроса latest (§12): профиль + период канала (пресет или custom-границы). */
export function summaryLatestKey(
  profileId: string,
  period: StatsPeriodParam,
): readonly ['summary-latest', string, StatsPeriodParam] {
  return [SUMMARY_LATEST_KEY_ROOT[0], profileId, period];
}

/** Ошибка IPC-канала с dto (ok:false конверт) — данные, не технический краш. */
export class SummaryIpcError extends Error {
  /** DTO ошибки из конверта (code/messageKey/params — TASK-008 §7). */
  readonly dto: AppErrorDto;

  constructor(dto: AppErrorDto) {
    super(`IPC: ${dto.code} (${dto.messageKey})`);
    this.name = 'SummaryIpcError';
    this.dto = dto;
  }
}

/** Разворот конверта preview: failure → SummaryIpcError (§11). */
async function fetchPreview(
  profileId: string,
  period: StatsPeriodParam,
  includeNotes: boolean,
): Promise<AiContextPreviewResponse> {
  const result = await call('ai/context/preview', { profileId, period, includeNotes });
  if (!result.ok) {
    throw new SummaryIpcError(result.error);
  }
  return result.data;
}

/** Разворот конверта latest: failure → SummaryIpcError (§12). */
async function fetchLatest(
  profileId: string,
  period: StatsPeriodParam,
): Promise<AiSummaryLatestResponse> {
  const result = await call('ai/summary/latest', { profileId, period });
  if (!result.ok) {
    throw new SummaryIpcError(result.error);
  }
  return result.data;
}

/** Превью контекста (§5/AC-5.5): точный текст проекции периода с текущими опциями. */
export function useContextPreview(
  profileId: string,
  period: StatsPeriodParam,
  includeNotes: boolean,
) {
  return useQuery({
    queryKey: ['ai-context-preview', profileId, period, includeNotes],
    queryFn: () => fetchPreview(profileId, period, includeNotes),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}

/** Сохранённый разбор периода + stale-флаг (§12); события данных — refetch (бейдж). */
export function useLatestSummary(profileId: string, period: StatsPeriodParam) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: summaryLatestKey(profileId, period),
    queryFn: () => fetchLatest(profileId, period),
    staleTime: 0,
  });

  // §12: данные изменились — refetch latest (stale-бейдж обновится; частичный ключ
  // матчит все периоды — прецедент ['stats'] дашборда).
  useHlEvent('measurement:changed', () => {
    void queryClient.invalidateQueries({ queryKey: SUMMARY_LATEST_KEY_ROOT });
  });
  useHlEvent('data:versionBumped', () => {
    void queryClient.invalidateQueries({ queryKey: SUMMARY_LATEST_KEY_ROOT });
  });

  return query;
}

/** Финал генерации = payload события 'ai/summary/result' (§11): summaryId нет — «не резюме». */
export interface SummaryFinal {
  readonly summaryId?: string;
  readonly cached: boolean;
  readonly stale: boolean;
}

/** Состояние генерации для экрана (§5): стрим + финал + прерывание. */
export interface SummaryGeneration {
  /** 'streaming' — requestId активен (токены идут; «Стоп» виден); иначе 'idle'. */
  readonly phase: 'idle' | 'streaming';
  /** Накопленный текст стрима (delta-append, §12). */
  readonly text: string;
  /** Финал последней генерации; undefined — не пришёл (идёт стрим или прервана). */
  readonly final: SummaryFinal | undefined;
  /** true — генерация прервана без финала (краш воркера/сбой) → «Повторить» (§5). */
  readonly interrupted: boolean;
  /** Начать генерацию; отказ канала (BUSY и пр.) — reject с SummaryIpcError (§13). */
  readonly start: (params: { period: StatsPeriodParam; includeNotes: boolean }) => Promise<void>;
  /** «Стоп»: ai/cancel по активному requestId (частичный ответ не сохранится, §5 п.5). */
  readonly stop: () => void;
  /** Сброс состояния + cancel активной (смена периода — §13). */
  readonly reset: () => void;
}

/** Генерация резюме со стрим-подпиской (§5: мутация + useHlEvent). */
export function useSummaryGeneration(): SummaryGeneration {
  const queryClient = useQueryClient();
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [final, setFinal] = useState<SummaryFinal | undefined>(undefined);
  const [interrupted, setInterrupted] = useState(false);
  // Зеркала для обработчиков событий: порядок ready→final в одном тике (§5 выше)
  // разрешается по ref, а не по batch-состоянию.
  const requestIdRef = useRef<string | undefined>(undefined);
  const finalRef = useRef<SummaryFinal | undefined>(undefined);

  // Стрим (§11/§15): токены чужих requestId игнорируем; батчинг ≤20 Гц уже на main.
  useHlEvent('ai:token', (payload) => {
    if (payload.requestId !== requestIdRef.current) {
      return;
    }
    setText((previous) => previous + payload.text);
  });

  // Финал (§11, ровно один): сохранить исход, инвалидировать latest (§12).
  useHlEvent('ai/summary/result', (payload) => {
    if (payload.requestId !== requestIdRef.current) {
      return;
    }
    const outcome: SummaryFinal = {
      summaryId: payload.summaryId,
      cached: payload.cached,
      stale: payload.stale,
    };
    finalRef.current = outcome;
    requestIdRef.current = undefined;
    setRequestId(undefined);
    setFinal(outcome);
    setInterrupted(false);
    void queryClient.invalidateQueries({ queryKey: SUMMARY_LATEST_KEY_ROOT });
  });

  // Прерывание (§5): ready/failed СВОЕГО requestId без финала — execute отклонён
  // (краш воркера, сбой ensureModel/стрима) — финала не будет.
  useHlEvent('ai:status', (payload) => {
    if (payload.requestId !== requestIdRef.current || finalRef.current !== undefined) {
      return;
    }
    if (payload.state === 'ready' || payload.state === 'failed') {
      setInterrupted(true);
      setRequestId(undefined);
      requestIdRef.current = undefined;
    }
  });

  const start = useCallback(
    async (params: { period: StatsPeriodParam; includeNotes: boolean }): Promise<void> => {
      const result = await call('ai/summary/generate', {
        profileId: PROFILE_ID,
        period: params.period,
        includeNotes: params.includeNotes,
      });
      if (!result.ok) {
        throw new SummaryIpcError(result.error);
      }
      const id = result.data.requestId;
      requestIdRef.current = id;
      finalRef.current = undefined;
      setRequestId(id);
      setText('');
      setFinal(undefined);
      setInterrupted(false);
    },
    [],
  );

  const stop = useCallback((): void => {
    const id = requestIdRef.current;
    if (id === undefined) {
      return;
    }
    void call('ai/cancel', { requestId: id }).catch(() => undefined);
    // requestId живёт до финала done(cancelled) — «Стоп» остаётся до завершения.
  }, []);

  const reset = useCallback((): void => {
    const id = requestIdRef.current;
    if (id !== undefined) {
      void call('ai/cancel', { requestId: id }).catch(() => undefined);
    }
    requestIdRef.current = undefined;
    finalRef.current = undefined;
    setRequestId(undefined);
    setText('');
    setFinal(undefined);
    setInterrupted(false);
  }, []);

  // §13: уход с экрана во время генерации → cancel (abort в main; состояние уже
  // не нужно — частичный ответ не сохраняется).
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
    text,
    final,
    interrupted,
    start,
    stop,
    reset,
  };
}

/** Мутация «Очистить разборы» (§5): delete-all → инвалидация latest. */
export function useDeleteSummaries() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<null> => {
      const result = await call('ai/summary/delete-all', {});
      if (!result.ok) {
        throw new SummaryIpcError(result.error);
      }
      return result.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SUMMARY_LATEST_KEY_ROOT });
    },
  });
}
