/**
 * TASK-047 §5/§10/§13/§16/§17 + TASK-049: секция «Вид» экрана настроек:
 *  - тема — радиогруппа system|light|dark (fieldset/legend + нативные радио —
 *    стрелки/checked — семантика скринридеров, §16; прецедент ArmSegment TASK-031);
 *  - размер текста — сегмент 100|112.5|125 (те же нативные радио; классы hl-text-*
 *    применяются ThemeProvider'ом немедленно — AC6, без перезапуска).
 * Формат даты с TASK-049 — в секции «Продвинутые» (AdvancedSection): виден только
 * при advancedMode=true, prefs сохраняются при скрытии (§13).
 *
 * Изменения уходят через usePreferences().setPreferences — optimistic (§10):
 * значение контрола берётся из prefs (main-источник), отказ мутации откатывает
 * кэш и помечается aria-live-текстом (§16). Пока prefs не загружены, controls
 * выключены (disabled у fieldset — цели нажатия не «моргают»).
 */
import { useTranslation } from 'react-i18next';

import type { Prefs, PrefsPatch } from '@hl/contracts';

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
            className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-fill px-3 text-base hover:bg-accent/10"
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

/** Секция «Вид» (§5): тема, размер текста. */
export function AppearanceSection(): JSX.Element {
  const { t } = useTranslation();
  const { prefs, setPreferences } = usePreferences();
  const loading = prefs === undefined;

  const patch = (partial: PrefsPatch): void => {
    setPreferences.mutate(partial);
  };

  return (
    <fieldset className="border-0 p-0" disabled={loading}>
      <legend className="mb-2 text-base font-medium">{t('settings.appearance.section')}</legend>
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
      </div>
      {/* §16/§10: отказ сохранения — aria-live, значение уже откатлено optimistic'ом. */}
      <p role="status" aria-live="polite" className="mt-3 text-sm text-status-fail">
        {setPreferences.isError ? t('settings.appearance.saveError') : ''}
      </p>
    </fieldset>
  );
}
