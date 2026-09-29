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

/**
 * Статус llm-worker (TASK-076 §7): жизненный цикл процесса ИИ. Публикатор —
 * LlmProcessClient (TASK-076); потребитель — экран ИИ (TASK-088).
 */
export type AiWorkerState = 'starting' | 'ready' | 'busy' | 'restarting' | 'failed';

/** Карта «имя события → payload» (§5): единый источник имён и форм для main и рендерера. */
export interface HlEventMap {
  /** Данные изменились (импорт/правка): бейдж ИИ-резюме, инвалидация запросов (FR-5.7). */
  'data:versionBumped': { readonly newVersion: number };
  /** Изменены измерения профиля: перечитать список (FR-5.x, TASK-026/029 — публикаторы). */
  'measurement:changed': { readonly profileId: string };
  /**
   * Изменены настройки (TASK-047 §5/§7): сигнал рендереру перечитать ['prefs'] —
   * мгновенное применение темы/масштаба без перезапуска (§10). Payload — ТОЛЬКО
   * имена изменённых ключей patch (компактность §7), не значения.
   */
  'prefs:changed': { readonly patchKeys: readonly string[] };
  /**
   * TASK-074 §5/§11: показать баннер-подсказку о копии на дашборде (решение о показе
   * — JobScheduler, дедупликация ≤1/7д). Payload пуст — имя события несёт смысл.
   */
  'job:backup-reminder': Record<string, never>;
  /**
   * TASK-075 §5/§11: сетевая активность EgressGateway — лента приватности в реальном
   * времени (FR-7.1, карта арх. 05). Payload — только метаданные операции (kind — имя
   * операции белого списка, endpoint — URL без PHI: CDN моделей/сервер обновлений,
   * §7 TASK-075); статусы/байты — в журнале network_event (TASK-099).
   */
  'net:activity': { readonly kind: string; readonly endpoint: string };
  /**
   * TASK-076 §5/§11: статус llm-worker (UtilityProcess) — индикаторы экрана ИИ
   * (TASK-088). requestId включается, когда статус относится к конкретной
   * генерации (например, краш отклонил активный запрос); иначе опущен.
   */
  'ai:status': { readonly state: AiWorkerState; readonly requestId?: string };
  /**
   * TASK-076 §5/§11: батч токенов генерации (клиент батчит delta воркера,
   * flush 50 мс — частота ≤20/с допустима для канала hl:event; текст —
   * накопленный за интервал кусок, не разовый delta).
   */
  'ai:token': { readonly requestId: string; readonly text: string };
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
  'prefs:changed': ['patchKeys'],
  'job:backup-reminder': [],
  'net:activity': ['kind', 'endpoint'],
  'ai:status': ['state', 'requestId'],
  'ai:token': ['requestId', 'text'],
  'app:log': ['level', 'messageKey'],
} as const satisfies {
  readonly [K in keyof HlEventMap]: readonly (keyof HlEventMap[K])[];
};

/** Транспортный канал событий: main шлёт {name, payload} всем живым webContents (§5/§11). */
export const HL_EVENT_CHANNEL = 'hl:event';
