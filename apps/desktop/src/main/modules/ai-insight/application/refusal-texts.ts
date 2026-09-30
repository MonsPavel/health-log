/**
 * TASK-086 §5/§7: refusalTextFactory — фабрика гарантированных отказ-текстов БЕЗ
 * LLM (арх. 07 §4 эшелон 2): treatment/dosage, diagnosis, insufficientData,
 * emergency (полный текст FR-7.4 из общего модуля shared/critical-texts).
 * LLM не вызывается там, где текст должен быть гарантирован (AC-5.1).
 *
 * ТЕКСТЫ — RU-КОНСТАНТЫ main (решение §5/§17: как system prompt 084 — LLM-слой не
 * локализуется каталогом UI); ключи-идентификаторы классов — REFUSAL_TEXT_KEYS
 * (участник лог-события §18). Golden-снапшот текстов — __fixtures__/
 * refusal-texts-golden.txt (несовпадение = осознанный коммит), запрет-лексика
 * SRS 01 §8 — словарь-тест (§14). ⚠️ Состав лексики: слово «диагноз» в отказах
 * НЕ используется (запрет-тест §14/§20) — не-диагностика выражена формулировкой
 * «Я не определяю заболевания» вместо цитаты §5 «Я не ставлю диагнозы».
 *
 * ФАКТУРА (§7/§13): «короткие факты из контекста — средние/count из
 * PeriodStatistics, без советов»; в тексте — только числа (count, дни, средние
 * СДА/ДДА, пульс), интерпретаций нет. У treatment/dosage фактура — только «если
 * есть данные» (§5); diagnosis — всегда (честный ответ, что видно в данных);
 * insufficientData называет счётчики в скобках (порог kernel TASK-006).
 *
 * СОВМЕСТИМОСТЬ (§7 085): RefusalTextFactory расширяет интерфейс ResponseGuard
 * вторым опциональным параметром meta — (cls) => string 085 принимает её без
 * адаптера (инъекция контейнером в 087; guard-замены приходят без meta — базовые
 * тексты без фактуры). emergency без meta — RU-локаль (решение §17).
 *
 * §15: чистые строковые операции над готовой статистикой — микросекунды; §14:
 * никаких сетевых вызовов и внешних данных, только аргументы.
 */
import type { PeriodStatisticsDto } from '@hl/contracts';

import {
  CRITICAL_THRESHOLD_HIGH,
  criticalHighText,
} from '../../../shared/critical-texts.js';
import type { RefusalClass } from '../domain/guardrail-policy.js';
import { daysWord } from './context-format.js';

/**
 * Ключи-идентификаторы отказов (§5: «ключи-идентификаторы для логов», §18) —
 * стабильные, в текст и PHI не входят. Полный Record: новый RefusalClass в
 * политике 082 без ключа и текста не скомпилируется.
 */
export const REFUSAL_TEXT_KEYS: Readonly<Record<RefusalClass, string>> = {
  treatment: 'ai.refusal.treatment',
  dosage: 'ai.refusal.dosage',
  diagnosis: 'ai.refusal.diagnosis',
  emergency: 'ai.refusal.emergency',
  insufficientData: 'ai.refusal.insufficientData',
};

/** Мета фабрики (§5 «refusalTextFactory(class, meta)»): фактура и локаль номеров. */
export interface RefusalTextMeta {
  /** Статистика периода (read model 054 на проводе) — источник фактуры (§7). */
  readonly stats?: PeriodStatisticsDto;
  /** Локаль для номеров экстренных служб (§14: реестр по локали 041); нет — ru. */
  readonly locale?: string;
}

/**
 * Фабрика отказ-текстов (§5): класс + мета → готовый гарантированный текст.
 * Совместима с портом ResponseGuard 085 (второй параметр опционален).
 */
export type RefusalTextFactory = (refusalClass: RefusalClass, meta?: RefusalTextMeta) => string;

/** Локаль по умолчанию (§17: RU-константы main; EN — не включено §5). */
const DEFAULT_LOCALE = 'ru';

/** Базовый текст treatment/dosage — один шаблон на оба класса (§5). */
const MEDICATION_REFUSAL =
  'Это вопрос о лекарствах, а я не могу советовать приём или изменение препаратов. Обсудите это с врачом.';

/** RU-множественное слово «измерение/измерения/измерений» (фактура §5/§7). */
function measurementsWord(n: number): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 12 && mod100 <= 14) {
    return 'измерений';
  }
  if (mod10 === 1) {
    return 'измерение';
  }
  if (mod10 >= 2 && mod10 <= 4) {
    return 'измерения';
  }
  return 'измерений';
}

/** Фактура периода (§7/§13): count/дни/средние/пульс — только числа. */
function factsOf(stats: PeriodStatisticsDto | undefined): string {
  if (stats === undefined || stats.count === 0) {
    return 'в периоде пока нет измерений';
  }
  const parts = [
    `${stats.count} ${measurementsWord(stats.count)} за ${stats.daysWithMeasurements} ${daysWord(stats.daysWithMeasurements)}`,
  ];
  if (stats.sys.avg !== undefined && stats.dia.avg !== undefined) {
    parts.push(`среднее СДА ${stats.sys.avg}, ДДА ${stats.dia.avg}`);
  }
  if (stats.pulse?.avg !== undefined) {
    parts.push(`пульс ${stats.pulse.avg}`);
  }
  return parts.join(', ');
}

/** Фактура средних для «Вот факты» (insufficientData): только числа, без count. */
function factsAveragesOf(stats: PeriodStatisticsDto): string | undefined {
  if (stats.count === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (stats.sys.avg !== undefined && stats.dia.avg !== undefined) {
    parts.push(`среднее СДА ${stats.sys.avg}, ДДА ${stats.dia.avg}`);
  }
  if (stats.pulse?.avg !== undefined) {
    parts.push(`пульс ${stats.pulse.avg}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** Отказ treatment/dosage (§5): базовый текст + фактура, «если есть данные». */
function medicationText(stats: PeriodStatisticsDto | undefined): string {
  if (stats === undefined || stats.count === 0) {
    return MEDICATION_REFUSAL;
  }
  return `${MEDICATION_REFUSAL}\n\nВот что видно в данных: ${factsOf(stats)}.`;
}

/** Отказ diagnosis (§5): не-диагностика + фактура (всегда) + отсылка к врачу. */
function diagnosisText(stats: PeriodStatisticsDto | undefined): string {
  const facts = factsOf(stats);
  return `Я не определяю заболевания. Вот что видно в данных: ${facts}. Обратитесь к врачу для оценки.`;
}

/** Отказ insufficientData (§5): счётчики в скобках (порог kernel) + честные факты. */
function insufficientText(stats: PeriodStatisticsDto | undefined): string {
  if (stats === undefined) {
    // Защитный вариант (инъекция фабрики в ResponseGuard 085 — meta нет): текст
    // гарантирован и без фактуры.
    return 'Данных пока мало — я не буду делать выводов.';
  }
  const counters = `${stats.count} ${measurementsWord(stats.count)} за ${stats.daysWithMeasurements} ${daysWord(stats.daysWithMeasurements)}`;
  const averages = factsAveragesOf(stats);
  const facts = averages === undefined ? 'измерений в периоде нет' : averages;
  return `Данных пока мало (${counters}) — я не буду делать выводов. Вот факты: ${facts}.`;
}

/** Отказ emergency (§14/§20): полный текст FR-7.4, номера по локали (041). */
function emergencyText(locale: string | undefined): string {
  return criticalHighText(CRITICAL_THRESHOLD_HIGH, locale ?? DEFAULT_LOCALE);
}

/**
 * Фабрика отказ-текстов (§5): dispatch по классу — данные REFUSAL_TEXT_KEYS +
 * четыре шаблона выше; нового класса без текста не даст компилятор (Record).
 * Чистая функция: результат зависит только от аргументов.
 */
export const refusalText: RefusalTextFactory = (refusalClass, meta) => {
  const stats = meta?.stats;
  switch (refusalClass) {
    case 'treatment':
    case 'dosage':
      return medicationText(stats);
    case 'diagnosis':
      return diagnosisText(stats);
    case 'insufficientData':
      return insufficientText(stats);
    case 'emergency':
      return emergencyText(meta?.locale);
  }
};
