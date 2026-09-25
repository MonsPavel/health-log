/**
 * TASK-013 §5: маршрут /ai — экран-заглушка «ИИ» (§3, ИА); резюме/чат — с TASK-088/090.
 * Отдельный модуль = отдельный чанк (§15).
 */
import { PlaceholderScreen } from '../../shared/ui/PlaceholderScreen';

export function AiPage(): JSX.Element {
  return <PlaceholderScreen titleKey="common.nav.ai" icon="🤖" />;
}
