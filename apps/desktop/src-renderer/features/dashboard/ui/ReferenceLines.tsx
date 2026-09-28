/**
 * TASK-057 §5/§13: опорные линии графика — границы «высокое нормальное»/«АГ 1»
 * ИЗ ДАННЫХ активной шкалы (не хардкод: sys-порог high_normal и hypertension1 —
 * sysRange.min категорий; dia — diaRange.min, §13), стили из токенов темы
 * (пунктир, var(--hl-border) — не compete с сериями), подпись источника
 * (sourceLabel) — ОДИН РАЗ НА ГРАФИК (§13, HTML-caption вне SVG: label
 * ReferenceLine в jsdom не рендерится и для вспомогательных технологий глух —
 * HTML-подпись проверяема тестами и доступна скринридерам; решение в духе
 * ADR-0003 §2 «декоративные узлы — aria-hidden»).
 *
 * referenceThresholdsOf — чистая функция извлечения (§7): категории
 * high_normal/hypertension1 могут отсутствовать в будущих версиях шкалы —
 * отсутствующие пороги линий не дают (потребители рисуют то, что отдала шкала).
 */
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
function rangeMinOf(category: ActiveScale['categories'][number], channel: 'sys' | 'dia'): number | null {
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

/** Свойства ReferenceLines (§5): активная шкала или undefined (ещё грузится). */
export interface ReferenceLinesProps {
  readonly scale: ActiveScale | undefined;
}

/**
 * Опорные линии внутри ComposedChart (§20.1: 2 sys + 2 dia) + caption источника.
 * Пунктир strokeDasharray "2 4" и токен --hl-border — линии-справка не
 * пересекаются стилем с сериями (sys — сплошная, dia — штрих, §5).
 */
export function ReferenceLines({ scale }: ReferenceLinesProps): JSX.Element | null {
  if (scale === undefined) {
    return null;
  }
  const { lines, sourceLabel } = referenceThresholdsOf(scale);
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
      {/* §13: подпись источника — один раз на график; за пределами SVG (см. шапку). */}
      <div data-testid="scale-source" className="text-xs text-neutral-500">
        {sourceLabel}
      </div>
    </>
  );
}
