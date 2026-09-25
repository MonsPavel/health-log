/**
 * TASK-013 §5: маршрут /journal — экран-заглушка «Журнал» (§3, ИА); ввод и история
 * — с TASK-031/033. Отдельный модуль = отдельный чанк (§15).
 */
import { PlaceholderScreen } from '../../shared/ui/PlaceholderScreen';

export function JournalPage(): JSX.Element {
  return <PlaceholderScreen titleKey="common.nav.journal" icon="📓" />;
}
