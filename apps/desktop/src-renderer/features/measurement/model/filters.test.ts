/**
 * TASK-044 §7/§13/§14/§19: юнит-тесты модели фильтров истории.
 *
 * toQuery (§13): пресет Nд → fromUtcMs = nowUtcMs − N*86400000 ВКЛЮЧИТЕЛЬНО
 * (граница пресета — точка включения записи портом TASK-021), toUtcMs отсутствует;
 * «всё» → from/to нет. TASK-046 custom: границы настенных дней from/to через
 * parseRange (§7), неполный диапазон — открытая сторона (§10), пустые оба и
 * невалидные даты — границы дефолтного 30d (§10/§14). arm/hasNote пробрасываются
 * как есть.
 *
 * Парсер (§14): мусорный URL → дефолт 30d без ошибок; строгие enum-значения
 * (7D ≠ 7d); noted только '1'; посторонние параметры игнорируются. TASK-046:
 * from/to — только при period=custom, строгий ISO-календарь, мусор отбрасывается,
 * from > to — весь custom мусорен → дефолт.
 *
 * Сериализатор (§5/§12): период в URL ВСЕГДА (дефолт — period=30d — виден в
 * адресе), arm/noted — только непустые; roundtrip parse∘serialize — тождество
 * на всех UI-достижимых состояниях (§23: custom добавит TASK-046).
 */
import { describe, expect, it } from 'vitest';

import type { MeasurementDto } from '@hl/contracts';

import {
  DAY_MS,
  DEFAULT_FILTER_STATE,
  isFiltersActive,
  matchesDtoFilters,
  parseHistoryFilters,
  serializeHistoryFilters,
  toQuery,
} from './filters';
import { MS_PER_MINUTE, tzOffsetMinOf } from './taken-at';

/** Фиксированное «сейчас» — не Date.now (чистая функция, детерминизм §19). */
const NOW_MS = Date.UTC(2026, 8, 27, 15, 0);

/** Смещение зоны устройства для NOW (toQuery custom берёт зону момента now). */
const OFFSET_MIN = tzOffsetMinOf(NOW_MS);

/** Настенная полночь даты 'YYYY-MM-DD' в зоне OFFSET → ожидаемый fromUtcMs. */
function wallStart(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1) - OFFSET_MIN * MS_PER_MINUTE;
}

/** 23:59:59.999 настенной даты в зоне OFFSET → ожидаемый toUtcMs (§13 включительно). */
function wallEnd(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1) + DAY_MS - 1 - OFFSET_MIN * MS_PER_MINUTE;
}

describe('toQuery — пресеты периода (§13)', () => {
  it('7д: fromUtcMs = now − 7 суток ровно, toUtcMs отсутствует (граница включительная — TASK-021)', () => {
    expect(toQuery({ period: '7d' }, NOW_MS)).toStrictEqual({
      fromUtcMs: NOW_MS - 7 * DAY_MS,
    });
  });

  it('30д: fromUtcMs = now − 30 суток', () => {
    expect(toQuery({ period: '30d' }, NOW_MS)).toStrictEqual({
      fromUtcMs: NOW_MS - 30 * DAY_MS,
    });
  });

  it('90д: fromUtcMs = now − 90 суток', () => {
    expect(toQuery({ period: '90d' }, NOW_MS)).toStrictEqual({
      fromUtcMs: NOW_MS - 90 * DAY_MS,
    });
  });

  it('«всё»: ни fromUtcMs, ни toUtcMs (весь журнал)', () => {
    expect(toQuery({ period: 'all' }, NOW_MS)).toStrictEqual({});
  });

  it('custom без дат (§10: пустые оба) → границы дефолтного 30d — режим custom, запрос как 30d', () => {
    expect(toQuery({ period: 'custom' }, NOW_MS)).toStrictEqual({
      fromUtcMs: NOW_MS - 30 * DAY_MS,
    });
  });
});

describe('toQuery — комбинация фильтров (§5/§20 AC2)', () => {
  it('период + рука + noted: все поля в одном query-фрагменте', () => {
    expect(toQuery({ period: '7d', arm: 'left', noted: true }, NOW_MS)).toStrictEqual({
      fromUtcMs: NOW_MS - 7 * DAY_MS,
      arm: 'left',
      hasNote: true,
    });
  });

  it('без руки/заметки соответствующие ключи не появляются (toStrictEqual — отсутствие, не undefined)', () => {
    expect(toQuery({ period: 'all', arm: 'right' }, NOW_MS)).toStrictEqual({ arm: 'right' });
    expect(toQuery({ period: 'all', noted: false }, NOW_MS)).toStrictEqual({});
  });
});

describe('parseHistoryFilters — URL → состояние (§7/§14)', () => {
  /** Читатель по строке запроса (та же минимальная поверхность, что у useSearchParams). */
  function params(search: string): URLSearchParams {
    return new URLSearchParams(search);
  }

  it('пустой URL → дефолт 30d без руки и заметки', () => {
    expect(parseHistoryFilters(params(''))).toStrictEqual(DEFAULT_FILTER_STATE);
    expect(DEFAULT_FILTER_STATE).toStrictEqual({ period: '30d' });
  });

  it.each(['7d', '30d', '90d', 'all'] as const)('period=%s — валиден', (period) => {
    expect(parseHistoryFilters(params(`period=${period}`))).toStrictEqual({ period });
  });

  it('мусорный период (§14: ?period=<script>) → дефолт 30d', () => {
    expect(parseHistoryFilters(params('period=%3Cscript%3E'))).toStrictEqual({
      period: '30d',
    });
  });

  it('чувствительность к регистру: 7D → дефолт; period=custom — валиден (TASK-046 §5)', () => {
    expect(parseHistoryFilters(params('period=7D'))).toStrictEqual({ period: '30d' });
    expect(parseHistoryFilters(params('period=custom'))).toStrictEqual({ period: 'custom' });
  });

  it('рука: left/right читаются, мусор → не задана', () => {
    expect(parseHistoryFilters(params('arm=left'))).toStrictEqual({ period: '30d', arm: 'left' });
    expect(parseHistoryFilters(params('arm=right'))).toStrictEqual({ period: '30d', arm: 'right' });
    expect(parseHistoryFilters(params('arm=center'))).toStrictEqual({ period: '30d' });
  });

  it('noted: только «1» означает истину; 0/true/мусор → не задан', () => {
    expect(parseHistoryFilters(params('noted=1'))).toStrictEqual({ period: '30d', noted: true });
    expect(parseHistoryFilters(params('noted=0'))).toStrictEqual({ period: '30d' });
    expect(parseHistoryFilters(params('noted=true'))).toStrictEqual({ period: '30d' });
  });

  it('полная комбинация period=7d&arm=right&noted=1 → всё состояние (§5)', () => {
    expect(parseHistoryFilters(params('period=7d&arm=right&noted=1'))).toStrictEqual({
      period: '7d',
      arm: 'right',
      noted: true,
    });
  });

  it('посторонние параметры URL игнорируются (§14 — никаких прочтений)', () => {
    expect(parseHistoryFilters(params('foo=bar&period=90d&baz=%3Cscript%3E'))).toStrictEqual({
      period: '90d',
    });
  });
});

describe('serializeHistoryFilters — состояние → URL (§5/§12)', () => {
  it('дефолт сериализуется с period=30d (сброс → URL в дефолт с видимым периодом)', () => {
    expect(serializeHistoryFilters(DEFAULT_FILTER_STATE).toString()).toBe('period=30d');
  });

  it('полное состояние: period=7d&arm=left&noted=1', () => {
    expect(serializeHistoryFilters({ period: '7d', arm: 'left', noted: true }).toString()).toBe(
      'period=7d&arm=left&noted=1',
    );
  });

  it('не заданные arm/noted в URL не попадают', () => {
    expect(serializeHistoryFilters({ period: 'all' }).toString()).toBe('period=all');
  });
});

describe('roundtrip parse∘serialize — тождество на UI-достижимых состояниях (§12)', () => {
  it.each(['7d', '30d', '90d', 'all'] as const)('period=%s', (period) => {
    const state = { period, arm: 'left', noted: true } as const;
    expect(parseHistoryFilters(serializeHistoryFilters(state))).toStrictEqual(state);
    expect(parseHistoryFilters(serializeHistoryFilters({ period }))).toStrictEqual({ period });
  });
});

// TASK-046 §5/§7/§10: произвольный период — state {period:'custom', from?, to?},
// toQuery через parseRange (настенные границы §13), URL period=custom&from=&to=.
describe('TASK-046: toQuery — custom через parseRange (§7/§10/§13)', () => {
  it('оба поля: from = полночь настенного from-дня, to = 23:59:59.999 настенного to-дня', () => {
    expect(
      toQuery({ period: 'custom', from: '2026-03-01', to: '2026-03-15' }, NOW_MS),
    ).toStrictEqual({
      fromUtcMs: wallStart('2026-03-01'),
      toUtcMs: wallEnd('2026-03-15'),
    });
  });

  it('только from — «от даты до ∞» (§10 прогрессивно)', () => {
    expect(toQuery({ period: 'custom', from: '2026-03-01' }, NOW_MS)).toStrictEqual({
      fromUtcMs: wallStart('2026-03-01'),
    });
  });

  it('только to — «до даты от −∞», to не в будущем (§10/EC-20)', () => {
    expect(toQuery({ period: 'custom', to: '2026-03-15' }, NOW_MS)).toStrictEqual({
      toUtcMs: wallEnd('2026-03-15'),
    });
    expect(toQuery({ period: 'custom', to: '2026-09-28' }, NOW_MS)).toStrictEqual({
      fromUtcMs: NOW_MS - 30 * DAY_MS,
    });
  });

  it('невалидная пара в состоянии (from>to — рукописный URL): границы дефолтного 30d (§14)', () => {
    expect(
      toQuery({ period: 'custom', from: '2026-03-15', to: '2026-03-01' }, NOW_MS),
    ).toStrictEqual({ fromUtcMs: NOW_MS - 30 * DAY_MS });
  });

  it('мусор в состоянии (from=xx — парсер такое не создаёт, защита в глубину): дефолт 30d', () => {
    expect(toQuery({ period: 'custom', from: 'xx', to: '2026-02-30' }, NOW_MS)).toStrictEqual({
      fromUtcMs: NOW_MS - 30 * DAY_MS,
    });
  });

  it('рука/заметки сочетаются с custom-границами (§5: единый query-фрагмент)', () => {
    expect(
      toQuery({ period: 'custom', from: '2026-03-01', to: '2026-03-15', arm: 'right', noted: true }, NOW_MS),
    ).toStrictEqual({
      fromUtcMs: wallStart('2026-03-01'),
      toUtcMs: wallEnd('2026-03-15'),
      arm: 'right',
      hasNote: true,
    });
  });
});

describe('TASK-046: parseHistoryFilters — from/to только при custom (§5/§14)', () => {
  /** Читатель по строке запроса (та же минимальная поверхность, что у useSearchParams). */
  function params(search: string): URLSearchParams {
    return new URLSearchParams(search);
  }

  it('period=custom&from&to — состояние с датами (§5 URL-формат)', () => {
    expect(parseHistoryFilters(params('period=custom&from=2026-03-01&to=2026-03-15'))).toStrictEqual(
      { period: 'custom', from: '2026-03-01', to: '2026-03-15' },
    );
  });

  it('period=custom без дат — режим custom с пустыми полями (не дефолт: поля видимы)', () => {
    expect(parseHistoryFilters(params('period=custom'))).toStrictEqual({ period: 'custom' });
  });

  it.each([
    'from=xx',
    'from=2026-3-1',
    'from=2026-02-30',
    'from=2026-03-01T00:00',
    'from=',
  ] as const)('мусорный %s отбрасывается, дата не в состоянии (§14)', (fragment) => {
    expect(parseHistoryFilters(params(`period=custom&${fragment}&to=2026-03-15`))).toStrictEqual({
      period: 'custom',
      to: '2026-03-15',
    });
  });

  it('from > to (рукописный URL) — весь custom мусорен → дефолт 30d (§14/AC2)', () => {
    expect(
      parseHistoryFilters(params('period=custom&from=2026-03-15&to=2026-03-01')),
    ).toStrictEqual(DEFAULT_FILTER_STATE);
  });

  it('from/to при пресете — игнорируются (параметры только режима custom, §5)', () => {
    expect(parseHistoryFilters(params('period=7d&from=2026-03-01&to=2026-03-15'))).toStrictEqual({
      period: '7d',
    });
  });
});

describe('TASK-046: serializeHistoryFilters и roundtrip custom (§5/§12)', () => {
  it('custom с датами: period=custom&from=…&to=… (§2 URL-формат)', () => {
    expect(
      serializeHistoryFilters({ period: 'custom', from: '2026-03-01', to: '2026-03-15' }).toString(),
    ).toBe('period=custom&from=2026-03-01&to=2026-03-15');
  });

  it('custom без дат: только period=custom (поля пустые — режим выбираем)', () => {
    expect(serializeHistoryFilters({ period: 'custom' }).toString()).toBe('period=custom');
  });

  it('у пресетов from/to в URL не пишутся, даже если попали в состояние', () => {
    expect(
      serializeHistoryFilters({ period: '7d', from: '2026-03-01', to: '2026-03-15' }).toString(),
    ).toBe('period=7d');
  });

  it('roundtrip custom: parse∘serialize — тождество (§12, AC5 перезагрузка)', () => {
    const state = { period: 'custom', from: '2026-03-01', to: '2026-03-15' } as const;
    expect(parseHistoryFilters(serializeHistoryFilters(state))).toStrictEqual(state);
    expect(parseHistoryFilters(serializeHistoryFilters({ period: 'custom', from: state.from }))).toStrictEqual({
      period: 'custom',
      from: state.from,
    });
    expect(parseHistoryFilters(serializeHistoryFilters({ period: 'custom' }))).toStrictEqual({
      period: 'custom',
    });
  });

  it('isFiltersActive: custom — активные фильтры (особое пустое состояние, §10)', () => {
    expect(isFiltersActive({ period: 'custom' })).toBe(true);
    expect(isFiltersActive({ period: 'custom', from: '2026-03-01' })).toBe(true);
  });
});

// TASK-045 §5/§10/§12: строка поиска — q в состоянии фильтров (URL ?q=), клиентское
// сужение результата поиска фильтрами (search возвращает по всей БД — §10).
describe('TASK-045: параметр q — состояние ↔ URL', () => {
  /** Читатель по строке запроса (та же минимальная поверхность, что у useSearchParams). */
  function params(search: string): URLSearchParams {
    return new URLSearchParams(search);
  }

  it('парсер: q читается, пробельная/пустая q → поле отсутствует (мусор → дефолт, §14)', () => {
    expect(parseHistoryFilters(params('period=30d&q=болела'))).toStrictEqual({
      period: '30d',
      q: 'болела',
    });
    expect(parseHistoryFilters(params('q=   '))).toStrictEqual({ period: '30d' });
    expect(parseHistoryFilters(params('q='))).toStrictEqual({ period: '30d' });
  });

  it('сериализатор: q только непустая; roundtrip сохраняет (URLSearchParams кодирует кириллицу)', () => {
    const withQuery = serializeHistoryFilters({ period: '30d', q: 'голова' });
    expect(withQuery.get('q')).toBe('голова');
    expect(serializeHistoryFilters({ period: 'all' }).toString()).toBe('period=all');
    const state = { period: '7d', q: 'кофе' } as const;
    expect(parseHistoryFilters(serializeHistoryFilters(state))).toStrictEqual(state);
  });

  it('isFiltersActive: непустая q — активные фильтры (особое пустое состояние, §10)', () => {
    expect(isFiltersActive({ period: '30d', q: 'кофе' })).toBe(true);
    expect(isFiltersActive({ period: '30d' })).toBe(false);
  });

  it('toQuery: q НЕ входит во фрагмент list (поиск — отдельный канал, §10/§11)', () => {
    expect(toQuery({ period: 'all', q: 'кофе' }, NOW_MS)).toStrictEqual({});
  });
});

describe('TASK-045: matchesDtoFilters — клиентское сужение результата поиска (§10)', () => {
  const dto = (overrides: Partial<MeasurementDto> = {}): MeasurementDto => ({
    id: 'm-1',
    profileId: 'p',
    sys: 120,
    dia: 80,
    irregularPulse: false,
    arm: 'left',
    note: 'болела голова',
    takenAtUtcMs: NOW_MS - DAY_MS,
    tzOffsetMin: 180,
    source: 'manual',
    createdAtUtcMs: NOW_MS - DAY_MS,
    updatedAtUtcMs: NOW_MS - DAY_MS,
    ...overrides,
  });

  it('пустой фрагмент — проходит всё', () => {
    expect(matchesDtoFilters({}, dto())).toBe(true);
  });

  it('период: from/to включительно (прецедент порта TASK-021)', () => {
    const fragment = { fromUtcMs: NOW_MS - 2 * DAY_MS, toUtcMs: NOW_MS };
    expect(matchesDtoFilters(fragment, dto())).toBe(true);
    expect(matchesDtoFilters(fragment, dto({ takenAtUtcMs: NOW_MS - 3 * DAY_MS }))).toBe(false);
    expect(matchesDtoFilters(fragment, dto({ takenAtUtcMs: NOW_MS - 2 * DAY_MS }))).toBe(true);
  });

  it('рука и «только с заметками»', () => {
    expect(matchesDtoFilters({ arm: 'right' }, dto())).toBe(false);
    expect(matchesDtoFilters({ arm: 'left' }, dto())).toBe(true);
    expect(matchesDtoFilters({ hasNote: true }, dto({ note: undefined }))).toBe(false);
    expect(matchesDtoFilters({ hasNote: true }, dto())).toBe(true);
  });
});
