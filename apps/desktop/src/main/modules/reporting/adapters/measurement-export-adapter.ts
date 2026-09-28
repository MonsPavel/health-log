/**
 * TASK-063 §5: боевой адаптер порта ExportCsvSource (application reporting) над
 * репозиторием журнала measurement (BpMeasurementRepository.listByPeriod — НОВОГО
 * SQL НЕТ, пагинация offset/limit контракта TASK-021 покрывает обход пачками).
 *
 * «ExportRow-маппинг агрегата» (§5) живёт здесь: только adapters вправе импортировать
 * чужой модуль (arch. 03 §4, depcruise application-ports/module-public-api; прецедент
 * TASK-054 MeasurementPointsAdapter). Трансляция:
 *  - bp развёрнут в sys/dia; «пульс не измерен» → undefined → пустая ячейка CSV;
 *  - irregularPulse → irregular (литерал true/false в CSV — домен toCsv, §5);
 *  - arm/note — как в агрегате (undefined → пустая ячейка);
 *  - datetime — ISO 8601 с настенным временем и offset записи (EC-06: запись хранит
 *    СВОЙ offset): Instant.toIso даёт «...ss.mmm±HH:MM» — миллисекунды обрезаются до
 *    секундного формата примера §5 («2026-09-24T08:12:00+03:00», однозначность парсинга
 *    сохраняется; вывод toIso строго форматирован — .mmm всегда ровно 3 цифры).
 *
 * Сортировка — контракт listByPeriod (takenAt desc, tie-break id desc); разворот в asc
 * делает use case (§13). Асинхронность — единообразно с портом.
 */
import { Instant } from '@hl/kernel';

import { type BpMeasurement, type BpMeasurementRepository } from '../../measurement/index.js';

import type { ExportCsvSource } from '../application/export-csv.js';
import type { ExportRow } from '../domain/csv.js';

/** Миллисекундная часть ISO-вывода Instant.toIso (ровно 3 цифры перед offset). */
const ISO_MILLISECONDS = /\.\d{3}(?=[+-]\d{2}:\d{2}$)/;

/** Строка экспорта из агрегата журнала (§5): плоские числа + ISO-строка момента. */
export function toExportRow(m: BpMeasurement): ExportRow {
  return {
    id: m.id,
    profileId: m.profileId,
    datetime: Instant.toIso(m.takenAt).replace(ISO_MILLISECONDS, ''),
    sys: m.bp.sys,
    dia: m.bp.dia,
    pulse: m.pulse,
    irregular: m.irregularPulse,
    arm: m.arm,
    note: m.note,
    source: m.source,
  };
}

/** Адаптер чтения пачек журнала для экспорта (§5): профиль-скоуп и пагинация — как есть. */
export class MeasurementExportAdapter implements ExportCsvSource {
  private readonly repo: BpMeasurementRepository;

  constructor(repo: BpMeasurementRepository) {
    this.repo = repo;
  }

  listBatch(profileId: string, offset: number, limit: number): Promise<ExportRow[]> {
    return this.repo
      .listByPeriod({ profileId, offset, limit })
      .then((measurements) => measurements.map(toExportRow));
  }
}
