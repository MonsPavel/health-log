/**
 * TASK-012 §5: single-instance lock — тестируемая обёртка над штатным механизмом
 * Electron app.requestSingleInstanceLock() (идемпотентный лок по user-data-lockfile;
 * свои файловые локи/порты избыточны — §4). Повторный запуск не создаёт второй
 * экземпляр: не получили лок → молчаливый app.quit() без диалога (пользователь увидит
 * фокус существующего окна); получили → подписка second-instance, по событию окно
 * восстанавливается и получает фокус (§2). Гонка «два запуска одновременно» разрешается
 * механизмом Electron атомарно; повреждение лок-файла Electron пересоздаёт сам (§13).
 *
 * Модуль чист (без импорта electron, прецедент global-errors §19): Electron-приложение
 * подставляется проводкой в bootstrap.ts до whenReady; тесты — fake-таргетом (§19).
 *
 * argv события second-instance в MVP не используется — задел на будущий приём
 * файлов/ссылок вторым экземпляром (§23); обработчик получает его как есть.
 */
import type { HlLogger } from '../shared/logger/logger.js';

/**
 * Минимальная форма Electron app для захвата лока (§19: fake в тестах). Сигнатура
 * on повторяет electron-перегрузку 'second-instance' (listener: event, argv,
 * workingDirectory) — app структурно совместим, а обёртка не перепутает argv с event.
 */
export interface SingleInstanceApp {
  /** Захват лока: true — мы первый (и единственный) экземпляр. */
  requestSingleInstanceLock(): boolean;
  /** Молчаливое завершение второго процесса (§5: без диалога). */
  quit(): void;
  /** Подписка на second-instance; listener получает событие и argv второго процесса. */
  on(
    event: 'second-instance',
    listener: (event: unknown, argv: string[], workingDirectory: string) => void,
  ): unknown;
}

/** Слушатель второго экземпляра: argv — командная строка второго процесса (§23). */
export type SecondInstanceListener = (argv: string[]) => void;

/**
 * Захват single-instance лока (§5/§9): lock → не получили: quit синхронно и false
 * (вызывающий bootstrap не регистрирует whenReady — окно не создаётся, §20 п. 2);
 * получили: подписка second-instance → onSecondInstance(argv), true.
 */
export function ensureSingleInstance(
  onSecondInstance: SecondInstanceListener,
  target: SingleInstanceApp,
): boolean {
  if (!target.requestSingleInstanceLock()) {
    target.quit();
    return false;
  }
  // Electron-сигнатура слушателя: (event, argv, workingDirectory) — наружу идёт argv.
  target.on('second-instance', (_event, argv) => {
    onSecondInstance(argv);
  });
  return true;
}

/** Зависимости обработчика second-instance — точка подстановки фейков в тестах (§19). */
export interface SecondInstanceDeps {
  /** Логгер категории app (§9/§18: info-запись события). */
  readonly logger: HlLogger;
  /** Восстановление существующего окна (create-window focusExistingWindow, §10). */
  readonly focusWindow: () => void;
}

/**
 * Обработчик second-instance (§9/§18): info-запись «почему окно вдруг в фокусе» +
 * восстановление окна. Содержимое argv в лог не попадает — там пути второго процесса
 * (могут содержать имя пользователя; правило §13 «никогда — данные ввода», §14
 * fail-closed): логируется только размер массива.
 */
export function createSecondInstanceHandler(deps: SecondInstanceDeps): SecondInstanceListener {
  return (argv) => {
    deps.logger.info('second-instance', { args: argv.length });
    deps.focusWindow();
  };
}
