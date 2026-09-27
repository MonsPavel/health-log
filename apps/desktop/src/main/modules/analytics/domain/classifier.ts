/**
 * TASK-053 §5/§7: Classifier — категория среднего за период по активной шкале
 * (правило «худшая из двух»: sys и dia классифицируются НЕЗАВИСИМО, берётся более
 * тяжёлая — индекс в отсортированном массиве больше; SRS 04 табл. 4.1: «по более
 * высокой категории из двух измерений») с обязательными примечаниями FR-4.2.
 *
 * ЗАМЕТКИ НЕОТДЕЛИМЫ ОТ РЕЗУЛЬТАТА (§3): при наличии категории возвращаются ВСЕГДА
 * обе — homeBP (домашний порог ≥135/85 ↔ офисный ≥140/90) и specialGroups
 * (неприменимость особым группам). Тексты — ИЗ ДАННЫХ шкалы (§14, юр. контроль
 * R-1: стабильность формулировок), здесь не генерируются. При insufficientData
 * (пороги kernel AI_MIN_* — единый источник с PeriodStatistics, §13) сборщик
 * подаёт средние как undefined → категория undefined + note insufficientData;
 * заметки homeBP/specialGroups — пара к категории и в этой ветке отсутствуют.
 *
 * КЛАССИФИКАТОР НЕ СОДЕРЖИТ ПОРОГОВ (§4): данные шкалы хранят диапазоны категорий
 * (TASK-050 §7). Типы ScaleCategory/BpRange — структурное зеркало опубликованных
 * типов @hl/scales-data: domain-purity (арх. 03 §4) запрещает domain импортировать
 * пакет, совместимость зеркал фиксирует тип-тест (прецедент zod-зеркала contracts,
 * TASK-050 §4). Защита «вне всех диапазонов» (§7, «по стороне выхода»): выше всех
 * диапазонов → последняя категория; ниже всех и в щели между категориями → соседняя
 * БОЛЕЕ ТЯЖЁЛАЯ — занижение в щели небезопасно (§3). Правило достижимо на
 * прод-входе: округлённые до 1 знака средние 052 подаются как есть (§13) и попадают
 * в щели целых границ (129.5, 84.5, 179.5, …). Пульс-классификация — НЕ включено
 * (§5: только справка 60–100 на UI); гипотензия — low-флаг TASK-020, не шкала.
 * Чистая функция O(6) (§15), без времени/состояния (арх. 02 §5).
 */

/** Диапазон АД в мм рт. ст., границы включительно; null — открытая сторона — зеркало BpRange @hl/scales-data. */
export interface BpRange {
  readonly min: number | null;
  readonly max: number | null;
}

/** Категория шкалы — зеркало ScaleCategory @hl/scales-data (совместимость — тип-тест). */
export interface ScaleCategory {
  readonly code: string;
  readonly label: string;
  /** Границы по систолическому давлению (СДА), мм рт. ст. */
  readonly sysRange: BpRange;
  /** Границы по диастолическому давлению (ДДА), мм рт. ст. */
  readonly diaRange: BpRange;
}

/** Поверхность шкалы, необходимая классификации (§5): удовлетворяют ScaleData и ActiveScale. */
export interface ScaleForClassification {
  /** Категории в порядке от оптимальной к тяжёлой (§13 TASK-050). */
  readonly categories: readonly ScaleCategory[];
  readonly homeBPNote: string;
  readonly specialGroupsNote: string;
}

/** Род примечания (§5); тексты homeBP/specialGroups — из данных шкалы. */
export type ClassificationNoteKind = 'homeBP' | 'specialGroups' | 'insufficientData';

/** Примечание, неотделимое от результата классификации (§3/§5). */
export interface ClassificationNote {
  readonly kind: ClassificationNoteKind;
  readonly text: string;
}

/** Результат классификации средних (§5): категория + обязательные примечания. */
export interface Classification {
  /** Нет категории при недостатке данных (пороги kernel — у сборщика, §13). */
  readonly category: ScaleCategory | undefined;
  readonly notes: readonly ClassificationNote[];
}

/**
 * Текст note insufficientData (§17: notes — тексты RU v1). Без чисел порогов:
 * пороги kernel не дублируются в текст (единый источник — constants kernel).
 */
export const INSUFFICIENT_DATA_NOTE_TEXT =
  'Данных пока мало: среднее и категория за период не определяются — продолжайте измерения.';

/** Значение в диапазоне: обе границы включительно, null — сторона открыта (§7 TASK-050). */
function contains(range: BpRange, value: number): boolean {
  return (range.min === null || value >= range.min) && (range.max === null || value <= range.max);
}

/**
 * Индекс ПЕРВОЙ категории, чей диапазон содержит значение (§7), или защита §7
 * «по стороне выхода»: выше всех диапазонов → последняя категория; ниже всех и в
 * щели между категориями → СОСЕДНЯЯ БОЛЕЕ ТЯЖЁЛАЯ (первая, чей min больше
 * значения) — сторона выхода из щели примыкает к тяжёлой соседке, и занижение
 * (напр. 179.5 → «Оптимальное») было бы «молчаливым смещением» §3. Достижимо на
 * прод-входе: округлённые средние 052 подаются как есть (§13) и попадают в щели
 * целых границ. Ниже всех первая категория и есть соседняя тяжёлая. Пустой список
 * категорий → undefined (категории нет — заметок нет).
 */
function categoryIndexFor(
  categories: readonly ScaleCategory[],
  value: number,
  rangeKey: 'sysRange' | 'diaRange',
): number | undefined {
  const last = categories.length - 1;
  if (last < 0) {
    return undefined;
  }
  for (let i = 0; i < categories.length; i += 1) {
    if (contains(categories[i]![rangeKey], value)) {
      return i;
    }
  }
  const lastMax = categories[last]![rangeKey].max;
  if (lastMax !== null && value > lastMax) {
    return last;
  }
  for (let i = 0; i < categories.length; i += 1) {
    const min = categories[i]![rangeKey].min;
    if (min !== null && value < min) {
      return i;
    }
  }
  // Недостижимо при стыковке диапазонов (значение не выше lastMax обязано иметь
  // соседнюю с большим min) — защита в самую тяжёлую сторону (§3).
  return last;
}

/**
 * Классификация округлённых средних периода по активной шкале (§5). `avgSys`/
 * `avgDia` подаются сборщиком 052 КАК ЕСТЬ (§13: классификатор не перечитывает);
 * undefined (любое из двух) — сигнал «мало данных» от порогов kernel → категория
 * undefined + note insufficientData. При категории — ВСЕГДА обе заметки
 * homeBP + specialGroups (AC §20) в фиксированном порядке.
 */
export function classify(
  avgSys: number | undefined,
  avgDia: number | undefined,
  scale: ScaleForClassification,
): Classification {
  if (avgSys === undefined || avgDia === undefined) {
    return {
      category: undefined,
      notes: [{ kind: 'insufficientData', text: INSUFFICIENT_DATA_NOTE_TEXT }],
    };
  }

  const sysIndex = categoryIndexFor(scale.categories, avgSys, 'sysRange');
  const diaIndex = categoryIndexFor(scale.categories, avgDia, 'diaRange');
  if (sysIndex === undefined || diaIndex === undefined) {
    // Невозможно по форме канала (≥1 категория) — защита без выдуманной категории.
    return { category: undefined, notes: [] };
  }

  // «Худшая из двух» (§7): больший индекс отсортированного массива — тяжелее.
  const worst = Math.max(sysIndex, diaIndex);
  return {
    category: scale.categories[worst],
    notes: [
      { kind: 'homeBP', text: scale.homeBPNote },
      { kind: 'specialGroups', text: scale.specialGroupsNote },
    ],
  };
}
