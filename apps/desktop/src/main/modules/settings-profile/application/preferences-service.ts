/**
 * TASK-047 §5/§7/§9/§11/§18: use case PreferencesService — настройки как ЕДИНЫЙ
 * документ `prefs` под одним ключом app_setting (не по-ключево: атомарные чтения, §5;
 * per-key granular схемы — будущая работа при росте документа >20 полей, §5).
 *
 * ИСТОЧНИК ПРАВДЫ ДЕФОЛТОВ (§8): DEFAULT_PREFS в коде (seed миграции §8 — пусто);
 * zod-дефолт-семантика делает безопасным восстановление из копии со старой/усечённой
 * схемой prefs (§22): отсутствующий/повреждённый документ → DEFAULT_PREFS, не ошибка.
 *
 * ПОРЯДОК set (§9): zod (patch, strip — неизвестные ключи отбрасываются, AC5) →
 * merge с текущими → валидация результата (инвариант: valid current + valid patch —
 * невалидный результат невозможен, defensive → APP/INTERNAL) → запись → событие
 * prefs:changed {patchKeys} → лог. Отказ записи → AppError STORAGE/* наверх, событий
 * нет; невалидный patch → VALIDATION/FAILED, записи нет (§11).
 *
 * СОБЫТИЕ (§5/§7): payload — ТОЛЬКО имена изменённых ключей patch (компактность,
 * §7); renderer перечитывает ['prefs'] по нему (§10/§12) — мгновенное применение
 * темы/масштаба без перезапуска (§20 AC6).
 *
 * ЛОГ (§18): info `prefs.set keys=[theme]` — имена ключей, не значения (единообразие
 * с PHI-правилом; значения не чувствительны, но ключей достаточно для диагностики).
 *
 * ЗАВИСИМОСТИ (§7): порт SettingsStorePort + события/логгер — минимальные структурные
 * поверхности (прецедент AddMeasurementDeps); подстановка в тестах — fake/vi.fn.
 */
import { AppError } from '@hl/kernel';

import type { HlEventMap, Prefs, PrefsPatch } from '@hl/contracts';
import { PREFS_PATCH_SCHEMA, PREFS_SCHEMA } from '@hl/contracts';

import type { SettingsStorePort } from './ports/settings-store.js';

/** Ключ единственного документа настроек в app_setting (§5). */
export const PREFS_STORAGE_KEY = 'prefs';

/**
 * §8: значения по умолчанию — источник правды. netConsents.updatesCheck = false —
 * приватность по умолчанию: сеть не включается без явного согласия (§14, TASK-075/099).
 */
export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  textScale: '100',
  dateFormat: 'auto',
  advancedMode: false,
  netConsents: { updatesCheck: false },
};

/** Ключ i18n-каталога (`errors.internal`, contracts TASK-008) — defensive-ветка. */
const APP_INTERNAL_MESSAGE_KEY = 'errors.internal';
/** Ключ VALIDATION/FAILED (§11): невалидный patch канала. */
const VALIDATION_FAILED_MESSAGE_KEY = 'errors.validation';

/** Минимальная поверхность шины событий для сервиса (§7, прецедент AddMeasurementEvents). */
export interface PreferencesEvents {
  emit<K extends keyof HlEventMap>(name: K, payload: HlEventMap[K]): void;
}

/** Минимальная поверхность логгера сервиса (§18; HlLogger ей удовлетворяет). */
export interface PreferencesLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Зависимости конструктора (§7): подстановочные в тестах. */
export interface PreferencesServiceDeps {
  readonly store: SettingsStorePort;
  readonly events: PreferencesEvents;
  readonly logger: PreferencesLogger;
}

/** Сервис настроек (§5): getPrefs → полный документ; setPrefs(patch) → обновлённый. */
export class PreferencesService {
  private readonly store: SettingsStorePort;

  private readonly events: PreferencesEvents;

  private readonly logger: PreferencesLogger;

  constructor(deps: PreferencesServiceDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.logger = deps.logger;
  }

  /**
   * Полный документ настроек (§11): чтение ключа со схемой адаптера; отсутствие или
   * повреждение (адаптер отсёк по §14) → DEFAULT_PREFS + warn (§20 AC3), без креша.
   */
  async getPrefs(): Promise<Prefs> {
    const stored = this.store.get(PREFS_STORAGE_KEY, PREFS_SCHEMA);
    if (stored === undefined) {
      this.logger.warn('prefs: документ отсутствует/повреждён — применены дефолты', {
        key: PREFS_STORAGE_KEY,
      });
      return DEFAULT_PREFS;
    }
    return stored;
  }

  /**
   * Частичное обновление (§9): zod-strip patch → merge → валидация результата →
   * запись → событие → лог. Возвращает обновлённый ПОЛНЫЙ документ (§11).
   */
  async setPrefs(patch: PrefsPatch): Promise<Prefs> {
    // 1. zod (§9): strip-схема отбрасывает неизвестные ключи (AC5); неверный тип —
    //    VALIDATION/FAILED (§11). Безопасный safeParse: невалидный patch — данные,
    //    не краш.
    const parsed = PREFS_PATCH_SCHEMA.safeParse(patch);
    if (!parsed.success) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9, прецедент settings-store)
      throw AppError.of('VALIDATION/FAILED', VALIDATION_FAILED_MESSAGE_KEY, undefined, parsed.error);
    }
    const validPatch = parsed.data;

    // 2. Merge с текущими (§9): документ читается заново — атомарность чтения (§5).
    const current = await this.getPrefs();
    const merged: Prefs = {
      theme: validPatch.theme ?? current.theme,
      textScale: validPatch.textScale ?? current.textScale,
      dateFormat: validPatch.dateFormat ?? current.dateFormat,
      advancedMode: validPatch.advancedMode ?? current.advancedMode,
      netConsents: validPatch.netConsents ?? current.netConsents,
    };

    // 3. Валидация результата (§9): инвариант, defensive-ветка (APP/INTERNAL).
    const checked = PREFS_SCHEMA.safeParse(merged);
    if (!checked.success) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- наружу только AppError (контракт §9)
      throw AppError.of('APP/INTERNAL', APP_INTERNAL_MESSAGE_KEY, undefined, checked.error);
    }

    // 4. Запись (§9): отказ → STORAGE/* наверх (порт), событий нет.
    await this.store.set(PREFS_STORAGE_KEY, JSON.stringify(checked.data));

    // 5. Событие (§5): имена изменённых ключей — из ИСХОДНОГО patch (порядок
    //    вызывающего), неизвестные отброшены фильтром по валидированным (§7).
    const knownKeys = new Set(Object.keys(validPatch));
    const patchKeys = Object.keys(patch).filter((key) => knownKeys.has(key));
    this.events.emit('prefs:changed', { patchKeys });

    // 6. Лог (§18): keys=[…] — без значений.
    this.logger.info('prefs.set', { keys: patchKeys });

    return checked.data;
  }
}
