/**
 * TASK-067 §5/§7: шаблон PDF-отчёта врача (@react-pdf/renderer, декларативные
 * компоненты; без JSX — h/createElement, main-сборка tsc без jsx-пайплайна).
 *
 * СОСТАВ (§5, FR-6.3): титул (период, «Сформировано», версия) → таблица
 * измерений (зебра, перенос строк, разрывы страниц с повтором заголовка —
 * `fixed` + чанки wrap:false по 30 строк §19) → «Средние» (утро/вечер/период +
 * count, нет части — прочерк §13) → «Регулярность» (N из M, streak) →
 * упрощённый график sys (примитивы react-pdf SVG: линия sys + опорные 140/90;
 * решение §4: без PNG-растра, полный график — на экране) → ИИ-раздел (только
 * при явном includeAiSection и тексте: рамка + маркировка + повтор дисклеймера).
 *
 * §7: никакой бизнес-логики — только применение готовых чисел payload'а
 * (read models 052/056 собирают их на main-стороне, TASK-068). Форматирование —
 * форматтеры application-слоя reporting (§13), тексты — RU-каталог (§17).
 *
 * ДЕТЕРМИНИЗМ (§19/§22, проверено ранним чеком): react-pdf вкладывает в
 * метаданные CreationDate (дефолт new Date()), и от него же зависит трейлерный
 * /ID (md5 info) — поэтому Document получает creationDate из payload'а
 * (generatedAtUtcMs): два рендера одинакового входа → идентичные байты (AC2).
 *
 * §14: примечания пользователя печатаются как текст (react-pdf экранирует);
 * шрифты — Roboto OFL 1.1 (каталог fonts/, LICENSE рядом).
 */
import {
  Document,
  Font,
  Line,
  Page,
  Polyline,
  StyleSheet,
  Svg,
  Text,
  View,
  type DocumentProps,
} from '@react-pdf/renderer';
import { createElement, type ReactElement } from 'react';

import {
  TABLE_ROWS_PER_PAGE,
  formatBp,
  formatDateTime,
  formatInt,
  formatLongDate,
  formatWallDate,
  formatWallTime,
  limitLastRows,
  paginateRows,
} from '../../application/report-format.ts';
import type {
  PdfRenderPayload,
  ReportAiText,
  ReportData,
  ReportPartAverages,
  ReportRow,
  ReportSpec,
} from '../../application/report-spec.ts';
import { REPORT_RU, type ReportStrings } from './report-strings.ts';

/** Семейство шрифтов отчёта: Roboto с кириллицей (§4, OFL — каталог fonts/). */
export const REPORT_FONT_FAMILY = 'Roboto';

let fontsRegistered = false;

/**
 * Регистрация шрифтов один раз на процесс/воркер (§9: «загружаются один раз на
 * воркер (register)»). Файлы лежат рядом с модулем (§6): src в тестах (нативный
 * Node и vite), dist после копирования ассетов сборкой (copy-report-assets).
 */
export function ensureReportFonts(): void {
  if (fontsRegistered) {
    return;
  }
  const fontsDir = new URL('./fonts/', import.meta.url);
  Font.register({
    family: REPORT_FONT_FAMILY,
    fonts: [
      { src: fileUrlToPath(new URL('Roboto-Regular.ttf', fontsDir)) },
      { src: fileUrlToPath(new URL('Roboto-Bold.ttf', fontsDir)), fontWeight: 700 },
    ],
  });
  fontsRegistered = true;
}

/** file:// URL → путь файловой системы (Font.register читает fs на Windows). */
function fileUrlToPath(url: URL): string {
  return decodeURIComponent(url.href.replace(/^file:\/\/\/(?=[A-Za-z]:)/, '')).replace(/\//g, '/');
}

// --- чистая логика секций (юниты §19 без рендера) ---

/**
 * ИИ-текст для рендера (§13): ТОЛЬКО при явном includeAiSection И наличии текста.
 * При includeAiSection=false переданный aiText игнорируется — защита от случайного
 * включения ИИ-текста в отчёт врачу (юнит-тест §19, AC §20).
 */
export function resolveAiText(spec: ReportSpec): ReportAiText | undefined {
  return spec.includeAiSection && spec.aiText !== undefined ? spec.aiText : undefined;
}

/** Структура таблицы измерений (§9/§19): страницы по 30 строк + приписка лимита. */
export interface TableSection {
  /** Страницы таблицы (чанки по TABLE_ROWS_PER_PAGE, порядок asc сохранён). */
  readonly pages: ReportRow[][];
  /** Всего строк периода (до лимита). */
  readonly total: number;
  /** Строк за лимитом (0 — приписка не нужна). */
  readonly omitted: number;
  /** Приписка «последние 2000 из N» (§9): числа для каталога строк. */
  readonly limitNote?: { readonly shown: number; readonly total: number };
}

/** Сборка таблицы: лимит последних 2000 (§9) + разбивка на страницы (§19). */
export function buildTableSection(rows: readonly ReportRow[]): TableSection {
  const limited = limitLastRows(rows);
  return {
    pages: paginateRows(limited.rows, TABLE_ROWS_PER_PAGE),
    total: limited.total,
    omitted: limited.omitted,
    ...(limited.omitted > 0
      ? { limitNote: { shown: limited.rows.length, total: limited.total } }
      : {}),
  };
}

// --- стили (печать: чёрный/белый, зебра светлая, шрифт таблицы ≥9pt — §16) ---

const styles = StyleSheet.create({
  page: {
    fontFamily: REPORT_FONT_FAMILY,
    fontSize: 9.5,
    color: '#111111',
    paddingTop: '15mm',
    paddingBottom: '15mm',
    paddingHorizontal: '15mm',
  },
  title: { fontSize: 16, fontWeight: 700, textAlign: 'center' },
  subtitle: { fontSize: 10.5, textAlign: 'center', marginTop: 6 },
  generated: { fontSize: 9.5, textAlign: 'center', marginTop: 2, color: '#444444' },
  sectionTitle: { fontSize: 11.5, fontWeight: 700, marginTop: 14, marginBottom: 4 },
  table: { marginTop: 8 },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#E8E8E8',
    borderStyle: 'solid',
    borderBottomWidth: 0.75,
    borderBottomColor: '#555555',
  },
  headerCell: { fontSize: 9, fontWeight: 700, padding: 3 },
  row: {
    flexDirection: 'row',
    borderStyle: 'solid',
    borderBottomWidth: 0.4,
    borderBottomColor: '#BBBBBB',
  },
  rowZebra: { backgroundColor: '#F4F4F4' },
  cell: { fontSize: 9, padding: 3 },
  limitNote: { fontSize: 8.5, color: '#444444', marginTop: 4 },
  chunk: { wrap: false },
  infoTable: { marginTop: 2 },
  infoRow: { flexDirection: 'row' },
  infoLabel: { fontSize: 9.5, width: '42mm', color: '#333333', paddingVertical: 1.5 },
  infoValue: { fontSize: 9.5, fontWeight: 700, paddingVertical: 1.5 },
  chartSvg: { marginTop: 4 },
  chartLegend: { fontSize: 8.5, color: '#444444', marginTop: 2 },
  aiFrame: {
    marginTop: 16,
    padding: 8,
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: '#333333',
  },
  aiTitle: { fontSize: 11, fontWeight: 700 },
  aiMeta: { fontSize: 8.5, color: '#333333', marginTop: 2 },
  aiDisclaimer: { fontSize: 9.5, fontWeight: 700, marginTop: 4 },
  aiParagraph: { fontSize: 9.5, lineHeight: 1.35, marginTop: 6 },
});

/** Ширины колонок таблицы (мм; контент A4 с полями 15мм = 180мм). */
const COLUMN_WIDTHS_MM = { date: 22, time: 14, sys: 13, dia: 13, pulse: 13, arm: 18 } as const;

// --- компоненты секций ---

/** Титул (§5): заголовок, период спеки (Intl), «Сформировано: …, Health Log v…». */
function titleBlock(
  period: ReportSpec['period'],
  data: ReportData,
  strings: ReportStrings,
): ReactElement {
  const tz = data.periodTzOffsetMin;
  return createElement(
    View,
    null,
    createElement(Text, { style: styles.title }, strings.title),
    createElement(
      Text,
      { style: styles.subtitle },
      `${strings.periodLabel}: ` +
        `${formatLongDate(period.fromUtcMs, tz)}` +
        ` — ${formatLongDate(period.toUtcMs, tz)}`,
    ),
    createElement(
      Text,
      { style: styles.generated },
      `${strings.generatedLabel}: ${formatDateTime(data.generatedAtUtcMs, tz)}, ` +
        `${strings.appLabel} v${data.appVersion}`,
    ),
  );
}

/** Заголовочная строка таблицы — проп `fixed`: повтор на каждой странице (AC §20). */
function tableHeader(strings: ReportStrings, fixed = false): ReactElement {
  const columns: readonly (readonly [string, number])[] = [
    [strings.table.date, COLUMN_WIDTHS_MM.date],
    [strings.table.time, COLUMN_WIDTHS_MM.time],
    [strings.table.sys, COLUMN_WIDTHS_MM.sys],
    [strings.table.dia, COLUMN_WIDTHS_MM.dia],
    [strings.table.pulse, COLUMN_WIDTHS_MM.pulse],
    [strings.table.arm, COLUMN_WIDTHS_MM.arm],
    [strings.table.note, 87],
  ];
  return createElement(
    View,
    { ...(fixed ? { fixed: true } : {}), style: styles.tableHeader },
    ...columns.map(([label, widthMm]) =>
      createElement(
        Text,
        { key: label, style: [styles.headerCell, { width: `${widthMm}mm` }] },
        label,
      ),
    ),
  );
}

/** Одна строка таблицы: дата, время, СДА, ДДА, ЧСС (прочерк), рука, примечание. */
function tableRow(row: ReportRow, index: number, strings: ReportStrings): ReactElement {
  const armLabel =
    row.arm === undefined ? '—' : row.arm === 'left' ? strings.armLeft : strings.armRight;
  const cells: readonly string[] = [
    formatWallDate(row.utcMs, row.tzOffsetMin),
    formatWallTime(row.utcMs, row.tzOffsetMin),
    formatInt(row.sys),
    formatInt(row.dia),
    formatBp(row.pulse),
    armLabel,
    row.note ?? '',
  ];
  const widthsMm: readonly number[] = [
    COLUMN_WIDTHS_MM.date,
    COLUMN_WIDTHS_MM.time,
    COLUMN_WIDTHS_MM.sys,
    COLUMN_WIDTHS_MM.dia,
    COLUMN_WIDTHS_MM.pulse,
    COLUMN_WIDTHS_MM.arm,
    87,
  ];
  return createElement(
    View,
    { style: [styles.row, ...(index % 2 === 1 ? [styles.rowZebra] : [])] },
    ...cells.map((value, i) =>
      createElement(Text, { key: i, style: [styles.cell, { width: `${widthsMm[i]}mm` }] }, value),
    ),
  );
}

/** Таблица измерений (§5): страницы-чанки, зебра, приписка лимита (§9). */
function tableBlock(section: TableSection, strings: ReportStrings): ReactElement[] {
  if (section.pages.length === 0) {
    return [];
  }
  const children: ReactElement[] = [
    createElement(Text, { key: 'title', style: styles.sectionTitle }, strings.measurementsTitle),
    createElement(
      View,
      { key: 'table', style: styles.table },
      // `fixed` — ПРОП элемента (не стиль): react-pdf повторяет узел на каждой
      // странице, пока таблица не кончилась (AC §20: разрывы повторяют заголовок).
      tableHeader(strings, true),
      ...section.pages.map((pageRows, pageIndex) =>
        createElement(
          View,
          { key: pageIndex, style: styles.chunk, wrap: false },
          ...pageRows.map((row, rowIndex) => tableRow(row, rowIndex, strings)),
        ),
      ),
    ),
  ];
  if (section.limitNote !== undefined) {
    children.push(
      createElement(
        Text,
        { key: 'limitNote', style: styles.limitNote },
        strings.rowLimitNote(section.limitNote.shown, section.limitNote.total),
      ),
    );
  }
  return children;
}

/** Строка блока «Средние»/«Регулярность»: подпись — значение. */
function infoRow(label: string, value: string, key: string): ReactElement {
  return createElement(
    View,
    { key, style: styles.infoRow },
    createElement(Text, { style: styles.infoLabel }, label),
    createElement(Text, { style: styles.infoValue }, value),
  );
}

/** Средние одной части: «120 / 80, ЧСС 65»; нет части — прочерки (§13). */
function partAveragesLabel(part: ReportPartAverages | undefined, strings: ReportStrings): string {
  if (part === undefined) {
    return '—';
  }
  const pulse =
    part.pulseAvg === undefined ? '—' : `${strings.averages.pulseAvg}: ${formatInt(part.pulseAvg)}`;
  return `${formatInt(part.sysAvg)} / ${formatInt(part.diaAvg)}${part.pulseAvg === undefined ? '' : `, ${pulse}`}`;
}

/** Блок «Средние» (§5): утро/вечер/период + count + дни с измерениями. */
function averagesBlock(data: ReportData, strings: ReportStrings): ReactElement {
  const { averages } = data;
  return createElement(
    View,
    null,
    createElement(Text, { style: styles.sectionTitle }, strings.averages.title),
    createElement(
      View,
      { style: styles.infoTable },
      infoRow(strings.averages.morning, partAveragesLabel(averages.morning, strings), 'morning'),
      infoRow(strings.averages.evening, partAveragesLabel(averages.evening, strings), 'evening'),
      infoRow(strings.averages.period, partAveragesLabel(averages.period, strings), 'period'),
      infoRow(
        strings.averages.count,
        `${formatInt(averages.period.count)}${
          averages.period.count > 0
            ? `, ${strings.regularity.daysWithMeasurements.toLowerCase()}: ${formatInt(data.regularity.daysWithMeasurements)}`
            : ''
        }`,
        'count',
      ),
    ),
  );
}

/** Блок «Регулярность» (§5): N дней из M, streak. */
function regularityBlock(data: ReportData, strings: ReportStrings): ReactElement {
  const { regularity } = data;
  return createElement(
    View,
    null,
    createElement(Text, { style: styles.sectionTitle }, strings.regularity.title),
    createElement(
      View,
      { style: styles.infoTable },
      infoRow(
        strings.regularity.daysWithMeasurements,
        `${formatInt(regularity.daysWithMeasurements)} из ${formatInt(regularity.totalDays)} ${strings.regularity.totalDaysUnit}`,
        'days',
      ),
      infoRow(
        strings.regularity.streak,
        `${formatInt(regularity.longestStreakDays)} ${strings.regularity.streakUnit}`,
        'streak',
      ),
    ),
  );
}

/** Геометрия графика: система координат viewBox 510×170 pt (180×60 мм). */
const CHART = {
  width: 510,
  height: 170,
  padLeft: 6,
  padRight: 6,
  padTop: 10,
  padBottom: 10,
} as const;

/**
 * Упрощённый график sys (§4): линия по точкам таблицы (те же точки — §4), X —
 * равномерно по индексу (упрощение задокументировано), Y — клинический диапазон,
 * включающий опорные 140/90; пунктирные опорные линии — примитивы react-pdf SVG.
 */
function chartBlock(data: ReportData, strings: ReportStrings): ReactElement | null {
  const sysValues = data.rows.map((row) => row.sys);
  if (sysValues.length === 0) {
    return null;
  }
  const { width, height, padLeft, padRight, padTop, padBottom } = CHART;
  const lo = Math.floor((Math.min(...sysValues, 90) - 10) / 10) * 10;
  const hi = Math.ceil((Math.max(...sysValues, 140) + 10) / 10) * 10;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;
  const xOf = (index: number): number =>
    sysValues.length === 1
      ? padLeft + innerWidth / 2
      : padLeft + (index * innerWidth) / (sysValues.length - 1);
  const yOf = (value: number): number => padTop + (1 - (value - lo) / (hi - lo)) * innerHeight;

  const points = sysValues.map((value, index) => `${xOf(index)},${yOf(value)}`).join(' ');
  const reference140 = yOf(140);
  const reference90 = yOf(90);

  return createElement(
    View,
    null,
    createElement(Text, { style: styles.sectionTitle }, strings.chart.title),
    createElement(
      Svg,
      { width: '180mm', height: '60mm', viewBox: `0 0 ${width} ${height}`, style: styles.chartSvg },
      // Оси.
      createElement(Line, {
        x1: padLeft,
        y1: padTop,
        x2: padLeft,
        y2: height - padBottom,
        stroke: '#555555',
        strokeWidth: 0.75,
      }),
      createElement(Line, {
        x1: padLeft,
        y1: height - padBottom,
        x2: width - padRight,
        y2: height - padBottom,
        stroke: '#555555',
        strokeWidth: 0.75,
      }),
      // Опорные 140/90 — пунктир (§4).
      createElement(Line, {
        x1: padLeft,
        y1: reference140,
        x2: width - padRight,
        y2: reference140,
        stroke: '#888888',
        strokeWidth: 0.75,
        strokeDasharray: '4 3',
      }),
      createElement(Line, {
        x1: padLeft,
        y1: reference90,
        x2: width - padRight,
        y2: reference90,
        stroke: '#888888',
        strokeWidth: 0.75,
        strokeDasharray: '4 3',
      }),
      // Линия систолического АД.
      createElement(Polyline, { points, stroke: '#111111', strokeWidth: 1.25, fill: 'none' }),
    ),
    createElement(Text, { style: styles.chartLegend }, strings.chart.referenceLegend),
  );
}

/**
 * ИИ-раздел (§5): рамка + заголовок-маркировка + модель/момент генерации + текст
 * (обычный, с переносами — решение §5) + ПОВТОР дисклеймера в конце. Попадает в
 * документ только через resolveAiText (§13/§7: мимо маркировки не протекает).
 */
function aiSectionBlock(ai: ReportAiText, data: ReportData, strings: ReportStrings): ReactElement {
  const paragraphs = ai.contentMd.split(/\n{2,}/);
  return createElement(
    View,
    { style: styles.aiFrame },
    createElement(Text, { style: styles.aiTitle }, strings.ai.title),
    createElement(Text, { style: styles.aiMeta }, `${strings.ai.disclaimer}`),
    createElement(
      Text,
      { style: styles.aiMeta },
      `${strings.ai.modelLabel}: ${ai.modelId}, ` +
        `${strings.ai.generatedLabel}: ${formatDateTime(ai.generatedAt, data.periodTzOffsetMin)}`,
    ),
    ...paragraphs.map((paragraph, index) =>
      createElement(Text, { key: index, style: styles.aiParagraph }, paragraph),
    ),
    createElement(Text, { style: styles.aiDisclaimer }, strings.ai.disclaimer),
  );
}

/**
 * Корень документа отчёта (§5): A4, поля 15мм; метаданные с ФИКСИРОВАННОЙ
 * creationDate из payload'а — детерминизм байтов (§19/AC2).
 */
export function createReportDocument(payload: PdfRenderPayload): ReactElement<DocumentProps> {
  ensureReportFonts();
  const { spec, data } = payload;
  const strings = REPORT_RU;
  const table = buildTableSection(data.rows);
  const aiText = resolveAiText(spec);
  const chart = chartBlock(data, strings);

  return createElement(
    Document,
    {
      title: strings.title,
      language: 'ru-RU',
      creationDate: new Date(data.generatedAtUtcMs),
    },
    createElement(
      Page,
      { size: 'A4', style: styles.page },
      titleBlock(spec.period, data, strings),
      ...tableBlock(table, strings),
      averagesBlock(data, strings),
      regularityBlock(data, strings),
      chart,
      ...(aiText === undefined ? [] : [aiSectionBlock(aiText, data, strings)]),
    ),
  );
}
