/**
 * TASK-013 §5: маршрут /reports — экран-заглушка «Отчёты» (§3, ИА); экспорт/PDF
 * — с TASK-063+. Отдельный модуль = отдельный чанк (§15).
 */
import { PlaceholderScreen } from '../../shared/ui/PlaceholderScreen';

export function ReportsPage(): JSX.Element {
  return <PlaceholderScreen titleKey="common.nav.reports" icon="📄" />;
}
