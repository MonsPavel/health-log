/**
 * TASK-013 §5: маршрут /dashboard — экран-заглушка «Динамика» (§3, ИА);
 * графики и статистика — с TASK-057. Отдельный модуль = отдельный чанк (§15).
 */
import { PlaceholderScreen } from '../../shared/ui/PlaceholderScreen';

export function DashboardPage(): JSX.Element {
  return <PlaceholderScreen titleKey="common.nav.dashboard" icon="📈" />;
}
