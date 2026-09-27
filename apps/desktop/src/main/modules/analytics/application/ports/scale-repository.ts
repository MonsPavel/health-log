/**
 * TASK-051 §5: порт хранилища справочных шкал — application-слой модуля analytics
 * (арх. 03 §4: application не импортирует адаптеры — depcruise application-ports;
 * реализация — SQLite-адаптер SqliteScaleRepository над reference_scale миграции
 * v4; подстановка тестам — fake/in-memory).
 *
 * Контракт асинхронный (Promise) — единообразно с портами SettingsStore/NotesSearch:
 * better-sqlite3 синхронный, Promise-обёртка в адаптере (прецедент TASK-047).
 *
 * Семантика активности (§13, правило фиксируется): активная запись на code —
 * строка с MAX(activated_at_utc) среди активированных; активность НЕ снимается
 * с прежних версий (история хранится с проставленным моментом активации).
 */
/** Хранимая запись шкалы (строка reference_scale; snake_case → camelCase — маппинг адаптера). */
export interface ScaleRecord {
  readonly id: string;
  readonly code: string;
  /** Семвер данных (FR-4.5). */
  readonly version: string;
  /** Источник для показа пользователю, например 'ESC/ESH 2018'. */
  readonly sourceLabel: string;
  /** Файл данных шкалы (форма ScaleData пакета @hl/scales-data) — валидирует сервис при чтении (§7). */
  readonly dataJson: string;
  /** Момент активации (epoch ms); null — запись ожидает активации. */
  readonly activatedAtUtc: number | null;
}

/** Данные новой записи шкалы; момент активации ставит activate (Clock адаптера). */
export interface ScaleRecordInput {
  readonly id: string;
  readonly code: string;
  readonly version: string;
  readonly sourceLabel: string;
  readonly dataJson: string;
}

/** Порт хранилища шкал (§5). */
export interface ScaleRepository {
  /**
   * Активная запись кода (§13: MAX(activated_at_utc) среди активированных);
   * записей нет / все не активированы → undefined.
   */
  findActiveByCode(code: string): Promise<ScaleRecord | undefined>;

  /**
   * Вставляет запись новой версии; дубль (code, version) → AppError
   * STORAGE/CONSTRAINT (§8: UNIQUE — защита от дублей при повторной активации);
   * прочий сбой SQL → AppError STORAGE/* (наружу только коды, детали в cause — §14).
   */
  insert(input: ScaleRecordInput): Promise<void>;

  /**
   * Активирует запись: activated_at_utc = now (Clock адаптера — время в рантайме
   * только через инъекцию, §13 прецедент миграции v1). Несуществующий id —
   * no-op (0 строк; сервис активирует сразу после insert).
   */
  activate(id: string): Promise<void>;
}
