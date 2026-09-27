/**
 * TASK-046 §5/§10/§13/§16/§17: поля произвольного периода — два нативных
 * input type=date (TD-11: доступность ОС, клавиатура, ноль зависимостей) с
 * labels «С»/«По» (§17 filters.custom.from/to).
 *
 * Контролируемые черновики (прецедент строки поиска TASK-045): значения —
 * проп-состояние (URL→поля), внешняя смена применённых дат (сброс фильтров,
 * уход на пресет) синхронизирует черновики и снимает ошибку. Валидный ввод
 * (в т.ч. неполный — §10 прогрессивно: одно поле = открытая вторая граница,
 * пустые оба = сброс к дефолту 30d) применяется СРАЗУ — колбэк onApply, хук
 * переписывает URL. Invalid-пара (from > to; to в будущем — EC-20) БЛОКИРУЕТ
 * применение: черновик остаётся локальным, под полями — текст ошибки с
 * role=alert, поля связаны aria-describedby и помечены aria-invalid (§16);
 * нативный input не даёт мусорного значения — invalidFormat из UI недостижим
 * и молча блокирует (защита в глубину, §14).
 *
 * «Сейчас» для валидации — Date.now() на событии ввода (момент проверки, §13);
 * чистая математика — в model/range.parseRange (зона — параметр).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { parseRange } from '../model/range';
import { tzOffsetMinOf } from '../model/taken-at';

/** Ключи текстов ошибок, достижимых из нативного ввода (§17). */
const ERROR_KEY: Readonly<
  Record<
    'invalidOrder' | 'futureTo',
    'measurement.filters.custom.invalidOrder' | 'measurement.filters.custom.futureTo'
  >
> = {
  invalidOrder: 'measurement.filters.custom.invalidOrder',
  futureTo: 'measurement.filters.custom.futureTo',
};

/** Props полей диапазона: применённое состояние + колбэк применения (§5). */
export interface CustomRangeFieldsProps {
  /** Применённая дата «от» 'YYYY-MM-DD' (undefined — поле пусто). */
  readonly from?: string;
  /** Применённая дата «до» 'YYYY-MM-DD' (undefined — поле пусто). */
  readonly to?: string;
  /** Применение валидного диапазона (undefined = поле не задано, §10). */
  readonly onApply: (from: string | undefined, to: string | undefined) => void;
}

/** Поля «С»/«По» произвольного периода (§5); рендерятся только в режиме custom. */
export function CustomRangeFields({ from, to, onApply }: CustomRangeFieldsProps): JSX.Element {
  const { t } = useTranslation();
  // Черновики ввода — локально; в URL — только валидные значения (§19).
  const [fromDraft, setFromDraft] = useState(from ?? '');
  const [toDraft, setToDraft] = useState(to ?? '');
  // Виды ошибок, достижимые из нативного ввода (§17: ровно два ключа).
  const [error, setError] = useState<'invalidOrder' | 'futureTo' | null>(null);
  // Внешняя смена применённых дат (сброс, ссылка) — источник истины для черновиков (§12).
  useEffect(() => {
    setFromDraft(from ?? '');
    setToDraft(to ?? '');
    setError(null);
  }, [from, to]);

  const handleChange = (nextFrom: string, nextTo: string): void => {
    setFromDraft(nextFrom);
    setToDraft(nextTo);
    const nowMs = Date.now();
    const result = parseRange(nextFrom, nextTo, nowMs, tzOffsetMinOf(nowMs));
    if (!result.ok) {
      // invalidFormat из нативного input недостижим (санитизация значения) —
      // блок без текста; invalidOrder/futureTo — текст §17.
      setError(result.error === 'invalidFormat' ? null : result.error);
      return;
    }
    setError(null);
    onApply(nextFrom === '' ? undefined : nextFrom, nextTo === '' ? undefined : nextTo);
  };

  // §16: ошибка диапазона связывает оба поля (invalidOrder) или «По» (futureTo).
  const errorId = 'filter-range-error';

  return (
    <div className="flex flex-wrap items-end gap-x-2 gap-y-1" data-testid="filter-range">
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-range-from" className="text-sm text-accent">
          {t('measurement.filters.custom.from')}
        </label>
        <input
          id="filter-range-from"
          type="date"
          data-testid="filter-range-from"
          value={fromDraft}
          onChange={(event) => handleChange(event.target.value, toDraft)}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === 'invalidOrder' ? errorId : undefined}
          className="min-h-11 rounded-md border border-border bg-transparent px-3 py-2 text-base"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-range-to" className="text-sm text-accent">
          {t('measurement.filters.custom.to')}
        </label>
        <input
          id="filter-range-to"
          type="date"
          data-testid="filter-range-to"
          value={toDraft}
          onChange={(event) => handleChange(fromDraft, event.target.value)}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
          className="min-h-11 rounded-md border border-border bg-transparent px-3 py-2 text-base"
        />
      </div>
      {error !== null && (
        <span
          id={errorId}
          role="alert"
          data-testid="filter-range-error"
          className="text-sm text-accent"
        >
          {t(ERROR_KEY[error])}
        </span>
      )}
    </div>
  );
}
