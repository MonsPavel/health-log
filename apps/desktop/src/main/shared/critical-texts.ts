/**
 * TASK-086 §6: критический текст FR-7.4 — ОБЩИЙ МОДУЛЬ main («вынести „критический
 * текст“ в shared-константу main, импортируемую обеими»). Единственный источник
 * RU-констант полного текста срочности и реестра номеров экстренных служб на
 * main-стороне: фабрика отказов 086 (refusal-texts) импортирует отсюда, панель
 * 041 (renderer) остаётся на своём i18n-каталоге — renderer импортировать
 * main/shared не может по зонам (арх. 03 §4: renderer — только @hl/contracts),
 * поэтому дублирование снято ТЕСТ-СВЕРКОЙ (critical-texts.test.ts читает каталог
 * и реестр панели и приравнивает их этим константам — §20: «Emergency-текст ==
 * текст панели 041 (тест-сверка общих констант)»; решение §5 086: «константы
 * дублируются с тестом-сверкой»).
 *
 * Строки хранятся ДОСЛОВНО как значения каталога панели (i18next-плейсхолдеры
 * {{param}}) — сверка тестом байт-в-байт. Тон §10/§13 041: спокойный факт, без
 * диагнозов и императивов паники («срочно» нет — есть конкретный шаг). Полная
 * сборка текста — criticalHighText(): интро с {pressure}, список симптомов,
 * призыв, номера из реестра по локали (§14 086: «номера служб — из того же
 * реестра локали (041)», данные реестра равны панели — тест-сверка).
 *
 * ⚠️ Правка любой строки ниже = расхождение с панелью 041: тест-сверка упадёт —
 * менять синхронно с каталогом src-renderer/components/critical/ru.json (или это
 * осознанная ревизия формулировок SRS 04 FR-7.4, §14 082).
 */

/** Интро high-варианта: значение записи либо порог SRS «≥180/120» ({{pressure}}). */
export const CRITICAL_HIGH_INTRO =
  'Давление {{pressure}} может указывать на гипертонический криз.';

/** Ведение списка симптомов. */
export const CRITICAL_SYMPTOMS_LEAD = 'При симптомах:';

/** Симптомы — дословно SRS 04 FR-7.4, порядок фиксирован (golden-тест 041 §19). */
export const CRITICAL_SYMPTOMS: readonly string[] = [
  'сильная головная боль',
  'боль в груди',
  'одышка',
  'нарушение речи или зрения',
];

/** Призыв к действию (конкретный шаг — не императив паники, §22 041). */
export const CRITICAL_CTA = 'Немедленно обратитесь за медицинской помощью.';

/** Ведение строки номеров. */
export const CRITICAL_NUMBERS_LEAD = 'Экстренные службы:';

/** Подпись единого номера (в RU-семантике; каталог панели: unifiedLabel). */
export const CRITICAL_UNIFIED_LABEL = 'единый';

/** Фраза-заглушка, когда для локали нет записи в реестре (§5 041). */
export const CRITICAL_NUMBERS_FALLBACK = 'Номер местной службы экстренной помощи';

/** Порог high без значений записи (verbatim-интро панели, golden 041 §19). */
export const CRITICAL_THRESHOLD_HIGH = '≥180/120';

/** Запись реестра номеров экстренных служб (контракт 041 §7). */
export interface EmergencyNumbers {
  /** Локаль записи (язык интерфейса, fr-5.9). */
  readonly locale: string;
  /** Основной номер (скорая/местная служба). */
  readonly primary: string;
  /** Единый номер экстренных служб (если в локали он есть и отличается). */
  readonly unified?: string;
  /** Локализованная подпись основной службы (данные реестра, §4/§7 041). */
  readonly label: string;
}

/**
 * Реестр (данные = реестру панели 041, §14: «из того же реестра локали» —
 * equality закреплён тест-сверкой critical-texts.test.ts): ru — 103/112,
 * en-US — 911. Расширение — новая запись здесь И в реестре панели (тест поднимет,
 * если разойдутся).
 */
export const EMERGENCY_NUMBERS: Readonly<Record<string, EmergencyNumbers>> = {
  ru: { locale: 'ru', primary: '103', unified: '112', label: 'скорая' },
  'en-US': { locale: 'en-US', primary: '911', label: 'Emergency services' },
};

/**
 * Номера для локали интерфейса: точный тег → базовый язык (ru-RU → ru).
 * Неизвестная локаль → undefined (fallback-фраза). Семантика — как у панели 041.
 */
export function getEmergencyNumbers(locale: string): EmergencyNumbers | undefined {
  const direct = EMERGENCY_NUMBERS[locale];
  if (direct !== undefined) {
    return direct;
  }
  const base = locale.split('-')[0] ?? '';
  return EMERGENCY_NUMBERS[base];
}

/** Подстановка i18next-плейсхолдеров {{param}} (каталог-совместимые шаблоны). */
export function interpolate(template: string, params: Readonly<Record<string, string>>): string {
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Строка номеров в форматах панели (§13 041): с единым номером — «103 (скорая),
 * 112 (единый)»; без него — «911»; реестра нет — fallback-фраза.
 */
export function emergencyNumbersText(numbers: EmergencyNumbers | undefined): string {
  if (numbers === undefined) {
    return CRITICAL_NUMBERS_FALLBACK;
  }
  if (numbers.unified !== undefined) {
    return interpolate('{{primary}} ({{primaryLabel}}), {{unified}} ({{unifiedLabel}})', {
      primary: numbers.primary,
      primaryLabel: numbers.label,
      unified: numbers.unified,
      unifiedLabel: CRITICAL_UNIFIED_LABEL,
    });
  }
  return numbers.primary;
}

/**
 * Полный текст срочности FR-7.4 (эшелон 2 арх. 07 §4): построчно как рендерит
 * high-вариант панели 041 — интро с {pressure}, ведение, четыре симптома списком,
 * призыв, номера по локали. Давление — значения записи либо порог ({{pressure}}).
 * Маркер списка «- » — текстовая форма <li> панели. Текст детерминирован
 * (аргументы → байт-одинаковый результат), внешних вызовов нет (§14).
 */
export function criticalHighText(pressure: string, locale: string): string {
  const numbers = emergencyNumbersText(getEmergencyNumbers(locale));
  const lines = [
    interpolate(CRITICAL_HIGH_INTRO, { pressure }),
    CRITICAL_SYMPTOMS_LEAD,
    ...CRITICAL_SYMPTOMS.map((symptom) => `- ${symptom}`),
    CRITICAL_CTA,
    `${CRITICAL_NUMBERS_LEAD} ${numbers}`,
  ];
  return lines.join('\n');
}
