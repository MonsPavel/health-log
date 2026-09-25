/**
 * TASK-013 §5: маршрут /settings — экран-заглушка «Настройки» (§3, ИА); экран
 * настроек и переключатели темы/масштаба — с TASK-047/048. Отдельный модуль =
 * отдельный чанк (§15).
 */
import { PlaceholderScreen } from '../../shared/ui/PlaceholderScreen';

export function SettingsPage(): JSX.Element {
  return <PlaceholderScreen titleKey="common.nav.settings" icon="⚙️" />;
}
