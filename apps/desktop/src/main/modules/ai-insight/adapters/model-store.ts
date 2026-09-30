/**
 * TASK-080 §2/§5: ModelStore — загрузка модели через egress (op 'models.download')
 * с проверкой свободного места, докачкой после обрыва (HTTP Range), sha256-
 * верификацией и АТОМАРНОЙ установкой в <models>/<file> (§3: недокачанный файл
 * никогда не притворяется готовым).
 *
 * FLOW download(modelId) (§5): модель в манифесте? → место на диске
 * (sizeBytes + 100 МБ запас, иначе AI/DISK_FULL) → HEAD (поддержка Range? если
 * нет — грузим целиком, докачка невозможна — resumable=false в состоянии) →
 * цикл Range-запросов → append в <file>.part → прогресс ai:progress (throttle
 * 250 мс, §15) → sha256 потоково (mismatch → удалить .part, AI/HASH_MISMATCH)
 → место ПЕРЕД финальным rename (§13) → rename (атомарно, та же ФС) → installed.
 *
 * RETRY (§4/§13): 3 автоматических ретрая с бэкоффом 1/5/25 с на сетевые ошибки
 * (не-ok HTTP — тоже retry-ветка: код ответа — решение потребителя, §13 075),
 * затем состояние paused — пользователь продолжает вручную. Пауза (§5): закрыть
 * соединение (AbortController), состояние paused c bytesLoaded.
 *
 * СОСТОЯНИЕ (§5/§8): .part-файл сам — состояние (размер = скачано), рядом meta
 * json {modelId, sha256, total}; перезапуск приложения с .part → paused
 * (status() по диску), resume докачивает с Range (AC6). Состояния (§7):
 * not_installed→downloading⇄paused→verifying→installed; error — терминальное
 * с reset-возможностью (reset(): error→not_installed, хвосты удалены).
 *
 * ОДНА АКТИВНАЯ ЗАГРУЗКА (§9): вторая download/resume → AI/DOWNLOAD_BUSY.
 * Отмена приложения посреди — .part сохранён, resume при следующем старте
 * предлагается (§9: status persisted через .part существование).
 *
 * БЕЗОПАСНОСТЬ (§14): сеть только через egress-порт (структурно EgressGateway —
 * межмодульный импорт чужих adapters запрещён, арх. 03 §4); sha256 обязателен;
 * файлы только в models/ каталоге — file из манифеста валидируется
 * MODEL_FILE_PATTERN до join (path traversal). РЕАЛЬНЫЙ резолв имён (findFile)
 * идёт через реестр моделей 079 (каталог = источник «что можно ставить»).
 *
 * ЛОГ (§18): журнал gateway (байты) + структурный лог «model store state=…
 * bytes=…» на сменах состояний; логгер структурный LlmClientLogger (боевой —
 * createLogger('ai')), по умолчанию молчун (прецедент 076/079).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { appendFile, mkdir, rename, rm, statfs, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MODEL_FILE_PATTERN,
  type ModelDescriptor,
  type ModelStatus,
  type ModelStatusInfo,
} from '@hl/contracts';
import { AppError, SystemClock, err, ok, type Clock, type Result } from '@hl/kernel';

import type { LlmClientLogger, LlmNotify } from './llm-process-client.js';

/** Ключ i18n для AI/DISK_FULL (конвенция арх. 05 §29; тексты — TASK-101). */
export const AI_DISK_FULL_MESSAGE_KEY = 'errors.AI_DISK_FULL';
/** Ключ i18n для AI/HASH_MISMATCH. */
export const AI_HASH_MISMATCH_MESSAGE_KEY = 'errors.AI_HASH_MISMATCH';
/** Ключ i18n для AI/DOWNLOAD_BUSY. */
export const AI_DOWNLOAD_BUSY_MESSAGE_KEY = 'errors.AI_DOWNLOAD_BUSY';

/** Суффикс недокачанного файла (§4: <models>/<file>.part). */
const PART_SUFFIX = '.part';
/** Meta-json рядом с .part (§5): {modelId, sha256, total}. */
const META_SUFFIX = '.part.meta.json';

/** Запас свободного места поверх sizeBytes (§5: 100 МБ). */
const DEFAULT_DISK_MARGIN_BYTES = 100 * 1024 * 1024;
/** Интервал throttle прогресс-событий (§15: 250 мс — не флуд в IPC). */
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
/** Автоматических ретраев на сетевые ошибки (§4: затем paused). */
const MAX_RETRIES = 3;
/**
 * Детектор зависшего соединения (§13 «обрыв — норма жизни»: stalled-стрим без
 * данных N мс = обрыв → abort попытки → retry с Range). Дефолт 30 с; тесты
 * подменяют (на части платформ закрытие сокета сервером доходит секунды).
 */
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
/** Бэкофф ретраев (§4: 1/5/25 с; тесты подменяют). */
const DEFAULT_RETRY_BACKOFF_MS: readonly [number, number, number] = [1_000, 5_000, 25_000];

/** Каталог моделей — источник «что можно ставить» (реестр 079, структурно). */
export interface ModelCatalogPort {
  listModels(): ModelDescriptor[];
}

/** Запрос egress-порта (§5: endpoint — URL из манифеста, init — опции fetch). */
export interface ModelEgressRequest {
  readonly endpoint: string;
  readonly init?: RequestInit;
}

/**
 * Порт сети (§5/§14: только через gateway): структурно EgressGateway.request —
 * контейнер передаёт боевой singleton 075, тесты — подмену (§19). Прямой импорт
 * чужого адаптера запрещён (арх. 03 §4) — потому порт здесь, а не тип 075.
 */
export interface ModelEgressPort {
  request(op: string, request: ModelEgressRequest): Promise<Response>;
}

/** Опции ModelStore (§5; всё переопределяемо — тесты §19). */
export interface ModelStoreOptions {
  /** Каталог установки моделей (<userData>/models — арх. 07 §6; параметр — §9). */
  readonly modelsDir: string;
  /** Реестр моделей 079 (каталог-манифест, источник «что можно ставить»). */
  readonly registry: ModelCatalogPort;
  /** EgressGateway 075 (единственная точка сети, D11). */
  readonly egress: ModelEgressPort;
  /** Мост событий ai:progress (§11); по умолчанию — no-op (тесты подставляют spy). */
  readonly notify?: LlmNotify;
  readonly logger?: LlmClientLogger;
  /** Часы (throttle прогресса); по умолчанию SystemClock. */
  readonly clock?: Clock;
  /** Свободно байт на диске каталога (мок fs-статс в тестах, §19); дефолт — statfs. */
  readonly freeDiskBytes?: (dir: string) => number | Promise<number>;
  /** Бэкофф ретраев, мс (§4: 1/5/25 с). */
  readonly retryBackoffMs?: readonly number[];
  /** Интервал throttle прогресса, мс (§15: 250). */
  readonly progressIntervalMs?: number;
  /** Нет данных N мс → обрыв попытки (§13; тесты подменяют). */
  readonly stallTimeoutMs?: number;
  /** Запас места поверх sizeBytes, байт (§5: 100 МБ). */
  readonly diskMarginBytes?: number;
}

/** Активная загрузка (одна, §9). */
interface ActiveDownload {
  readonly modelId: string;
  /** Контроллер ТЕКУЩЕЙ попытки (свежий на каждый HEAD/GET — само-аборт stall-
   * детектора не должен отравлять ретрай); pause() рвёт его (§5). */
  attemptController: AbortController;
  pauseRequested: boolean;
  state: 'downloading' | 'verifying';
  bytesLoaded: number;
  totalBytes: number;
  /** false — сервер без Range (§5: докачка невозможна, отмечаем в состоянии). */
  resumable: boolean;
}

/** HTTP-статус вне ожидаемого — retry-ветка (§13: код — решение потребителя). */
class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`model store: неожиданный HTTP-статус ${String(status)}`);
  }
}

/** Внутренний маркер паузы (не покидает класс — наружу только Result/AppError). */
class DownloadPausedError extends Error {
  constructor() {
    super('model store: загрузка приостановлена пользователем');
  }
}

/** Молчун-логгер (дефолт; боевой внедряет контейнер). */
const SILENT_LOGGER: LlmClientLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Свободное место по умолчанию: statfs каталога (bavail — доступно непривилегированно). */
const defaultFreeDiskBytes = async (dir: string): Promise<number> => {
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** ModelStore (§5): singleton контейнера (проводка — 081). */
export class ModelStore {
  private readonly modelsDir: string;
  private readonly catalog: ModelCatalogPort;
  private readonly egress: ModelEgressPort;
  private readonly notify: LlmNotify;
  private readonly logger: LlmClientLogger;
  private readonly clock: Clock;
  private readonly freeDiskBytes: (dir: string) => number | Promise<number>;
  private readonly retryBackoffMs: readonly number[];
  private readonly progressIntervalMs: number;
  private readonly stallTimeoutMs: number;
  private readonly diskMarginBytes: number;

  private active: ActiveDownload | undefined;
  /** Терминальные ошибки в памяти: modelId → errorKey (сброс — reset()). */
  private readonly errorKeys = new Map<string, string>();
  /** Момент последнего byte-прогресса (throttle §15). */
  private lastProgressAt = 0;

  constructor(options: ModelStoreOptions) {
    this.modelsDir = options.modelsDir;
    this.catalog = options.registry;
    this.egress = options.egress;
    this.notify = options.notify ?? (() => undefined);
    this.logger = options.logger ?? SILENT_LOGGER;
    this.clock = options.clock ?? new SystemClock();
    this.freeDiskBytes = options.freeDiskBytes ?? defaultFreeDiskBytes;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.diskMarginBytes = options.diskMarginBytes ?? DEFAULT_DISK_MARGIN_BYTES;
  }

  /**
   * Скачать модель (§5). Возвращает Result по ЗАВЕРШЕНИИ всего флоу (installed/
   * paused/error); мгновенные отказы (busy/нет в манифесте/нет места) — err до
   * старта сети (§13 AC4). Ход загрузки — события ai:progress и status().
   */
  download(modelId: string): Promise<Result<ModelStatusInfo>> {
    return this.start(modelId);
  }

  /**
   * Продолжить (§5/§13): resume → Range с bytesLoaded (размер .part). Нет .part —
   * начнёт с нуля; при активной загрузке — AI/DOWNLOAD_BUSY (§9).
   */
  resume(modelId: string): Promise<Result<ModelStatusInfo>> {
    return this.start(modelId);
  }

  /**
   * Пауза (§5): закрыть соединение, состояние paused c bytesLoaded (.part
   * сохранён). Идемпотентно: неактивная/чужая модель — no-op.
   */
  pause(modelId: string): void {
    const active = this.active;
    if (active === undefined || active.modelId !== modelId || active.pauseRequested) {
      return;
    }
    active.pauseRequested = true;
    active.attemptController.abort();
    this.logger.info('model download state=paused', {
      modelId,
      state: 'paused',
      bytes: active.bytesLoaded,
    });
  }

  /**
   * Сброс терминального error (§7): error→not_installed, хвосты (.part/meta)
   * удалены. При активной загрузке — no-op (кнопки reset в этом состоянии нет).
   */
  reset(modelId: string): void {
    if (this.active?.modelId === modelId) {
      return;
    }
    this.errorKeys.delete(modelId);
    try {
      const file = this.findFile(modelId);
      if (file !== null) {
        rmSync(this.partPath(file), { force: true });
        rmSync(this.metaPath(file), { force: true });
      }
    } catch {
      // Каталог недоступен для резолва имени — состояние ошибки всё равно снято.
    }
    this.logger.info('model store state=reset', { modelId, state: 'not_installed' });
  }

  /**
   * Статус модели (§5): активная — из памяти; иначе по диску — installed
   * (финальный файл), paused (.part + meta), error (терминальная в памяти),
   * not_installed. Бросает APP/INTERNAL только на побитом манифесте (контракт
   * реестра 079 — отказ списка громкий).
   */
  status(modelId: string): ModelStatusInfo {
    const active = this.active;
    if (active !== undefined && active.modelId === modelId) {
      const info: {
        state: ModelStatus;
        bytesLoaded: number;
        totalBytes: number;
        resumable?: boolean;
      } = {
        state: active.state,
        bytesLoaded: active.bytesLoaded,
        totalBytes: active.totalBytes,
      };
      if (!active.resumable) {
        info.resumable = false;
      }
      return info;
    }
    const file = this.findFile(modelId);
    if (file !== null && existsSync(this.finalPath(file))) {
      return { state: 'installed' };
    }
    const errorKey = this.errorKeys.get(modelId);
    if (errorKey !== undefined) {
      const info: { state: ModelStatus; errorKey: string; bytesLoaded?: number } = {
        state: 'error',
        errorKey,
      };
      if (file !== null && existsSync(this.partPath(file))) {
        info.bytesLoaded = statSync(this.partPath(file)).size;
      }
      return info;
    }
    if (file !== null && existsSync(this.partPath(file))) {
      // Перезапуск приложения с недокачанным .part → paused (§9, AC6).
      const info: {
        state: ModelStatus;
        bytesLoaded: number;
        totalBytes?: number;
      } = { state: 'paused', bytesLoaded: statSync(this.partPath(file)).size };
      const total = readMetaTotal(this.metaPath(file));
      if (total !== undefined) {
        info.totalBytes = total;
      }
      return info;
    }
    return { state: 'not_installed' };
  }

  /** Список установленных моделей (§5): финальный файл на месте. */
  listInstalled(): string[] {
    return this.catalog
      .listModels()
      .filter((model) => {
        this.safeFile(model.file);
        return existsSync(this.finalPath(model.file));
      })
      .map((model) => model.id);
  }

  // --- внутреннее: запуск загрузки ---

  /** Общий вход download/resume: быстрые guard'ы до сети, затем флоу §5. */
  private async start(modelId: string): Promise<Result<ModelStatusInfo>> {
    if (this.active !== undefined) {
      // §9: одна активная загрузка — второй вход отклоняется сразу.
      return err(AppError.of('AI/DOWNLOAD_BUSY', AI_DOWNLOAD_BUSY_MESSAGE_KEY));
    }
    let descriptor: ModelDescriptor | undefined;
    try {
      descriptor = this.catalog.listModels().find((model) => model.id === modelId);
    } catch (cause) {
      return err(
        cause instanceof AppError
          ? cause
          : AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'models-manifest' }, cause),
      );
    }
    if (descriptor === undefined) {
      return err(
        AppError.of('AI/MODEL_NOT_FOUND', 'errors.AI_MODEL_NOT_FOUND', { model: modelId }),
      );
    }
    if (!MODEL_FILE_PATTERN.test(descriptor.file)) {
      // §14 path traversal: манифест-ресурс валиден по схеме 079, но имя файла —
      // последняя линия обороны перед join (коррупция ресурса = громкий отказ).
      return err(
        AppError.of(
          'APP/INTERNAL',
          'errors.internal',
          { reason: 'model-file-name' },
          descriptor.file,
        ),
      );
    }
    // active — до первого await: гонка двух стартов закрыта синхронным guard'ом.
    this.errorKeys.delete(modelId);
    this.lastProgressAt = 0;
    this.active = {
      modelId,
      attemptController: new AbortController(),
      pauseRequested: false,
      state: 'downloading',
      bytesLoaded: 0,
      totalBytes: descriptor.sizeBytes,
      resumable: true,
    };
    try {
      return await this.run(descriptor);
    } catch (cause) {
      this.active = undefined;
      this.logger.error('model store: непредвиденный сбой загрузки', { modelId, cause });
      this.errorKeys.set(modelId, 'errors.internal');
      this.emitState(modelId, 0, descriptor.sizeBytes, 'error');
      return err(
        cause instanceof AppError
          ? cause
          : AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'model-store' }, cause),
      );
    }
  }

  /** Флоу §5 после guard'ов (active уже установлен). */
  private async run(descriptor: ModelDescriptor): Promise<Result<ModelStatusInfo>> {
    // Локальная ссылка: сужение this.active слетает после await (свойство).
    // Единственный владелец очистки this.active в этом флоу — сам run() и его
    // хелперы (finalizePaused/verifyAndInstall) — объект живёт до финализации.
    const active = this.active;
    if (active === undefined) {
      return err(AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'model-store' }));
    }
    const modelId = descriptor.id;
    const filePath = this.finalPath(descriptor.file);
    const partPath = this.partPath(descriptor.file);
    const metaPath = this.metaPath(descriptor.file);

    if (existsSync(filePath)) {
      // Уже установлена — идемпотентный no-op (ensureModel 087).
      this.active = undefined;
      return ok({ state: 'installed' });
    }

    await mkdir(this.modelsDir, { recursive: true });

    // Хвост прошлой загрузки: валидная .part → докачка; чужая/битая → полный рестарт.
    let offset = this.readPartState(partPath, metaPath, descriptor);
    active.bytesLoaded = offset;

    // Место ДО старта (§13): sizeBytes + запас, иначе AI/DISK_FULL (AC4).
    const freeBefore = await this.freeDiskBytes(this.modelsDir);
    if (freeBefore < descriptor.sizeBytes + this.diskMarginBytes) {
      this.active = undefined;
      this.logger.warn('model store: недостаточно места', {
        modelId,
        needed: descriptor.sizeBytes + this.diskMarginBytes,
        free: freeBefore,
      });
      return err(AppError.of('AI/DISK_FULL', AI_DISK_FULL_MESSAGE_KEY));
    }

    // Состояние downloading + стартовый прогресс (UI видит старт сразу).
    active.bytesLoaded = offset;
    this.emitState(modelId, offset, descriptor.sizeBytes, 'downloading');

    // Meta для докачки после перезапуска (§5): total — sizeBytes манифеста
    // (источник истины; HEAD content-length — только транспортная информация).
    await writeFile(
      metaPath,
      JSON.stringify({ modelId, sha256: descriptor.sha256, total: descriptor.sizeBytes }),
    );

    // HEAD (§5): поддержка Range? нет → грузим целиком, докачка невозможна.
    const head = await this.headWithRetries(descriptor);
    if (head === 'paused') {
      return this.finalizePaused(partPath);
    }
    if (head === 'exhausted') {
      this.logger.warn('model store: HEAD недоступен, бюджет ретраев исчерпан — paused', {
        modelId,
      });
      return this.finalizePaused(partPath);
    }
    const rangeSupported = (head.headers.get('accept-ranges') ?? '').includes('bytes');
    active.resumable = rangeSupported;
    if (offset > 0 && !rangeSupported) {
      // §13: сервер без Range → полный рестарт загрузки (хвост не притворяется докачкой).
      await rm(partPath, { force: true });
      await rm(metaPath, { force: true });
      offset = 0;
      active.bytesLoaded = 0;
      this.logger.warn('model store: сервер без Range — полный рестарт', { modelId });
    } else if (offset > descriptor.sizeBytes) {
      // Хвост длиннее заявленного — порчен: рестарт.
      await rm(partPath, { force: true });
      await rm(metaPath, { force: true });
      offset = 0;
      active.bytesLoaded = 0;
    }

    // Цикл Range-запросов (§5) с ретраями §4; полная .part — GET не нужен.
    if (offset < descriptor.sizeBytes) {
      let attempt = 0;
      for (;;) {
        try {
          offset = await this.streamIntoPart(descriptor, partPath, offset);
          break;
        } catch (cause) {
          if (active.pauseRequested || cause instanceof DownloadPausedError) {
            return this.finalizePaused(partPath);
          }
          attempt += 1;
          this.logger.warn('model store: сетевая неудача, retry', {
            modelId,
            attempt,
            cause,
          });
          if (attempt > MAX_RETRIES) {
            // §4/§13: бюджет исчерпан → paused, пользователь продолжает вручную.
            this.logger.warn('model store: бюджет ретраев исчерпан — paused', { modelId });
            return this.finalizePaused(partPath);
          }
          await sleep(this.backoffMs(attempt - 1));
          offset = existsSync(partPath) ? statSync(partPath).size : 0;
          active.bytesLoaded = offset;
        }
      }
    }

    return this.verifyAndInstall(descriptor, partPath, metaPath, filePath, offset);
  }

  /**
   * HEAD с ретраями (§4): ответ | 'paused' (пауза в полёте) | 'exhausted'
   * (бюджет исчерпан — paused, AC по §13).
   */
  private async headWithRetries(
    descriptor: ModelDescriptor,
  ): Promise<Response | 'paused' | 'exhausted'> {
    const active = this.active;
    if (active === undefined) {
      return 'paused';
    }
    for (let attempt = 0; ; attempt += 1) {
      // Свежий контроллер на попытку: пауза/сталл рвут только её (§5).
      const controller = new AbortController();
      active.attemptController = controller;
      try {
        const response = await this.egress.request('models.download', {
          endpoint: descriptor.url,
          init: { method: 'HEAD', signal: controller.signal },
        });
        if (response.ok) {
          return response;
        }
        throw new DownloadHttpError(response.status);
      } catch (cause) {
        if (active.pauseRequested) {
          return 'paused';
        }
        this.logger.warn('model store: HEAD не удался, retry', {
          modelId: descriptor.id,
          attempt: attempt + 1,
          cause,
        });
        if (attempt >= MAX_RETRIES) {
          return 'exhausted';
        }
        await sleep(this.backoffMs(attempt));
      }
    }
  }

  /**
   * Один Range-запрос до конца ответа (§5): append в .part, прогресс throttle
   * 250 мс. 200 при offset>0 — сервер проигнорировал Range: truncate и рестарт
   * с нуля (§13); иной не-206/не-200 — retry-ветка.
   */
  private async streamIntoPart(
    descriptor: ModelDescriptor,
    partPath: string,
    offset: number,
  ): Promise<number> {
    const active = this.active;
    if (active === undefined) {
      throw new DownloadPausedError();
    }
    // Свежий контроллер на попытку (§5): пауза рвёт текущую; само-аборт stall-
    // детектора не отравляет следующую попытку (ретрай с новым offset).
    const controller = new AbortController();
    active.attemptController = controller;
    const headers: Record<string, string> = {};
    if (offset > 0) {
      headers.range = `bytes=${String(offset)}-`;
    }
    const response = await this.egress.request('models.download', {
      endpoint: descriptor.url,
      init: { method: 'GET', headers, signal: controller.signal },
    });
    if (!response.ok) {
      throw new DownloadHttpError(response.status);
    }
    if (response.status === 200 && offset > 0) {
      await truncate(partPath, 0);
      offset = 0;
      active.bytesLoaded = 0;
      this.logger.warn('model store: Range проигнорирован (200) — рестарт с нуля', {
        modelId: descriptor.id,
      });
    } else if (response.status !== 206 && offset > 0) {
      throw new DownloadHttpError(response.status);
    }
    const body = response.body;
    if (body === null) {
      throw new DownloadHttpError(response.status);
    }
    // Stall-детектор (§13): нет данных stallTimeoutMs → обрыв попытки (abort);
    // таймер перевооружается на каждый чанк, снят в finally.
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = (): void => {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
      }
      stallTimer = setTimeout(() => {
        this.logger.warn('model store: нет данных дольше stallTimeout — обрыв попытки', {
          modelId: descriptor.id,
          stallTimeoutMs: this.stallTimeoutMs,
        });
        controller.abort();
      }, this.stallTimeoutMs);
    };
    try {
      armStall();
      for await (const chunk of body) {
        if (active.pauseRequested) {
          throw new DownloadPausedError();
        }
        armStall();
        const bytes = chunk as Uint8Array;
        await appendFile(partPath, bytes);
        offset += bytes.byteLength;
        active.bytesLoaded = offset;
        this.emitState(descriptor.id, offset, active.totalBytes, 'downloading');
      }
    } finally {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
      }
    }
    return offset;
  }

  /**
   * Верификация и установка (§5): sha256 потоково → mismatch: удалить .part/meta,
   * error + AI/HASH_MISMATCH (AC3, RESET-возможность через reset()); место ПЕРЕД
   * финальным rename (§13) → rename той же ФС (атомарно, §3) → installed.
   */
  private async verifyAndInstall(
    descriptor: ModelDescriptor,
    partPath: string,
    metaPath: string,
    filePath: string,
    bytesLoaded: number,
  ): Promise<Result<ModelStatusInfo>> {
    const active = this.active;
    if (active === undefined) {
      return err(AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'model-store' }));
    }
    active.state = 'verifying';
    this.emitState(descriptor.id, bytesLoaded, active.totalBytes, 'verifying');
    this.logger.info('model download state=verifying', {
      modelId: descriptor.id,
      state: 'verifying',
      bytes: bytesLoaded,
    });

    const actualSha256 = await this.sha256File(partPath);
    if (actualSha256 !== descriptor.sha256) {
      // §13: не хламим диск — .part/meta удалены; error терминален до reset().
      await rm(partPath, { force: true });
      await rm(metaPath, { force: true });
      this.active = undefined;
      this.errorKeys.set(descriptor.id, AI_HASH_MISMATCH_MESSAGE_KEY);
      this.logger.error('model store: sha256 mismatch — .part удалена', { modelId: descriptor.id });
      this.emitState(descriptor.id, 0, active.totalBytes, 'error');
      return err(
        AppError.of('AI/HASH_MISMATCH', AI_HASH_MISMATCH_MESSAGE_KEY, { model: descriptor.file }),
      );
    }

    // Место перед финальным rename (§13): нет места — .part сохранена, resume
    // досматривает (verify → rename) после освобождения диска.
    const free = await this.freeDiskBytes(this.modelsDir);
    if (free < descriptor.sizeBytes + this.diskMarginBytes) {
      this.active = undefined;
      this.errorKeys.set(descriptor.id, AI_DISK_FULL_MESSAGE_KEY);
      this.logger.warn('model store: нет места перед rename — error, .part сохранена', {
        modelId: descriptor.id,
      });
      this.emitState(descriptor.id, bytesLoaded, active.totalBytes, 'error');
      return err(AppError.of('AI/DISK_FULL', AI_DISK_FULL_MESSAGE_KEY));
    }

    await rename(partPath, filePath);
    await rm(metaPath, { force: true });
    this.active = undefined;
    this.logger.info('model download state=installed', {
      modelId: descriptor.id,
      state: 'installed',
      bytes: bytesLoaded,
    });
    this.emitState(descriptor.id, bytesLoaded, active.totalBytes, 'installed');
    return ok({ state: 'installed' });
  }

  /** Финализация paused (§5): bytesLoaded = размер .part; событие + ok. */
  private finalizePaused(partPath: string): Result<ModelStatusInfo> {
    const active = this.active;
    if (active === undefined) {
      return err(AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'model-store' }));
    }
    const size = existsSync(partPath) ? statSync(partPath).size : 0;
    this.active = undefined;
    this.emitState(active.modelId, size, active.totalBytes, 'paused');
    const info: {
      state: ModelStatus;
      bytesLoaded: number;
      totalBytes: number;
      resumable?: boolean;
    } = { state: 'paused', bytesLoaded: size, totalBytes: active.totalBytes };
    if (!active.resumable) {
      info.resumable = false;
    }
    return ok(info);
  }

  // --- внутреннее: диск и состояние .part ---

  /**
   * Валидный хвост прошлой загрузки: размер .part или 0 (с удалением чужого/
   * битого хвоста — meta {modelId, sha256} обязана совпадать с манифестом, §5).
   */
  private readPartState(partPath: string, metaPath: string, descriptor: ModelDescriptor): number {
    if (!existsSync(partPath)) {
      return 0;
    }
    let meta: { modelId?: unknown; sha256?: unknown } | undefined;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
        modelId?: unknown;
        sha256?: unknown;
      };
    } catch {
      meta = undefined;
    }
    const valid =
      meta !== undefined && meta.modelId === descriptor.id && meta.sha256 === descriptor.sha256;
    if (!valid) {
      // Чужой/битый хвост: полный рестарт (недокачанное не притворяется докачкой).
      rmSync(partPath, { force: true });
      rmSync(metaPath, { force: true });
      this.logger.warn('model store: хвост .part невалиден — рестарт', { modelId: descriptor.id });
      return 0;
    }
    return statSync(partPath).size;
  }

  /** sha256 потоково (§5): файл читается стримом — 2–3 ГБ без буферизации. */
  private async sha256File(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Uint8Array);
    }
    return hash.digest('hex');
  }

  private partPath(file: string): string {
    return join(this.modelsDir, file + PART_SUFFIX);
  }

  private metaPath(file: string): string {
    return join(this.modelsDir, file + PART_SUFFIX + META_SUFFIX);
  }

  private finalPath(file: string): string {
    return join(this.modelsDir, file);
  }

  /** Имя файла по id из реестра (с валидацией §14); null — модели нет в манифесте. */
  private findFile(modelId: string): string | null {
    const descriptor = this.catalog.listModels().find((model) => model.id === modelId);
    if (descriptor === undefined) {
      return null;
    }
    return this.safeFile(descriptor.file);
  }

  /** §14: имя файла манифеста → безопасное имя или громкий APP/INTERNAL. */
  private safeFile(file: string): string {
    if (!MODEL_FILE_PATTERN.test(file)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт ошибок TASK-006; прецедент llm-process-client/sqlite.ts)
      throw AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'model-file-name' }, file);
    }
    return file;
  }

  /** Бэкофф попытки (§4: 1/5/25 с; вне диапазона — последний). */
  private backoffMs(attempt: number): number {
    const last = this.retryBackoffMs[this.retryBackoffMs.length - 1] ?? 25_000;
    if (attempt < 0 || attempt >= this.retryBackoffMs.length) {
      return last;
    }
    return this.retryBackoffMs[attempt] ?? last;
  }

  /**
   * ai:progress (§11). Byte-прогресс (downloading) — throttle 250 мс (§15, AC5:
   * ≤4/сек); смены состояний (verifying/installed/paused/error) — сразу.
   * Отказ моста не рвёт загрузку (прецедент setState 076).
   */
  private emitState(
    modelId: string,
    downloadedBytes: number,
    totalBytes: number,
    state: ModelStatus,
  ): void {
    if (state === 'downloading') {
      const now = this.clock.nowMs();
      if (now - this.lastProgressAt < this.progressIntervalMs) {
        return;
      }
      this.lastProgressAt = now;
    }
    try {
      this.notify('ai:progress', { modelId, downloadedBytes, totalBytes, state });
    } catch (cause) {
      this.logger.debug('model store: ai:progress не доставлен', { modelId, state, cause });
    }
  }
}

// --- вспомогательные функции уровня модуля ---

/** total из meta-json; битый/чужой meta — undefined (статус честно без total). */
function readMetaTotal(metaPath: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (typeof raw === 'object' && raw !== null) {
      const total = (raw as { total?: unknown }).total;
      if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
        return total;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
