/**
 * TASK-057 §5/§13: опорные линии графика — границы «высокое нормальное»/«АГ 1»
 * ИЗ ДАННЫХ активной шкалы (не хардкод: sys-порог high_normal и hypertension1 —
 * sysRange.min категорий; dia — diaRange.min, §13), стили из токенов темы
 * (пунктир, var(--hl-border) — не compete с сериями).
 *
 * РАЗДЕЛЕНИЕ (ревью TASK-057): компонент ReferenceLines рендерит ТОЛЬКО
 * <ReferenceLine> — он ребёнок ComposedChart, а Recharts 3.10 монтирует
 * произвольных детей ВНУТРЬ <svg>; HTML-элемент внутри svg в Chromium (движок
 * Electron) не рендерится (getBoundingClientRect 0×0, offsetParent null) и не
 * попадает в accessibility-дерево — jsdom этого не видит (узел в DOM-дереве
 * есть), поэтому подпись источника НЕ МОЖЕТ быть ребёнком графика. Она вынесена
 * в ScaleSourceCaption, который TrendChart ставит ВНЕ svg и ВНЕ aria-hidden-
 * обёртки графика — рядом с легендой/подписью агрегации; ОДИН РАЗ НА ГРАФИК
 * (§13). label самого ReferenceLine не используется: в jsdom его текст не
 * рендерится, тестопригодность теряется.
 *
 * referenceThresholdsOf — чистая функция извлечения (§7): категории
 * high_normal/hypertension1 могут отсутствовать в будущих версиях шкалы —
 * отсутствующие пороги линий не дают (потребители рисуют то, что отдала шкала).
 */
import { useTranslation } from 'react-i18next';
import { ReferenceLine } from 'recharts';

import type { ActiveScale } from '@hl/contracts';

/** Категории-источники опорных линий (§13: high_normal — «высокое нормальное», hypertension1 — «АГ1»). */
const REFERENCE_CATEGORIES = ['high_normal', 'hypertension1'] as const;

/** Одна опорная линия (§13): канал и значение — нижняя граница диапазона категории. */
export interface BpReference {
  readonly channel: 'sys' | 'dia';
  readonly value: number;
}

/** Извлечённые пороги шкалы (§7): линии + подпись источника. */
export interface BpReferences {
  readonly lines: readonly BpReference[];
  readonly sourceLabel: string;
}

/** Нижняя граница диапазона; null (открытая сторона) — линии не даёт. */
function rangeMinOf(
  category: ActiveScale['categories'][number],
  channel: 'sys' | 'dia',
): number | null {
  const range = channel === 'sys' ? category.sysRange : category.diaRange;
  return range.min;
}

/**
 * Извлечение опорных линий из активной шкалы (§13): для high_normal и
 * hypertension1 — min sysRange и min diaRange; сортировка по значению внутри
 * канала (на графике 85 < 90, 130 < 140 — детерминированный порядок, NFR-10).
 */
export function referenceThresholdsOf(scale: ActiveScale): BpReferences {
  const lines: BpReference[] = [];
  for (const code of REFERENCE_CATEGORIES) {
    const category = scale.categories.find((candidate) => candidate.code === code);
    if (category === undefined) {
      continue;
    }
    for (const channel of ['sys', 'dia'] as const) {
      const min = rangeMinOf(category, channel);
      if (min !== null) {
        lines.push({ channel, value: min });
      }
    }
  }
  const byChannelValue = (a: BpReference, b: BpReference): number =>
    a.channel === b.channel ? a.value - b.value : a.channel === 'sys' ? -1 : 1;
  return { lines: [...lines].sort(byChannelValue), sourceLabel: scale.sourceLabel };
}

/** Шкала валидна для рисования: задана и категории — массив (guard против мусора провода). */
function isDrawableScale(scale: ActiveScale | undefined): scale is ActiveScale {
  return scale !== undefined && Array.isArray(scale.categories);
}

/** Свойства ReferenceLines (§5): активная шкала или undefined (ещё грузится). */
export interface ReferenceLinesProps {
  readonly scale: ActiveScale | undefined;
}

/**
 * Опорные линии ВНУТРИ ComposedChart (§20.1: 2 sys + 2 dia) — только SVG-узлы
 * Recharts (см. шапку: никаких HTML-детей графика). Пунктир strokeDasharray
 * "2 4" и токен --hl-border — линии-справка не пересекаются стилем с сериями
 * (sys — сплошная, dia — штрих, §5).
 */
export function ReferenceLines({ scale }: ReferenceLinesProps): JSX.Element | null {
  if (!isDrawableScale(scale)) {
    return null;
  }
  const { lines } = referenceThresholdsOf(scale);
  return (
    <>
      {lines.map((line) => (
        <ReferenceLine
          key={`${line.channel}-${line.value}`}
          y={line.value}
          stroke="var(--hl-border)"
          strokeDasharray="2 4"
          ifOverflow="extendDomain"
        />
      ))}
    </>
  );
}

/** Свойства ScaleSourceCaption (§13): активная шкала или undefined (ещё грузится). */
export interface ScaleSourceCaptionProps {
  readonly scale: ActiveScale | undefined;
}

/**
 * Подпись источника справочных значений (§13: один раз на график; §17: текст —
 * sourceLabel ИЗ ДАННЫХ шкалы). Рендерится TrendChart'ом ВНЕ <svg> и ВНЕ
 * aria-hidden-обёртки графика — видим и доступен вспомогательным технологиям
 * (ревью TASK-057: HTML внутри svg в Chromium не рендерится).
 */
export function ScaleSourceCaption({ scale }: ScaleSourceCaptionProps): JSX.Element | null {
  const { t } = useTranslation();
  if (!isDrawableScale(scale)) {
    return null;
  }
  return (
    <div data-testid="scale-source" className="mt-1 text-xs text-muted">
      {t('dashboard.a11y.sourceLabel', { source: scale.sourceLabel })}
    </div>
  );
}
