/**
 * TASK-067 §17: RU-каталог текстов отчёта — единый источник строк шаблона
 * (в компонентах ключи, не литералы). EN-локализация пост-MVP: шаблон
 * параметризован каталогом (тип ReportStrings), замена каталога — единственная
 * точка перевода.
 */

/** Тексты, зависящие от чисел (приписка лимита §9). */
export interface ReportStringsFunctions {
  /** Приписка ограничения таблицы: «Показаны последние 2000 из 3000 измерений». */
  rowLimitNote(shown: number, total: number): string;
}

/** Каталог строк отчёта (RU; §17). */
export interface ReportStrings extends ReportStringsFunctions {
  readonly title: string;
  readonly measurementsTitle: string;
  readonly periodLabel: string;
  readonly generatedLabel: string;
  readonly appLabel: string;
  readonly table: {
    readonly date: string;
    readonly time: string;
    readonly sys: string;
    readonly dia: string;
    readonly pulse: string;
    readonly arm: string;
    readonly note: string;
  };
  readonly averages: {
    readonly title: string;
    readonly morning: string;
    readonly evening: string;
    readonly period: string;
    readonly sysAvg: string;
    readonly diaAvg: string;
    readonly pulseAvg: string;
    readonly count: string;
  };
  readonly regularity: {
    readonly title: string;
    readonly daysWithMeasurements: string;
    readonly totalDaysUnit: string;
    readonly streak: string;
    readonly streakUnit: string;
  };
  readonly chart: {
    readonly title: string;
    readonly referenceLegend: string;
    readonly unit: string;
  };
  readonly ai: {
    readonly title: string;
    readonly disclaimer: string;
    readonly modelLabel: string;
    readonly generatedLabel: string;
  };
  readonly armLeft: string;
  readonly armRight: string;
}

/** RU-каталог (§17): ключи — контракт шаблона, строки — только здесь. */
export const REPORT_RU: ReportStrings = {
  title: 'Дневник артериального давления',
  measurementsTitle: 'Измерения',
  periodLabel: 'Период',
  generatedLabel: 'Сформировано',
  appLabel: 'Health Log',
  table: {
    date: 'Дата',
    time: 'Время',
    sys: 'СДА',
    dia: 'ДДА',
    pulse: 'ЧСС',
    arm: 'Рука',
    note: 'Примечание',
  },
  averages: {
    title: 'Средние',
    morning: 'Утро',
    evening: 'Вечер',
    period: 'За период',
    sysAvg: 'СДА (сред.)',
    diaAvg: 'ДДА (сред.)',
    pulseAvg: 'ЧСС (сред.)',
    count: 'Измерений',
  },
  regularity: {
    title: 'Регулярность',
    daysWithMeasurements: 'Дней с измерениями',
    totalDaysUnit: 'дней',
    streak: 'Лучшая серия',
    streakUnit: 'дн. подряд',
  },
  chart: {
    // Терминология TASK-110 (docs/terminology.md): аббревиатура «АД» в UI не
    // используется — полное «систолическое давление» (сокращения — СДА/ДДА).
    title: 'Динамика систолического давления',
    referenceLegend: 'Пунктирные линии — опорные значения 140 и 90 мм рт. ст.',
    unit: 'мм рт. ст.',
  },
  ai: {
    title: 'Раздел, сгенерированный ИИ',
    // Формулировка FR-5.6 унифицирована ревизией TASK-110 (copy-audit:
    // fr56-disclaimer-report-aimark — «не является медицинской консультацией»).
    disclaimer: 'Сгенерировано ИИ; не является медицинской консультацией',
    modelLabel: 'Модель',
    generatedLabel: 'Сгенерировано',
  },
  armLeft: 'Левая',
  armRight: 'Правая',
  rowLimitNote: (shown, total) => `Показаны последние ${shown} из ${total} измерений`,
};
