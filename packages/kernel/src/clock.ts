/**
 * TASK-006 §7: порт Clock — единственный источник текущего времени (арх. 04 §2).
 * Домен не читает Date.now() напрямую → детерминированные тесты (NFR-10).
 */

/** Порт текущего времени: миллисекунды и текущее смещение пояса устройства. */
export interface Clock {
  /** Текущее время, мс эпохи Unix (UTC). */
  nowMs(): number;
  /** Смещение пояса устройства сейчас: UTC+3 → 180, UTC-5 → -300. */
  tzOffsetMin(): number;
}

/** Боевая реализация порта поверх Date (§7: «SystemClock (Date/intl)»). */
export class SystemClock implements Clock {
  /** Единственное законное Date.now() в пакете (§24: grep — только внутри SystemClock). */
  nowMs(): number {
    return Date.now();
  }

  tzOffsetMin(): number {
    // getTimezoneOffset отдаёт минуты НАЗАД от UTC (UTC+3 → -180) — инвертируем
    // к конвенции Instant.tzOffsetMin.
    return -new Date().getTimezoneOffset();
  }
}

/** Фиктивные часы для тестов: фиксированные ms и tz (детерминизм, NFR-10). */
export class FixedClock implements Clock {
  constructor(
    private readonly ms: number,
    private readonly tz: number,
  ) {}

  nowMs(): number {
    return this.ms;
  }

  tzOffsetMin(): number {
    return this.tz;
  }
}
