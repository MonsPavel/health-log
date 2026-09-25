/**
 * TASK-006 §7: ошибка приложения. messageKey — всегда ключ i18n-каталога рендерера,
 * никаких пользовательских текстов в main (§7, §16–17). Класс НЕ наследует Error:
 * у AppError нет стека (§14) — в сериализуемые поля (задел AppErrorDto, TASK-008)
 * попадают только code/messageKey/params; cause живёт в памяти main для логов.
 */
import type { ErrorCode } from './error-codes.js';

/** Подстановки плейсхолдеров i18n-сообщения (§7). */
export type AppErrorParams = Record<string, string | number>;

export class AppError {
  /** Машинный код из реестра ErrorCode (§5). */
  readonly code: ErrorCode;
  /** Ключ каталога локализации рендерера, не текст (§7). */
  readonly messageKey: string;
  /** Подстановки сообщения; отсутствует, если сообщению нечего подставлять. */
  readonly params?: AppErrorParams;
  /** Причина — только в памяти main для логов, наружу не сериализуется (§14). */
  readonly cause?: unknown;

  /** Единственный путь создания — фабрика AppError.of (§7). */
  private constructor(
    code: ErrorCode,
    messageKey: string,
    params?: AppErrorParams,
    cause?: unknown,
  ) {
    this.code = code;
    this.messageKey = messageKey;
    this.params = params;
    this.cause = cause;
  }

  /** Фабрика ошибок: code + messageKey + опциональные params и cause (§7). */
  static of(
    code: ErrorCode,
    messageKey: string,
    params?: AppErrorParams,
    cause?: unknown,
  ): AppError {
    return new AppError(code, messageKey, params, cause);
  }
}
