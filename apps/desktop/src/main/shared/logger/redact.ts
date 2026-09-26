/**
 * TASK-010 §5/§7/§14: редакция PHI — рекурсивный censor-serializer, второй слой защиты
 * поверх pino.redact (§14: pino redact не покрывает произвольную глубину вложенности).
 *
 * Контракт (§7): PHI-поля — sys, dia, pulse, note, content, question, answer,
 * measurements (+ singular measurement из redact-путей §5) и любые объекты с этими
 * ключами на ЛЮБОМ уровне вложенности. Значение PHI-ключа заменяется целиком на
 * '[redacted]'; разрешённые соседи (id, коды ошибок, длительности, версии, пути без
 * имени пользователя) остаются без изменений.
 *
 * Правила:
 *  - редакция — по КЛЮЧУ, точное совпадение (system ≠ sys, §7: ключи логируются, не
 *    содержимое строк; первичное правило — §13 logger.ts: не логировать пользовательский
 *    ввод);
 *  - вход никогда не мутируется — возвращается новый объект (мету логгера можно
 *    переиспользовать);
 *  - fail-safe (§14): глубже MAX_REDACT_DEPTH — цензура («неизвестное = цензуренное»),
 *    циклические ссылки — цензура ссылки вместо бесконечной рекурсии/исключения.
 *
 * Процесс (§22): любое новое чувствительное поле домена = правка PHI_KEYS и
 * PHI_REDACT_PATHS в этом файле (пункт в DoD фич-задач P1+).
 */

/** Заменитель цензурированных значений (§5). */
export const PHI_CENSOR = '[redacted]';

/**
 * Чёрный список PHI-ключей рекурсивного слоя (§7 + singular measurement из §5).
 * Точное совпадение ключа на любом уровне вложенности.
 */
export const PHI_KEYS: ReadonlySet<string> = new Set([
  'sys',
  'dia',
  'pulse',
  'note',
  'content',
  'question',
  'answer',
  'measurement',
  'measurements',
  // TASK-022 §14: ключ шифрования БД (openEncrypted) никогда не логируется —
  // цензура на любом уровне вложенности рекурсивного слоя.
  'keyHex',
  'key',
]);

/**
 * redact-пути первого слоя — pino.redact (§5, дословно): известные пути с цензурой
 * PHI_CENSOR. Покрывают верхний уровень и `*.note`/`*.content` на глубине 1; глубже —
 * работа рекурсивного слоя (redactPhi в formatters.log, logger.ts).
 */
export const PHI_REDACT_PATHS: readonly string[] = [
  'sys',
  'dia',
  'pulse',
  'note',
  'content',
  'question',
  'answer',
  '*.note',
  '*.content',
  'measurement',
  'measurements',
  // TASK-022 §14: ключ шифрования БД — top-level и глубина 1 (глубже — рекурсивный слой).
  'keyHex',
  'key',
  '*.keyHex',
  '*.key',
];

/**
 * Предел глубины рекурсии (§14 fail-safe): глубже — значение считается неизвестным и
 * цензурируется. 10 уровней на порядок больше фактической мете логов; защита от
 * циклов и патологических объектов.
 */
export const MAX_REDACT_DEPTH = 10;

/**
 * Рекурсивная редакция: обходит значение и возвращает копию, где все PHI-ключи
 * (PHI_KEYS, точное совпадение) заменены на PHI_CENSOR. Массивы обходятся по элементам;
 * ключи-не-PHI рекурсивно; PHI-ключ — целиком, без обхода значения.
 *
 * Ошибки (Error) не имеют собственных enumerable-полей — здесь они вырождаются в {};
 * ошибки логируются через logDiagnostic (logger.ts), где стек/cause извлекаются
 * отдельным сериализатором и проходят эту же редакцию (§20).
 */
export function redactPhi(
  value: unknown,
  depth = 0,
  seen: ReadonlySet<object> = new Set(),
): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return PHI_CENSOR;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Ошибки — листья: их разбор (message/stack/cause) — работа err-сериализатора
  // (logger.ts, logDiagnostic §5). Важно: pino применяет formatters.log ДО
  // сериализаторов, поэтому опустошённый здесь Error лишит сериализатор стека.
  // Без сериализатора ошибка всё равно выродится в {} при строковой сериализации —
  // без утечки собственных полей (fail-closed).
  if (value instanceof Error) {
    return value;
  }
  // здесь value сужено до object (null отсечён выше)
  if (seen.has(value)) {
    return PHI_CENSOR;
  }
  const visited = new Set(seen);
  visited.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactPhi(item, depth + 1, visited));
  }
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    out[key] = PHI_KEYS.has(key) ? PHI_CENSOR : redactPhi(member, depth + 1, visited);
  }
  return out;
}
