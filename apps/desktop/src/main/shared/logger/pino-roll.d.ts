/**
 * Локальные типы pino-roll@4.0.0 (§6; мажор зафиксирован в package.json — §22): пакет
 * не поставляет деклараций. Подключается тройным слэшем из logger.ts — оба tsconfig-
 * проекта (tsconfig.main.json и корневой для colocated-тестов) получают типы без правок
 * конфигураций. Описано только используемое подмножество опций (полный список — README
 * пакета; остальные проходят насквозь в SonicBoom).
 */
declare module 'pino-roll' {
  import type { DestinationStream } from 'pino';

  /** Опции pino-roll v4, используемые логгером приложения. */
  export interface PinoRollOptions {
    /** Базовое имя файла лога; ротированные получают номер перед расширением (hl.1.log). */
    readonly file: string;
    /** Предел размера одного файла до ротации: '5m'/'1k'/байты числом (§5: 5 МБ). */
    readonly size?: string | number;
    /** Сколько ротированных файлов хранить помимо активного (§5: 5 файлов). */
    readonly limit?: { readonly count?: number };
    /** Создавать каталог назначения (userData/logs может не существовать до первого старта). */
    readonly mkdir?: boolean;
    /** Синхронная запись (§15: объёмы малы, worker-transport — только по замеру). */
    readonly sync?: boolean;
  }

  /** Поток ротации: совместим с DestinationStream pino, плюс завершение записи. */
  export interface PinoRollStream extends DestinationStream {
    /** Дозапись буфера и закрытие файла (SonicBoom.end). */
    end(): void;
  }

  /** Фабрика потока ротации; Promise — сборка асинхронна начиная с v4. */
  function build(options: PinoRollOptions): Promise<PinoRollStream>;

  export default build;
}
