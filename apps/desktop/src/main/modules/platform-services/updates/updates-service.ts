/**
 * TASK-096 §2/§5: UpdatesService — electron-updater в ручном режиме за согласием
 * (NFR-11): даже проверка обновлений — сетевой след (IP), поэтому каждый сетевой
 * шаг разрешён и журналирован через EgressGateway.
 *
 * ПАЙПЛАЙН ПРОВЕРКИ (§9): consent+политика → gateway.checkPermission('updates.check')
 * (отказ — blocked-запись уже в журнале, наружу NET/BLOCKED_BY_POLICY — мгновенный
 * видимый отказ §24) → throttle backoff (после ОШИБКИ повтор не чаще 10 мин, §13)
 * → journal.start(feedUrl) (running) → adapter.checkForUpdates() → события →
 * journal-end (ok/failed). Ошибка сети → ответ {status: 'error'} — НЕ креш и не
 * тост-спам (§9), журнал failed.
 *
 * ЧЕСТНАЯ МОДЕЛЬ СЕТИ (§4): electron-updater выполняет трафик сам — через
 * gateway.request() его физически не провести; разрешение и журнал — здесь
 * (gateway.checkPermission + gateway-journal), вызов updater'а — ТОЛЬКО после
 * allowed. Байты updater-трафика gateway не наблюдаемы — в журнале NULL (§22,
 * аудиторская оговорка TASK-106; факт проверки и исход журнал фиксирует).
 *
 * РЕШЕНИЯ §5:
 *  - скачивание покрывается тем же согласием updatesCheck (один флаг, текст
 *    согласия упоминает и загрузку — UI 097/099); download() проходит ту же
 *    проверку разрешения/журнала;
 *  - quitAndInstall — только по явной кнопке (канал updates/install; consent не
 *    нужен — операция локальная); без скачанного обновления — отказ UPD/NOT_READY
 *    (§13/AC6); перезапуск выполняет сам updater;
 *  - авто-проверка — задача JobScheduler `updates.check` (createUpdatesCheckJob):
 *    БЕЗ согласия тик молчит (проверка согласия внутри задачи — журнал/сеть не
 *    трогаются), С согласием — интервал 24 ч. ОТКЛОНЕНИЕ ОТ БУКВЫ §5
 *    («runOnStart=true») ЗАФИКСИРОВАНО: в каркасе 074 комбинация runOnStart +
 *    intervalMs ведёт себя как runOnStart (запуск на КАЖДОМ тике), что ломает
 *    AC §20 «проверка раз в 24 ч (FixedClock)»; задача intervalMs-only даёт
 *    семантику «первый тик после старта — проверка, далее не чаще раза в 24 ч».
 *
 * СОБЫТИЯ (§11): update:available {version}, update:progress {percent},
 * update:ready — боевой мост notify (broadcastToWindows); снапшот статуса §7
 * (UpdateStatus) — единое состояние для UI (097).
 *
 * ТЕСТИРУЕМОСТЬ (§19): сеть updater'а за интерфейсом-обёрткой UpdatesAdapter —
 * тесты подставляют мок; боевой адаптер — wireElectronUpdater (конфиг §4/§14:
 * autoDownload=false, disableWebInstaller=true — никаких фоновых загрузок, AC3)
 * над структурной поверхностью electron-updater; createDefaultUpdatesAdapter
 * резолвит autoUpdater ЛЕНИВО при первом использовании (сборка графа идёт и в
 * node-vitest — прецедент createDefaultEgressFetch).
 *
 * СОСТОЯНИЕ (§12): снапшот и lastFailureAtUtc — в памяти main (перезапуск сбрасывает;
 * авто-проверка 24 ч и ручная проверка восстанавливают актуальность). Персистентность
 * не требуется: подпись/фид — TASK-104, ошибка проверки — исход канала, не состояние.
 */
import { AppError, type Clock } from '@hl/kernel';
import { NET_BLOCKED_BY_POLICY_MESSAGE_KEY, EgressGateway, type EgressNotify } from '../egress/egress-gateway.js';
import type { HlLogger } from '../../../shared/logger/logger.js';
import type {
  JobCtx,
  JobDefinition,
  JobShowAction,
} from '../../../shared/scheduler/scheduler.js';
import type { UpdatesInstallResponse, UpdatesStatusResponse } from '@hl/contracts';

/** Имя сетевой операции белого списка (EgressPolicy 075) и журнала (§18). */
export const UPDATES_CHECK_OP = 'updates.check';

/** Ключ i18n-каталога для UPD/NOT_READY (конвенция арх. 05 §29; тексты — TASK-101). */
export const UPD_NOT_READY_MESSAGE_KEY = 'errors.UPD_NOT_READY';

/** Backoff повторной проверки ПОСЛЕ ошибки (§13): не чаще раза в 10 минут. */
export const UPDATES_CHECK_RETRY_THROTTLE_MS = 10 * 60 * 1000;

/** Имя задачи авто-проверки в реестре scheduler'а и ключ lastRun в prefs.jobState.jobs (§5). */
export const UPDATES_CHECK_JOB_NAME = 'updates.check';

/** Интервал авто-проверки при согласии (§5/§20 AC4): 24 часа. */
export const UPDATES_AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Состояние обновления в снапшоте статуса (§7 — единый снимок для UI). */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'latest'
  | 'downloading'
  | 'ready'
  | 'error';

/** Снапшот статуса обновления (§7): state + версия/прогресс, когда есть. */
export interface UpdateStatus {
  readonly state: UpdateState;
  readonly version?: string;
  /** Процент загрузки 0..100 (state=downloading). */
  readonly progress?: number;
}

/** Исход проверки обновления (маппинг результата updater'а, §19). */
export interface UpdateCheckOutcome {
  readonly available: boolean;
  /** Версия доступного/актуального обновления из фида (если отдал updater). */
  readonly version?: string;
}

/**
 * Интерфейс-обёртка updater'а (§19): вся работа с electron-updater — за этим
 * портом; тесты подставляют мок. Все методы async — ленивый боевой адаптер
 * резолвится при первом использовании.
 */
export interface UpdatesAdapter {
  /** URL фида обновлений (журнал/лента — §18); '' — фид не настроен (до TASK-104). */
  getFeedUrl(): Promise<string>;
  /** Проверка обновления; сетевая неудача — reject (сервис маппит в {status:'error'}). */
  checkForUpdates(): Promise<UpdateCheckOutcome>;
  /** Загрузка; резолв — после update-downloaded; неудача — reject. */
  downloadUpdate(): Promise<void>;
  /** Установка + перезапуск (делает сам updater); вызов — только при state=ready (§13). */
  quitAndInstall(): Promise<void>;
  onAvailable(listener: (version: string) => void): void;
  onNotAvailable(listener: () => void): void;
  onDownloadProgress(listener: (percent: number) => void): void;
  onDownloaded(listener: (version: string) => void): void;
  onError(listener: (cause: unknown) => void): void;
}

/** Зависимости сервиса (§5): сборка — контейнер, подмена — тесты (§19). */
export interface UpdatesServiceDeps {
  readonly adapter: UpdatesAdapter;
  readonly gateway: EgressGateway;
  readonly clock: Clock;
  readonly logger: HlLogger;
  /** Мост событий renderer'у (§11): боевой broadcastToWindows / fake в тестах. */
  readonly notify: EgressNotify;
}

/** UpdatesService (§5): singleton контейнера; каналы updates/* — потребители (§11). */
export class UpdatesService {
  private readonly deps: UpdatesServiceDeps;
  private status: UpdateStatus = { state: 'idle' };
  /** Момент последней НЕУДАЧНОЙ проверки (backoff §13); undefined — ошибок не было. */
  private lastFailureAtUtc: number | undefined;

  constructor(deps: UpdatesServiceDeps) {
    this.deps = deps;
    // События updater'а → снапшот §7 + события рендереру (§11). Боевой autoUpdater
    // эмитит их сам в ходе check/download; дублирования нет — check() результат
    // канала маппит из исхода, не из события.
    deps.adapter.onAvailable((version) => {
      this.status = { state: 'available', version };
      this.deps.logger.info('update available', { version });
      this.deps.notify('update:available', { version });
    });
    deps.adapter.onNotAvailable(() => {
      this.status = { state: 'latest' };
      this.deps.logger.info('update not available');
    });
    deps.adapter.onDownloadProgress((percent) => {
      this.status = { state: 'downloading', progress: percent };
      this.deps.notify('update:progress', { percent });
    });
    deps.adapter.onDownloaded((version) => {
      this.status = { state: 'ready', version };
      this.deps.logger.info('update downloaded', { version });
      this.deps.notify('update:ready', {});
    });
    deps.adapter.onError((cause) => {
      this.status = { state: 'error' };
      this.deps.logger.warn('updater error', { cause });
    });
  }

  /** Снапшот статуса (§7): единое состояние для UI (097). */
  getStatus(): UpdateStatus {
    return this.status;
  }

  /**
   * Проверка обновления (§9): разрешение/журнал gateway → throttle backoff →
   * adapter.checkForUpdates. Отказ политики/согласия — AppError
   * NET/BLOCKED_BY_POLICY (мгновенный видимый отказ, §24); сетевая неудача —
   * {status: 'error'} без креша (§9/AC5).
   */
  async check(): Promise<UpdatesStatusResponse> {
    const permission = await this.deps.gateway.checkPermission(UPDATES_CHECK_OP);
    if (!permission.allowed) {
      // §13: без согласия — blocked (запись уже в журнале gateway'ем).
      throw AppError.of('NET/BLOCKED_BY_POLICY', NET_BLOCKED_BY_POLICY_MESSAGE_KEY, {
        op: UPDATES_CHECK_OP,
      });
    }
    const nowMs = this.deps.clock.nowMs();
    if (
      this.lastFailureAtUtc !== undefined &&
      nowMs - this.lastFailureAtUtc < UPDATES_CHECK_RETRY_THROTTLE_MS
    ) {
      // §13: backoff после ошибки — сеть и журнал не трогаем (дублей нет).
      this.deps.logger.info('update check throttled', { kind: UPDATES_CHECK_OP });
      return { status: 'error' };
    }
    const endpoint = await this.deps.adapter.getFeedUrl().catch(() => '');
    permission.journal.start(endpoint);
    this.status = { state: 'checking' };
    try {
      const outcome = await this.deps.adapter.checkForUpdates();
      permission.journal.ok(); // байты updater-а не наблюдаемы — NULL (§22)
      if (outcome.available && outcome.version !== undefined) {
        this.status = { state: 'available', version: outcome.version };
        return { status: 'available', version: outcome.version };
      }
      this.status = { state: 'latest' };
      return { status: 'latest' };
    } catch (cause) {
      this.lastFailureAtUtc = this.deps.clock.nowMs();
      permission.journal.failed();
      this.status = { state: 'error' };
      this.deps.logger.warn('update check failed', { kind: UPDATES_CHECK_OP, cause });
      return { status: 'error' };
    }
  }

  /**
   * Загрузка обновления (§5 РЕШЕНИЕ: то же согласие updatesCheck — текст согласия
   * упоминает и загрузку): разрешение/журнал — как у check; ход — событиями
   * update:progress, финал — {status: 'ready'}. При state=ready — идемпотентный
   * ответ без сети (§13).
   */
  async download(): Promise<UpdatesStatusResponse> {
    if (this.status.state === 'ready') {
      return { status: 'ready', version: this.status.version };
    }
    const permission = await this.deps.gateway.checkPermission(UPDATES_CHECK_OP);
    if (!permission.allowed) {
      throw AppError.of('NET/BLOCKED_BY_POLICY', NET_BLOCKED_BY_POLICY_MESSAGE_KEY, {
        op: UPDATES_CHECK_OP,
      });
    }
    const endpoint = await this.deps.adapter.getFeedUrl().catch(() => '');
    permission.journal.start(endpoint);
    this.status = { state: 'downloading', progress: 0 };
    try {
      await this.deps.adapter.downloadUpdate();
      permission.journal.ok();
      // Версию фиксирует событие update-downloaded (боевой updater эмитит его до резолва).
      return this.status.state === 'ready' && this.status.version !== undefined
        ? { status: 'ready', version: this.status.version }
        : { status: 'ready' };
    } catch (cause) {
      permission.journal.failed();
      this.status = { state: 'error' };
      this.deps.logger.warn('update download failed', { kind: UPDATES_CHECK_OP, cause });
      return { status: 'error' };
    }
  }

  /**
   * Установка обновления (§5: только по явной кнопке; consent не нужен — операция
   * локальная). Без скачанного обновления — отказ UPD/NOT_READY (§13/AC6); сам
   * перезапуск выполняет updater (§13).
   */
  async install(): Promise<UpdatesInstallResponse> {
    if (this.status.state !== 'ready') {
      throw AppError.of('UPD/NOT_READY', UPD_NOT_READY_MESSAGE_KEY);
    }
    await this.deps.adapter.quitAndInstall();
    return { restarting: true };
  }
}

/** Зависимости задачи авто-проверки (§5): сама проверка — порт (UpdatesService). */
export interface UpdatesCheckJobDeps {
  /** Проверка за согласием (боевой — UpdatesService.check; отказ пробрасывается — изолирует scheduler 074 §9). */
  readonly check: () => Promise<unknown>;
}

/**
 * Задача авто-проверки `updates.check` (§5/§20 AC4): intervalMs 24 ч (СМ. ШАПКУ —
 * отклонение от буквы «runOnStart=true» зафиксировано: первый тик после старта
 * приложения и есть первая проверка, далее не чаще раза в 24 ч). Без согласия
 * задача молчит — согласие читается из ctx.prefs (срез на момент тика), ни сеть,
 * ни журнал не трогаются (§5 «задача сама молчит»).
 */
export function createUpdatesCheckJob(deps: UpdatesCheckJobDeps): JobDefinition {
  return {
    name: UPDATES_CHECK_JOB_NAME,
    intervalMs: UPDATES_AUTO_CHECK_INTERVAL_MS,
    run: async (ctx: JobCtx): Promise<JobShowAction | null> => {
      if (ctx.prefs.netConsents.updatesCheck !== true) {
        return null; // §5: без согласия — тишина (это не blocked: авто-проверки нет)
      }
      await deps.check();
      return null;
    },
  };
}

/**
 * Минимальная структурная поверхность electron-updater (§19): достаточно для
 * ручного режима; остальное API updater'а сервису недоступно (порт сужает).
 */
export interface ElectronUpdaterLike {
  autoDownload: boolean;
  disableWebInstaller: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  /** URL фида; null/undefined — не настроен (до TASK-104). */
  getFeedURL(): string | null | undefined;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Версия из payload события updater'а ({version: string}); нестроковое — undefined. */
function versionOf(info: unknown): string | undefined {
  const version = (info as { version?: unknown } | null | undefined)?.version;
  return typeof version === 'string' && version.length > 0 ? version : undefined;
}

/**
 * Боевой адаптер: конфиг и маппинг electron-updater к UpdatesAdapter (§4/§14/§19).
 * КОНФИГ (AC3): autoDownload=false — никаких фоновых загрузок; disableWebInstaller=
 * true — веб-инсталлятор выключен. События пробрасываются подписчикам сервиса.
 */
export function wireElectronUpdater(updater: ElectronUpdaterLike, logger: HlLogger): UpdatesAdapter {
  updater.autoDownload = false; // §4/§14: ручной режим целиком
  updater.disableWebInstaller = true; // §4: веб-инсталлятор выключен
  logger.debug('updater wired: ручной режим (autoDownload=false, disableWebInstaller=true)');
  return {
    async getFeedUrl(): Promise<string> {
      const url = updater.getFeedURL();
      return typeof url === 'string' ? url : '';
    },
    async checkForUpdates(): Promise<UpdateCheckOutcome> {
      const result = (await updater.checkForUpdates()) as {
        isUpdateAvailable?: unknown;
        updateInfo?: unknown;
      } | null;
      if (result === null || result.isUpdateAvailable !== true) {
        return { available: false };
      }
      return { available: true, version: versionOf(result.updateInfo) };
    },
    async downloadUpdate(): Promise<void> {
      await updater.downloadUpdate();
    },
    async quitAndInstall(): Promise<void> {
      updater.quitAndInstall();
    },
    onAvailable(listener: (version: string) => void): void {
      updater.on('update-available', (...args: unknown[]) => {
        const version = versionOf(args[0]);
        if (version !== undefined) {
          listener(version);
        }
      });
    },
    onNotAvailable(listener: () => void): void {
      updater.on('update-not-available', () => listener());
    },
    onDownloadProgress(listener: (percent: number) => void): void {
      updater.on('download-progress', (...args: unknown[]) => {
        const percent = (args[0] as { percent?: unknown } | null | undefined)?.percent;
        if (typeof percent === 'number') {
          listener(percent);
        }
      });
    },
    onDownloaded(listener: (version: string) => void): void {
      updater.on('update-downloaded', (...args: unknown[]) => {
        const version = versionOf(args[0]);
        if (version !== undefined) {
          listener(version);
        }
      });
    },
    onError(listener: (cause: unknown) => void): void {
      updater.on('error', (...args: unknown[]) => listener(args[0]));
    },
  };
}

/**
 * Дефолтный (боевой) адаптер: electron-updater резолвится ЛЕНИВО при первом
 * использовании (§19-прецедент createDefaultEgressFetch — сборка графа идёт и в
 * node-vitest, где autoUpdater отсутствует); подписки на события накапливаются и
 * навешиваются после резолва (сервис подписывается в конструкторе — до первого
 * вызова сети).
 */
export function createDefaultUpdatesAdapter(logger: HlLogger): UpdatesAdapter {
  const subscriptions: Array<(adapter: UpdatesAdapter) => void> = [];
  let wired: Promise<UpdatesAdapter> | undefined;
  const resolve = (): Promise<UpdatesAdapter> => {
    wired ??= (async (): Promise<UpdatesAdapter> => {
      const electronUpdater = (await import('electron-updater')) as unknown as {
        autoUpdater?: ElectronUpdaterLike;
      };
      const autoUpdater = electronUpdater.autoUpdater;
      if (autoUpdater === undefined) {
        // Не Electron-рантайм (node-vitest/тесты) — честный отказ при ВЫЗОВЕ,
        // не тихий сбой (прецедент createDefaultVault VAULT/UNAVAILABLE).
        throw AppError.of('APP/INTERNAL', 'errors.internal', { reason: 'updater-unavailable' });
      }
      const adapter = wireElectronUpdater(autoUpdater, logger);
      for (const apply of subscriptions.splice(0, subscriptions.length)) {
        apply(adapter);
      }
      return adapter;
    })();
    return wired;
  };
  return {
    getFeedUrl: () => resolve().then((adapter) => adapter.getFeedUrl()),
    checkForUpdates: () => resolve().then((adapter) => adapter.checkForUpdates()),
    downloadUpdate: () => resolve().then((adapter) => adapter.downloadUpdate()),
    quitAndInstall: () => resolve().then((adapter) => adapter.quitAndInstall()),
    onAvailable: (listener) => {
      subscriptions.push((adapter) => adapter.onAvailable(listener));
    },
    onNotAvailable: (listener) => {
      subscriptions.push((adapter) => adapter.onNotAvailable(listener));
    },
    onDownloadProgress: (listener) => {
      subscriptions.push((adapter) => adapter.onDownloadProgress(listener));
    },
    onDownloaded: (listener) => {
      subscriptions.push((adapter) => adapter.onDownloaded(listener));
    },
    onError: (listener) => {
      subscriptions.push((adapter) => adapter.onError(listener));
    },
  };
}
