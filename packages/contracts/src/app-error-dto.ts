/**
 * TASK-008 §5/§7: сериализованная форма AppError (kernel) для IPC (арх. 05 §2).
 * Наружу уходят только code/messageKey/params/retryable; стеков у AppError нет по
 * построению, cause в DTO не переносится (§14) — он живёт в памяти main для логов (§18).
 */
import type { AppError, AppErrorParams, ErrorCode } from '@hl/kernel';

/** Ошибка приложения в форме, пересекающей границу IPC (арх. 05 §2). */
export interface AppErrorDto {
  /** Машинный код из реестра ErrorCode — стабильный публичный API (арх. 05 §6). */
  readonly code: ErrorCode;
  /** Ключ i18n-каталога рендерера, не текст (§7, §17). */
  readonly messageKey: string;
  /** Подстановки плейсхолдеров сообщения; отсутствует, если подставлять нечего. */
  readonly params?: AppErrorParams;
  /** Повтор допустим (§13: только коды из реестра повторяемых; сейчас реестр пуст). */
  readonly retryable?: boolean;
}

/**
 * §13: коды, для которых toDto ставит retryable: true. Сейчас пуст — повторяемые
 * NET/* появятся вместе с сетевыми задачами (TASK-075/080).
 */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([]);

/** APP/INTERNAL в форме DTO — наружу при необработанных ошибках каркаса (§13, п. 4). */
export const APP_INTERNAL_ERROR: AppErrorDto = {
  code: 'APP/INTERNAL',
  messageKey: 'errors.internal',
};

/** VALIDATION/FAILED в форме DTO — наружу при отклонении payload zod-схемой (§13, п. 2). */
export const VALIDATION_FAILED_ERROR: AppErrorDto = {
  code: 'VALIDATION/FAILED',
  messageKey: 'errors.validation',
};

/**
 * Сериализация AppError в DTO (§7): cause и стек никогда не пересекают границу —
 * поля просто не копируются (отсутствуют в объекте, см. тесты §19).
 */
export function toDto(error: AppError): AppErrorDto {
  return {
    code: error.code,
    messageKey: error.messageKey,
    ...(error.params === undefined ? {} : { params: error.params }),
    ...(RETRYABLE_CODES.has(error.code) ? { retryable: true } : {}),
  };
}
