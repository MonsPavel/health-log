/**
 * TASK-011 §5/§9/§13: глобальная обработка неожиданных ошибок main-процесса —
 * страховка от сбоев, не покрытых Result/AppError (TASK-006): uncaughtException и
 * unhandledRejection → лог (категория app, уровень error, cause через logDiagnostic
 * TASK-010) → безопасный диалог (§9: константный RU-текст + только код, без message
 * исключения — §14) с guard-ом от циклов диалогов.
 *
 * GUARD ДИАЛОГОВ (§5): не более 1 активного диалога (пока модалка открыта, новые
 * ошибки только логируются) + счётчик ошибок подряд: больше 5 подряд — диалоги
 * молчат (тихий лог), это шторм/цикл крашей. Счётчик сбрасывается, когда диалог
 * закрылся и за время его показа новых ошибок не было — серия угасла.
 *
 * ОТКАЗОБЕЗОПАСНОСТЬ (§13): ошибка внутри обработчика ошибки (упал логгер) уходит
 * в stderr напрямую, без рекурсии через pino; провал showMessageBox глушится и не
 * лишает хендлер дееспособности.
 *
 * Модуль чист (без импорта electron, прецедент navigation-guards §19): Electron
 * подставляется проводкой в bootstrap.ts, тесты — фейками deps и process-подобным
 * target с подменёнными process.on-регистрациями (§19).
 */
import { logDiagnostic, type HlLogger } from '../shared/logger/logger.js';

/** Тип глобального сбоя main (§5). */
export type ErrorKind = 'uncaughtException' | 'unhandledRejection';

/** Зависимости хендлера — точка подстановки фейков в тестах (§19). */
export interface GlobalErrorDeps {
  /** Логгер категории app (§5: уровень error, cause в метах под err). */
  readonly logger: HlLogger;
  /** Безопасный диалог; resolve = пользователь закрыл (модальность важна для guard). */
  readonly showDialog: (text: string) => Promise<unknown>;
}

/**
 * Минимальная форма process для регистрации (§19: подменённые process.on).
 * Сигнатуры совпадают с перегрузками NodeJS.Process.on — process совместим.
 */
export interface ProcessErrorTarget {
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  on(
    event: 'unhandledRejection',
    listener: (reason: unknown, promise: Promise<unknown>) => void,
  ): unknown;
}

/**
 * §9: RU-константа диалога краша. Каталог рендерера в main недоступен (арх. 06 §6:
 * тексты живут в рендерере) — фиксируется как ДОПУСТИМОЕ ИСКЛЮЧЕНИЕ из §17 с
 * комментарием; message исключения сознательно не показывается (§14).
 */
function crashDialogText(): string {
  return 'Произошла непредвиденная ошибка. Данные не затронуты. Код: APP/INTERNAL';
}

/** Порог «шторма»: подряд больше этого числа ошибок → диалоги молчат (§5). */
const MAX_CONSECUTIVE_BEFORE_SILENCE = 5;

/**
 * Фабрика обработчика глобальных ошибок (§5). Каждый вызов: лог всегда (все ошибки
 * видны — §20 п. 2), диалог — по guard-у. Замыкание хранит состояние guard-а.
 */
export function createGlobalErrorHandler(
  deps: GlobalErrorDeps,
): (error: unknown, kind: ErrorKind) => void {
  let dialogOpen = false; // §9: не более 1 активного диалога
  let consecutive = 0; // ошибки подряд с последнего «угасания» серии
  let duringDialog = 0; // ошибки, пришедшие пока диалог был открыт

  return (error: unknown, kind: ErrorKind) => {
    try {
      logDiagnostic(deps.logger, error, { kind });
    } catch (loggingCause) {
      // §13: ошибка внутри обработчика ошибки → stderr напрямую, без рекурсии через pino.
      console.error('[global-errors] сбой логирования глобальной ошибки', loggingCause);
      return;
    }

    consecutive += 1;

    if (dialogOpen) {
      duringDialog += 1;
      return; // модалка уже открыта — только лог (§9)
    }
    if (consecutive > MAX_CONSECUTIVE_BEFORE_SILENCE) {
      return; // шторм: >5 подряд → тихий лог, диалоги молчат (§5)
    }

    dialogOpen = true;
    duringDialog = 0;
    // showDialog вызывается СИНХРОННО из обработчика; асинхронно — только settling
    // (sync-throw и reject нормализуются в rejection одной обёрткой).
    void (async (): Promise<unknown> => deps.showDialog(crashDialogText()))()
      .catch((cause: unknown) => {
        console.error('[global-errors] диалог краша не показан', cause);
      })
      .finally(() => {
        dialogOpen = false;
        if (duringDialog === 0) {
          consecutive = 0; // серия угасла: диалог закрыт, новых ошибок не было
        }
      });
  };
}

/**
 * Регистрация глобальных хендлеров на process-подобном target (§5). По умолчанию —
 * process; тесты подставляют фейк с подменёнными process.on-регистрациями (§19).
 */
export function installGlobalErrorHandlers(
  deps: GlobalErrorDeps,
  target: ProcessErrorTarget = process,
): void {
  const handle = createGlobalErrorHandler(deps);
  target.on('uncaughtException', (error: Error) => handle(error, 'uncaughtException'));
  target.on('unhandledRejection', (reason: unknown) => handle(reason, 'unhandledRejection'));
}
