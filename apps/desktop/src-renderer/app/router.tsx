/**
 * TASK-013 §4/§5/§15: HashRouter (совместим с file://-подобной загрузкой prod,
 * арх. 06 §4) с пятью маршрутами-заглушками. React.lazy на каждый маршрут —
 * код-сплит с первого дня (§15): каждый экран — отдельный чанк; Suspense-fallback —
 * common.loading. «/» и неизвестный путь — на /dashboard (нет экрана 404 в MVP).
 *
 * Layout вне Routes (§15): смена маршрута перерисовывает только subtree Routes.
 */
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppLayout } from './layout';

/** Именованные экспорты страниц адаптируются под React.lazy (default-обёртка). */
const DashboardPage = lazy(() =>
  import('../features/dashboard/ui/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const JournalPage = lazy(() =>
  import('../features/journal/ui/JournalPage').then((m) => ({ default: m.JournalPage })),
);
const AiPage = lazy(() =>
  import('../features/ai/ui/AiPage').then((m) => ({ default: m.AiPage })),
);
const ReportsPage = lazy(() =>
  import('../features/reports/ui/ReportsPage').then((m) => ({ default: m.ReportsPage })),
);
const SettingsPage = lazy(() =>
  import('../features/settings/ui/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

/** Fallback код-сплита: нейтральный текст из каталога (§17). */
function RouteFallback(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center p-8 text-accent" role="status">
      {t('common.loading')}
    </div>
  );
}

/** Поддерево маршрутов внутри layout (children-паттерн §15). */
function RouteTree(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/journal" element={<JournalPage />} />
      <Route path="/ai" element={<AiPage />} />
      <Route path="/reports" element={<ReportsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

/** Роутер каркаса: HashRouter → AppLayout → Suspense → Routes (§5/§15). */
export function AppRouter(): JSX.Element {
  return (
    <HashRouter>
      <AppLayout>
        <Suspense fallback={<RouteFallback />}>
          <RouteTree />
        </Suspense>
      </AppLayout>
    </HashRouter>
  );
}
