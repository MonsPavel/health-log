/**
 * TASK-110 §19: юнит-тесты скрипта ревизии RU-текстов (copy-audit).
 *
 * Слои (прецедент contrast-audit.test.mjs — расчёты отделены от ФС):
 *  1. словарь запрет-корней — корень находит все словоформы и НЕ находит
 *     легитимные слова-соседи («диагностика» ≠ «диагноз», «гипертонический
 *     криз» ≠ «гипертония у вас» — SRS 01 §8 + спека §4);
 *  2. извлечение строковых литералов TS — комментарии НЕ сканируются
 *     (запрет-лексика в комменте — не UI-копия), литералы — да;
 *  3. params-фигурные скобки — {{param}} в значении; дрейф в обе стороны:
 *     параметр значения не передаётся в t() (missing-in-usage), t() передаёт
 *     параметр, которого в значении нет (missing-in-value); plural-группы
 *     (_one/_few/_many/_other) — без ложного дрейфа;
 *  4. фиксатура-каталог с нарушением → находка; обязательная подстрока
 *     отсутствует → находка; whitelist-строка с причиной → не находка (§22:
 *     whitelist-запись без причины — ошибка конфигурации);
 *  5. ГЕЙТ §19/§20 — полный прогон по РЕАЛЬНЫМ каталогам монорепо: 0
 *     запрет-находок вне whitelist, 0 params-дрейфа, все обязательные
 *     дисклеймер-подстроки (FR-5.6 «не является медицинской консультацией»,
 *     emergency «103») на месте;
 *  6. CLI — exit-коды 0/1/2 и --json (§20: вывод парсится JSON.parse).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  FORBIDDEN_ROOTS,
  MANDATORY_STRINGS,
  WHITELIST,
  buildAudit,
  buildReport,
  extractStringLiterals,
  extractValueParams,
  findForbiddenRoots,
  run,
} from './copy-audit.mjs';

/** Скрипт для CLI-тестов (§20: --json разбирается JSON.parse без ошибок). */
const SCRIPT_PATH = fileURLToPath(new URL('./copy-audit.mjs', import.meta.url));

/**
 * Пять main-файлов RU-констант (§5: critical-texts, refusal-texts,
 * system-prompt; §13: константы 087 + report.aiMark) — относительные пути
 * внутри mainDir. Фикстуры создают их (пустыми, если сценарий не про main).
 */
const MAIN_FILES = [
  'main/shared/critical-texts.ts',
  'main/modules/ai-insight/application/refusal-texts.ts',
  'main/modules/ai-insight/application/prompts/system-prompt.ts',
  'main/modules/ai-insight/application/generate-summary.ts',
  'main/modules/reporting/adapters/pdf/report-strings.ts',
];

/** Tmp-каталоги фикстур; удаляются после прогона (§13: без следов). */
const tmpRoots = [];
afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** tmp-дерево из map<относительный posix-путь, содержимое>; возвращает корень. */
async function makeFixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'hl-copy-audit-'));
  tmpRoots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, ...relPath.split('/'));
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}

/** Стандартный каркас фикстуры: пять main-файлов (пустые), чистый каталог
 * рендерера (srcDir обязан существовать — exit 2 на отсутствующий каталог)
 * + переданные файлы. */
async function makeFixtureWithMain(extraFiles = {}) {
  const files = {
    'renderer-src/i18n/ru/common.json': JSON.stringify({ ok: 'Спокойный текст' }),
  };
  for (const rel of MAIN_FILES) {
    files[`main-src/${rel}`] = '';
  }
  return makeFixture({ ...files, ...extraFiles });
}

/** buildAudit по фикстуре: srcDir/mainDir указывают в tmp, mandatory по умолчанию пуст. */
function auditFixture(root, extra = {}) {
  return buildAudit({
    rootDir: root,
    srcDir: join(root, 'renderer-src'),
    mainDir: join(root, 'main-src'),
    mandatory: [],
    ...extra,
  });
}

describe('запрет-корни (§4: словарь SRS 01 §8)', () => {
  it.each([
    ['диагноз', ['ставит диагноз', 'диагнозы не ставим', 'Диагноз по данным']],
    ['лечен', ['методы лечения', 'курс лечения', 'ЛЕЧЕНИЕ']],
    ['назнач', ['назначение врача', 'назначили препарат']],
    ['показани', ['показания к приёму', 'Медицинские показания']],
    [
      'гипертония у вас',
      ['гипертония у вас уже', 'гипертония у вас на ранней стадии', 'ГИПЕРТОНИЯ У ВАС'],
    ],
    ['вы больны', ['вы больны гриппом']],
    ['страдаете', ['вы страдаете гипертонией']],
  ])('корень «%s» находит свои словоформы', (root, samples) => {
    for (const sample of samples) {
      expect(findForbiddenRoots(sample)).toContain(root);
    }
  });

  it('легитимные слова-соседи НЕ находятся (§4: попадание = ручной разбор, а тут его нет)', () => {
    // «диагностика» (TASK-103, секция настроек) ≠ «диагноз»;
    // «гипертонический криз» (SRS 04 FR-7.4 verbatim) ≠ «гипертония у вас»;
    // «показатели за период» (допустимая лексика SRS 01 §8) ≠ «показание».
    expect(findForbiddenRoots('Раздел «Диагностика» настроек')).toEqual([]);
    expect(findForbiddenRoots('Давление может указывать на гипертонический криз.')).toEqual([]);
    expect(findForbiddenRoots('Показатели за период')).toEqual([]);
    expect(findForbiddenRoots('Среднее СДА, ДДА и пульс за период')).toEqual([]);
  });

  it('словарь покрывает все корни спеки §4 (список фиксирован тестом)', () => {
    expect(FORBIDDEN_ROOTS.map((entry) => entry.id).sort()).toEqual(
      [
        'диагноз',
        'лечен',
        'назнач',
        'показани',
        'гипертония у вас',
        'у вас гипертония',
        'вы больны',
        'страдаете',
      ].sort(),
    );
  });
});

describe('извлечение строковых литералов TS (§4: скан копий, не комментариев)', () => {
  it('литералы извлекаются, комментарии — нет', () => {
    const source = [
      '// диагнозов и императивов паники — это комментарий',
      '/* лечение в блок-комментарии */',
      "export const A = 'вы больны';",
      'export const B = "страдаете гипертонией";',
      'const C = `назначение`; // назначение в хвосте — комментарий',
    ].join('\n');
    const literals = extractStringLiterals(source);
    expect(literals).toEqual(['вы больны', 'страдаете гипертонией', 'назначение']);
  });

  it('конкатенация и шаблонные строки: части сканируются по отдельности', () => {
    const source = [
      "const D = 'леч' + 'ение';",
      'const E = `${prefix}диагноз и продолжение`;',
    ].join('\n');
    const literals = extractStringLiterals(source);
    // «леч»/«ение» по отдельности корень не дают — дрейф разбиения возможен,
    // но реальный код промпта не дробит корни; фиксируем честное поведение.
    expect(literals).toEqual(['леч', 'ение', '${prefix}диагноз и продолжение']);
  });

  it('экранированная кавычка внутри литерала не рвёт извлечение', () => {
    const source = "const F = 'он сказал \\'вы больны\\' вслух';";
    expect(extractStringLiterals(source)).toEqual(["он сказал \\'вы больны\\' вслух"]);
  });
});

describe('params-проверка (§5(3): простая проверка фигурных скобок)', () => {
  it('extractValueParams: имена из {{param}}', () => {
    expect(extractValueParams('Обычно около {{median}}. Значение {{value}}')).toEqual([
      'median',
      'value',
    ]);
    expect(extractValueParams('Без подстановок')).toEqual([]);
  });

  it('extractValueParams: пробелы внутри скобок допускаются', () => {
    expect(extractValueParams('{{ count }} измерений')).toEqual(['count']);
  });
});

describe('фикстуры → находки (§19: юнит-таблицы)', () => {
  it('запрет-корень в каталоге рендерера → находка файл/ключ/корень/строка', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/danger/ru.json': JSON.stringify({
        title: 'У вас гипертония второй стадии',
      }),
    });
    const audit = auditFixture(root);
    expect(audit.forbidden).toHaveLength(1);
    expect(audit.forbidden[0]).toMatchObject({
      file: 'renderer-src/features/danger/ru.json',
      key: 'danger.title',
      root: 'у вас гипертония',
    });
    expect(audit.forbidden[0].value).toContain('гипертония');
    expect(audit.verdict).toBe('FAIL');
    expect(audit.exitCode).toBe(1);
  });

  it('запрет-корень в main-константе → находка; корень в комментарии — НЕ находка', async () => {
    const root = await makeFixtureWithMain({
      'main-src/main/shared/critical-texts.ts': [
        '// вы больны — это комментарий, не копия',
        "export const BAD = 'страдаете от давления';",
      ].join('\n'),
    });
    const audit = auditFixture(root);
    expect(audit.forbidden).toHaveLength(1);
    expect(audit.forbidden[0].file).toBe('main-src/main/shared/critical-texts.ts');
    expect(audit.forbidden[0].root).toBe('страдаете');
  });

  it('запрет-корень в файле i18n/ru/<имя>.json (имя ≠ ru.json, каталог = ru) → находка (ревью TASK-110)', async () => {
    // Регресс discovery: файлы вида i18n/ru/common.json — это те же RU-каталоги
    // (namespace = имя файла); фильтр «только ru.json» их терял (10 файлов /
    // 205 значений = 37% корпуса мимо гейта).
    const root = await makeFixtureWithMain({
      'renderer-src/i18n/ru/lock.json': JSON.stringify({
        title: 'У вас гипертония — введите пароль',
      }),
    });
    const audit = auditFixture(root);
    expect(audit.scanned.catalogs).toBe(2); // каркасный common.json + lock.json
    expect(audit.forbidden).toHaveLength(1);
    expect(audit.forbidden[0]).toMatchObject({
      file: 'renderer-src/i18n/ru/lock.json',
      key: 'lock.title',
      root: 'у вас гипертония',
    });
  });

  it('params-дрейф в файле i18n/ru/<имя>.json ловится (namespace = имя файла)', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/i18n/ru/report.json': JSON.stringify({
        done: 'Файл сохранён: {{basename}} и {{lost}}',
      }),
      'renderer-src/ui/screen.tsx':
        "const t = x; export const A = t('report.done', { basename: 'f' });",
    });
    const audit = auditFixture(root);
    expect(audit.params).toEqual([
      {
        file: 'renderer-src/i18n/ru/report.json',
        key: 'report.done',
        param: 'lost',
        direction: 'missing-in-usage',
      },
    ]);
  });

  it('discovery: раскладка i18n/ru/* + features/* + components/* — все RU-каталоги в скане', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/i18n/ru/data.json': JSON.stringify({ title: 'Данные' }),
      'renderer-src/features/p/ru.json': JSON.stringify({ title: 'Раздел' }),
      'renderer-src/components/critical/ru.json': JSON.stringify({ panel: { title: 'Панель' } }),
      'renderer-src/i18n/ru/common.json': JSON.stringify({ ok: 'Спокойный текст' }),
    });
    // Каркас уже кладёт i18n/ru/common.json — он перезаписан выше; итого 4 каталога
    // (data + features/p + components/critical + common), 4 значения.
    const audit = auditFixture(root);
    expect(audit.scanned.catalogs).toBe(4);
    expect(audit.scanned.catalogValues).toBe(4); // data.title, p.title, critical.panel.title, common.ok
  });

  it('обязательная подстрока отсутствует → находка; на месте → ok без влияния на вердикт', async () => {
    const root = await makeFixtureWithMain({
      'cat/good.json': JSON.stringify({ d: 'Это не является медицинской консультацией.' }),
      'cat/bad.json': JSON.stringify({ d: 'Что-то другое' }),
    });
    const mandatory = [
      {
        id: 'good',
        kind: 'json',
        file: 'cat/good.json',
        key: 'good.d',
        mustContain: 'не является медицинской консультацией',
      },
      {
        id: 'bad',
        kind: 'json',
        file: 'cat/bad.json',
        key: 'bad.d',
        mustContain: 'не является медицинской консультацией',
      },
    ];
    const audit = auditFixture(root, { mandatory });
    expect(audit.mandatory).toHaveLength(2);
    expect(audit.mandatory[0]).toMatchObject({ id: 'good', ok: true });
    expect(audit.mandatory[1]).toMatchObject({ id: 'bad', ok: false });
    expect(audit.verdict).toBe('FAIL');
    expect(audit.exitCode).toBe(1);
  });

  it('обязательная подстрока: пустое значение и отсутствующий файл — находки (тихий пропуск недопустим)', async () => {
    const root = await makeFixtureWithMain({
      'cat/empty.json': JSON.stringify({ d: '' }),
    });
    const mandatory = [
      { id: 'empty', kind: 'json', file: 'cat/empty.json', key: 'empty.d', mustContain: 'X' },
      { id: 'gone', kind: 'json', file: 'cat/gone.json', key: 'gone.d', mustContain: 'X' },
    ];
    const audit = auditFixture(root, { mandatory });
    expect(audit.mandatory.map((entry) => entry.ok)).toEqual([false, false]);
  });

  it('обязательная подстрока в TS-константе (ts-regex) — mustContain и mustEqual', async () => {
    const root = await makeFixtureWithMain({
      'main-src/main/shared/critical-texts.ts': [
        'export const EMERGENCY_NUMBERS = {',
        "  ru: { locale: 'ru', primary: '103', unified: '112', label: 'скорая' },",
        '};',
      ].join('\n'),
    });
    const mandatory = [
      {
        id: 'emergency',
        kind: 'ts-regex',
        file: 'main-src/main/shared/critical-texts.ts',
        regex: /ru:\s*\{\s*locale:\s*'ru',\s*primary:\s*'([^']+)'/,
        group: 1,
        mustEqual: '103',
      },
      {
        id: 'wrong',
        kind: 'ts-regex',
        file: 'main-src/main/shared/critical-texts.ts',
        regex: /нет такого:\s*'([^']+)'/,
        group: 1,
        mustEqual: '103',
      },
    ];
    const audit = auditFixture(root, { mandatory });
    expect(audit.mandatory[0]).toMatchObject({ id: 'emergency', ok: true, found: '103' });
    expect(audit.mandatory[1]).toMatchObject({ id: 'wrong', ok: false });
  });

  it('params-дрейф: параметр значения не передаётся → missing-in-usage', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/p/ru.json': JSON.stringify({
        hint: 'Обычно около {{median}}. Значение {{value}} в поле «{{field}}»',
      }),
      'renderer-src/ui/screen.tsx': "const t = x; export const A = t('p.hint', { median, field });",
    });
    const audit = auditFixture(root);
    expect(audit.params).toEqual([
      {
        file: 'renderer-src/features/p/ru.json',
        key: 'p.hint',
        param: 'value',
        direction: 'missing-in-usage',
      },
    ]);
  });

  it('params-дрейф: t() передаёт параметр, которого нет в значении → missing-in-value', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/p/ru.json': JSON.stringify({ plain: 'Мало данных' }),
      'renderer-src/ui/screen.tsx':
        "const t = x; export const A = t('p.plain', { median, period });",
    });
    const audit = auditFixture(root);
    expect(audit.params).toEqual([
      {
        file: 'renderer-src/features/p/ru.json',
        key: 'p.plain',
        param: 'median',
        direction: 'missing-in-value',
      },
      {
        file: 'renderer-src/features/p/ru.json',
        key: 'p.plain',
        param: 'period',
        direction: 'missing-in-value',
      },
    ]);
  });

  it('мультистрочный params-объект и значения-выражения парсятся (конвенция кода)', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/p/ru.json': JSON.stringify({ label: 'Среднее {{avg}} из {{total}}' }),
      'renderer-src/ui/screen.tsx': [
        'const t = x;',
        'export const A = t("p.label", {',
        '  avg: formatNumberRu(value),',
        '  total,',
        '});',
      ].join('\n'),
    });
    const audit = auditFixture(root);
    expect(audit.params).toEqual([]);
  });

  it('plural-группа _one/_few/_many/_other: {{count}} в каждой форме — дрейфа нет', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/p/ru.json': JSON.stringify({
        pl_one: '{{count}} день',
        pl_few: '{{count}} дня',
        pl_many: '{{count}} дней',
        pl_other: '{{count}} дня',
      }),
      'renderer-src/ui/screen.tsx': 'const t = x; export const A = t("p.pl", { count: n });',
    });
    const audit = auditFixture(root);
    expect(audit.params).toEqual([]);
  });

  it('ключ с параметрами без единого использования → вне проверки params (зона check:i18n unused)', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/p/ru.json': JSON.stringify({ orphan: '{{median}} — потерян' }),
    });
    const audit = auditFixture(root);
    expect(audit.params).toEqual([]);
  });

  it('динамическое потребление (errors.*, privacy.ops.*) — вне params-проверки', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/i18n/ru/errors.json': JSON.stringify({ rangeSys: 'От {{min}} до {{max}}' }),
      'renderer-src/i18n/ru/privacy.json': JSON.stringify({
        ops: { models_download: 'Скачивает {{size}}' },
      }),
    });
    const audit = auditFixture(root);
    expect(audit.params).toEqual([]);
  });

  it('whitelist-строка с причиной → не находка; обход фиксируется в отчёте (§22)', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/p/ru.json': JSON.stringify({ title: 'Мы не ставим диагнозов' }),
    });
    const whitelist = [
      {
        file: 'renderer-src/features/p/ru.json',
        fragment: 'диагнозов',
        root: 'диагноз',
        reason: 'отрицание — легитимно (§4: «мы не ставим диагнозов»)',
      },
    ];
    const audit = auditFixture(root, { whitelist });
    expect(audit.forbidden).toEqual([]);
    expect(audit.whitelisted).toHaveLength(1);
    expect(audit.whitelisted[0]).toMatchObject({ key: 'p.title', root: 'диагноз' });
    expect(audit.whitelisted[0].reason).toContain('отрицание');
    expect(audit.verdict).toBe('OK');
  });

  it('whitelist-запись без причины — ошибка конфигурации (§22: правило проекта)', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/p/ru.json': JSON.stringify({ title: 'Мы не ставим диагнозов' }),
    });
    const whitelist = [{ file: 'renderer-src/features/p/ru.json', fragment: 'диагнозов' }];
    expect(() => auditFixture(root, { whitelist })).toThrow(/причин/);
  });

  it('чистая фикстура → verdict OK, exit 0', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/p/ru.json': JSON.stringify({ title: 'Спокойный текст {{n}}' }),
      'renderer-src/ui/screen.tsx': 'const t = x; export const A = t("p.title", { n: 1 });',
    });
    const audit = auditFixture(root);
    expect(audit.forbidden).toEqual([]);
    expect(audit.params).toEqual([]);
    expect(audit.verdict).toBe('OK');
    expect(audit.exitCode).toBe(0);
  });
});

describe('таблицы скрипта по умолчанию (§13: ключ→обязательная подстрока; §22: whitelist с причинами)', () => {
  it('все whitelist-записи имеют непустую причину', () => {
    expect(WHITELIST.length).toBeGreaterThan(0);
    for (const entry of WHITELIST) {
      expect(entry.reason?.trim().length ?? 0).toBeGreaterThan(10);
      expect(entry.fragment?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it('обязательные подстроки: дисклеймер FR-5.6 и emergency «103» (таблица фиксирована тестом)', () => {
    const ids = MANDATORY_STRINGS.map((entry) => entry.id);
    expect(ids).toContain('fr56-disclaimer-renderer');
    expect(ids).toContain('fr56-disclaimer-main-087');
    expect(ids).toContain('fr56-disclaimer-report-aimark');
    expect(ids).toContain('report-ai-tooltip');
    expect(ids).toContain('system-prompt-disclaimer');
    expect(ids).toContain('emergency-main-ru');
    expect(ids).toContain('emergency-renderer-ru');
    for (const entry of MANDATORY_STRINGS) {
      expect(entry.file?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('ГЕЙТ §19/§20: полный прогон по реальным каталогам монорепо', () => {
  const result = run({});

  it('discovery покрывает ВЕСЬ RU-корпус: 17 каталогов / 565 значений (ревью TASK-110)', () => {
    // 7 = features/* + components/* (файлы «ru.json») + 10 = i18n/ru/*.json
    // (namespace = имя файла); 560 + 5 = 565 — сходится с check:i18n
    // (TASK-121: errors/ru.json +BACKUP_MACHINE_BOUND — честная «копия с этой машины»;
    // TASK-113: settings/ru.json +4 ключа секции «Помощь»,
    // errors.json +1 ключ MEASUREMENT_FUTURE_TIME — репетиция новичка).
    // При ДОБАВЛЕНИИ каталога цифры правятся осознанным коммитом вместе с отчётом.
    expect(result.json.scanned.catalogs).toBe(17);
    expect(result.json.scanned.catalogValues).toBe(565);

  });

  it('0 запрет-находок вне whitelist (§20 AC1)', () => {
    expect(result.json.forbidden).toEqual([]);
  });

  it('whitelist-обходы задокументированы (system prompt: запреты формулируются словами запрета)', () => {
    expect(result.json.whitelisted.length).toBeGreaterThan(0);
    expect(result.json.whitelisted.every((entry) => entry.file && entry.root && entry.reason)).toBe(
      true,
    );
  });

  it('0 params-дрейфа (§20 AC1: {{median}} не потерян)', () => {
    expect(result.json.params).toEqual([]);
  });

  it('все обязательные подстроки на месте (§20 AC2: скрипт-таблица)', () => {
    const broken = result.json.mandatory.filter((entry) => !entry.ok);
    expect(broken).toEqual([]);
  });

  it('дисклеймер-инварианты содержат формулировку FR-5.6 (SRS 01 §8)', () => {
    const byId = Object.fromEntries(result.json.mandatory.map((entry) => [entry.id, entry]));
    for (const id of [
      'fr56-disclaimer-renderer',
      'fr56-disclaimer-main-087',
      'fr56-disclaimer-report-aimark',
      'report-ai-tooltip',
      'system-prompt-disclaimer',
    ]) {
      expect(byId[id].found).toContain('не является медицинской консультацией');
    }
  });

  it('emergency-реестры содержат «103» для ru (§5(2))', () => {
    const byId = Object.fromEntries(result.json.mandatory.map((entry) => [entry.id, entry]));
    expect(byId['emergency-main-ru'].found).toBe('103');
    expect(byId['emergency-renderer-ru'].found).toBe('103');
  });

  it('итог: verdict OK, exit 0 (§24: скрипт зелёный)', () => {
    expect(result.json.verdict).toBe('OK');
    expect(result.exitCode).toBe(0);
  });

  it('отчёт — markdown с таблицами находок и вердиктом', () => {
    const report = result.report ?? buildReport(result.json);
    expect(report).toContain('# copy-audit');
    expect(report).toContain('запрет-корни');
    expect(report).toContain('whitelist');
    expect(report).toContain('обязательные');
    expect(report).toContain('params');
    expect(report).toContain('verdict: OK');
  });
});

describe('buildReport (фикстура с нарушением — строки таблиц)', () => {
  it('находки попадают в markdown-таблицы с файлом и ключом', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/danger/ru.json': JSON.stringify({ title: 'У вас гипертония' }),
    });
    const audit = auditFixture(root);
    const report = buildReport(audit);
    expect(report).toContain('verdict: FAIL');
    expect(report).toContain('renderer-src/features/danger/ru.json');
    expect(report).toContain('danger.title');
    expect(report).toContain('у вас гипертония');
  });
});

describe('CLI (§20: exit-код + --json)', () => {
  function cli(args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT_PATH, ...args]);
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.on('close', (code) => {
        resolve({ code, stdout });
      });
    });
  }

  it('реальный монорепо после правок: exit 0, --json парсится (§20)', async () => {
    const { code, stdout } = await cli(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.verdict).toBe('OK');
    expect(parsed.forbidden).toEqual([]);
    expect(parsed.params).toEqual([]);
  }, 60000);

  it('фикстура с нарушением (--root): exit 1 и упоминание файла', async () => {
    const root = await makeFixtureWithMain({
      'renderer-src/features/danger/ru.json': JSON.stringify({ title: 'У вас гипертония' }),
    });
    const { code, stdout } = await cli([
      '--json',
      '--root',
      root,
      '--src',
      'renderer-src',
      '--main',
      'main-src',
    ]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.verdict).toBe('FAIL');
    expect(parsed.forbidden[0].file).toContain('danger');
  }, 60000);

  it('несуществующий каталог исходников → exit 2 (ошибка вызова)', async () => {
    const { code } = await cli(['--root', join(tmpdir(), 'hl-copy-audit-nope')]);
    expect(code).toBe(2);
  }, 60000);
});
