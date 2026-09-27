/**
 * TASK-049 §5/§13/§16/§17: секция «Продвинутые» экрана настроек. Рендерится только
 * при advancedMode=true — условный рендер в SettingsScreen: скрытая секция
 * удаляется из DOM ЦЕЛИКОМ (§16: не visibility:hidden — скринридер не озвучивает).
 * Наполнение (§5): формат даты — перенос из «Вида» (TASK-047, единственный
 * существующий advanced-параметр); будущие: выбор модели ИИ, бета-канал.
 * prefs скрытых опций сохраняются (§13): значение живёт в документе prefs,
 * видимость секции на него не влияет. Изменения — optimistic (§10), прецедент
 * AppearanceSection.
 */
import { useTranslation } from 'react-i18next';

import type { Prefs } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';
import { usePreferences } from '../model/use-preferences';

const DATE_FORMATS: readonly {
  readonly value: Prefs['dateFormat'];
  readonly labelKey: string;
}[] = [
  { value: 'auto', labelKey: 'settings.appearance.dateFormatAuto' },
  { value: 'dmy', labelKey: 'settings.appearance.dateFormatDmy' },
  { value: 'mdy', labelKey: 'settings.appearance.dateFormatMdy' },
];

/** Детерминированный пример для превью формата даты (31 января 2026, настенное). */
const PREVIEW_INSTANT = { utcMs: Date.UTC(2026, 0, 31, 12, 0), tzOffsetMin: 0 };

/** Секция «Продвинутые» (§5): видна только при advancedMode=true. */
export function AdvancedSection(): JSX.Element {
  const { t } = useTranslation();
  const { prefs, setPreferences } = usePreferences();
  const loading = prefs === undefined;

  return (
    <section
      aria-labelledby="advanced-section-title"
      data-testid="advanced-section"
      className="mt-6"
    >
      <h2 id="advanced-section-title" className="mb-2 text-base font-medium">
        {t('settings.advancedSection')}
      </h2>
      <fieldset className="border-0 p-0" disabled={loading}>
        <div>
          <label htmlFor="date-format" className="block text-sm text-accent">
            {t('settings.appearance.dateFormat')}
          </label>
          <select
            id="date-format"
            value={prefs?.dateFormat ?? 'auto'}
            onChange={(event) =>
              setPreferences.mutate({ dateFormat: event.target.value as Prefs['dateFormat'] })
            }
            className="mt-1 min-h-11 rounded-md border border-border bg-transparent px-3 py-2 text-base"
          >
            {DATE_FORMATS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-accent" data-testid="date-format-preview">
            {t('settings.appearance.dateFormatPreview', {
              example: formatDateTime(PREVIEW_INSTANT, {
                preset: 'date',
                dateFormat: prefs?.dateFormat ?? 'auto',
              }),
            })}
          </p>
        </div>
      </fieldset>
      {/* §16/§10: отказ сохранения — aria-live, значение уже откатлено optimistic'ом. */}
      <p role="status" aria-live="polite" className="mt-3 text-sm text-red-600">
        {setPreferences.isError ? t('settings.appearance.saveError') : ''}
      </p>
    </section>
  );
}
