/**
 * TASK-047 §4/§5: порт хранилища настроек — application-слой модуля settings-profile
 * (арх. 03 §4: адаптеры импортируют только application-порты своего модуля;
 * application не импортирует адаптеры — depcruise application-ports). Реализация —
 * SQLite-адаптер SettingsStore над app_setting миграции v3; подстановка тестам — fake.
 *
 * Повреждённое/отсутствующее значение — undefined (НЕ ошибка): решение «что вместо»
 * (дефолты DEFAULT_PREFS) — забота сервиса, §5 «повреждённый JSON → дефолт + warn».
 */
import type { ZodType } from 'zod';

/** Порт KV-хранилища настроек (§5): чтение со схемой, запись JSON-текста. */
export interface SettingsStorePort {
  /**
   * Читает значение по ключу и валидирует schema (§14 — при КАЖДОМ чтении):
   * ключа нет / повреждённый JSON / значение вне схемы → undefined (адаптер логирует).
   */
  get<T>(key: string, schema: ZodType<T>): T | undefined;

  /** Пишет значение (JSON-текст) по ключу; отказ → AppError STORAGE/* (§9). */
  set(key: string, valueJson: string): Promise<void>;
}
