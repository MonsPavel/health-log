/**
 * TASK-049 §4/§7/§12: FlagsService (renderer) — минимальный типизированный реестр
 * флагов (арх. 09 §4): defaults — в коде (реестр), значения — поля prefs. Remote-flags
 * отклонены навсегда (сеть; §5 «не включено», TD-стиль арх. 09 §4).
 *
 * §7, MVP-маппинг 1:1 (документируется): имя флага = имя булева поля prefs —
 * advancedMode ↔ prefs.advancedMode. Реестр — надстройка для единых чтения/записи
 * и типов: флаги reports.aiSection/ai.chat (P4/P5, §5) войдут в тот же реестр.
 * §12: флаги — производные prefs (тот же кэш-ключ ['prefs'], без отдельного стора);
 * пока prefs не загружены — defaults реестра (§13: чистый запуск = простой режим).
 *
 * Новый флаг = запись в FLAGS (+ булево поле prefs-схемы при необходимости):
 * useFlags/useSetFlag и тип-тесты выводятся из реестра, ручных списков нет (§19:
 * добавление флага не ломает существующих; неизвестное имя флага — ошибка
 * компиляции, AC-4).
 */
import { useMemo } from 'react';

import type { Prefs } from '@hl/contracts';

import { usePreferences } from '../features/settings/model/use-preferences';

/** Имена флагов (§7): union реестра; расширение — без правок потребителей. */
export type FlagName = 'advancedMode';

/** Описание флага в реестре (§5): значение по умолчанию + ключ подписи (§17). */
export interface FlagDefinition {
  /** Значение, пока prefs не загружены / поле отсутствует (§13: первый запуск). */
  readonly default: boolean;
  /** Ключ i18n подписи переключателя (§17); t() в UI — литерал (§22). */
  readonly labelKey: string;
}

/** Реестр флагов (§5): единственная точка добавления; Record — полнота по FlagName. */
export const FLAGS: Record<FlagName, FlagDefinition> = {
  advancedMode: { default: false, labelKey: 'settings.simpleMode' },
};

/** Значения флагов по умолчанию (§13): чистый запуск/загрузка — простой режим. */
function defaultFlags(): Record<FlagName, boolean> {
  const flags = {} as Record<FlagName, boolean>;
  for (const name of Object.keys(FLAGS) as FlagName[]) {
    flags[name] = FLAGS[name].default;
  }
  return flags;
}

/** Значения из документа prefs (§7: маппинг 1:1 — имя флага = булево поле prefs). */
function readFlags(prefs: Prefs): Record<FlagName, boolean> {
  const flags = {} as Record<FlagName, boolean>;
  for (const name of Object.keys(FLAGS) as FlagName[]) {
    flags[name] = prefs[name];
  }
  return flags;
}

/** Флаги текущего пользователя (§12): до загрузки prefs — defaults реестра. */
export function useFlags(): Record<FlagName, boolean> {
  const { prefs } = usePreferences();
  return useMemo(() => (prefs === undefined ? defaultFlags() : readFlags(prefs)), [prefs]);
}

/**
 * Запись флага (§7): patch в prefs через usePreferences (optimistic §10, источник
 * истины — main). Значение скрытой опции хранится независимо от видимости секции
 * (§13: toggle туда-сюда не сбрасывает).
 */
export function useSetFlag(): (name: FlagName, value: boolean) => void {
  const { setPreferences } = usePreferences();
  // TS выводит форму patch из union-ключа — дополнительного приведения не нужно.
  return (name: FlagName, value: boolean) => {
    setPreferences.mutate({ [name]: value });
  };
}
