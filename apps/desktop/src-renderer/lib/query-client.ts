/**
 * TASK-013 §12: фабрика QueryClient — кэш серверных данных рендерера (арх. 06 §3).
 *
 * defaultOptions.queries: retry 0 — локальные операции либо мгновенны, либо ошибка
 * есть результат валидации (повтор не меняет ответ); staleTime Infinity — данные
 * не «протухают» по таймеру, инвалидация только событиями measurement:changed /
 * data:versionBumped (TASK-009); gcTime 10 минут — выгрузка неактуальных кэшей.
 *
 * Фабрика (а не синглтон-экспорт): тестам и будущим провайдерам — независимые
 * клиенты без общего состояния; провайдер создаёт один клиент на жизнь окна
 * (providers.tsx).
 */
import { QueryClient } from '@tanstack/react-query';

const TEN_MINUTES_MS = 10 * 60 * 1000;

/** QueryClient с дефолтами §12; транспорт появится с TASK-030 (§11). */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 0,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: TEN_MINUTES_MS,
      },
    },
  });
}
