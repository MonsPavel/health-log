/**
 * TASK-047 §5/§10/§16: экран «Настройки» (маршрут /settings, преемник заглушки
 * TASK-013). Секции: «Вид» (AppearanceSection) — тема (радиогруппа), размер текста
 * (сегмент), формат даты (select); применение мгновенное — через prefs (§10),
 * персистентность — БД (§3). Отдельный модуль = отдельный чанк (§15).
 * Секции крупного режима/простого режима — TASK-048/049, сетевые согласия —
 * TASK-099 (§5 «не включено»).
 */
import { useTranslation } from 'react-i18next';

import { AppearanceSection } from './AppearanceSection';

export function SettingsScreen(): JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="mx-auto max-w-2xl p-4" aria-labelledby="settings-title">
      <h1 id="settings-title" className="mb-4 text-xl font-semibold">
        {t('settings.title')}
      </h1>
      <AppearanceSection />
    </section>
  );
}
