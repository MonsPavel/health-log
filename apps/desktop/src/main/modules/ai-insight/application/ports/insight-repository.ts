/**
 * TASK-087 §5/§7: порт хранилища инсайтов — application-слой модуля ai-insight
 * (арх. 03 §4: application не импортирует adapters/чужие модули — depcruise
 * application-ports; прецеденты ContextPointsPort 083, MeasurementPointsPort 052).
 * Боевая реализация — SqliteInsightRepository (адаптер над таблицей ai_summary
 * миграции v6); юнит-тесты use case 087 — fake в памяти (§19).
 *
 * Кэш-идентичность резюме — contextHash (SHA-256 canonical-строки 083: период,
 * опции, полный текст контекста, modelId, PROMPT_TEMPLATE_VERSION — §2): повторный
 * запрос того же периода без изменений данных — мгновенный hit (FR-5.7, §3).
 *
 * data_version (§7/арх. 04 §4): запись хранит счётчик НА МОМЕНТ генерации; stale =
 * record.dataVersion < currentDataVersion() — вычисляется при ЧТЕНИИ (не хранится):
 * currentDataVersion читает тот же meta.data_version, что bump'ают мутации
 * measurement (адаптер — прямой SELECT, без связки с чужим модулем).
 *
 * СОПОСТАВЛЕНИЕ latest (§12/ревью TASK-087): пресетные периоды ('7d'|'30d'|'90d'|
 * 'all') идентичны ПАРАМЕТРОМ (periodParam записи), не границам — границы пресета
 * «двигаются» вместе с now момента генерации, точное равенство границ между
 * generate и latest недостижимо при любом сдвиге часов. Custom-период идентичен
 * своими явными границами (renderer шлёт готовые utcMs — они стабильны).
 *
 * deleteAll — «Очистить разборы» (§8): необратимая очистка КЭША резюме, данные
 * дневника не трогает.
 */
import type { StatsPeriodParam } from '@hl/contracts';
import type { Instant } from '@hl/kernel';

/** Границы периода записи (§7 «period»): разрешённые границы запроса контекста. */
export interface SummaryPeriod {
  /** Нижняя граница (включительно); 'all' — сентинел 0 (см. шапку generate-summary). */
  readonly fromUtcMs: number;
  /** Верхняя граница (включительно); ∞/пресеты — nowMs момента генерации. */
  readonly toUtcMs: number;
}

/** Канонический идентификатор периода записи (ключ сопоставления latest — см. шапку). */
export type SummaryPeriodParam = '7d' | '30d' | '90d' | 'all' | 'custom';

/** Запись кэша ИИ-резюме (§7 дословно + periodParam — ключ сопоставления latest). */
export interface SummaryRecord {
  /** uuid v7 (конвенция id агрегатов, §5). */
  readonly id: string;
  /** Профиль-владелец (принудительный скоуп, арх. 08 §3). */
  readonly profileId: string;
  /** Канонический параметр периода ('7d'|'30d'|'90d'|'all'|'custom') — ключ latest. */
  readonly periodParam: SummaryPeriodParam;
  /** Разрешённые границы периода (метаданные отображения: «что реально запрашивалось»). */
  readonly period: SummaryPeriod;
  /** SHA-256 canonical-строки 083 — кэш-ключ (FR-5.7). */
  readonly contextHash: string;
  /** Модель генерации (участник hash — §2). */
  readonly modelId: string;
  /** Версия модели (арх. 07 §6: версия фиксируется в каждом резюме). */
  readonly modelVersion: string;
  /** Счётчик meta.data_version на момент генерации (основа stale §7). */
  readonly dataVersion: number;
  /** Ответ модели после ResponseGuard — БЕЗ дисклеймера/подписи (они отдельно, §5). */
  readonly contentMd: string;
  /** Несъёмный дисклеймер — отдельное поле, рендер всегда показывает (§5/§20 п.6). */
  readonly disclaimerText: string;
  /** Подпись периода — отдельное поле, рендер всегда показывает (§5/§20 п.6). */
  readonly periodText: string;
  /** Момент сохранения (epoch ms). */
  readonly createdAtUtc: number;
}

/**
 * Порт хранилища инсайтов (§5 дословно: findByContextHash, save, latestForPeriod,
 * deleteAll + currentDataVersion для stale §7). Все методы асинхронные (прецедент
 * порта 021: better-sqlite3 синхронный, Promise-обёртка — единообразие порта).
 */
export interface InsightRepository {
  /**
   * Запись по кэш-ключу в скоупе профиля; нет — undefined (не throw, §7: «hit/miss»
   * — валидные исходы, ошибки — только STORAGE/* адаптера).
   */
  findByContextHash(profileId: string, contextHash: string): Promise<SummaryRecord | undefined>;

  /** Сохранить запись (use case зовёт ТОЛЬКО при done(ok) — решение §5/§9). */
  save(record: SummaryRecord): Promise<void>;

  /**
   * Новейшая запись (created_at_utc DESC, tie-break id DESC) профиля для ЗАПРОШЕННОГО
   * периода (§12: бейдж «данные изменились» для текущего вида периода). Пресет/
   * 'all' сопоставляется по каноническому параметру (см. шапку), custom — по точным
   * границам; нет — undefined.
   */
  latestForPeriod(profileId: string, period: StatsPeriodParam): Promise<SummaryRecord | undefined>;

  /** Очистить ВСЕ резюме (кнопка «Очистить разборы», §8); идемпотентен. */
  deleteAll(): Promise<void>;

  /** Текущий data_version (meta): база stale-сравнения §7. */
  currentDataVersion(): Promise<number>;
}

/** Re-export Instant для удобства потребителей порта (периоды — по UTC, §7). */
export type { Instant };
