/**
 * TASK-083 §5/§7: порты данных AiContextBuilder — application-слой модуля
 * ai-insight (арх. 03 §4: application не импортирует чужие модули — depcruise
 * application-ports; прецедент MeasurementPointsPort TASK-052). Боевые реализации —
 * адаптеры ai-insight/adapters над публичным API analytics (052/054/056) и
 * measurement (заметки), проводка — контейнером.
 *
 * ContextPoint — структурное зеркало точки аналитики 052 + note (§5: заметки —
 * текстом при includeNotes; журнал хранит заметку в агрегате BpMeasurement, порт
 * аналитики её не доставляет — отдельный порт, без правки чужого контракта).
 * stats — read model 054 на проводе (PeriodStatisticsDto @hl/contracts), series —
 * ответ read model 056 (TrendResponse), шкала — форма канала scales/active (051).
 */
import type { ActiveScale, PeriodStatisticsDto, TrendResponse } from '@hl/contracts';
import type { Instant } from '@hl/kernel';

/**
 * Точка периода для ИИ-контекста (§5): зеркало MeasurementPoint 052 (id/sys/dia/
 * pulse/takenAt/critical/irregular/arm) + note записи (§14: попадает в текст
 * ТОЛЬКО при includeNotes). id опционален: боевой адаптер доставляет всегда,
 * ручные фикстуры тестов — нет.
 */
export interface ContextPoint {
  readonly id?: string;
  readonly sys: number;
  readonly dia: number;
  /** ЧСС, уд/мин; undefined — не измерен (FR-1.1). */
  readonly pulse: number | undefined;
  /** Момент измерения (UTC + собственный offset записи — EC-06). */
  readonly takenAt: Instant;
  /** Флаг критичности пары по политике TASK-020 (ставит адаптер порта). */
  readonly critical: 'high' | 'low' | undefined;
  /** Флаг записи «неровный пульс» (EC-10); отсутствует, если флага нет. */
  readonly irregular?: boolean;
  /** Рука измерения (TASK-059); отсутствует, если у записи руки нет. */
  readonly arm?: 'left' | 'right';
  /** Заметка записи (≤500 символов, trim — TASK-017); отсутствует, если заметки нет. */
  readonly note?: string;
}

/** Запрос выборки — то же подмножество MeasurementQuery, что у порта 052 (§13). */
export interface ContextPointsQuery {
  /** Профиль-владелец: обязателен — принудительный скоуп (арх. 08 §3). */
  readonly profileId: string;
  /** Нижняя граница периода по takenAt.utcMs, включительно. */
  readonly fromUtcMs?: number;
  /** Верхняя граница периода по takenAt.utcMs, включительно. */
  readonly toUtcMs?: number;
}

/** Порт чтения точек периода с заметками (§5; боевая реализация — адаптер 083). */
export interface ContextPointsPort {
  /** Точки периода; сортировка не гарантирована — сборщик сортирует сам (§13). */
  listByPeriod(query: ContextPointsQuery): Promise<ContextPoint[]>;
}

/** Порт статистики периода (§5 «stats (054 read model)»): форма PeriodStatisticsDto. */
export interface ContextStatsPort {
  getStatistics(query: ContextPointsQuery): Promise<PeriodStatisticsDto>;
}

/** Режим серий (§5): raw — детальные точки, daily — агрегаты настенных дней (056). */
export type ContextSeriesMode = TrendResponse['mode'];

/**
 * Порт серий периода (§5 «серии (056)»). Режим решает сборщик: период длиннее
 * CONTEXT_MAX_DAYS → daily (защита контекст-окна, §5) — порог 056 (500 точек)
 * про объём текста контекста ничего не знает.
 */
export interface ContextSeriesPort {
  getSeries(query: ContextPointsQuery, mode: ContextSeriesMode): Promise<TrendResponse>;
}

/** Порт активной шкалы (§5 «шкала (051)»): поверхность ScaleService (прецедент 054). */
export interface ContextScalePort {
  getActiveScale(): Promise<ActiveScale>;
}
