/**
 * TASK-094 §2/§5/§7: VaultService — сессионная механика локального входа (эпик 6.1,
 * FR-7.5 «подошёл и посмотрел»). Агрегат VaultState (арх. 02 §3.7): {mode, locked,
 * attempts, backoffUntilUtcMs, lastActivityUtcMs}; состояние locked→unlocked, счётчик
 * неудач и окно backoff — В ПАМЯТИ СЕССИИ (§4: перезагрузка сбрасывает — принятый
 * компромисс: persist позволил бы «вечную блокировку» как атаку на пользователя, §23).
 *
 * ПОВЕДЕНИЕ (§5/§13):
 *  - unlock(pass): в окне backoff — отказ VAULT/RATE_LIMITED с params {backoffSec}
 *    (попытка ДО проверки пароля — перебор непрактичен, §3/§14); иначе vault.unlock →
 *    неудача → attempts++ и backoff 2^(N−3) с (кап 60, §4; backoff начинается с 3-й
 *    неудачи — «3 неудачи → backoff 1 с», §13; первые две — без задержки) → успех →
 *    сброс attempts (AC2) и открытие БД (§9 «unlock → ensureKey → открытие»).
 *  - lock(reason): closeDatabase (checkpoint+close — БД ЗАКРЫТА, честная защита §5),
 *    событие lock:engaged; mode=none — no-op (блокировать нечего: открыть без пароля
 *    нельзя). Повторный lock идемпотентен. attempts/backoff при lock СОХРАНЯЮТСЯ:
 *    §5 привязывает сброс к успешному unlock, и backoff продолжает защищать перебор
 *    пароля в locked-состоянии (перезапуск приложения сбрасывает — принятый
 *    компромисс §4).
 *  - повторный unlock после lock требует пароль заново и переоткрывает БД (§8).
 *  - автоблок (§9/AC4): lockIfIdle(now, autoLockMin) — no-op при locked/mode=none;
 *    простой ≥ autoLockMin минут от lastActivityUtcMs → lock('autolock'). Активность —
 *    touchActivity() (любой IPC-вызов; централизованно в registerChannel, §9). Порог
 *    0 — выкл. Проверка — задача session.autolock (createAutolockJob, интервал 30 с)
 *    и боевой таймер bootstrap'а, который зовёт checkAutolock() напрямую (ДЕВИАЦИЯ ОТ
 *    БУКВЫ §5 зафиксирована: прогон автоблока через JobScheduler.tick писал бы jobState
 *    в prefs каждые 30 с → событие prefs:changed → перечитывание ['prefs'] рендерером
 *    → IPC-вызов → touchActivity → простой никогда не накопился бы). Задача в
 *    scheduler зарегистрирована (§5, tick при старте), таймер 30 с — рядом с ней.
 *  - set-passphrase — транзит к порту 093 (set/change/remove; §19 консистентность).
 *
 * СОБЫТИЯ (§5/арх. 05 §4): lock:engaged — БД закрыта (экран блокировки, 095);
 * lock:required — приложение стартует заблокированным (mode=passphrase); актуальное
 * состояние рендерер уточняет vault/status при старте (§12) — доставка at-most-once.
 *
 * БЕЗОПАСНОСТЬ (§14): backoff «серверный» — считается в main по порту Clock, UI-таймер
 * не доверенный; лог неудачи — attempts/backoffSec БЕЗ пароля (§18). Ключ БД остаётся
 * в кэше адаптера vault (порт 093, время жизни экземпляра): путь повторного открытия
 * проходит через unlock(pass) — пароль проверяется по файлу; прямых вызовов
 * openDatabase вне сервиса граф не содержит, гвардия requireUnlocked каркаса —
 * единая точка доступа рендерера (§14: обход = ревью-блокер), а закрытое соединение
 * недоступно и через прокси (VAULT/LOCKED, §9 093).
 *
 * ТЕСТИРУЕМОСТЬ (§19): все зависимости — порты (vault, open/close БД, notify, Clock,
 * logger, getAutoLockMin); детерминированные часы в тестах — AdvanceClock (прецедент
 * StepClock passphrase-crypto.test.ts).
 */
import { AppError, err, ok, type Clock, type Result } from '@hl/kernel';

import type { JobCtx, JobDefinition, JobShowAction } from '../../../shared/scheduler/scheduler.js';
import {
  VAULT_LOCKED_MESSAGE_KEY,
  VAULT_WRONG_PASSPHRASE_MESSAGE_KEY,
  type KeyVault,
  type VaultMode,
} from './ports/key-vault.js';

/** Ключ i18n для VAULT/RATE_LIMITED (конвенция арх. 05 §29; тексты — TASK-101). */
export const VAULT_RATE_LIMITED_MESSAGE_KEY = 'errors.VAULT_RATE_LIMITED';

/** Максимум окна backoff, сек (§4: «максимум 60 с»). */
export const MAX_BACKOFF_SEC = 60;

/** Имя задачи автоблока в реестре scheduler'а (§5). */
export const AUTOLOCK_JOB_NAME = 'session.autolock';

/** Интервал проверки простоя, мс (§5: «интервал проверки 30 с»; таймер — bootstrap). */
export const AUTOLOCK_CHECK_INTERVAL_MS = 30_000;

/**
 * Задержка после N-й подряд неудачи unlock, сек (§4: 2^(N−3), максимум 60; §13:
 * «3 неудачи → backoff 1 с» — backoff начинается с 3-й неудачи, первые две без
 * задержки). Чистая функция — таблица AC1 тестируется напрямую.
 */
export function backoffDelaySec(failedAttempts: number): number {
  if (failedAttempts < 3) {
    return 0;
  }
  return Math.min(MAX_BACKOFF_SEC, 2 ** (failedAttempts - 3));
}

/** Причина блокировки (§18: лог lock manual/autolock). */
export type LockReason = 'manual' | 'autolock';

/** Команда канала vault/set-passphrase (§5 — union по action, контракт vault.ts). */
export type SetPassphraseCommand =
  | { readonly action: 'set'; readonly pass: string }
  | { readonly action: 'change'; readonly old: string; readonly new: string }
  | { readonly action: 'remove'; readonly old: string };

/** Форма статуса (§5: {mode, locked, backoffSec?}; контракт — VAULT_STATUS_RESPONSE_SCHEMA). */
export interface VaultStatus {
  readonly mode: VaultMode;
  readonly locked: boolean;
  readonly backoffSec?: number;
}

/** Мост событий блокировки (боевой — broadcastToWindows; тесты — шпион, §19). */
export type VaultNotify = (name: 'lock:engaged' | 'lock:required', payload: Record<string, never>) => void;

/** Минимальная поверхность логгера (§18; HlLogger ей удовлетворяет). */
export interface VaultServiceLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости сервиса (§5/§19: сборка — контейнер, подмена — тесты). */
export interface VaultServiceDeps {
  /** Порт 093: unlock/setPassphrase/… + getMode (режим защиты). */
  readonly vault: KeyVault;
  /** Открытие/переоткрытие БД (контейнер 093: ensureKey → open+migrate). */
  readonly openDatabase: () => Promise<Result<void, AppError>>;
  /** Закрытие БД при блокировке: checkpoint(TRUNCATE)+close (§5/AC3 — файлы -wal уходят). */
  readonly closeDatabase: () => void;
  /** Доставка событий lock:* renderer'у (§5; боевой — broadcastToWindows). */
  readonly notify: VaultNotify;
  /** Порт времени (§19: детерминированные тесты). */
  readonly clock: Clock;
  /** Логгер (§18: unlock fail/success, lock manual/autolock, attempts при backoff). */
  readonly logger: VaultServiceLogger;
  /** Порог автоблока (prefs.autoLockMin; читает контейнер — сервис БД напрямую не трогает). */
  readonly getAutoLockMin: () => Promise<number>;
}

/** Состояние сессии входа (§5). Один экземпляр на приложение (контейнер). */
export class VaultService {
  private readonly vault: KeyVault;
  private readonly openDatabase: () => Promise<Result<void, AppError>>;
  private readonly closeDatabase: () => void;
  private readonly notify: VaultNotify;
  private readonly clock: Clock;
  private readonly logger: VaultServiceLogger;
  private readonly getAutoLockMin: () => Promise<number>;

  /** true — сессия заблокирована (passphrase-режим до успешного unlock или после lock). */
  private locked: boolean;
  /** Подряд неудачных попыток unlock (сброс — успех или lock). */
  private attempts = 0;
  /** Момент окончания окна backoff, мс эпохи; undefined — окна нет. */
  private backoffUntilUtcMs: number | undefined;
  /** Момент последнего пользовательского действия (любой IPC-вызов, §9). */
  private lastActivityUtcMs: number;

  constructor(deps: VaultServiceDeps) {
    this.vault = deps.vault;
    this.openDatabase = deps.openDatabase;
    this.closeDatabase = deps.closeDatabase;
    this.notify = deps.notify;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.getAutoLockMin = deps.getAutoLockMin;
    this.locked = deps.vault.getMode() === 'passphrase';
    this.lastActivityUtcMs = deps.clock.nowMs();
    if (this.locked) {
      // Старт заблокированным (§5/§12): сигнал экрану блокировки; статус дублирует
      // vault/status — доставка at-most-once, ранняя рассылка может не доехать.
      this.safeNotify('lock:required');
    }
  }

  /**
   * Доставка события lock:* — fire-and-forget (§5): сбой моста (окна ещё нет,
   * среда без Electron) НЕ должен ломать саму сессию входа — предупреждение в лог.
   */
  private safeNotify(name: 'lock:engaged' | 'lock:required'): void {
    try {
      this.notify(name, {});
    } catch (cause) {
      this.logger.warn('vault: доставка события не удалась', { event: name, cause });
    }
  }

  /** Гвардия каркаса requireUnlocked (§7/§11): false — secure-каналы закрыты. */
  isUnlocked(): boolean {
    return this.vault.getMode() !== 'passphrase' || !this.locked;
  }

  /** §5: {mode, locked, backoffSec?} — backoffSec только в окне (остаток, вверх, §17). */
  getStatus(): VaultStatus {
    const nowMs = this.clock.nowMs();
    const remainingMs = this.backoffUntilUtcMs === undefined ? 0 : this.backoffUntilUtcMs - nowMs;
    return {
      mode: this.vault.getMode(),
      locked: !this.isUnlocked(),
      ...(remainingMs > 0 ? { backoffSec: Math.ceil(remainingMs / 1000) } : {}),
    };
  }

  /** Пользовательское действие (§9): любой IPC-вызов продлевает окно автоблока. */
  touchActivity(): void {
    this.lastActivityUtcMs = this.clock.nowMs();
  }

  /**
   * Разблокировка (§5/§13): отказ в окне backoff — RATE_LIMITED (пароль не
   * проверяется, счётчик не растёт); неудача — attempts++ и backoff (лог с
   * attempts, §14/§18); успех — сброс и открытие БД (§9).
   */
  async unlock(pass: string): Promise<Result<{ ok: true }, AppError>> {
    if (this.isUnlocked()) {
      if (this.vault.getMode() !== 'passphrase') {
        return ok({ ok: true }); // mode=none — блокировалось нечего, БД открыта при сборке
      }
      // Сессия уже открыта — идемпотентно; чиним возможное «разблокировано,
      // но БД закрыта» повторным открытием (ok немедленно, если открыта).
      const opened = await this.openDatabase();
      return opened.ok ? ok({ ok: true }) : opened;
    }
    const nowMs = this.clock.nowMs();
    if (this.backoffUntilUtcMs !== undefined && nowMs < this.backoffUntilUtcMs) {
      const backoffSec = Math.ceil((this.backoffUntilUtcMs - nowMs) / 1000);
      this.logger.warn('vault unlock refused: backoff', { attempts: this.attempts, backoffSec });
      return err(
        AppError.of('VAULT/RATE_LIMITED', VAULT_RATE_LIMITED_MESSAGE_KEY, { backoffSec }),
      );
    }
    const result = await this.vault.unlock(pass);
    if (!result.ok) {
      this.attempts += 1;
      const backoffSec = backoffDelaySec(this.attempts);
      this.backoffUntilUtcMs = backoffSec > 0 ? nowMs + backoffSec * 1000 : undefined;
      // §14/§18: исход неудачи — только счётчики; пароль и его длина не логируются.
      this.logger.warn('vault unlock failed', { attempts: this.attempts, backoffSec });
      return err(result.error);
    }
    this.attempts = 0;
    this.backoffUntilUtcMs = undefined;
    this.locked = false;
    this.logger.info('vault unlock ok');
    const opened = await this.openDatabase();
    return opened.ok ? ok({ ok: true }) : opened;
  }

  /**
   * Блокировка (§5/AC3): checkpoint+close БД (файлы -wal/-shm уходят), сброс
   * attempts/backoff, событие lock:engaged. mode=none — no-op {locked: false};
   * повторный lock — идемпотентен.
   */
  lock(reason: LockReason): { locked: boolean } {
    if (!this.isUnlocked()) {
      return { locked: true }; // уже заблокировано — идемпотентно
    }
    if (this.vault.getMode() !== 'passphrase') {
      return { locked: false }; // блокировать нечего (§13: открыть без пароля нельзя)
    }
    this.closeDatabase();
    this.locked = true;
    this.lastActivityUtcMs = this.clock.nowMs(); // свежее окно автоблока на новую сессию
    this.logger.info('vault lock engaged', { reason });
    this.safeNotify('lock:engaged');
    return { locked: true };
  }

  /**
   * Ядро автоблока (§9): locked/mode=none — no-op (до чтения prefs — БД закрыта,
   * §3 «фоновые задачи ничего не читают БД»); порог 0 — выкл; простой ≥ порога —
   * lock('autolock'). Возвращает true, если заблокировало.
   */
  lockIfIdle(nowMs: number, autoLockMin: number): boolean {
    if (!this.isUnlocked() || autoLockMin <= 0) {
      return false;
    }
    if (nowMs - this.lastActivityUtcMs < autoLockMin * 60_000) {
      return false;
    }
    this.lock('autolock');
    return true;
  }

  /**
   * Тик проверки автоблока (§9): порог из prefs через порт getAutoLockMin; отказ
   * чтения изолирован (боевой таймер 30 с не должен умирать, §9 каркаса задач).
   */
  async checkAutolock(nowMs: number = this.clock.nowMs()): Promise<void> {
    if (!this.isUnlocked()) {
      return; // §9: locked уже → no-op (и prefs закрытой БД не читаем, §3)
    }
    try {
      const autoLockMin = await this.getAutoLockMin();
      this.lockIfIdle(nowMs, autoLockMin);
    } catch (cause) {
      this.logger.warn('vault autolock check failed', { cause });
    }
  }

  /**
   * Управление паролем (§5: {pass|old+new|remove}) — транзит к порту 093
   * (setPassphrase/changePassphrase/removePassphrase, §19); ответ — новый режим.
   */
  async setPassphrase(command: SetPassphraseCommand): Promise<Result<{ mode: VaultMode }, AppError>> {
    const result =
      command.action === 'set'
        ? await this.vault.setPassphrase(command.pass)
        : command.action === 'change'
          ? await this.vault.changePassphrase(command.old, command.new)
          : await this.vault.removePassphrase(command.old);
    if (!result.ok) {
      return result;
    }
    return ok({ mode: this.vault.getMode() });
  }
}

/** Зависимости задачи автоблока (§5): ядро проверки — сервис (шпион в тестах). */
export interface AutolockJobDeps {
  readonly service: {
    /** lockIfIdle(nowMs, autoLockMin) — см. VaultService (locked → no-op, §9). */
    readonly lockIfIdle: (nowMs: number, autoLockMin: number) => void;
  };
}

/**
 * Задача автоблока `session.autolock` (§5/§9): порог — из ctx.prefs.autoLockMin
 * (тик планировщика уже прочитал документ), ядро — lockIfIdle сервиса (locked →
 * no-op). Зарегистрирована в scheduler контейнера: тик при старте оценивает
 * автоблок; живой таймер 30 с — bootstrap (см. шапку — почему не через tick).
 */
export function createAutolockJob(deps: AutolockJobDeps): JobDefinition {
  return {
    name: AUTOLOCK_JOB_NAME,
    intervalMs: AUTOLOCK_CHECK_INTERVAL_MS,
    run: (ctx: JobCtx): JobShowAction | null => {
      if (ctx.prefs.autoLockMin === 0) {
        return null; // §5: 0 — выкл (тишина — это не blocked)
      }
      deps.service.lockIfIdle(ctx.now.utcMs, ctx.prefs.autoLockMin);
      return null;
    },
  };
}

/** Реэкспорт ключа ошибки гвардии для хендлеров/тестов (единый источник — contracts). */
export { VAULT_LOCKED_MESSAGE_KEY, VAULT_WRONG_PASSPHRASE_MESSAGE_KEY };
