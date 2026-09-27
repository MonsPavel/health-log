/**
 * TASK-047 §5/§10/§13/§16/§17: секция «Вид» экрана настроек:
 *  - тема — радиогруппа system|light|dark (fieldset/legend + нативные радио —
 *    стрелки/checked — семантика скринридеров, §16; прецедент ArmSegment TASK-031);
 *  - размер текста — сегмент 100|112.5|125 (те же нативные радио; классы hl-text-*
 *    применяются ThemeProvider'ом немедленно — AC6, без перезапуска);
 *  - формат даты — select auto|dmy|mdy; рядом — живой пример через formatDateTime
 *    (§13: prefs-пресет расширяет утилиту TASK-013).
 *
 * Изменения уходят через usePreferences().setPreferences — optimistic (§10):
 * значение контрола берётся из prefs (main-источник), отказ мутации откатывает
 * кэш и помечается aria-live-текстом (§16). Пока prefs не загружены, controls
 * выключены (disabled у fieldset — цели нажатия не «моргают»).
 */
import { useTranslation } from 'react-i18next';

import type { Prefs, PrefsPatch } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';
import { usePreferences } from '../model/use-preferences';

const THEMES: readonly { readonly value: Prefs['theme']; readonly labelKey: string }[] = [
  { value: 'system', labelKey: 'settings.appearance.themeSystem' },
  { value: 'light', labelKey: 'settings.appearance.themeLight' },
  { value: 'dark', labelKey: 'settings.appearance.themeDark' },
];

const TEXT_SCALES: readonly { readonly value: Prefs['textScale']; readonly labelKey: string }[] = [
  { value: '100', labelKey: 'settings.appearance.textScale100' },
  { value: '112.5', labelKey: 'settings.appearance.textScale112' },
  { value: '125', labelKey: 'settings.appearance.textScale125' },
];

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

/** Сегмент нативных радио (§16): общая форма для темы и масштаба. */
function RadioGroup({
  name,
  legend,
  options,
  value,
  onChange,
}: {
  readonly name: string;
  readonly legend: string;
  readonly options: readonly { readonly value: string; readonly labelKey: string }[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <fieldset className="border-0 p-0">
      <legend className="text-sm text-accent">{legend}</legend>
      <div className="mt-1 flex gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-border px-3 text-base hover:bg-accent/10"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="h-5 w-5 accent-[var(--hl-accent)]"
            />
            {t(option.labelKey)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Секция «Вид» (§5): тема, размер текста, формат даты. */
export function AppearanceSection(): JSX.Element {
  const { t } = useTranslation();
  const { prefs, setPreferences } = usePreferences();
  const loading = prefs === undefined;

  const patch = (partial: PrefsPatch): void => {
    setPreferences.mutate(partial);
  };

  return (
    <fieldset className="border-0 p-0" disabled={loading}>
      <legend className="mb-2 text-base font-medium">
        {t('settings.appearance.section')}
      </legend>
      <div className="flex flex-col gap-4">
        <RadioGroup
          name="theme"
          legend={t('settings.appearance.theme')}
          options={THEMES}
          value={prefs?.theme ?? 'system'}
          onChange={(theme) => patch({ theme: theme as Prefs['theme'] })}
        />
        <RadioGroup
          name="textScale"
          legend={t('settings.appearance.textScale')}
          options={TEXT_SCALES}
          value={prefs?.textScale ?? '100'}
          onChange={(textScale) => patch({ textScale: textScale as Prefs['textScale'] })}
        />
        <div>
          <label htmlFor="date-format" className="block text-sm text-accent">
            {t('settings.appearance.dateFormat')}
          </label>
          <select
            id="date-format"
            value={prefs?.dateFormat ?? 'auto'}
            onChange={(event) => patch({ dateFormat: event.target.value as Prefs['dateFormat'] })}
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
      </div>
      {/* §16/§10: отказ сохранения — aria-live, значение уже откатлено optimistic'ом. */}
      <p role="status" aria-live="polite" className="mt-3 text-sm text-red-600">
        {setPreferences.isError ? t('settings.appearance.saveError') : ''}
      </p>
    </fieldset>
  );
}
