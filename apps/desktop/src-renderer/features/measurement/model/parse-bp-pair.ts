/**
 * TASK-040 §4/§7: умная вставка пары «120/80» — чистая функция без DOM (тестируемость,
 * §4): текст буфера разбирается регуляркой §5, результат — только если ОБА числа в
 * доменных границах; иначе undefined (форма покажет тост-подсказку, поля не тронет —
 * EC-18: толерантный разбор, не потерять введённое).
 *
 * Текст буфера живёт только в памяти вызова — в DOM/логи не попадает (§14).
 */

/**
 * §7: границы домена — КОПИЯ констант контракта TASK-028
 * (packages/contracts/src/measurement/schemas.ts: SYS_MIN/SYS_MAX/DIA_MIN/DIA_MAX).
 * СИНХРОНИЗАЦИЯ: менять только вместе с контрактом (zod-схема — истина для
 * валидации на submit; здесь — только порог распознавания пары при вставке).
 */
const SYS_MIN = 50;
const SYS_MAX = 300;
const DIA_MIN = 20;
const DIA_MAX = 200;

/**
 * §5: два числа по 2–3 цифры с разделителем / , ; - или пробелом; пробелы по краям
 * (и вокруг разделителя) тримятся.
 */
const BP_PAIR_RE = /^\s*(\d{2,3})\s*[/,;\-\s]\s*(\d{2,3})\s*$/;

/** Распознанная пара давления: sys/dia — числа в доменных границах (§7). */
export interface BpPair {
  /** Систолическое (СДА), 50–300. */
  readonly sys: number;
  /** Диастолическое (ДДА), 20–200. */
  readonly dia: number;
}

/**
 * Разобрать текст буфера как пару «120/80» (§7): возвращает {sys, dia} только если
 * оба числа в доменных границах (50–300 / 20–200); одиночное число, мусор,
 * >3 цифр — undefined. Ведущие нули схлопываются числом («080» → 80).
 */
export function parseBpPair(text: string): BpPair | undefined {
  const match = BP_PAIR_RE.exec(text);
  if (match === null) {
    return undefined;
  }
  const sys = Number(match[1]);
  const dia = Number(match[2]);
  if (sys < SYS_MIN || sys > SYS_MAX || dia < DIA_MIN || dia > DIA_MAX) {
    return undefined;
  }
  return { sys, dia };
}
