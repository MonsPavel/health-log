/**
 * TASK-013 §5/§12: корневые провайдеры рендерера. Порядок: i18n (side-effect init —
 * каталог inline, синхронно к первому рендеру) → QueryClientProvider (кэш серверных
 * данных) → ThemeProvider (data-theme/масштаб на <html>).
 *
 * ПОРЯДОК (смена TASK-047 §6/§10): ThemeProvider читает настройки из prefs через
 * usePreferences (useQuery/useMutation) — ему нужен QueryClient ВЫШЕ по дереву,
 * поэтому QueryClientProvider теперь внешний.
 *
 * QueryClient создаётся один на жизнь окна (useState-инициализатор — без
 * пересоздания при ре-рендере и StrictMode double-invoke): defaultOptions §12 —
 * retry 0, staleTime Infinity (инвалидация только событиями TASK-009), gcTime 10 мин.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import '../i18n';
import { createQueryClient } from '../lib/query-client';
import { ThemeProvider } from './theme/ThemeProvider';

/** Композиция корневых провайдеров (§5); рендерится один раз в App. */
export function AppProviders({ children }: { readonly children: ReactNode }): JSX.Element {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}
