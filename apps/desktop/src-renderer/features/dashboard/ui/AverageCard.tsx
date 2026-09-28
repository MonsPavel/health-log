/**
 * TASK-061 §2/§5/§13/§16/§17: карточка «Среднее за 7 дней» домашней сводки —
 * СДА/ДДА/ЧСС + count ИЗ ГОТОВОГО stats-ответа (stats/period 7d, §4: принцип
 * задачи — без новых вычислений; дробные — formatNumberRu, та же копия, что у
 * резюме тренда 059). Категория+notes — из classification ТОГО ЖЕ ответа:
 * категория несёт подпись ИЗ ДАННЫХ шкалы (SCALE_CATEGORY-объект с label —
 * R-1: формулировки не хардкодятся, классификация без второй загрузки — §4 054).
 *
 * МАЛО ДАННЫХ (§13/EC-09): флаг stats.insufficientData → пометка «мало данных»
 * TASK-060-стиля (переиспользуется FewDataNote с count ТОГО ЖЕ ответа — единые
 * read models); категория при этом ОТСУТСТВУЕТ (классификатор вернул undefined —
 * UI не может наврать), средние при существующих записях показываются (пометка —
 * не сокрытие данных). Note классификации kind=insufficientData не дублируется:
 * это та же мысль, что у пометки, другим текстом — в карточке сообщение одно.
 *
 * ДОСТУПНОСТЬ (§16): section + h3 (иерархия заголовков экрана); строки данных —
 * текст, без цветовых вердиктов.
 */
import { useTranslation } from 'react-i18next';

import type { PeriodStatisticsDto } from '@hl/contracts';

import { formatNumberRu } from './TrendSummary';
import { FewDataNote } from './FewDataNote';

/** Свойства карточки (§5): stats 7d — средние, count и classification в одном ответе. */
export interface AverageCardProps {
  readonly stats: PeriodStatisticsDto;
}

/** Карточка «Среднее за 7 дней» (§5): средние, count, категория+notes, «мало данных». */
export function AverageCard({ stats }: AverageCardProps): JSX.Element {
  const { t } = useTranslation();

  const insufficient =
    stats.insufficientData.tooFewMeasurements || stats.insufficientData.tooFewDays;
  // Подпись категории — из classification (label едет в stats-ответе из данных
  // шкалы, §4 054); нет категории (insufficientData) — строки нет (EC-09).
  const category = stats.classification?.category;
  // Note insufficientData классификатора не дублирует пометку FewDataNote (§13).
  const notes = (stats.classification?.notes ?? []).filter(
    (note) => note.kind !== 'insufficientData',
  );

  return (
    <section data-testid="average-card" className="rounded-md border border-border p-4">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600 dark:text-neutral-300">
        {t('dashboard.average.title')}
      </h3>
      {insufficient && stats.count > 0 && <FewDataNote count={stats.count} />}
      <div className="mt-1 flex flex-col gap-1">
        {stats.sys.avg !== undefined && (
          <p data-testid="average-sys" className="text-lg">
            {t('dashboard.average.sys', { avg: formatNumberRu(stats.sys.avg) })}
          </p>
        )}
        {stats.dia.avg !== undefined && (
          <p data-testid="average-dia" className="text-lg">
            {t('dashboard.average.dia', { avg: formatNumberRu(stats.dia.avg) })}
          </p>
        )}
        {stats.pulse?.avg !== undefined && (
          <p data-testid="average-pulse" className="text-lg">
            {t('dashboard.average.pulse', { avg: formatNumberRu(stats.pulse.avg) })}
          </p>
        )}
        <p data-testid="average-count" className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('dashboard.average.count', { count: stats.count })}
        </p>
      </div>
      {category !== undefined && (
        <p data-testid="average-category" className="mt-2 text-base font-medium">
          {t('dashboard.average.category', { label: category.label })}
        </p>
      )}
      {notes.length > 0 && (
        <div
          data-testid="average-notes"
          className="mt-1 flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400"
        >
          {notes.map((note) => (
            <p key={note.kind}>{note.text}</p>
          ))}
        </div>
      )}
    </section>
  );
}
