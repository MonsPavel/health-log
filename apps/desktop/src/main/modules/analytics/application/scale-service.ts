/**
 * TASK-051 §5/§7/§9/§13/§15/§18: ScaleService — активация данных пакета
 * @hl/scales-data (TASK-050) в reference_scale v4 при первом старте и чтение
 * активной шкалы для канала `scales/active`.
 *
 * АКТИВАЦИЯ ПРИ СТАРТЕ (§5/§9, ensureActivated — идемпотентно):
 *  - активной записи по code нет → INSERT данных пакета (data_json) + activate;
 *  - активная запись с той же версией данных → no-op («не трогать»);
 *  - активная запись с ДРУГОЙ версией (данные пакета обновились) → INSERT новой
 *    версии + активировать её; старая остаётся в истории с ПРЕЖНИМ
 *    activated_at_utc — активность определяется по max activated_at_utc на code
 *    (§13, правило фиксируется портом). Направление различия версий не
 *    анализируется: данные пакета — единственный источник (комплект приложения).
 *  - Событие scales:changed при смене версии — НЕ в MVP (§5); место публикации —
 *    здесь, после успешного activate (потребители 052/053 подписаны на события).
 *  Гонка двойного старта закрыта single-instance (TASK-012, §9) — блокировок нет.
 *
 * ЧТЕНИЕ (§7, getActiveScale): data_json валидируется zod-схемой SCALE_DATA_SCHEMA
 * (зеркало пакета, contracts) ПРИ чтении; повреждение (не JSON / вне схемы /
 * активной записи нет) → AppError STORAGE/CORRUPT + лог error — НЕ тихий дефолт:
 * шкала критична для UI и классификатора (FR-4.5). Успешное чтение кэшируется в
 * памяти (§15: один SELECT на старт; данные статичны между запусками, рендерерский
 * кэш staleTime Infinity — §11); инвалида́ция в MVP не нужна.
 *
 * ЛОГ (§18): `scale activated code=… version=…` при активации (в т.ч. смене
 * версии), `scale active (cached)` — no-op старт; повреждение — error с cause.
 *
 * ЗАВИСИМОСТИ (§7): порт ScaleRepository + логгер + данные пакета — минимальные
 * структурные поверхности; подстановка в тестах — fake (§19). Момент активации
 * ставит адаптер (Clock в адаптере — §13 инъекция времени).
 */
import { randomUUID } from 'node:crypto';

import { SCALE_DATA_SCHEMA, type ActiveScale } from '@hl/contracts';
import { AppError } from '@hl/kernel';

import type { ScaleData } from '@hl/scales-data';

import type { ScaleRepository } from './ports/scale-repository.js';

/** Ключи i18n-каталога по конвенции арх. 05 §29 (`errors.<КОД_С_ПОДЧЁРКИВАНИЯМИ>`); тексты — TASK-101. */
export const STORAGE_CORRUPT_MESSAGE_KEY = 'errors.STORAGE_CORRUPT';

/** Минимальная поверхность логгера сервиса (§18; HlLogger ей удовлетворяет). */
export interface ScaleServiceLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости конструктора (§7): подстановочные в тестах (§19: мок данных пакета). */
export interface ScaleServiceDeps {
  /** Хранилище шкал (SQLite-адаптер в контейнере, fake в тестах). */
  readonly repo: ScaleRepository;
  readonly logger: ScaleServiceLogger;
  /** Данные пакета @hl/scales-data (комплект приложения; мок — в тесте смены версии). */
  readonly data: ScaleData;
}

/** Сервис справочных шкал (§5): ensureActivated() при старте, getActiveScale() для канала. */
export class ScaleService {
  private readonly repo: ScaleRepository;

  private readonly logger: ScaleServiceLogger;

  private readonly data: ScaleData;

  /** Кэш чтения (§15): ActiveScale статичен между запусками — инвалидации нет. */
  private cached: ActiveScale | undefined;

  constructor(deps: ScaleServiceDeps) {
    this.repo = deps.repo;
    this.logger = deps.logger;
    this.data = deps.data;
  }

  /**
   * Идемпотентная активация данных пакета при старте (§5/§9/§13). Отказ хранилища
   * (STORAGE/* из порта) пробрасывается выше — старт приложения прерывается
   * (шкала критична, §7; диалог — глобальный хендлер TASK-011).
   */
  async ensureActivated(): Promise<void> {
    const active = await this.repo.findActiveByCode(this.data.code);

    // §5: активной шкалы нет → записать данные и активировать.
    if (active === undefined) {
      await this.activatePackageData();
      return;
    }

    // §5: активная запись той же версии — no-op («если есть — не трогать»).
    if (active.version === this.data.version) {
      this.logger.info('scale active (cached)', { code: this.data.code, version: active.version });
      return;
    }

    // §13: версия данных пакета изменилась → новая запись + переключение активности;
    // старая остаётся в истории (activated_at_utc прежний — правило порта/§13).
    // Событие scales:changed — НЕ в MVP (§5, комментарий): потребители 052/053
    // перечитают канал при следующем старте.
    this.logger.info('scale version changed', {
      code: this.data.code,
      from: active.version,
      to: this.data.version,
    });
    await this.activatePackageData();
  }

  /**
   * Активная шкала в форме канала (§7): чтение записи → валидация data_json
   * зеркалом пакета → проекция ActiveScale → кэш (§15). Повреждение — AppError
   * STORAGE/CORRUPT + лог error, не тихий дефолт (§7: шкала критична).
   */
  async getActiveScale(): Promise<ActiveScale> {
    if (this.cached !== undefined) {
      return this.cached;
    }

    const record = await this.repo.findActiveByCode(this.data.code);
    if (record === undefined) {
      // Достижимо только при вызове до ensureActivated (контейнер зовёт его на
      // старте) или при внешней порче БД — в обоих случаях состояние хранилища
      // нечитаемо для домена: STORAGE/CORRUPT-стиль (§7).
      return this.corrupt('scale: активная запись отсутствует', { code: this.data.code });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(record.dataJson) as unknown;
    } catch (cause) {
      return this.corrupt('scale: повреждённый JSON данных шкалы', { code: record.code, cause });
    }

    const parsed = SCALE_DATA_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      return this.corrupt('scale: данные шкалы не прошли валидацию схемы', {
        code: record.code,
        cause: parsed.error.message,
      });
    }

    // Проекция в форму канала (§7): language и $comment на провод не идут.
    const active: ActiveScale = {
      code: parsed.data.code,
      version: parsed.data.version,
      sourceLabel: parsed.data.sourceLabel,
      categories: parsed.data.categories.map((category) => ({ ...category })),
      homeBPNote: parsed.data.homeBPNote,
      specialGroupsNote: parsed.data.specialGroupsNote,
    };
    this.cached = active;
    return active;
  }

  /** INSERT данных пакета + активация (§5); лог активации с кодом и версией (§18). */
  private async activatePackageData(): Promise<void> {
    const id = randomUUID();
    await this.repo.insert({
      id,
      code: this.data.code,
      version: this.data.version,
      sourceLabel: this.data.sourceLabel,
      dataJson: JSON.stringify(this.data),
    });
    await this.repo.activate(id);
    this.logger.info('scale activated', { code: this.data.code, version: this.data.version });
  }

  /** Единая форма ошибки повреждения (§7): STORAGE/CORRUPT + error-лог, наружу только код. */
  private corrupt(message: string, meta: Record<string, unknown>): never {
    this.logger.error(message, meta);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §7, прецедент settings-store)
    throw AppError.of('STORAGE/CORRUPT', STORAGE_CORRUPT_MESSAGE_KEY, undefined, meta);
  }
}
