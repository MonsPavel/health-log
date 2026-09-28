/**
 * TASK-059 §2/§5/§13/§16/§17: таблица-альтернатива графику — полное скринридер-
 * представление данных динамики (NFR-6) и персона П5 (врачу удобнее таблица).
 *
 * ОДНИ ДАННЫЕ (§4/§13): таблица строится из ТОГО ЖЕ TrendResponse, что и график —
 * ноль параллельных вычислений, разойтись не могут. RAW — строка на запись
 * (дата-время Intl, СДА, ДДА, ЧСС, Рука, Флаги бейджами TASK-042); DAILY —
 * дневная таблица (день, avg±, min–max, count) — сортировок нет: read model
 * отдаёт wallDate asc (§13 056), сортировка агрегатов вне §5.
 *
 * СОРТИРОВКА (§5/§12): по клику заголовка — дата asc/desc, sys, dia; простая
 * сортировка ЗАГРУЖЕННЫХ точек (страница ≤500 — локальна, §15; сервер не
 * трогаем). Состояние — ЛОКАЛЬНЫЙ state (§12: не URL — шум). Повторный клик по
 * активному столбцу меняет направление, клик по новому — asc; значения
 * сортируются с tie-break по дате (детерминизм равных значений).
 *
 * ДОСТУПНОСТЬ (§16): caption с периодом (§17 params), th scope="col"; сортируемые
 * заголовки — кнопки в th с aria-sort (ascending/descending, активный столбец);
 * значения с единицами — единицы в заголовках («СДА, мм рт. ст.»), скринридер
 * читает заголовок+ячейку полностью; пустые состояния — «Нет данных за период»
 * (TASK-060-текст, тот же ключ, что у графика). Печать/пагинация — вне §5.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DayPoint, RawPoint, TrendResponse } from '@hl/contracts';

import { formatDateTime } from '../../../lib/i18n-date';
import { FlagBadges } from '../../measurement/ui/FlagBadges';

/** Ключ сортировки таблицы (§5): дата — по умолчанию (хронология графика). */
export type TrendSortKey = 'date' | 'sys' | 'dia';

/** Направление сортировки (§5: дата asc/desc). */
export type TrendSortDir = 'asc' | 'desc';

/** Состояние сортировки (§12): локальный state таблицы, не URL. */
export interface TrendSortState {
  readonly key: TrendSortKey;
  readonly dir: TrendSortDir;
}

/** Свойства таблицы (§5): тот же ответ trend/series, что у графика + подпись периода. */
export interface TrendTableProps {
  readonly response: TrendResponse;
  /** Подпись периода для caption («30 дней» — формирует экран, как для графика). */
  readonly periodLabel: string;
}

/** Число в ru-формате (§17 Intl; максимум 1 знак — правило отображения 052). */
function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
}

/** Дата дня 'YYYY-MM-DD' → настенная Intl-дата с годом (§17; dayTickOf графика — без года). */
function dayCellOf(wallDate: string): string {
  const [y, mo, d] = String(wallDate).split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(Date.UTC(y, mo - 1, d));
}

/**
 * Сравнение точек по выбранному столбцу и направлению (§5). tie-break по дате
 * для сортировок по значению — равные значения стоят в хронологии (детерминизм,
 * NFR-10); сортировка по дате при равных utc — стабильный порядок входа
 * (Array#sort стабилен, прецедент read model 056).
 */
function comparePoints(a: RawPoint, b: RawPoint, key: TrendSortKey, dir: TrendSortDir): number {
  const sign = dir === 'asc' ? 1 : -1;
  const primary =
    key === 'date' ? a.utcMs - b.utcMs : key === 'sys' ? a.sys - b.sys : a.dia - b.dia;
  if (primary !== 0) {
    return primary * sign;
  }
  return key === 'date' ? 0 : a.utcMs - b.utcMs;
}

/** Заголовки и сортировки raw-таблицы: колонки §5 с точками входа (тесты). */
function RawTable({
  points,
  periodLabel,
}: {
  readonly points: readonly RawPoint[];
  readonly periodLabel: string;
}): JSX.Element {
  const { t } = useTranslation();
  const [sort, setSort] = useState<TrendSortState>({ key: 'date', dir: 'asc' });

  const toggle = (key: TrendSortKey): void => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );
  };

  const sorted = [...points].sort((a, b) => comparePoints(a, b, sort.key, sort.dir));
  const ariaSortOf = (key: TrendSortKey): 'ascending' | 'descending' | undefined =>
    sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;

  const sortableHeader = (key: TrendSortKey, label: string, testId: string): JSX.Element => (
    <th scope="col" aria-sort={ariaSortOf(key)} className="px-2 py-1 text-left">
      <button
        type="button"
        data-testid={testId}
        onClick={() => toggle(key)}
        className="min-h-11 rounded px-1 font-semibold hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        {label}
      </button>
    </th>
  );

  return (
    <table data-testid="trend-table" className="w-full border-collapse text-sm">
      <caption data-testid="trend-table-caption" className="mb-2 text-left text-sm text-accent">
        {t('dashboard.table.caption', { period: periodLabel })}
      </caption>
      <thead>
        <tr className="border-b border-border">
          {sortableHeader('date', t('dashboard.table.columns.datetime'), 'trend-sort-date')}
          {sortableHeader('sys', t('dashboard.table.columns.sys'), 'trend-sort-sys')}
          {sortableHeader('dia', t('dashboard.table.columns.dia'), 'trend-sort-dia')}
          <th scope="col" className="px-2 py-1 text-left">
            {t('dashboard.table.columns.pulse')}
          </th>
          <th scope="col" className="px-2 py-1 text-left">
            {t('measurement.fields.arm')}
          </th>
          <th scope="col" className="px-2 py-1 text-left">
            {t('dashboard.table.columns.flags')}
          </th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((point) => (
          <tr
            key={point.id ?? `${point.utcMs}-${point.sys}-${point.dia}`}
            data-testid="trend-table-row"
            className="border-b border-border"
          >
            <td className="px-2 py-1">
              {formatDateTime(
                { utcMs: point.utcMs, tzOffsetMin: point.tzOffsetMin },
                { preset: 'datetime' },
              )}
            </td>
            <td className="px-2 py-1">{point.sys}</td>
            <td className="px-2 py-1">{point.dia}</td>
            {/* §5: «не измерен» — прочерк (место резервируется — колонка читается). */}
            <td className="px-2 py-1">{point.pulse === undefined ? '—' : point.pulse}</td>
            <td className="px-2 py-1">
              {point.arm === undefined
                ? '—'
                : t(point.arm === 'left' ? 'measurement.filters.arm.left' : 'measurement.filters.arm.right')}
            </td>
            {/* Флаги — бейджи TASK-042 (переиспользование, §5): critical/irregular точки. */}
            <td className="px-2 py-1">
              <FlagBadges
                measurement={{
                  sys: point.sys,
                  dia: point.dia,
                  ...(point.critical !== undefined ? { critical: point.critical } : {}),
                  irregularPulse: point.irregular === true,
                }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Дневная таблица (§5): день, avg± (min–max), count; сортировок нет — wallDate asc read model'а. */
function DayTable({ days, periodLabel }: { readonly days: readonly DayPoint[]; readonly periodLabel: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <table data-testid="trend-table" className="w-full border-collapse text-sm">
      <caption data-testid="trend-table-caption" className="mb-2 text-left text-sm text-accent">
        {t('dashboard.table.caption', { period: periodLabel })}
      </caption>
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className="px-2 py-1 text-left">
            {t('dashboard.table.day')}
          </th>
          <th scope="col" className="px-2 py-1 text-left">
            {t('dashboard.table.columns.sys')}
          </th>
          <th scope="col" className="px-2 py-1 text-left">
            {t('dashboard.table.columns.dia')}
          </th>
          <th scope="col" className="px-2 py-1 text-left">
            {t('dashboard.table.columns.count')}
          </th>
        </tr>
      </thead>
      <tbody>
        {days.map((day) => (
          <tr key={day.wallDate} data-testid="trend-table-row" className="border-b border-border">
            <td className="px-2 py-1">{dayCellOf(day.wallDate)}</td>
            <td className="px-2 py-1">
              {`${formatNumber(day.sysAvg)} (${day.sysMin}–${day.sysMax})`}
            </td>
            <td className="px-2 py-1">
              {`${formatNumber(day.diaAvg)} (${day.diaMin}–${day.diaMax})`}
            </td>
            <td className="px-2 py-1">{day.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Таблица-альтернатива графику (§5): ветка по mode того же TrendResponse. */
export function TrendTable({ response, periodLabel }: TrendTableProps): JSX.Element {
  const isDaily = response.mode === 'daily';
  const days = isDaily ? (response.days ?? []) : [];
  const points = isDaily ? [] : (response.points ?? []);

  // Пустые состояния (§13): «Нет данных за период» — текст TASK-060 (общий ключ).
  if (points.length === 0 && days.length === 0) {
    return (
      <div data-testid="trend-table-empty" className="px-6 py-16 text-center text-base font-medium">
        <EmptyText />
      </div>
    );
  }
  return isDaily ? (
    <DayTable days={days} periodLabel={periodLabel} />
  ) : (
    <RawTable points={points} periodLabel={periodLabel} />
  );
}

/** Отдельный компонент текста пустого состояния — useTranslation внутри хука. */
function EmptyText(): JSX.Element {
  const { t } = useTranslation();
  return <>{t('dashboard.empty.title')}</>;
}
