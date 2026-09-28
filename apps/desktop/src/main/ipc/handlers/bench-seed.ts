/**
 * TASK-062 §8/§9/§11/§14: TEST-ONLY bench-сид main-стороны — синтетика для
 * perf-bench графика. Три части:
 *  1. Гард `benchChannelsEnabled` (§11/§14): канал `__bench/seed` регистрируется
 *     ТОЛЬКО при env HL_BENCH=1 и ТОЛЬКО в не-packaged запуске (двойная защита —
 *     в packaged env игнорируется). Без флага регистрация пропускается — вызов
 *     канала неотличим от вызова неизвестного канала (APP/INTERNAL каркаса).
 *  2. Чистый генератор `generateSyntheticMeasurements` (§9: «генератор — общая
 *     функция с юнит-тестами»): детерминированный PRNG (mulberry32) с seed,
 *     реалистичная форма день/вечер (45/45/10) + шум, ~3 года до якоря. Якорь —
 *     ПАРАМЕТР (не настенные часы): два прогона с одним seed и якорем —
 *     байт-идентичны (§20 AC3). Размещение — в src/main, НЕ в tools/scripts:
 *     main-бандл собирается tsc с rootDir=src (tsconfig.main.json) и технически
 *     не может импортировать tools; дубликат генератора в tools нарушил бы
 *     «общая функция — одна копия» (§9).
 *  3. Хендлер `createBenchSeedHandler` (§8/§9): ВСЕ вставки — одна db.transaction
 *     (10k IPC-цикл add был бы слишком медленным, §8), INSERT v1 без изменений
 *     (TASK-025; named params — прецедент sqlite-measurement-repository). Профиль
 *     — seed-profile-0001 миграции v1 (FK).
 *
 * БЕЗОПАСНОСТЬ (§14): канал пишет только в БД переданного tmp-userData
 * (HL_TEST_USER_DATA bench-прогона); боевые данные недостижимы — запуск с флагом
 * выполняет скрипт bench поверх собственной tmp-директории.
 *
 * Файл живёт рядом с хендлерами каналов (ipc/handlers — прецедент trends.ts):
 * регистрация выполняется bootstrap-ом ДО installChannelBridge.
 */
import { BENCH_SEED_RESPONSE_SCHEMA, type BenchSeedRequest, type BenchSeedResponse } from '@hl/contracts';

/** Имя env-флага bench-режима (§5/§6: HL_BENCH=1; единственный источник строки). */
export const HL_BENCH_ENV = 'HL_BENCH';

/** Профиль-владелец сидинга (seed миграции v1; FK bp_measurement.profile_id). */
const SEED_PROFILE_ID = 'seed-profile-0001';

/**
 * Гард регистрации bench-канала (§11/§14). isPackaged — параметр (тест-эмуляция
 * packaged-режима §14; bootstrap подставляет app.isPackaged).
 */
export function benchChannelsEnabled(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): boolean {
  return env[HL_BENCH_ENV] === '1' && !isPackaged;
}

/** Строка синтетики (§8): форма строки bp_measurement v1 + часть суток (тест §19). */
export interface SyntheticMeasurementRow {
  /** uuid-v7-образный id, детерминированный по seed (не uuid-пакет: время-базный v7 не сеется). */
  readonly id: string;
  readonly profileId: string;
  readonly takenAtUtc: number;
  readonly tzOffsetMinutes: number;
  readonly sys: number;
  readonly dia: number;
  /** null — «пульс не измерен» (колонка nullable, v1 §8). */
  readonly pulse: number | null;
  readonly irregularPulse: boolean;
  readonly arm: 'left' | 'right';
  readonly note: string | null;
  readonly source: 'manual';
  readonly createdAtUtc: number;
  readonly updatedAtUtc: number;
  /** Часть суток правила дня 052 — для юнит-теста распределения (§19), в INSERT не идёт. */
  readonly part: 'morning' | 'evening' | 'other';
}

/** Опции генератора: count, seed и якорь конца периода (детерминизм §20 AC3). */
export interface SyntheticGeneratorOptions {
  /** Сколько записей сгенерировать (0 — пустой массив). */
  readonly count: number;
  /** Seed детерминированного PRNG (mulberry32). */
  readonly seed: number;
  /** Момент (utcMs), НЕ ПОЗЖЕ которого лежат все записи; последняя ≈ якорь − 1 мин. */
  readonly anchorUtcMs: number;
}

/** Длительность окна синтетики: 3 года (§2: «10 000 записей за 3 года»), дней. */
const SPAN_DAYS = 1096;

/** Смещение зоны синтетики (EC-06): константа +180 (детерминизм, MSK-подобная). */
const TZ_OFFSET_MIN = 180;

/** Части суток (§5 «форма день/вечер»): доли утро/вечер, остаток — «другое». */
const MORNING_SHARE = 0.45;
const EVENING_SHARE = 0.45;

/** UTC-часы частей (wall = utc + 3ч: утро 7–11, вечер 17–21 — реалистичные окна замеров). */
const MORNING_HOURS_UTC = [4, 5, 6, 7, 8] as const;
const EVENING_HOURS_UTC = [14, 15, 16, 17, 18] as const;

/** Границы значений (внутри CHECK v1: 50–300 / 20–200 / 20–300, TASK-025 §8). */
const SYS_RANGE = [95, 175] as const;
const DIA_RANGE = [58, 112] as const;
const PULSE_RANGE = [45, 110] as const;

/**
 * Детерминированный PRNG mulberry32 (32-битный, без зависимостей): одинаковый
 * seed — одинаковая последовательность (проверяется юнит-тестом §19).
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Колокол (сумма трёх равномерных) — шум значений вокруг базы, центр ~0.5. */
function bellOf(next: () => number): number {
  return (next() + next() + next()) / 3;
}

function clamp(value: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, value));
}

/** hex-строка длиной n из PRNG — детерминированный uuid-v7-образный id. */
function hexOf(next: () => number, chars: number): string {
  let out = '';
  for (let i = 0; i < chars; i += 1) {
    out += Math.floor(next() * 16).toString(16);
  }
  return out;
}

function syntheticId(next: () => number): string {
  const variant = ['8', '9', 'a', 'b'][Math.floor(next() * 4)];
  return `${hexOf(next, 8)}-${hexOf(next, 4)}-7${hexOf(next, 3)}-${variant}${hexOf(next, 3)}-${hexOf(next, 12)}`;
}

/**
 * Генератор синтетики (§5: «10 000 записей за 3 года (детерминированный PRNG с
 * seed, реалистичная форма день/вечер+шум)»). Записи равномерно заполняют окно
 * ~3 лет до якоря (день записи детерминирован индексом), внутри дня — часть
 * суток (45/45/10) и её час; значения — база + колокольный шум; ~5% без пульса,
 * ~2% «неровный пульс» (EC-10), ~3% с короткой заметкой. Результат отсортирован
 * по моменту строго возрастает (упоминание: чтения listByPeriod/trend ждут
 * возрастающий порядок; сортировка стабильна — детерминизм сохраняется).
 */
export function generateSyntheticMeasurements(
  options: SyntheticGeneratorOptions,
): SyntheticMeasurementRow[] {
  const { count, seed, anchorUtcMs } = options;
  const next = mulberry32(seed);
  const rows: SyntheticMeasurementRow[] = [];

  // Окно синтетики: SPAN_DAYS полных суток, ПОСЛЕДНИЙ день — сутки до дня якоря
  // (записи якорного дня обрезались бы клампом и ломали форму «час ↔ часть суток»).
  const anchorDayStartUtc = Math.floor(anchorUtcMs / 86_400_000) * 86_400_000;
  const spanStartUtc = anchorDayStartUtc - SPAN_DAYS * 86_400_000;

  for (let i = 0; i < count; i += 1) {
    // День записи: равномерное заполнение окна индексом (детерминизм без часов).
    const dayIndex = count === 1 ? SPAN_DAYS - 1 : Math.floor((i * SPAN_DAYS) / count);
    const dayStartUtc = spanStartUtc + dayIndex * 86_400_000;

    const roll = next();
    const part: SyntheticMeasurementRow['part'] =
      roll < MORNING_SHARE
        ? 'morning'
        : roll < MORNING_SHARE + EVENING_SHARE
          ? 'evening'
          : 'other';
    const hours =
      part === 'morning' ? MORNING_HOURS_UTC : part === 'evening' ? EVENING_HOURS_UTC : null;
    const hourUtc = hours === null ? Math.floor(next() * 24) : hours[Math.floor(next() * hours.length)]!;

    const takenAtBase = dayStartUtc + hourUtc * 3_600_000 + Math.floor(next() * 3_600_000);
    // Все записи строго ДО якоря (−1 мин): окно «истории», не будущего.
    const takenAtUtc = Math.min(takenAtBase, anchorUtcMs - 60_000);

    const eveningBoost = part === 'evening' ? 2 : 0;
    const sys = Math.round(
      clamp(118 + (bellOf(next) - 0.5) * 34 + eveningBoost, SYS_RANGE),
    );
    const dia = Math.round(clamp(76 + (bellOf(next) - 0.5) * 24 + eveningBoost / 2, DIA_RANGE));
    const pulse = next() < 0.05 ? null : Math.round(clamp(66 + (bellOf(next) - 0.5) * 20, PULSE_RANGE));
    const note = next() < 0.03 ? 'Замер после прогулки' : null;

    rows.push({
      id: syntheticId(next),
      profileId: SEED_PROFILE_ID,
      takenAtUtc,
      tzOffsetMinutes: TZ_OFFSET_MIN,
      sys,
      dia,
      pulse,
      irregularPulse: next() < 0.02,
      arm: next() < 0.5 ? 'left' : 'right',
      note,
      source: 'manual',
      createdAtUtc: takenAtUtc,
      updatedAtUtc: takenAtUtc,
      part,
    });
  }

  // Строго возрастающий порядок моментов (сортировка стабильна, ничьи — +1 мс).
  rows.sort((a, b) => a.takenAtUtc - b.takenAtUtc);
  for (let i = 1; i < rows.length; i += 1) {
    const previous = rows[i - 1]!;
    const current = rows[i]!;
    if (current.takenAtUtc <= previous.takenAtUtc) {
      rows[i] = { ...current, takenAtUtc: previous.takenAtUtc + 1 };
    }
  }
  return rows;
}

/**
 * Минимальная поверхность better-sqlite3 для хендлера (§19: fake-БД в юнит-тестах;
 * боевая — EncryptedDatabase контейнера, структурно совместима). Контракт
 * db.transaction — better-sqlite3: ВОЗВРАЩАЕТ транзакционную функцию (BEGIN…COMMIT,
 * сбой → ROLLBACK); исполнение — её вызов (промах здесь = тихая пустая вставка,
 * поймано прогон-пробой bench, §24).
 */
export interface BenchSeedDatabase {
  transaction(fn: () => unknown): () => unknown;
  prepare(sql: string): { run(params: Record<string, unknown>): unknown };
}

/** Опции хендлера: seed/якорь генератора (тесты фиксируют; bench — дефолты). */
export interface BenchSeedHandlerOptions {
  /** Seed генератора; по умолчанию — константа (воспроизводимость между прогонами, §4). */
  readonly seed?: number;
  /** Якорь генератора; по умолчанию — момент создания хендлера (свежая tmp-БД bench). */
  readonly anchorUtcMs?: number;
}

/** Seed bench-прогонов по умолчанию (дата задачи — константа кода, не часы). */
export const DEFAULT_BENCH_SEED = 20260928;

/** INSERT v1 без изменений (TASK-025 §8; named params — прецедент репозитория TASK-026). */
const BENCH_SEED_INSERT_SQL = `
  INSERT INTO bp_measurement (
    id, profile_id, taken_at_utc, tz_offset_minutes, sys, dia, pulse,
    irregular_pulse, arm, note, source, created_at_utc, updated_at_utc
  ) VALUES (
    @id, @profile_id, @taken_at_utc, @tz_offset_minutes, @sys, @dia, @pulse,
    @irregular_pulse, @arm, @note, @source, @created_at_utc, @updated_at_utc
  )
`;

/**
 * Фабрика хендлера `__bench/seed {count}` (§9): генерация + вставка ОДНОЙ
 * транзакцией; ответ {inserted} — факт вставки. Statement готовится один раз
 * (§15 better-sqlite3), исполняется внутри транзакции.
 */
export function createBenchSeedHandler(
  db: BenchSeedDatabase,
  options: BenchSeedHandlerOptions = {},
): (payload: BenchSeedRequest) => BenchSeedResponse {
  const insertStmt = db.prepare(BENCH_SEED_INSERT_SQL);
  const seed = options.seed ?? DEFAULT_BENCH_SEED;
  const anchorUtcMs = options.anchorUtcMs ?? Date.now();
  return (payload) => {
    const rows = generateSyntheticMeasurements({ count: payload.count, seed, anchorUtcMs });
    // better-sqlite3: db.transaction(fn) ВОЗВРАЩАЕТ транзакционную функцию —
    // исполнение (BEGIN…COMMIT, сбой → ROLLBACK) — её ВЫЗОВ.
    const insertAll = db.transaction(() => {
      for (const row of rows) {
        insertStmt.run({
          id: row.id,
          profile_id: row.profileId,
          taken_at_utc: row.takenAtUtc,
          tz_offset_minutes: row.tzOffsetMinutes,
          sys: row.sys,
          dia: row.dia,
          pulse: row.pulse,
          irregular_pulse: row.irregularPulse ? 1 : 0,
          arm: row.arm,
          note: row.note,
          source: row.source,
          created_at_utc: row.createdAtUtc,
          updated_at_utc: row.updatedAtUtc,
        });
      }
    });
    insertAll();
    // Ответ валидируется схемой контракта (гвоздь формы §9): inserted — факт.
    return BENCH_SEED_RESPONSE_SCHEMA.parse({ inserted: rows.length });
  };
}
