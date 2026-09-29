/**
 * TASK-063 §5/§9: use case ExportCsv — «все записи профиля → CSV» (US-27, принцип 3
 * SRS «владение данными»: экспорт — страховка пользователя и мост к врачу/таблицам).
 *
 * ЧТЕНИЕ (§5/§8): журнал обходится ПАЧКАМИ по EXPORT_BATCH_SIZE (1000) через порт
 * ExportCsvSource — зеркало пагинации listByPeriod репозитория (TASK-021 §7); 50k
 * записей ≈ 3 МБ CSV (§8/§15) — результат собирается целиком в памяти (массив + join).
 * Пачки приходят в контракте репозитория (takenAt desc, tie-break id desc) — use case
 * разворачивает накопленное: в CSV хронология takenAt asc (§13 — читаемость врачу).
 *
 * ОТКАЗЫ (§9): доменных отказов нет. Пустой журнал — НЕ ошибка: валидный CSV с
 * заголовком и count=0 («честный пустой файл»). Неуспех чтения контрактом порта
 * репозитория не определён (TASK-021 §7) — источник сигнализирует исключением;
 * use case перехватывает и доставляет ошибку значением Result: err EXPORT/FAILED
 * (детали — в cause, наружу код/ключ; §14). Исключения не пересекают слои.
 *
 * СКОУП (§14, арх. 08 §3): profileId обязателен — пустой/не-строковый → программная
 * ошибка TypeError в точке вызова (dev-контракт, паритет порта репозитория TASK-021);
 * схема канала TASK-065 отсечёт это на границе IPC.
 *
 * ТЕЛЕМЕТРИЯ (§18): info `exportCsv` {count, durationMs} — без значений измерений
 * (PHI-правило, TASK-010); неуспех — error с кодом.
 *
 * КАНАЛ (§11): регистрация `report/export-csv` — TASK-065 (вместе с save-dialog);
 * здесь только use case + тесты. Файловый I/O (диалог/запись) — тоже TASK-065:
 * use case возвращает СТРОКУ csv, ничего не пишет.
 */
import { performance } from 'node:perf_hooks';

import { AppError, err, ok, type Result } from '@hl/kernel';

import { EXPORT_FAILED_MESSAGE_KEY } from '../domain/constants.js';
import { toCsv, type ExportRow } from '../domain/csv.js';

/**
 * Размер пачки чтения (§5/§8: «пачками по 1000»): баланс памяти/числа запросов —
 * 50k записей = 50 пачек; limit в каждом запросе пагинации.
 */
export const EXPORT_BATCH_SIZE = 1000;

/**
 * Порт чтения журнала для экспорта (§5): application reporting не импортирует чужие
 * модули (depcruise application-ports, прецедент TASK-052 MeasurementPointsPort) —
 * контракт локальный, боевая реализация — тонкий адаптер над BpMeasurementRepository
 * (reporting/adapters, §5 «ExportRow-маппинг агрегата» живёт там: только adapters
 * вправе импортировать модуль measurement).
 */
export interface ExportCsvSource {
  /**
   * Пачка строк экспорта профиля: offset записей от начала (самая новая первая —
   * контракт listByPeriod), limit — размер пачки. Возвращает меньше limit записей —
   * журнал исчерпан (в т.ч. 0).
   */
  listBatch(profileId: string, offset: number, limit: number): Promise<ExportRow[]>;
}

/** Минимальная поверхность логгера use case (§18); HlLogger контейнера ей удовлетворяет. */
export interface ExportCsvLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости конструктора (§7): подстановочные в тестах. */
export interface ExportCsvDeps {
  readonly source: ExportCsvSource;
  readonly logger: ExportCsvLogger;
}

/** Результат успешного выполнения (§5): CSV-строка целиком (BOM+заголовок+записи) и число записей. */
export interface ExportCsvResult {
  readonly csv: string;
  readonly count: number;
}

/** Use case UC-экспорт CSV (§5): execute(profileId) → Result<{csv, count}>. */
export class ExportCsvUseCase {
  constructor(private readonly deps: ExportCsvDeps) {}

  /** Выполняет сценарий (§5); ошибки — значением Result, исключения не пересекают слои. */
  async execute(profileId: string): Promise<Result<ExportCsvResult, AppError>> {
    const startedAtMs = performance.now();

    // Скоуп (§14): пустой profileId — программная ошибка, не AppError (§7 шапки).
    if (typeof profileId !== 'string' || profileId.length === 0) {
      throw new TypeError('ExportCsvUseCase: profileId обязателен (непустая строка)');
    }

    // 1. Обход журнала пачками (§5/§8): накопление в массив (конкатенация §15),
    //    стоп — пачка меньше размера окна (исчерпание, включая 0 записей).
    const rows: ExportRow[] = [];
    try {
      let offset = 0;
      for (;;) {
        const batch = await this.deps.source.listBatch(profileId, offset, EXPORT_BATCH_SIZE);
        for (const row of batch) {
          rows.push(row);
        }
        if (batch.length < EXPORT_BATCH_SIZE) {
          break;
        }
        offset += EXPORT_BATCH_SIZE;
      }
    } catch (cause) {
      // 2. Сбой чтения (§9): err EXPORT/FAILED значением + error-лог; csv не строится.
      const error = AppError.of('EXPORT/FAILED', EXPORT_FAILED_MESSAGE_KEY, undefined, cause);
      this.deps.logger.error('exportCsv: не удалось собрать выгрузку', {
        code: error.code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return err(error);
    }

    // 3. Хронология asc (§13): пачки приходили desc (контракт listByPeriod) —
    //    разворот накопленного; конвертер порядок входа сохраняет (§13 домена).
    rows.reverse();

    // 4. Конвертация (§5): чистый toCsv домена; пустой журнал → заголовок без записей (§9).
    const csv = toCsv(rows);

    // 5. Лог (§18): count и длительность — без значений измерений (PHI, TASK-010).
    this.deps.logger.info('exportCsv', {
      count: rows.length,
      durationMs: Math.round(performance.now() - startedAtMs),
    });

    return ok({ csv, count: rows.length });
  }
}
