/**
 * TASK-075 §2/§5: EgressGateway — ЕДИНСТВЕННАЯ точка сети приложения (D11, арх. 08
 * §5, FR-7.1/7.3). BG-2 «нулевого сетевого следа» проверяем аудитом одного файла:
 * весь трафик обязан идти через request(), прямые fetch/node:http(s) вне каталога
 * egress/ запрещены ESLint-правилом (§5, зона-исключение — каталог egress и только он).
 *
 * ПАЙПЛАЙН request(op, {endpoint, init}) (§5):
 *   1. op в ALLOWED EgressPolicy? нет → AppError NET/BLOCKED_BY_POLICY {op};
 *   2. согласие prefs.netConsents[consentKey]? нет → тот же отказ (БЫСТРЫЙ, ДО
 *      сети — §9); согласия перечитываются на КАЖДЫЙ запрос (§14: отмена согласия
 *      мгновенно блокирует следующий);
 *   3. журнал network_event (v5): запись running → выполнение → обновление
 *      status/bytes/at ТОЙ ЖЕ записи (не дублирование);
 *   4. событие net:activity {kind, endpoint} renderer'у (мост broadcast, §11) —
 *      лента приватности в реальном времени (FR-7.1); доставляется на все ветки,
 *      журнал и лента показывают одно и то же (включая blocked, §9).
 *
 * Ветки §13: вне списка → blocked; нет согласия → blocked; согласие есть → ok;
 * сетевая ошибка → failed, ошибка ПРОБРАСЫВАЕТСЯ вызывающему (сырая причина —
 * маппинг в NET/*-коды — дело потребителей TASK-080/096; наружу из gateway идёт
 * только NET/BLOCKED_BY_POLICY).
 *
 * TASK-096 §4/§6: для потребителей, чья сеть выполняется ВНУТРИ стороннего
 * исполнителя (electron-updater — через request() физически не провести), —
 * checkPermission(op): решение политики/согласия (те же ветки §13, отказ —
 * blocked-запись и лента) + gateway-journal API {start → ok|failed} для записи
 * исхода операции, которую потребитель выполняет САМ после allowed (сеть
 * наблюдаема, но инициируем и журналируем мы — аудиторская оговорка §22 TASK-096).
 *
 * Журнал — ТОЛЬКО метаданные (kind/endpoint/status/bytes/at, §7): URL не содержит
 * PHI (эндпоинты — CDN моделей/сервер обновлений); тела запросов/ответов не
 * журналируются никогда. bytes — content-length ответа, если отдаёт; иначе NULL
 * (читать тело ради счётчика запрещено: Response возвращён вызывающему нечитанным).
 * HTTP-статус ответа не failing: failed — только сетевая неудача (транспорт), код
 * ответа — решение потребителя (§13).
 *
 * Исполнитель запроса (§4): боевой — net.fetch Electron (уважает прокси ОС),
 * ленивый импорт (§20-прецедент: сборка контейнера в node-vitest без electron);
 * в тесты fetch подставляется — на мок-сервер идёт РЕАЛЬНЫЙ трафик (§19).
 *
 * Согласия (§14) — read-only порт над prefs (TASK-047); TLS всегда: http-эндпоинтов
 * в политике нет (локальный мок-сервер тестов — не политика).
 *
 * Лог (§18): категория net — запрос и исход (kind/status/bytes/durationMs), дублирует
 * ключевые события журнала; без PHI.
 */
import { v7 as uuidV7 } from 'uuid';

import type { HlEventMap, NetConsents } from '@hl/contracts';
import { AppError, type Clock } from '@hl/kernel';

import type { HlLogger } from '../../../shared/logger/logger.js';
import type { EncryptedDatabase } from '../../../shared/db/sqlite.js';
import {
  EgressPolicy,
  NET_BLOCKED_BY_POLICY_MESSAGE_KEY,
  type EgressPolicyEntry,
} from './egress-policy.js';

/** Исполнитель запроса (§4): endpoint — строка-URL из политики потребителя. */
export type EgressFetch = (endpoint: string, init?: RequestInit) => Promise<Response>;

/**
 * Доставка событий renderer'у (§11): структурно BroadcastToWindows TASK-009 —
 * подмена в тестах (fake-окно) и боевой мост в контейнере.
 */
export type EgressNotify = <K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]) => void;

/** Параметры запроса (§5): endpoint обязателен, init — опции fetch. */
export interface EgressRequest {
  readonly endpoint: string;
  readonly init?: RequestInit;
}

/** Статус записи журнала (§5/§13): жизненный цикл running → ok|failed; blocked — отказ ДО сети. */
export type NetworkEventStatus = 'running' | 'ok' | 'failed' | 'blocked';

/** Запись журнала сети (§5/§7 — только метаданные, без PHI). */
export interface NetworkEventRow {
  readonly id: string;
  /** Имя операции (ALLOWED или отклонённое — для честности журнала, §9). */
  readonly kind: string;
  readonly endpoint: string;
  readonly status: NetworkEventStatus;
  /** Байты ответа (content-length); NULL — blocked/failed/без заголовка. */
  readonly bytes: number | null;
  /** Момент записи (старт запроса; обновляется по завершении), epoch ms. */
  readonly atUtc: number;
}

/**
 * Журнал ОДНОЙ разрешённой операции вне request() (TASK-096 §6 «gateway-journal
 * API»): жизненный цикл записи тот же, что у request() — running → ok|failed,
 * обновляется ОДНА строка network_event (§5 п. 3). Контракт строгий (§13,
 * прецедент listRecent): нарушение порядка вызовов — TypeError.
 */
export interface EgressOperationJournal {
  /** Открывает running-запись (endpoint — адрес сервера обновлений/фид). */
  start(endpoint: string): void;
  /** Успешный исход; bytes — если наблюдаемы (updater-трафик внутренний — NULL, §22 TASK-096). */
  ok(bytes?: number | null): void;
  /** Сетевая неудача операции. */
  failed(): void;
}

/**
 * Решение политики/согласия без выполнения запроса (TASK-096 §4/§6): потребитель,
 * чья сеть идёт внутри стороннего исполнителя (electron-updater), получает
 * разрешение здесь и вызывает сеть САМ — только после allowed. При отказе
 * blocked-запись и лента уже написаны checkPermission'ом (честность журнала, §9),
 * journal — строгая заглушка.
 */
export interface EgressPermission {
  /** true — операция в белом списке И согласие выдано; false — отказ (запись blocked уже в журнале). */
  readonly allowed: boolean;
  /** Журналирование разрешённой операции; при allowed=start обязателен до ok/failed. */
  readonly journal: EgressOperationJournal;
}

/** Зависимости gateway (§5): сборка — контейнер, подмена — тесты (§19). */
export interface EgressGatewayDeps {
  readonly db: EncryptedDatabase;
  readonly clock: Clock;
  readonly logger: HlLogger;
  /** Согласия — read-only срез prefs.netConsents (§14; TASK-047). */
  readonly consents: () => Promise<NetConsents>;
  /** Исполнитель запроса: боевой net.fetch (§4) / подмена тестов (§19). */
  readonly fetch: EgressFetch;
  /** Мост событий renderer'у (§11): боевой broadcastToWindows / fake в тестах. */
  readonly notify: EgressNotify;
}

/** SQL журнала: statements готовятся один раз (§15: обёртка над fetch, дёшево). */
const INSERT_EVENT_SQL =
  'INSERT INTO network_event (id, kind, endpoint, status, bytes, at_utc) VALUES (?, ?, ?, ?, ?, ?)';
const FINISH_SQL = 'UPDATE network_event SET status = ?, bytes = ?, at_utc = ? WHERE id = ?';
const LIST_RECENT_SQL =
  'SELECT id, kind, endpoint, status, bytes, at_utc FROM network_event ' +
  'ORDER BY at_utc DESC, id DESC LIMIT ?';

/**
 * Боевой исполнитель (§4): net.fetch Electron, если рантайм Electron (уважает
 * прокси ОС), иначе глобальный fetch node (тесты/dev). Ленивый импорт electron —
 * прецедент createDefaultVault (container): в node-vitest electron.net отсутствует —
 * честный фолбэк, не тихий сбой сети.
 */
export async function createDefaultEgressFetch(): Promise<EgressFetch> {
  try {
    const electron = (await import('electron')) as { net?: { fetch?: EgressFetch } };
    const netFetch = electron.net?.fetch;
    if (typeof netFetch === 'function') {
      return (endpoint, init) => netFetch(endpoint, init);
    }
  } catch {
    // Не Electron-рантайм (vitest/node) — глобальный fetch ниже.
  }
  return (endpoint, init) => globalThis.fetch(endpoint, init);
}

/** EgressGateway (§5): singleton контейнера (§9); каждый запрос проходит пайплайн §5. */
export class EgressGateway {
  private readonly deps: EgressGatewayDeps;

  constructor(deps: EgressGatewayDeps) {
    this.deps = deps;
  }

  /**
   * Единственная точка сети (§5). Отказ политики — БЫСТРЫЙ (до сети, §9) AppError
   * NET/BLOCKED_BY_POLICY {op}; сетевая ошибка пробрасывается вызывающему (§13).
   */
  async request(op: string, request: EgressRequest): Promise<Response> {
    const startedAt = this.deps.clock.nowMs();
    const policyEntry = (EgressPolicy.ALLOWED as Readonly<Record<string, EgressPolicyEntry>>)[op];

    // Ветки §13: вне списка ИЛИ без согласия → blocked-запись в журнале + отказ.
    if (policyEntry === undefined) {
      this.journalBlocked(op, request.endpoint, startedAt);
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §7, прецедент sqlite.ts)
      throw this.blockedByPolicy(op);
    }
    const consents = await this.deps.consents();
    if (consents[policyEntry.consentKey] !== true) {
      this.journalBlocked(op, request.endpoint, startedAt);
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §7, прецедент sqlite.ts)
      throw this.blockedByPolicy(op);
    }

    // (3) журнал: запись running до сети (§5 п. 3) + (4) событие ленты (§11).
    // Лента — fire-and-forget (§9, семантика broadcast TASK-009): отказ доставки
    // (нет окон/рантайма) НЕ рвёт операцию и журнал — это лучится в debug-лог.
    const id = uuidV7();
    this.deps.db
      .prepare(INSERT_EVENT_SQL)
      .run(id, op, request.endpoint, 'running', null, startedAt);
    this.notifyActivity(op, request.endpoint);
    this.deps.logger.info('net request', { kind: op, endpoint: request.endpoint });

    try {
      const response = await this.deps.fetch(request.endpoint, request.init);
      const bytes = parseContentLength(response.headers.get('content-length'));
      this.finish(id, 'ok', bytes, this.deps.clock.nowMs());
      this.deps.logger.info('net request done', {
        kind: op,
        status: 'ok',
        bytes,
        durationMs: this.deps.clock.nowMs() - startedAt,
      });
      return response;
    } catch (cause) {
      // Сетевая неудача (§13): failed в журнале, ошибка — вызывающему БЕЗ замены
      // (маппинг в коды — дело потребителя TASK-080/096).
      this.finish(id, 'failed', null, this.deps.clock.nowMs());
      this.deps.logger.warn('net request failed', {
        kind: op,
        status: 'failed',
        durationMs: this.deps.clock.nowMs() - startedAt,
      });
      throw cause;
    }
  }

  /**
   * Последние N записей журнала, новые раньше (§5 — потребители TASK-099;
   * сортировка at_utc DESC, id DESC: uuid v7 монотонен — детерминизм при равных at).
   */
  listRecent(limit: number): NetworkEventRow[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError(
        `listRecent: limit должен быть целым ≥ 1, получено ${String(limit)} (нарушение контракта — программная ошибка, TASK-075 §5)`,
      );
    }
    return (
      this.deps.db.prepare(LIST_RECENT_SQL).all(limit) as {
        id: string;
        kind: string;
        endpoint: string;
        status: string;
        bytes: number | null;
        at_utc: number;
      }[]
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      endpoint: row.endpoint,
      status: row.status as NetworkEventStatus,
      bytes: row.bytes,
      atUtc: row.at_utc,
    }));
  }

  /**
   * Единая точка решения для потребителей с «внутренней» сетью (TASK-096 §4):
   * electron-updater выполняет трафик сам — через request() его физически не
   * провести; честная модель — решение политики/согласия + журналирование ЗДЕСЬ,
   * вызов updater'а у потребителя ТОЛЬКО при allowed. Отказ (вне списка/без
   * согласия) — blocked-запись и лента (§9: журнал честен и про отказы), наружу
   * {allowed: false}; throwing AppError — дело потребителя (маппинг — §13 096).
   * Endpoint при отказе неизвестен (updater-knows-only) — пустая строка: адрес не
   * наблюдаем gateway'ем (§22 TASK-096 — аудиторская оговорка).
   */
  async checkPermission(op: string): Promise<EgressPermission> {
    const policyEntry = (EgressPolicy.ALLOWED as Readonly<Record<string, EgressPolicyEntry>>)[op];
    const consents = policyEntry === undefined ? undefined : await this.deps.consents();
    if (policyEntry === undefined || consents?.[policyEntry.consentKey] !== true) {
      this.journalBlocked(op, '', this.deps.clock.nowMs());
      return { allowed: false, journal: deniedJournal(op) };
    }
    return { allowed: true, journal: this.operationJournal(op) };
  }

  /**
   * Журнал разрешённой операции (§5 п. 3 — тот же жизненный цикл, что у request()):
   * running-запись при start(), финал ok/failed обновляет ТУ ЖЕ строку. Нарушение
   * порядка вызовов — TypeError (программная ошибка потребителя, прецедент listRecent).
   */
  private operationJournal(op: string): EgressOperationJournal {
    const id = uuidV7();
    let state: 'idle' | 'running' | 'finished' = 'idle';
    return {
      start: (endpoint: string) => {
        if (state !== 'idle') {
          throw new TypeError(
            `gateway journal: повторный start для ${op} (нарушение контракта — программная ошибка, TASK-096 §6)`,
          );
        }
        state = 'running';
        this.deps.db
          .prepare(INSERT_EVENT_SQL)
          .run(id, op, endpoint, 'running', null, this.deps.clock.nowMs());
        this.notifyActivity(op, endpoint);
        this.deps.logger.info('net operation started', { kind: op, endpoint });
      },
      ok: (bytes: number | null = null) => {
        if (state !== 'running') {
          throw new TypeError(
            `gateway journal: ok без start/повторный финал для ${op} (нарушение контракта — программная ошибка, TASK-096 §6)`,
          );
        }
        state = 'finished';
        this.deps.db.prepare(FINISH_SQL).run('ok', bytes, this.deps.clock.nowMs(), id);
        this.deps.logger.info('net operation done', { kind: op, status: 'ok' });
      },
      failed: () => {
        if (state !== 'running') {
          throw new TypeError(
            `gateway journal: failed без start/повторный финал для ${op} (нарушение контракта — программная ошибка, TASK-096 §6)`,
          );
        }
        state = 'finished';
        this.deps.db.prepare(FINISH_SQL).run('failed', null, this.deps.clock.nowMs(), id);
        this.deps.logger.warn('net operation failed', { kind: op, status: 'failed' });
      },
    };
  }

  /** Blocked-запись (§9: отказ тоже в журнале — честность пользовательского журнала). */
  private journalBlocked(kind: string, endpoint: string, atUtc: number): void {
    // Сразу финальным статусом: сети не было — running-фаза отсутствует.
    this.deps.db.prepare(INSERT_EVENT_SQL).run(uuidV7(), kind, endpoint, 'blocked', null, atUtc);
    this.notifyActivity(kind, endpoint);
    this.deps.logger.info('net request blocked', { kind });
  }

  /**
   * Доставка ленты (§11) — fire-and-forget: исключение моста (окна уничтожены,
   * транспорт недоступен) глушится с debug-логом; журнал и сетевая операция не
   * зависят от UI-доставки (прецедент broadcast.ts §5).
   */
  private notifyActivity(kind: string, endpoint: string): void {
    try {
      this.deps.notify('net:activity', { kind, endpoint });
    } catch (cause) {
      this.deps.logger.debug('net:activity: доставка не удалась (мост/окна недоступны?)', {
        kind,
        cause,
      });
    }
  }

  /** Обновляет running-запись финальным статусом (§5 п. 3: status/bytes/at). */
  private finish(
    id: string,
    status: NetworkEventStatus,
    bytes: number | null,
    atUtc: number,
  ): void {
    this.deps.db.prepare(FINISH_SQL).run(status, bytes, atUtc, id);
  }

  /** Отказ политики (§13): видимый, не тихий (арх. 08 §5). */
  private blockedByPolicy(op: string): AppError {
    return AppError.of('NET/BLOCKED_BY_POLICY', NET_BLOCKED_BY_POLICY_MESSAGE_KEY, { op });
  }
}

/** content-length → байты; отсутствующий/нечисловой заголовок — NULL (§5). */
function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

/**
 * Заглушка журнала ОТКАЗАННОЙ операции (TASK-096 §6): blocked-запись уже написана
 * checkPermission'ом; любой вызов — программная ошибка потребителя (журнал отказа
 * не должен притворяться рабочим — прецедент строгости listRecent).
 */
function deniedJournal(op: string): EgressOperationJournal {
  const denied = (): never => {
    throw new TypeError(
      `gateway journal: операция ${op} не разрешена — журналирование недоступно (нарушение контракта — программная ошибка, TASK-096 §6)`,
    );
  };
  return { start: () => denied(), ok: () => denied(), failed: () => denied() };
}
