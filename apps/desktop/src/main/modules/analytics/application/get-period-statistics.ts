/**
 * TASK-054 §5/§9: GetPeriodStatistics — use case канала `stats/period`, ТОНКАЯ
 * сборка read path (арх. 05 §5): период → границы → read model → scale → Response.
 * Никакой своей математики: точки периода достаёт порт MeasurementPointsPort
 * (TASK-052, боевая реализация — адаптер над журналом), агрегаты и classification
 * собирает buildPeriodStatistics (052 + 053), активная шкала — ScaleService
 * (TASK-051, кэш в памяти). Ответ фиксирует форму ОДИН РАЗ для трёх потребителей
 * (дашборд 061, отчёт 068, ИИ-контекст 083, §3).
 *
 * СЕМАНТИКИ ПЕРИОДА (§9, как TASK-044/046): пресет — from = now − N*24ч по Clock,
 * to = ∞ («последние N дней» пересчитываются при каждом вызове); 'all' — без границ;
 * custom {fromUtcMs, toUtcMs} — как есть, обе границы включительно (порт TASK-021 §13;
 * конвертация настенных дат в utcMs — забота рендерера, TASK-046).
 *
 * МАЛЫЕ ДАННЫЕ (EC-09, §2/§10): шкала подаётся в read model ВСЕГДА, но при
 * insufficientData (пороги kernel в сборщике 052) classification.category приходит
 * undefined + note insufficientData — «мало данных» не превращается в категорию АГ;
 * значения при этом считаются (честные цифры с пометкой).
 *
 * МАППИНГ DTO (§7): PeriodStatistics → провод — JSON-форма (flat-маппинг):
 * undefined-части отсутствуют в JSON, не null-простыня; NaN в read model запрещён
 * (AC 052), поэтому round-trip безопасен. Дрейф DTO от read model ловит schema-тест
 * из реального ответа канала (§22, stats.int.test.ts (1)).
 *
 * ОТКАЗЫ (§9): STORAGE/* — только инфраструктурные (репозиторий/шкала пробрасывают
 * AppError выше, каркас вернёт ApiFailure); своих доменных отказов нет — пустой
 * период → полная структура с нулями (§11, не ошибка).
 */
import type { ActiveScale, PeriodStatisticsDto, StatsRequest, StatsResponse } from '@hl/contracts';
import type { Clock } from '@hl/kernel';

import type { MeasurementPointsPort } from './ports/measurement-points.js';
import { buildPeriodStatistics } from './period-statistics.js';

/** Минимальная поверхность источника активной шкалы (§9: scale из ScaleService). */
export interface ScaleProvider {
  getActiveScale(): Promise<ActiveScale>;
}

/** Зависимости use case (§7): подстановочные в тестах (§19). */
export interface GetPeriodStatisticsDeps {
  /** Порт точек периода (боевой — адаптер журнала; fake — в тестах). */
  readonly points: MeasurementPointsPort;
  /** Активная шкала для classification и справки в ответе (§4). */
  readonly scales: ScaleProvider;
  /** Порт времени: пресеты считаются от «сейчас» (§9, TASK-044). */
  readonly clock: Clock;
}

/** Миллисекунды суток: пресет = now − N*24ч (§13 TASK-044 — не календарная неделя). */
const MS_PER_DAY = 86_400_000;

/** Длительность пресетов в сутках (§5); 'all' границ не имеет. */
const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

/** Включительные границы периода по takenAt.utcMs (порт TASK-021 §13); ∞ — поле отсутствует. */
export interface PeriodBounds {
  readonly fromUtcMs?: number;
  readonly toUtcMs?: number;
}

/**
 * Период запроса → включительные границы выборки (§9). Чистая функция: пресет —
 * от переданного «сейчас» (детерминизм тестов, NFR-10), custom — как есть (§13:
 * период «всё» на пустой БД и custom из одного дня — валидные запросы).
 */
export function periodBoundsOf(period: StatsRequest['period'], nowUtcMs: number): PeriodBounds {
  if (period === 'all') {
    return {};
  }
  if (typeof period === 'string') {
    return { fromUtcMs: nowUtcMs - PRESET_DAYS[period] * MS_PER_DAY };
  }
  return { fromUtcMs: period.fromUtcMs, toUtcMs: period.toUtcMs };
}

/**
 * Read model → проводная форма (§7): JSON round-trip материализует flat-маппинг —
 * ключи с undefined исчезают (не null), readonly-массивы превращаются в проводные
 * копии. Структура мала (агрегаты, не точки) — стоимость незначима (§15).
 */
function toDto(stats: ReturnType<typeof buildPeriodStatistics>): PeriodStatisticsDto {
  return JSON.parse(JSON.stringify(stats)) as PeriodStatisticsDto;
}

/** Use case канала `stats/period` (§5): execute(request) → {stats, scale}. */
export class GetPeriodStatistics {
  private readonly points: MeasurementPointsPort;

  private readonly scales: ScaleProvider;

  private readonly clock: Clock;

  constructor(deps: GetPeriodStatisticsDeps) {
    this.points = deps.points;
    this.scales = deps.scales;
    this.clock = deps.clock;
  }

  /**
   * Статистика периода (§9): границы → точки → read model со шкалой → ответ.
   * Одинаковые запросы (в пределах пресета и неизменных данных) — одинаковые
   * ответы: детерминизм read model 052 (§13, кэш-дружелюбность TD-8).
   */
  async execute(request: StatsRequest): Promise<StatsResponse> {
    // Шкала нужна и ответу (§4: scale в ответе — классификация без второй загрузки),
    // и сборщику (053). ScaleService кэширует — повторные вызовы дёшевы (§15 051).
    const scale = await this.scales.getActiveScale();

    const bounds = periodBoundsOf(request.period, this.clock.nowMs());
    const points = await this.points.listByPeriod({ profileId: request.profileId, ...bounds });
    const stats = toDto(buildPeriodStatistics(points, scale));

    return {
      stats,
      scale: { code: scale.code, version: scale.version, sourceLabel: scale.sourceLabel },
    };
  }
}
