/**
 * TASK-083 §4/§6/§17: сборка текста ИИ-контекста из готовых данных — секции
 * `# Период`, `## Агрегаты`, `## По дням`, `## Разрывы`, `## Заметки`, `## Шкала`
 * (компактный markdown-подобный формат: LLM-дружелюбный и читаемый человеком
 * в превью FR-5.5). ЗДЕСЬ НЕТ ДАННЫХ И ВРЕМЕНИ: вход — уже собранные read models
 * (054/056), разрывы и заметки от сборщика; любые строки детерминированы входом
 * (§13: одинаковый вход — байт-одинаковый текст).
 *
 * §17: внутренние маркеры секций — EN-идентификаторы (LLM-стабильность, единый
 * контракт с AI_CONTEXT_SECTION_IDS @hl/contracts — наличие секции в тексте ⇔ id
 * в ответе канала); человекочитаемые подписи — RU. LLM-контекст НЕ локализуется
 * (ответы ИИ локализованы) — RU v1 зафиксирован golden-снапшотом.
 *
 * Порядок строк фиксирован; опциональные части (пульс, части суток, delta,
 * classification, пометки) — строка/часть строки отсутствует целиком (§7
 * flat-маппинг). Округления НЕ дублируются: числа уже округлены доменом 052/056
 * (avg/sd 1 знак) — печать как есть (String). Заметки приходят подготовленными
 * (переносы схлопнул сборщик — построчный формат секций, §4).
 */
import type {
  ActiveScale,
  AiContextSectionId,
  PeriodStatisticsDto,
  StatsPeriodParam,
  TrendResponse,
} from '@hl/contracts';
import { Instant } from '@hl/kernel';

/** Длительность пресетов периода (§9 054: from = now − N*24ч) — для текста метки. */
const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

/**
 * Разрыв наблюдений (§7): дни без записей в периоде, ≥7; от периода до первой
 * записи — тоже разрыв (§7), для «всего журнала» ведущего разрыва нет.
 * Живёт здесь (а не у сборщика): формат строки разрыва — часть текстового
 * формата, тип общий для сборщика и рендера.
 */
export interface Gap {
  /** Первый день без записей, 'YYYY-MM-DD'. */
  readonly fromWallDate: string;
  /** Последний день без записей, 'YYYY-MM-DD'. */
  readonly toWallDate: string;
  /** Дней без записей (≥7, §5). */
  readonly days: number;
}

/** Подготовленная заметка для секции (§5): настенная дата записи + текст. */
export interface ContextNoteLine {
  /** Дата записи 'DD.MM' (собственный offset записи — EC-06). */
  readonly wallDate: string;
  /** Текст заметки в одну строку (переносы схлопнуты сборщиком). */
  readonly text: string;
}

/** Вход рендера (§4): всё уже собрано сборщиком — формат чист. */
export interface AiContextRenderInput {
  readonly period: StatsPeriodParam;
  /** Границы периода (custom — как есть; пресет — от Clock; 'all' — пусто). */
  readonly bounds: { readonly fromUtcMs?: number; readonly toUtcMs?: number };
  /** Пояс для настенных дат границ (часы устройства, §13: не участвует в данных). */
  readonly boundsTzOffsetMin: number;
  readonly stats: PeriodStatisticsDto;
  readonly series: TrendResponse;
  readonly gaps: readonly Gap[];
  readonly notes: readonly ContextNoteLine[];
  readonly includeNotes: boolean;
  readonly scale: ActiveScale;
}

/** Число как есть (avg/sd уже округлены доменом 052 — печать не дублирует). */
function num(value: number): string {
  return String(value);
}

/** Со знаком для delta (вечер−утро): '+8', '−3' — знак всегда, кроме отрицательных. */
function signed(value: number): string {
  return value >= 0 ? `+${num(value)}` : num(value);
}

/** 'YYYY-MM-DD' → 'DD.MM' (строки серий/разрывов/заметок, §13). */
function dayMonth(wallDate: string): string {
  return `${wallDate.slice(8, 10)}.${wallDate.slice(5, 7)}`;
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY' (диапазон периода, §4). */
function fullDate(wallDate: string): string {
  return `${wallDate.slice(8, 10)}.${wallDate.slice(5, 7)}.${wallDate.slice(0, 4)}`;
}

/** RU-множественное слово «день/дня/дней» (§13: «14 дней», «21 день»). */
function daysWord(n: number): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 12 && mod100 <= 14) {
    return 'дней';
  }
  if (mod10 === 1) {
    return 'день';
  }
  if (mod10 >= 2 && mod10 <= 4) {
    return 'дня';
  }
  return 'дней';
}

/** Диапазон шкалы: {min:null,max:119} → '≤119'; {180,null} → '≥180'; середина → '120–129' (границы включительно, §7 TASK-050). */
function scaleRange(range: { readonly min: number | null; readonly max: number | null }): string {
  if (range.min === null && range.max !== null) {
    return `≤${num(range.max)}`;
  }
  if (range.min !== null && range.max === null) {
    return `≥${num(range.min)}`;
  }
  if (range.min !== null && range.max !== null) {
    return range.min === range.max ? num(range.min) : `${num(range.min)}–${num(range.max)}`;
  }
  return '—';
}

/** Агрегаты канала построчно: пропущенные части — часть строки отсутствует (§7). */
function valueStatsLine(label: string, stats: { avg?: number; min?: number; max?: number; sd?: number }): string {
  if (stats.avg === undefined) {
    return `${label}: нет данных`;
  }
  const parts = [`среднее ${num(stats.avg)}`];
  if (stats.min !== undefined) {
    parts.push(`мин ${num(stats.min)}`);
  }
  if (stats.max !== undefined) {
    parts.push(`макс ${num(stats.max)}`);
  }
  if (stats.sd !== undefined) {
    parts.push(`SD ${num(stats.sd)}`);
  }
  return `${label}: ${parts.join(', ')}`;
}

/** Средняя части суток: `СДА 121, ДДА 81` + пульс, если в части измерен (§13 052). */
function partAverages(label: string, part: { count: number; sys: { avg?: number }; dia: { avg?: number }; pulse?: { avg?: number } }): string {
  const parts: string[] = [];
  if (part.sys.avg !== undefined) {
    parts.push(`СДА ${num(part.sys.avg)}`);
  }
  if (part.dia.avg !== undefined) {
    parts.push(`ДДА ${num(part.dia.avg)}`);
  }
  if (part.pulse !== undefined && part.pulse.avg !== undefined) {
    parts.push(`пульс ${num(part.pulse.avg)}`);
  }
  return `${label} (n=${num(part.count)}): ${parts.join(', ')}`;
}

/** Настенная дата момента в поясе offset ('YYYY-MM-DD'; календарная математика kernel). */
function isoWallDate(utcMs: number, tzOffsetMin: number): string {
  return Instant.toIso({ utcMs, tzOffsetMin }).slice(0, 10);
}

/** Метка диапазона периода (§9: без дат «сейчас» — пресет меткой, custom датами границ). */
function periodRangeLine(input: AiContextRenderInput): string {
  const { period, boundsTzOffsetMin } = input;
  if (period === 'all') {
    return 'Диапазон: весь журнал';
  }
  if (typeof period === 'string') {
    const days = PRESET_DAYS[period];
    return `Диапазон: последние ${num(days)} ${daysWord(days)}`;
  }
  const from = isoWallDate(period.fromUtcMs, boundsTzOffsetMin);
  const to = isoWallDate(period.toUtcMs, boundsTzOffsetMin);
  return `Диапазон: ${fullDate(from)}–${fullDate(to)}`;
}

/** Строки секции «По дням» (§5): raw — точка строкой, daily — агрегат дня (056). */
function seriesLines(series: TrendResponse): string[] {
  if (series.mode === 'daily') {
    return (series.days ?? []).map((day) => {
      const parts = [
        `СДА ${num(day.sysAvg)} (${num(day.sysMin)}–${num(day.sysMax)})`,
        `ДДА ${num(day.diaAvg)} (${num(day.diaMin)}–${num(day.diaMax)})`,
      ];
      if (day.morningSysAvg !== undefined) {
        parts.push(`утро ${num(day.morningSysAvg)}`);
      }
      if (day.eveningSysAvg !== undefined) {
        parts.push(`вечер ${num(day.eveningSysAvg)}`);
      }
      if (day.pulseAvg !== undefined) {
        parts.push(`пульс ${num(day.pulseAvg)}`);
      }
      parts.push(`n=${num(day.count)}`);
      return `${dayMonth(day.wallDate)} — ${parts.join(', ')}`;
    });
  }
  return (series.points ?? []).map((point) => {
    const iso = Instant.toIso({ utcMs: point.utcMs, tzOffsetMin: point.tzOffsetMin });
    const moment = `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
    const values = [`${num(point.sys)}/${num(point.dia)}`];
    if (point.pulse !== undefined) {
      values.push(`пульс ${num(point.pulse)}`);
    }
    // Пометки (§5: критические/irregular в сериях) — аннотации через пробел.
    const marks: string[] = [];
    if (point.irregular === true) {
      marks.push('[неровный пульс]');
    }
    if (point.critical !== undefined) {
      marks.push(point.critical === 'high' ? '[КРИТИЧЕСКОЕ: высокое]' : '[КРИТИЧЕСКОЕ: пониженное]');
    }
    const annotation = marks.length > 0 ? ` ${marks.join(' ')}` : '';
    return `${moment} — ${values.join(', ')}${annotation}`;
  });
}

/** Строки секции «Разрывы» (§13): «08.03–21.03 (14 дней)» или честное «не обнаружено». */
function gapLines(gaps: readonly Gap[]): string[] {
  if (gaps.length === 0) {
    return ['Разрывов не обнаружено'];
  }
  return gaps.map(
    (gap) => `${dayMonth(gap.fromWallDate)}–${dayMonth(gap.toWallDate)} (${num(gap.days)} ${daysWord(gap.days)})`,
  );
}

/** Строки секции «Шкала» (§5 «шкала (051)» + classification 053 — заметки из данных шкалы). */
function scaleLines(scale: ActiveScale, stats: PeriodStatisticsDto): string[] {
  const lines = [
    `Справочная шкала: ${scale.sourceLabel} (версия ${scale.version})`,
    'Категории (СДА / ДДА, мм рт. ст.):',
    ...scale.categories.map(
      (category) => `- ${category.label}: СДА ${scaleRange(category.sysRange)}, ДДА ${scaleRange(category.diaRange)}`,
    ),
  ];
  const classification = stats.classification;
  if (classification !== undefined) {
    if (classification.category !== undefined) {
      lines.push(`Категория средних за период: ${classification.category.label}`);
    }
    for (const note of classification.notes) {
      lines.push(`Примечание: ${note.text}`);
    }
  }
  return lines;
}

/**
 * Сборка текста и списка секций (§4/§11). Порядок секций фиксирован
 * (period, aggregates, daily, gaps, notes, scale); «Заметки» — только при
 * includeNotes (§14); остальные секции присутствуют всегда (пустые данные —
 * честные строки «нет», §11). Разделитель секций — пустая строка.
 */
export function renderAiContext(input: AiContextRenderInput): {
  text: string;
  sections: readonly AiContextSectionId[];
} {
  const { stats } = input;
  const blocks: Array<{ id: AiContextSectionId; lines: string[] }> = [];

  const insufficient = stats.insufficientData.tooFewMeasurements || stats.insufficientData.tooFewDays;
  const aggregates: string[] = [
    valueStatsLine('СДА (систолическое)', stats.sys),
    valueStatsLine('ДДА (диастолическое)', stats.dia),
  ];
  if (stats.pulse !== undefined) {
    aggregates.push(valueStatsLine('Пульс', stats.pulse));
  }
  aggregates.push(`Мало данных: ${insufficient ? 'да' : 'нет'}`);
  if (stats.morning !== undefined) {
    aggregates.push(partAverages('Утро', stats.morning));
  }
  if (stats.evening !== undefined) {
    aggregates.push(partAverages('Вечер', stats.evening));
  }
  if (stats.other !== undefined) {
    aggregates.push(partAverages('Другое', stats.other));
  }
  if (stats.delta !== undefined) {
    aggregates.push(`Разница вечер−утро: СДА ${signed(stats.delta.sys)}, ДДА ${signed(stats.delta.dia)}`);
  }
  const criticalKinds = [
    ...(stats.critical.high ? ['высокое'] : []),
    ...(stats.critical.low ? ['пониженное'] : []),
  ];
  aggregates.push(
    criticalKinds.length > 0
      ? `Критические значения: ЕСТЬ — ${criticalKinds.join(', ')}`
      : 'Критические значения: нет',
  );
  blocks.push({ id: 'period', lines: [periodRangeLine(input), `Измерений: ${num(stats.count)}`, `Дней с измерениями: ${num(stats.daysWithMeasurements)}`] });
  blocks.push({ id: 'aggregates', lines: aggregates });

  const daily: string[] = [];
  if (input.series.mode === 'daily') {
    daily.push('Данные агрегированы по дням: период длиннее лимита детального контекста.');
  }
  daily.push(...seriesLines(input.series));
  blocks.push({ id: 'daily', lines: daily });
  blocks.push({ id: 'gaps', lines: gapLines(input.gaps) });
  if (input.includeNotes) {
    blocks.push({
      id: 'notes',
      lines: input.notes.length > 0 ? input.notes.map((note) => `${note.wallDate} — ${note.text}`) : ['Нет заметок в периоде'],
    });
  }
  blocks.push({ id: 'scale', lines: scaleLines(input.scale, stats) });

  const titles: Record<AiContextSectionId, string> = {
    period: '# Период [period]',
    aggregates: '## Агрегаты [aggregates]',
    daily: '## По дням [daily]',
    gaps: '## Разрывы [gaps]',
    notes: '## Заметки [notes]',
    scale: '## Шкала [scale]',
  };
  const text = blocks.map((block) => `${titles[block.id]}\n${block.lines.join('\n')}`).join('\n\n');
  const sections = blocks.map((block) => block.id);
  return { text, sections };
}
