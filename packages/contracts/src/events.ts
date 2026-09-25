/**
 * TASK-009 §5/§11: реестр событий main→renderer — карта «имя события → payload».
 * Новое событие = расширение карты (механизм доставки не меняется): добавить имя в
 * HlEventMap и список полей payload в HL_EVENT_PAYLOAD_KEYS (тест-контракт
 * events.test.ts проверяет состав и белый список полей, §14).
 *
 * Payload — только сигналы (версии, id, статусы), никаких значений измерений и
 * текстов заметок (§14, §17: app:log несёт messageKey, не текст). Транспорт —
 * единый канал `hl:event` с конвертом {name, payload} (§11); обе стороны одной
 * сборки, payload-валидация на приёме — будущая работа (§5).
 *
 * Доменные события Measurement (data:versionBumped, measurement:changed) типизированы
 * здесь как часть контракта контекстов (арх. 02 §2); публикаторы появятся в
 * TASK-026/029. Семантика доставки — EventBus/broadcastToWindows (main, §13):
 * at-most-once, FIFO внутри имени, без гарантий порядка между разными именами.
 */

/** Уровень события app:log (§5); текст сообщения не пересекает границу — только ключ (§17). */
export type HlLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Карта «имя события → payload» (§5): единый источник имён и форм для main и рендерера. */
export interface HlEventMap {
  /** Данные изменились (импорт/правка): бейдж ИИ-резюме, инвалидация запросов (FR-5.7). */
  'data:versionBumped': { readonly newVersion: number };
  /** Изменены измерения профиля: перечитать список (FR-5.x, TASK-026/029 — публикаторы). */
  'measurement:changed': { readonly profileId: string };
  /** Технологическое событие журнала main (§18): только ключ сообщения, без PHI. */
  'app:log': { readonly level: HlLogLevel; readonly messageKey: string };
}

/**
 * Runtime-реестр полей payload по именам — материализация карты для тест-контракта
 * PHI (§14/§20: «нет полей sys/dia/pulse/note/content»). Ключи и значения связаны с
 * типами через satisfies: пропущенное имя карты или поле вне payload не скомпилируется.
 */
export const HL_EVENT_PAYLOAD_KEYS = {
  'data:versionBumped': ['newVersion'],
  'measurement:changed': ['profileId'],
  'app:log': ['level', 'messageKey'],
} as const satisfies {
  readonly [K in keyof HlEventMap]: readonly (keyof HlEventMap[K])[];
};

/** Транспортный канал событий: main шлёт {name, payload} всем живым webContents (§5/§11). */
export const HL_EVENT_CHANNEL = 'hl:event';
