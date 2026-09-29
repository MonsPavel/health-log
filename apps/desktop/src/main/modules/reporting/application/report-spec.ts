/**
 * TASK-067 §5/§7: wire-типы задачи пула `pdf.render` и шаблона отчёта.
 *
 * ReportSpec — «что просит пользователь» (период + ИИ-раздел по явному включению);
 * ReportData — ГОТОВЫЕ числа/точки из read models (052/056): сборка происходит на
 * main-стороне (TASK-068), шаблон ничего не считает (§7: никакой бизнес-логики;
 * арх. 02 §3.4: ИИ-тексты не могут «протечь» мимо маркировки). Плейсхолдер задачи
 * TASK-066 §7 («потребитель 067 объявит точную карту») закрыт типом PdfTaskMap.
 *
 * Всё — плоские структурные типы: payload уходит в воркер structured clone'ом
 * (TASK-066 §14), функции в payload недопустимы.
 */

/** Период отчёта (§5): границы по takenAt.utcMs, обе включительно. */
export interface ReportPeriod {
  readonly fromUtcMs: number;
  readonly toUtcMs: number;
}

/** Текст ИИ-раздела (§5): только по явному spec.includeAiSection. */
export interface ReportAiText {
  /** Markdown-текст резюме; шаблон печатает как текст с переносами (§5 решение). */
  readonly contentMd: string;
  /** Момент генерации (utc мс) — печатается в маркировке раздела. */
  readonly generatedAt: number;
  /** Идентификатор модели — печатается в маркировке раздела. */
  readonly modelId: string;
}

/**
 * Спецификация отчёта (§5). При includeAiSection=false поле aiText ИГНОРИРУЕТСЯ,
 * даже если передано (§13 — защита от случайного включения ИИ-текста в отчёт
 * врачу; юнит-тест §19/AC §20).
 */
export interface ReportSpec {
  readonly period: ReportPeriod;
  readonly includeAiSection: boolean;
  readonly aiText?: ReportAiText;
}

/** Рука измерения — зеркало measurement.Arm (TASK-059 §5). */
export type ReportArm = 'left' | 'right';

/** Строка таблицы измерений (§5): готовая точка; примечание — текст пользователя. */
export interface ReportRow {
  /** Момент измерения (UTC мс); настенное время — по tzOffsetMin точки. */
  readonly utcMs: number;
  /** Смещение пояса точки (EC-06): утро/вечер и колонки Дата/Время — по нему. */
  readonly tzOffsetMin: number;
  readonly sys: number;
  readonly dia: number;
  /** ЧСС; undefined — не измерен (FR-1.1) → прочерк (§13). */
  readonly pulse?: number;
  /** Рука; undefined — не указана (TASK-059) → прочерк. */
  readonly arm?: ReportArm;
  /** Примечание пользователя (§14: react-pdf печатает текст как текст). */
  readonly note?: string;
}

/** Средние одной части суток / периода (§5): готовые числа read model 052. */
export interface ReportPartAverages {
  readonly count: number;
  readonly sysAvg: number;
  readonly diaAvg: number;
  /** Средний пульс части; undefined — не было ни одного измеренного (§13 052) → прочерк. */
  readonly pulseAvg?: number;
}

/** Блок «Средние» (§5): период + утро/вечер (нет части → прочерк-строка, §13). */
export interface ReportAverages {
  readonly period: ReportPartAverages;
  readonly morning?: ReportPartAverages;
  readonly evening?: ReportPartAverages;
}

/** Блок «Регулярность» (§5): N дней из M, longest streak (read model 052). */
export interface ReportRegularity {
  /** Дней с измерениями (N). */
  readonly daysWithMeasurements: number;
  /** Дней в периоде всего (M, настенных). */
  readonly totalDays: number;
  /** Самая длинная серия подряд (streak). */
  readonly longestStreakDays: number;
}

/**
 * Готовые данные отчёта (§7) — собирает TASK-068 из read models на main-стороне.
 * periodTzOffsetMin — настенный offset для ТИТУЛА (период, «Сформировано»);
 * точки таблицы используют СВОЙ offset (EC-06).
 */
export interface ReportData {
  /** Версия приложения для титула «Health Log v{appVersion}» (§5). */
  readonly appVersion: string;
  /** Момент формирования (UTC мс) — и в титул, и в метаданные PDF (детерминизм §19). */
  readonly generatedAtUtcMs: number;
  readonly periodTzOffsetMin: number;
  /** Строки таблицы; pdf-task сортирует asc по utcMs (§5: сортировка всегда asc). */
  readonly rows: readonly ReportRow[];
  readonly averages: ReportAverages;
  readonly regularity: ReportRegularity;
}

/** Payload задачи пула `pdf.render` (§5). */
export interface PdfRenderPayload {
  readonly spec: ReportSpec;
  readonly data: ReportData;
}

/**
 * Результат задачи (§5 bytes + §18 метрики): байты PDF и метрики, которые
 * логирует main-сторона (§18 решение: воркер не логирует — возвращает).
 */
export interface PdfRenderResult {
  /** PDF-байты (Uint8Array, structured clone обратно в main). */
  readonly pdf: Uint8Array;
  /** Число страниц документа (для лога §18 и проверок §20). */
  readonly pages: number;
  /** Число строк, попавших в таблицу (после лимита §9). */
  readonly records: number;
  /** Длительность рендера в воркере, мс. */
  readonly durationMs: number;
}

/** Карта задач пула reporting (задел §7 TASK-066: точная типизация run()). */
export interface PdfTaskMap {
  'pdf.render': {
    readonly payload: PdfRenderPayload;
    readonly result: PdfRenderResult;
  };
}
