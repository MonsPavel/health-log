// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- локальные типы pino-roll (пакет без деклараций, §6): path-reference добавляет d.ts в программы обоих tsconfig-проектов без правок конфигов; directive обязан стоять в самом верху файла
/// <reference path="./pino-roll.d.ts" />
/**
 * TASK-010 §2/§5/§13/§14: структурный логгер main-процесса — pino + pino-roll
 * (ротация 5 МБ × 5 файлов в userData/logs, §5), категории и редакция PHI.
 *
 * ПРАВИЛА ВЫЗОВА (§13 — документируются здесь, потребители не повторяют):
 *   логируем — операции и их исходы: что сделали, сколько, какой код ошибки.
 *     Разрешено:   log.info('measurement.add', { durationMs: 12, flags: ['typo'], critical: false });
 *   никогда — что именно ввёл пользователь.
 *     Запрещено:   log.info('addMeasurement', { sys: 125, note: 'болит голова' });
 *   Ошибки — через logDiagnostic (stack/cause, §5). Ошибка, переданная обычной метой,
 *   выродится в {} (у Error нет enumerable-полей) — редакция PHI не про потерю стека.
 *
 * ЗАЩИТА В ГЛУБИНУ (§14, fail-safe) — два слоя:
 *   1. pino.redact по известным путям (PHI_REDACT_PATHS §5 дословно);
 *   2. рекурсивный censor-serializer redactPhi в formatters.log — произвольная глубина
 *      (pino redact глубина не покрывает). Нарушивший правило вызова всё равно не
 *      увидит PHI-значений в файле; контракт защищён тестами (§19/§20).
 *
 * ПОРЯДОК ИНИЦИАЛИЗАЦИИ (§9): bootstrap → whenReady → getPath('logs') → initFileLogging
 * → createLogger('app'). Фабрика ЛЕНИВАЯ (§6): до initFileLogging createLogger
 * возвращает буферизованный логгер (in-memory массив), который после инициализации
 * сбрасывается в файл — ранние ошибки старта не теряются; тот же логгер продолжает
 * писать уже напрямую.
 *
 * УРОВНИ (§5): prod (packaged) — info; dev — debug; LOG_LEVEL — переопределение только
 * в dev, некорректное значение откатывается к умолчанию окружения.
 *
 * ПРОИЗВОДИТЕЛЬНОСТЬ (§15): синхронная запись в файл допустима (объёмы малы); при
 * профилировке >5 мс/вызов — перевести на pino.transport worker (решение по замеру).
 */
import pino from 'pino';
import type { Logger } from 'pino';
import build from 'pino-roll';
import type { PinoRollStream } from 'pino-roll';

import { PHI_CENSOR, PHI_KEYS, PHI_REDACT_PATHS, redactPhi } from './redact.js';

/** Категории логов каркаса (§2: app, ipc, db, ai, net, events, job). */
export type LoggerCategory = 'app' | 'ipc' | 'db' | 'ai' | 'net' | 'events' | 'job';

/** Стандартные уровни pino без silent (тип публичного API логгера). */
export type HlLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Мета-поля вызова: значения произвольны, ключи проходят редакцию PHI (§14). */
export type LogMeta = Record<string, unknown>;

/**
 * Публичный API логгера категории (§5): message-first — как EventsLogger каркаса
 * событий (TASK-009), чтобы любой логгер приложения подставлялся структурно. Уровень
 * silent сознательно недоступен: глушение логов — не сценарий каркаса.
 */
export interface HlLogger {
  trace(message: string, meta?: LogMeta): void;
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  fatal(message: string, meta?: LogMeta): void;
}

/** Опции инициализации файлового лога; в приложении собираются из Electron (§9). */
export interface FileLoggingOptions {
  /** Абсолютный путь файла: <logs>/hl.log (pino-roll v4: активный файл — hl.1.log). */
  readonly file: string;
  /** dev (не packaged) → debug по умолчанию; prod → info (§5). */
  readonly dev: boolean;
  /** process.env.LOG_LEVEL — переопределение только в dev (§5). */
  readonly logLevel?: string;
  /** Предел размера файла до ротации; по умолчанию '5m' (§5: 5 МБ). */
  readonly size?: string;
  /** Сколько ротированных файлов хранить; по умолчанию 5 (§5, §18: предел 25 МБ). */
  readonly limitCount?: number;
}

/** Допустимые значения уровней (валидация LOG_LEVEL, §5). */
const LOG_LEVELS: ReadonlySet<string> = new Set<HlLogLevel>([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

/** Уровень prod по умолчанию (§5). */
const PROD_LEVEL: HlLogLevel = 'info';
/** Уровень dev по умолчанию (§5). */
const DEV_LEVEL: HlLogLevel = 'debug';
/** Размер ротации по умолчанию (§5: 5 МБ). */
const DEFAULT_SIZE = '5m';
/** Число хранимых ротированных файлов по умолчанию (§5: 5 файлов). */
const DEFAULT_LIMIT_COUNT = 5;

/**
 * Резолв уровня по окружению (§5): LOG_LEVEL переопределяет ТОЛЬКО в dev и только
 * валидным значением (иначе — откат к умолчанию окружения; fail-safe).
 */
export function resolveLogLevel(dev: boolean, logLevelEnv?: string): HlLogLevel {
  if (dev && logLevelEnv !== undefined) {
    const candidate = logLevelEnv.trim().toLowerCase();
    if (LOG_LEVELS.has(candidate)) {
      return candidate as HlLogLevel;
    }
  }
  return dev ? DEV_LEVEL : PROD_LEVEL;
}

// --- синглтон-состояние логирования (§9: буфер до init, файл после) ---

/** Корневой логгер; undefined = файловое логирование ещё не инициализировано. */
let root: Logger | undefined;

/** Поток ротации под корневым логгером; у pino.Logger нет end() — закрывается поток. */
let stream: PinoRollStream | undefined;

/** Запись буфера до инициализации (§9: ранние ошибки старта не теряются). */
interface BufferedEntry {
  readonly category: LoggerCategory;
  readonly level: HlLogLevel;
  readonly message: string;
  readonly meta: LogMeta;
}

/** In-memory буфер записей, сделанных до initFileLogging (§9). */
const buffered: BufferedEntry[] = [];

/** Кэш child-логгеров по категории: bindings создаются один раз на категорию. */
const children = new Map<LoggerCategory, Logger>();

/** Child-логгер категории из корневого (с кэшем — child() на каждый вызов дорог). */
function childOf(category: LoggerCategory, base: Logger): Logger {
  const cached = children.get(category);
  if (cached !== undefined) {
    return cached;
  }
  const created = base.child({ category });
  children.set(category, created);
  return created;
}

/** Адаптер pino-логгера к message-first HlLogger (публичный API каркаса). */
function asHlLogger(pinoLogger: Logger): HlLogger {
  const emit =
    (level: HlLogLevel) =>
    (message: string, meta: LogMeta = {}) => {
      // pino — obj-first (meta, message), наш API — message-first (§13)
      pinoLogger[level](meta, message);
    };
  return {
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('fatal'),
  };
}

/**
 * Фабрика логгера категории (§5). До initFileLogging возвращает буферизованный
 * логгер: записи копятся в памяти (§9) и после инициализации сбрасываются в файл;
 * сам логгер после init пишет напрямую — держать ссылку на ранний логгер безопасно
 * (ленивая фабрика, §6).
 */
export function createLogger(category: LoggerCategory): HlLogger {
  if (root === undefined) {
    const buffer =
      (level: HlLogLevel) =>
      (message: string, meta: LogMeta = {}): void => {
        if (root === undefined) {
          buffered.push({ category, level, message, meta });
          return;
        }
        childOf(category, root)[level](meta, message);
      };
    return {
      trace: buffer('trace'),
      debug: buffer('debug'),
      info: buffer('info'),
      warn: buffer('warn'),
      error: buffer('error'),
      fatal: buffer('fatal'),
    };
  }
  return asHlLogger(childOf(category, root));
}

/**
 * Сериализатор диагностической ошибки (pino serializers.err, §5 logDiagnostic):
 *   Error          → {type, message, stack}; поле cause — рекурсивно (цепочка причин);
 *   не-Error объект (в т.ч. AppError TASK-006 §7 — сознательно без стека и не
 *   наследует Error) → собственные enumerable-поля, где PHI-ключи (§7) цензурены
 *   целиком, cause обходится рекурсивно (там может лежать Error), остальные значения —
 *   через redactPhi;
 *   примитивы — как есть.
 * Стеки не содержат данных пользователя (§5) и не редактируются; произвольные
 * собственные поля Error намеренно не выгружаются (fail-closed: у стандартного Error
 * их нет, у кастомных классов — не наша задача публиковать).
 */
function serializeDiagnosticError(error: unknown): unknown {
  if (error instanceof Error) {
    const out: Record<string, unknown> = {
      type: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (error.cause !== undefined) {
      out['cause'] = serializeDiagnosticError(error.cause);
    }
    return out;
  }
  if (typeof error === 'object' && error !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(error)) {
      if (PHI_KEYS.has(key)) {
        out[key] = PHI_CENSOR;
      } else if (key === 'cause') {
        out[key] = serializeDiagnosticError(value);
      } else {
        out[key] = redactPhi(value);
      }
    }
    return out;
  }
  return error;
}

/**
 * Хелпер диагностического логирования ошибок (§5): пишет message/stack/cause без
 * PHI-полей (§20). Только для ошибок — обычные события идут уровневыми методами (§13).
 * Ошибка уезжает в мету под ключом `err` — на него зарегистрирован сериализатор.
 */
export function logDiagnostic(logger: HlLogger, error: unknown, context?: LogMeta): void {
  logger.error('diagnostic', { ...context, err: error });
}

/**
 * Инициализация файлового логирования (§9): создаёт корневой pino-логгер с ротацией
 * и переводит буфер в рабочий режим. Повторный вызов закрывает прежний поток —
 * сценарий: тесты (изолированные tmp) и горячая замена конфигурации.
 */
export async function initFileLogging(options: FileLoggingOptions): Promise<void> {
  const level = resolveLogLevel(options.dev, options.logLevel);
  const roll = await build({
    file: options.file,
    size: options.size ?? DEFAULT_SIZE,
    limit: { count: options.limitCount ?? DEFAULT_LIMIT_COUNT },
    // §15: синхронная запись допустима (объёмы малы); mkdir — каталог может не существовать
    sync: true,
    mkdir: true,
  });
  const instance = pino(
    {
      level,
      // Приватность (§7 «пути без имени пользователя»): hostname может содержать имя
      // пользователя — в лог не пишется; pid достаточен для сопоставления процессов.
      base: { pid: process.pid },
      // Слой 1 (§14): pino.redact по известным путям §5 дословно.
      redact: { paths: [...PHI_REDACT_PATHS], censor: PHI_CENSOR },
      // Слой 2 (§14): рекурсивная редакция произвольной глубины до сериализации.
      formatters: { log: (object) => redactPhi(object) as Record<string, unknown> },
      // Ошибки — через logDiagnostic: извлечение stack/cause + редакция (§5/§20).
      serializers: { err: serializeDiagnosticError },
    },
    roll,
  );

  // Повторная инициализация: закрываем прежний поток (у pino.Logger нет end()).
  stream?.end();
  root = instance;
  stream = roll;
  children.clear();

  // §9: сброс буфера — ранние записи попадают в файл с уровнем/категориями контекста
  const pending = buffered.splice(0, buffered.length);
  for (const entry of pending) {
    childOf(entry.category, root)[entry.level](entry.meta, entry.message);
  }
}

/**
 * Сброс синглтон-состояния (только тесты, §19): буфер до init требует «чистого» старта
 * модуля между кейсами; прод-код этой функцией не пользуется.
 */
export function resetLoggingForTests(): void {
  stream?.end();
  root = undefined;
  stream = undefined;
  children.clear();
  buffered.length = 0;
}
