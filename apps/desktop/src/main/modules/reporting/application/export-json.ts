/**
 * TASK-064 §5/§9: use case ExportJson — «JSON-слепок всех данных профиля» (мастер-формат
 * v1, US-владение данными SRS: страховка от потери функциональности CSV и основа
 * будущих миграций/интеграций — импорт пост-MVP FR-6.6, синхронизация).
 *
 * СБОРКА (§5/§9 — последовательная, малые объёмы): профиль хранилища + все замеры
 * профиля в форме MeasurementDto (контракт TASK-028 — переиспользование, §7) + prefs
 * (SettingsStore) + активные шкалы (ScaleService, только код/версия — §7) → корень
 * JSON_SNAPSHOT_SCHEMA (contracts) → `JSON.stringify(obj, null, 2)` — человекочитаемый
 * файл (§24: открывается в JSON-редакторе). counts ВЫЧИСЛЯЮТСЯ из фактов (длины
 * массивов, §9) — не заявляются. Хронология asc (§13, паритет CSV): источник отдаёт
 * пачку в контракте listByPeriod (takenAt desc) — use case разворачивает накопленное.
 *
 * ЧТЕНИЕ (§8) — через порты (минимальные структурные поверхности, application reporting
 * не импортирует чужие модули — depcruise application-ports, прецедент ExportCsvSource):
 *  - ExportJsonSource — журнал/профиль (боевой адаптер над BpMeasurementRepository);
 *  - ExportJsonPrefsSource — документ настроек; «не настроены» → undefined → ключа
 *    prefs в слепке нет (§13, JSON не знает undefined);
 *  - ExportJsonScalesSource — активные версии шкал [{code, version}].
 *
 * ОТКАЗЫ (§9): доменных отказов нет. Профиль отсутствует / пустой журнал — НЕ ошибка:
 * валидный пустой слепок с counts 0 («честный пустой файл», паритет CSV §9). Неуспех
 * чтения контрактом портов не определён — источник сигнализирует исключением; use case
 * перехватывает и доставляет ошибку значением Result: err EXPORT/FAILED (детали —
 * в cause, наружу код/ключ; §14). Исключения не пересекают слои.
 *
 * СКОУП (§14, паритет ExportCsv): profileId обязателен — пустой/не-строковый →
 * программная ошибка TypeError в точке вызова (dev-контракт); схема канала TASK-065
 * отсечёт это на границе IPC.
 *
 * ВАЛИДАЦИЯ СОБСТВЕННОЙ СХЕМОЙ (§4/§20 AC): схеме соответствует ГАРАНТИРУЕТСЯ
 * составом сборки и roundtrip-тестом (int-тест чтением реального tmp-БД-слепка +
 * schema-тесты contracts, §19/§22 — дрейф DTO ловится тестами, прецедент TASK-054).
 * Рантайм self-parse в use case НЕ вводится: двойной обход 50k записей (~10 МБ,
 * §15) против бюджета <3 с без пользы — форма корня зафиксирована типом JsonSnapshot.
 *
 * ТЕЛЕМЕТРИЯ (§18): info `exportJson` {count, durationMs} — без значений измерений
 * (PHI-правило, TASK-010); неуспех — error с кодом.
 *
 * КАНАЛ (§11): регистрация `report/export-json`, FileSaver-диалог и запись файла —
 * TASK-065; здесь только use case + тесты (возвращает СТРОКУ json, ничего не пишет).
 */
import { performance } from 'node:perf_hooks';

import type {
  JsonSnapshot,
  JsonSnapshotProfile,
  JsonSnapshotScaleRef,
  MeasurementDto,
  Prefs,
} from '@hl/contracts';
import { JSON_SNAPSHOT_FORMAT_VERSION } from '@hl/contracts';
import { AppError, err, ok, type Clock, type Result } from '@hl/kernel';

import { EXPORT_FAILED_MESSAGE_KEY } from '../domain/constants.js';

/**
 * Порт чтения данных профиля для слепка (§5/§8): журнал — форма MeasurementDto
 * (маппинг агрегата — боевой адаптер, как ExportRow-маппинг TASK-063); порядок —
 * контракт listByPeriod (takenAt desc, tie-break id desc). Профиль — факты хранилища
 * (id, name, createdAtUtc в мс эпохи); отсутствует → undefined.
 */
export interface ExportJsonSource {
  /** Профиль по id (§5); отсутствует → undefined (пустой слепок — не ошибка, §9). */
  getProfile(profileId: string): Promise<JsonSnapshotProfile | undefined>;
  /** Все измерения профиля (§5) в форме DTO TASK-028. */
  listMeasurements(profileId: string): Promise<MeasurementDto[]>;
}

/** Порт чтения настроек (§5/§8: prefs из SettingsStore). Минимальная поверхность. */
export interface ExportJsonPrefsSource {
  /** Полный документ prefs (TASK-047); не настроены → undefined (§13). */
  getPrefs(): Promise<Prefs | undefined>;
}

/** Порт чтения активных шкал (§5/§8: ScaleService). Только код/версия (§7). */
export interface ExportJsonScalesSource {
  /** Активные версии шкал; массив (мастер-формат допускает рост, §3). */
  listActiveScales(): Promise<JsonSnapshotScaleRef[]>;
}

/** Минимальная поверхность логгера use case (§18); HlLogger контейнера ей удовлетворяет. */
export interface ExportJsonLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости конструктора (§7): подстановочные в тестах; время/версия — инъекция (NFR-10). */
export interface ExportJsonDeps {
  readonly source: ExportJsonSource;
  readonly prefs: ExportJsonPrefsSource;
  readonly scales: ExportJsonScalesSource;
  /** Порт времени: createdAtUtc корня (FixedClock в тестах). */
  readonly clock: Clock;
  /** Версия приложения в метаданные слепка (§2; bootstrap — app.getVersion()). */
  readonly appVersion: string;
  readonly logger: ExportJsonLogger;
}

/** Результат успешного выполнения (§5): JSON-строка слепка и число замеров. */
export interface ExportJsonResult {
  readonly json: string;
  readonly count: number;
}

/** Use case UC-экспорт JSON-слепка (§5): execute(profileId) → Result<{json, count}>. */
export class ExportJsonUseCase {
  constructor(private readonly deps: ExportJsonDeps) {}

  /** Выполняет сценарий (§5); ошибки — значением Result, исключения не пересекают слои. */
  async execute(profileId: string): Promise<Result<ExportJsonResult, AppError>> {
    const startedAtMs = performance.now();

    // Скоуп (§14): пустой profileId — программная ошибка, не AppError (паритет ExportCsv).
    if (typeof profileId !== 'string' || profileId.length === 0) {
      throw new TypeError('ExportJsonUseCase: profileId обязателен (непустая строка)');
    }

    // 1. Последовательная сборка источников (§5/§9): профиль → замеры → prefs → шкалы.
    //    Сбой чтения (§9): err EXPORT/FAILED значением + error-лог; слепок не строится.
    let profile: JsonSnapshotProfile | undefined;
    let measurements: MeasurementDto[];
    let prefs: Prefs | undefined;
    let scaleRefs: JsonSnapshotScaleRef[];
    try {
      profile = await this.deps.source.getProfile(profileId);
      measurements = await this.deps.source.listMeasurements(profileId);
      prefs = await this.deps.prefs.getPrefs();
      scaleRefs = await this.deps.scales.listActiveScales();
    } catch (cause) {
      const error = AppError.of('EXPORT/FAILED', EXPORT_FAILED_MESSAGE_KEY, undefined, cause);
      this.deps.logger.error('exportJson: не удалось собрать выгрузку', {
        code: error.code,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      return err(error);
    }

    // 2. Хронология asc (§13, паритет CSV): пачка пришла desc (контракт listByPeriod) —
    //    разворот КОПИИ (входной массив источника не мутируется).
    const ordered = [...measurements].reverse();

    // 3. Корень мастер-формата (§5): counts из фактов (§9); prefs отсутствует → ключа
    //    нет (§13 — условный spread, JSON.stringify опущение undefined ненадёжен для
    //    массивов, а форма корня строже: точный список ключей проверен тестом §14).
    const snapshot: JsonSnapshot = {
      formatVersion: JSON_SNAPSHOT_FORMAT_VERSION,
      appVersion: this.deps.appVersion,
      createdAtUtc: this.deps.clock.nowMs(),
      counts: { measurements: ordered.length, profiles: profile !== undefined ? 1 : 0 },
      profiles: profile !== undefined ? [profile] : [],
      measurements: ordered,
      ...(prefs !== undefined ? { prefs } : {}),
      scales: scaleRefs,
    };

    // 4. Сериализация (§5): JSON.stringify(obj, null, 2) — читаемый файл (§24).
    const json = JSON.stringify(snapshot, null, 2);

    // 5. Лог (§18): count и длительность — без значений измерений (PHI, TASK-010).
    this.deps.logger.info('exportJson', {
      count: ordered.length,
      durationMs: Math.round(performance.now() - startedAtMs),
    });

    return ok({ json, count: ordered.length });
  }
}
