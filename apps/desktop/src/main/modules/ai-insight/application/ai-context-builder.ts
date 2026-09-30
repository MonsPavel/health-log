/**
 * TASK-083 §2/§5/§13: AiContextBuilder — детерминированная проекция периода для
 * LLM (арх. 07 §3): агрегаты (read model 054), серии (056), разрывы ≥7 дней
 * (сканирование настенных дат), заметки (текстом, только при includeNotes — §14),
 * шкала (051) + `contextHash = SHA-256(period-json, опции, полный текст, modelId,
 * PROMPT_TEMPLATE_VERSION)`. Одинаковый вход — байт-одинаковый контекст: сортировки
 * по фиксированным ключам (utc asc, id asc — как 056), округления уже сделаны
 * доменом, дат «сейчас» внутри нет (пресет периода — меткой, §9: period задаёт
 * рамки). Данные доставляют порты (§5; application не импортирует чужие модули —
 * арх. 03 §4), боевые реализации — адаптеры ai-insight/adapters над публичным API
 * analytics (052/054/056) и measurement (заметки), проводка — контейнером.
 *
 * ЛИМИТ ОБЪЁМА (§5, защита контекст-окна): период длиннее CONTEXT_MAX_DAYS=90
 * дней → серии агрегируются по дням (mode daily, та же математика 056 —
 * buildTrendResponse) + пометка «Данные агрегированы» в тексте. Порог 056 (500
 * точек) про график — про объём текста для LLM он ничего не знает.
 *
 * HASH (§2/§22): canonical-строка = JSON(period) + JSON({includeNotes}) + текст +
 * modelId + PROMPT_TEMPLATE_VERSION (с TASK-084 — экспорт 084 из
 * application/prompts/system-prompt.ts: смена текста шаблона = бамп версии =
 * новая hash = честное устаревание кэша резюме, §22; контракт-тест 084 §20 п.5 —
 * пересборка canonical-строки по экспорту). Полный текст в hash: любые
 * данные/опции меняют текст — hash.
 *
 * §14: заметки включаются ТОЛЬКО при includeNotes (байт-тест §19); текст контекста
 * — PHI, логировать его запрещено (§18 канала — только агрегаты).
 */
import { createHash } from 'node:crypto';

import type {
  AiContextSectionId,
  PeriodStatisticsDto,
  StatsPeriodParam,
  TrendResponse,
} from '@hl/contracts';
import type { Clock } from '@hl/kernel';
import { Instant } from '@hl/kernel';

import { renderAiContext, type ContextNoteLine, type Gap } from './context-format.js';
import { PROMPT_TEMPLATE_VERSION } from './prompts/system-prompt.js';
import type {
  ContextPoint,
  ContextPointsPort,
  ContextPointsQuery,
  ContextScalePort,
  ContextSeriesMode,
  ContextSeriesPort,
  ContextStatsPort,
} from './ports/ai-context.js';

export type { Gap } from './context-format.js';

/**
 * Лимит детального контекста в днях (§5): период длиннее — серии агрегируются
 * по дням + пометка (AC §20: 120-дневный период → aggregated).
 */
export const CONTEXT_MAX_DAYS = 90;

/**
 * Версия шаблона system prompt (коммент-синхронизация TASK-084 §5/§13):
 * единственный источник — экспорт application/prompts/system-prompt.ts (там же
 * правило §13: правка текста шаблона → бамп версии); здесь ре-экспорт для
 * потребителей канала (087). Версия входит в contextHash (§2): смена значения =
 * новая версия hash = честное устаревание кэша резюме (FR-5.7, §22). Контракт
 * «builder использует экспорт 084» закреплён пересборкой canonical-строки в
 * system-prompt.test.ts (084 §20 п.5).
 */
export { PROMPT_TEMPLATE_VERSION };

/** Миллисекунды суток (спан периода и настенные дни разрывов). */
const MS_PER_DAY = 86_400_000;

/** Длительность пресетов периода (семантики TASK-044, §9 054; to = ∞). */
const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

/** Порог разрыва наблюдений в днях (§5: «разрывы ≥7 дней», §13 формат строки). */
const GAP_MIN_DAYS = 7;

/** Вход сборки (§5): {profileId, period, includeNotes, modelId}. */
export interface AiContextInput {
  /** Профиль-владелец (принудительный скоуп, арх. 08 §3). */
  readonly profileId: string;
  /** Период: пресет TASK-044 или custom-границы TASK-046 (включительно). */
  readonly period: StatsPeriodParam;
  /** Заметки в тексте — ТОЛЬКО по явной опции (FR-5.5, §14). */
  readonly includeNotes: boolean;
  /** Активная модель (участник hash — §2; резолвит канал из prefs, §11). */
  readonly modelId: string;
}

/**
 * VO AiContext (§7, арх. 02 §3.3): текст + hash + эхо входа + собранные данные.
 * `sections` — EN-идентификаторы присутствующих секций (§11 ответа preview;
 * UI 088 показывает секции, §10) — считаются вместе с текстом (секция в тексте
 * ⇔ id в списке).
 */
export interface AiContext {
  /** Точная текстовая проекция (§4) — PHI при заметках, в лог не пишется (§14). */
  readonly text: string;
  /** SHA-256 canonical-строки (hex, §2) — кэш резюме FR-5.7 и eval 091. */
  readonly contextHash: string;
  /** Присутствующие секции в фиксированном порядке (§11/§17). */
  readonly sections: readonly AiContextSectionId[];
  readonly period: StatsPeriodParam;
  readonly includeNotes: boolean;
  readonly modelId: string;
  /** Read model 054 на проводе (агрегаты, классификация 053). */
  readonly stats: PeriodStatisticsDto;
  /** Серии 056: raw или daily (лимит контекст-окна, §5). */
  readonly series: TrendResponse;
  /** Разрывы ≥7 дней (между записями и от периода до первой записи, §7). */
  readonly gaps: readonly Gap[];
}

/** Зависимости (§5): всё внедряет контейнер, тесты — подстановки (§19). */
export interface AiContextBuilderDeps {
  /** Точки периода с заметками (разрывы, заметки; боевая — адаптер журнала). */
  readonly points: ContextPointsPort;
  /** Агрегаты периода (054 read model). */
  readonly stats: ContextStatsPort;
  /** Серии периода (056, явный режим — лимит контекст-окна). */
  readonly series: ContextSeriesPort;
  /** Активная шкала (051). */
  readonly scales: ContextScalePort;
  /** Время: пресеты периода (TASK-044); в текст/hash не входит (§9/§13). */
  readonly clock: Clock;
}

/**
 * Сортировка точек (§13, как 056 §9): utc asc, tie-break id asc (uuid v7 ≈ порядок
 * создания — полный порядок на прод-входе, где id есть всегда). Сортировка на
 * КОПИИ — вход порта не мутируется.
 */
function sortedPoints(points: readonly ContextPoint[]): ContextPoint[] {
  return [...points].sort((a, b) => {
    if (a.takenAt.utcMs !== b.takenAt.utcMs) {
      return a.takenAt.utcMs - b.takenAt.utcMs;
    }
    if (a.id !== undefined && b.id !== undefined && a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }
    return 0;
  });
}

/** Номер настенного дня момента (день СВОЕГО offset — EC-06; формула Instant.wallTime). */
function wallDayIndex(utcMs: number, tzOffsetMin: number): number {
  return Math.floor((Math.floor(utcMs / 60_000) + tzOffsetMin) / 1_440);
}

/** 'YYYY-MM-DD' настенного дня по его номеру (полночь UTC дня; календарика здесь нет — kernel). */
function wallDateOfIndex(dayIndex: number): string {
  return Instant.toIso({ utcMs: dayIndex * MS_PER_DAY, tzOffsetMin: 0 }).slice(0, 10);
}

/**
 * Разрывы ≥7 дней (§5/§7/§13): между соседними записями (дни без записей от
 * следующего дня за предыдущей до дня перед следующей) и от начала периода до
 * первой записи (§7; для «всего журнала» начала нет — ведущий разрыв не ищется).
 * Скан по отсортированным точкам — выход детерминирован (§13).
 */
function detectGaps(
  points: readonly ContextPoint[],
  fromUtcMs: number | undefined,
  boundsTzOffsetMin: number,
): Gap[] {
  const gaps: Gap[] = [];

  const first = points[0];
  if (fromUtcMs !== undefined && first !== undefined) {
    const startDay = wallDayIndex(fromUtcMs, boundsTzOffsetMin);
    const firstDay = wallDayIndex(first.takenAt.utcMs, first.takenAt.tzOffsetMin);
    const days = firstDay - startDay;
    if (days >= GAP_MIN_DAYS) {
      gaps.push({
        fromWallDate: wallDateOfIndex(startDay),
        toWallDate: wallDateOfIndex(firstDay - 1),
        days,
      });
    }
  }
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    if (prev === undefined || next === undefined) {
      continue;
    }
    const prevDay = wallDayIndex(prev.takenAt.utcMs, prev.takenAt.tzOffsetMin);
    const nextDay = wallDayIndex(next.takenAt.utcMs, next.takenAt.tzOffsetMin);
    const days = nextDay - prevDay - 1;
    if (days >= GAP_MIN_DAYS) {
      gaps.push({
        fromWallDate: wallDateOfIndex(prevDay + 1),
        toWallDate: wallDateOfIndex(nextDay - 1),
        days,
      });
    }
  }
  return gaps;
}

/** Заметки построчно (§5/§14): только точки с заметкой, порядок сортировки точек. */
function collectNotes(points: readonly ContextPoint[]): ContextNoteLine[] {
  const notes: ContextNoteLine[] = [];
  for (const point of points) {
    if (point.note !== undefined) {
      const iso = Instant.toIso(point.takenAt);
      notes.push({
        wallDate: `${iso.slice(8, 10)}.${iso.slice(5, 7)}`,
        // Построчный формат секций (§4): переносы заметки схлопываются.
        text: point.note.replace(/\r\n?|\n/g, ' '),
      });
    }
  }
  return notes;
}

/** Границы периода (§9 054): пресет — от Clock, custom — как есть, 'all' — без границ. */
function periodBoundsOf(
  period: StatsPeriodParam,
  nowUtcMs: number,
): {
  fromUtcMs?: number;
  toUtcMs?: number;
} {
  if (period === 'all') {
    return {};
  }
  if (typeof period === 'string') {
    return { fromUtcMs: nowUtcMs - PRESET_DAYS[period] * MS_PER_DAY };
  }
  return { fromUtcMs: period.fromUtcMs, toUtcMs: period.toUtcMs };
}

/**
 * Спан периода в днях (§5 «90-дневного эквивалента»): пресет — дни пресета;
 * custom — целые сутки вверх (90 дней ровно — raw, 90 дней + 1 мс — daily);
 * 'all' — от первой до последней записи. Определяет режим серий (§5/§20).
 */
function periodSpanDays(period: StatsPeriodParam, sorted: readonly ContextPoint[]): number {
  if (period === 'all') {
    if (sorted.length === 0) {
      return 0;
    }
    const first = sorted[0]!.takenAt.utcMs;
    const last = sorted[sorted.length - 1]!.takenAt.utcMs;
    return Math.ceil((last - first) / MS_PER_DAY);
  }
  if (typeof period === 'string') {
    return PRESET_DAYS[period];
  }
  return Math.ceil((period.toUtcMs - period.fromUtcMs) / MS_PER_DAY);
}

/**
 * AiContextBuilder (§2): build(input) → AiContext. Чистая сборка: время «сейчас»
 * участвует ТОЛЬКО в вычислении границ пресета (рамки данных), в текст и hash
 * не входит (§9/§13 — тест «одинаковый период в разные дни»). Ошибок домена нет:
 * STORAGE/* пробрасывают порты (каркас вернёт ApiFailure); пустой период —
 * валидный контекст (§11, прецедент 054/056).
 */
export class AiContextBuilder {
  private readonly points: ContextPointsPort;

  private readonly stats: ContextStatsPort;

  private readonly series: ContextSeriesPort;

  private readonly scales: ContextScalePort;

  private readonly clock: Clock;

  constructor(deps: AiContextBuilderDeps) {
    this.points = deps.points;
    this.stats = deps.stats;
    this.series = deps.series;
    this.scales = deps.scales;
    this.clock = deps.clock;
  }

  /**
   * Сборка контекста (§5): границы → [точки, агрегаты, шкала] параллельно →
   * спан → режим серий → разрывы/заметки → текст → hash. Модель-Id и опции —
   * участники hash (§2), данных не касаются.
   */
  async build(input: AiContextInput): Promise<AiContext> {
    const bounds = periodBoundsOf(input.period, this.clock.nowMs());
    const boundsTzOffsetMin = this.clock.tzOffsetMin();
    const query: ContextPointsQuery = { profileId: input.profileId, ...bounds };

    const [rawPoints, stats, scale] = await Promise.all([
      this.points.listByPeriod(query),
      this.stats.getStatistics(query),
      this.scales.getActiveScale(),
    ]);
    const sorted = sortedPoints(rawPoints);

    // Лимит контекст-окна (§5): спан > CONTEXT_MAX_DAYS → агрегированные серии.
    const mode: ContextSeriesMode =
      periodSpanDays(input.period, sorted) > CONTEXT_MAX_DAYS ? 'daily' : 'raw';
    const series = await this.series.getSeries(query, mode);

    const gaps = detectGaps(sorted, bounds.fromUtcMs, boundsTzOffsetMin);
    const notes = input.includeNotes ? collectNotes(sorted) : [];

    const { text, sections } = renderAiContext({
      period: input.period,
      bounds,
      boundsTzOffsetMin,
      stats,
      series,
      gaps,
      notes,
      includeNotes: input.includeNotes,
      scale,
    });

    // Canonical-строка hash (§2): period-json + опции + полный текст + modelId +
    // PROMPT_TEMPLATE_VERSION. JSON.stringify детерминирован для этих значений
    // (примитивы/фиксированный порядок ключей литерала).
    const canonical = [
      JSON.stringify(input.period),
      JSON.stringify({ includeNotes: input.includeNotes }),
      text,
      input.modelId,
      PROMPT_TEMPLATE_VERSION,
    ].join('\n');
    const contextHash = createHash('sha256').update(canonical, 'utf8').digest('hex');

    return {
      text,
      contextHash,
      sections,
      period: input.period,
      includeNotes: input.includeNotes,
      modelId: input.modelId,
      stats,
      series,
      gaps,
    };
  }
}
