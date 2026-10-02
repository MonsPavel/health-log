/**
 * TASK-047 §5/§10/§16 + TASK-049 §5/§13/§16: экран «Настройки» (маршрут /settings,
 * преемник заглушки TASK-013). Секции: «Вид» (AppearanceSection) — тема, размер
 * текста; применение мгновенное — через prefs (§10), персистентность — БД (§3).
 * TASK-049: переключатель «Простой режим» (§5) — по умолчанию ВКЛ (advancedMode=
 * false, §13); клик — toggling без подтверждения (§13: включение продвинутого
 * безвредно). Продвинутые опции — условная секция «Продвинутые» (AdvancedSection):
 * видна только при advancedMode=true, скрытие — условный рендер — из DOM целиком
 * (§16), prefs скрытых опций сохраняются (§13). Навигация не прячется (§5: решение
 * — стабильность для П3). Секции крупного режима — TASK-048. TASK-095 §6: секция
 * «Защита паролем» (SecuritySettings) — после «Вида», до «Продвинутых». TASK-097
 * §6: секция «Обновления» (UpdatesSection) — после «Защиты паролем», до
 * «Продвинутых». TASK-099 §5/§22: секция «Приватность» (PrivacyScreen) — после
 * «Обновлений», до «Продвинутых»; НЕ в advanced (важность выше простоты, §22).
 */
import { useTranslation } from 'react-i18next';

import { useFlags, useSetFlag } from '../../../lib/flags';
import { usePreferences } from '../model/use-preferences';
import { AdvancedSection } from './AdvancedSection';
import { AppearanceSection } from './AppearanceSection';
import { UpdatesSection } from './UpdatesSection';
import { PrivacyScreen } from './PrivacyScreen';
import { SecuritySettings } from '../../security/ui/SecuritySettings';

export function SettingsScreen(): JSX.Element {
  const { t } = useTranslation();
  const { prefs } = usePreferences();
  const flags = useFlags();
  const setFlag = useSetFlag();
  const loading = prefs === undefined;
  // Переключатель представляет «Простой режим»: checked = advancedMode=false (§2/§13).
  const simpleMode = !flags.advancedMode;

  return (
    <section className="mx-auto max-w-2xl p-4" aria-labelledby="settings-title">
      <h1 id="settings-title" className="mb-4 text-xl font-semibold">
        {t('settings.title')}
      </h1>
      {/* §16: switch-паттерн с aria-checked и подписью; имя switch — из label по id.
          §22: ключ в t() — литерал (динамические ключи запрещены). */}
      <div className="mb-6 flex items-center justify-between gap-4 rounded-md border border-border p-3">
        <div>
          <p id="settings-simple-mode-label" className="text-base font-medium">
            {t('settings.simpleMode')}
          </p>
          <p className="text-sm text-accent">{t('settings.simpleMode.hint')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={simpleMode}
          aria-labelledby="settings-simple-mode-label"
          disabled={loading}
          onClick={() => setFlag('advancedMode', !flags.advancedMode)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
            simpleMode ? 'border-accent bg-accent/30' : 'border-border bg-transparent'
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-4 w-4 rounded-full bg-accent transition-transform ${
              simpleMode ? 'translate-x-1' : 'translate-x-6'
            }`}
          />
        </button>
      </div>
      <AppearanceSection />
      {/* TASK-095 §5/§6: секция «Защита паролем» — включение/смена/снятие пароля,
          выбор автоблока; состояние — vault/status (§12). */}
      <SecuritySettings />
      {/* TASK-097 §5/§6: секция «Обновления» — проверка/скачивание/установка за
          согласием (updates/* 096), бета-канал — заготовка TASK-107 (§12). */}
      <UpdatesSection />
      {/* TASK-099 §5/§6: секция «Приватность» — обещание, операции/согласия
          (privacy/* 098), живая лента net:activity, инструкция самопроверки. */}
      <PrivacyScreen />
      {/* §5/§16: условный рендер — скрытая секция отсутствует в DOM. */}
      {flags.advancedMode ? <AdvancedSection /> : null}
    </section>
  );
}
