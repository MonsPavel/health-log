/**
 * TASK-120 §19/§20: юнит-тесты догенерации resources/app-update.yml для локальных
 * (no-tag) сборок.
 *
 * Наблюдение F3 живого аудита TASK-106 (docs/architecture/audits/2026-Q1-mvp.md §3):
 * electron-builder пишет app-update.yml только в publish-manager-пути, а там
 * генерация пропускается, если ни одна цель сборки не является NSIS
 * (isSuitableWindowsTarget в PublishManager.onAfterPack) — локальные
 * `--dir --publish never` сборки файл не получают. afterPack-хук
 * (electron-builder.yml → scripts/after-pack-app-update.mjs) дописывает файл
 * сам: publish настроен, файла нет → записать (первая запись publish — stable —
 * ровно как PublishManager.getAppUpdatePublishConfiguration → publishConfigs[0]).
 *
 * Карта приёмки §20:
 *  AC1 — генератор из конфига даёт yaml, совпадающий с ручным образцом аудита
 *        2026-Q1 (provider generic, url latest/download, channel stable,
 *        publisherName) и с builder-написанным образцом (включая
 *        updaterCacheDirName из appInfo);
 *  AC2 — саму сборку (`--dir --publish never`) юнит не покрывает: её проверяет
 *        ручная приёмка §5/§24 (хук вызывается electron-builder'ом, не тестом).
 *
 * Реальная первая запись publish берётся из apps/desktop/electron-builder.yml
 * (значения — текстовым разбором, тот же приём, что в конфиг-тесте
 * tests/e2e/helpers/update-feed.test.ts; YAML-парсер в рантайме теста не нужен).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  afterPack,
  buildAppUpdateYml,
  firstPublishEntry,
  yamlScalar,
} from './after-pack-app-update.mjs';

/** Корень пакета @hl/desktop (scripts/* → на уровень вверх). */
const APP_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Ручной образец аудита 2026-Q1 (§3 S3: «файл добавляется вручную —
 * детерминированное содержимое publish-блока»): четыре поля из первой записи
 * publish, ровно как в файле, добавлявшемся в dist-audit5 вручную.
 */
const AUDIT_MANUAL_SAMPLE = [
  'provider: generic',
  'url: https://github.com/MonsPavel/health-log/releases/latest/download',
  'channel: stable',
  'publisherName:',
  '  - CN=Health Log, O=Health Log, C=RU',
].join('\n');

/**
 * Builder-написанный образец (resources/app-update.yml полной nsis-сборки —
 * PublishManager.getAppUpdatePublishConfiguration → serializeToYaml): те же
 * четыре поля + updaterCacheDirName из appInfo (sanitizeFileName(name).
 * toLowerCase() + '-updater' — имя пакета @hl/desktop → '@hldesktop').
 */
const BUILDER_SAMPLE = `${AUDIT_MANUAL_SAMPLE}\nupdaterCacheDirName: '@hldesktop-updater'\n`;

/** tmp-каталоги прогонов (§13 vitest.setup: ФС пользователя не затрагивается). */
const tmpRoots = [];
afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Новый tmp-каталог с регистрацией на очистку. */
function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/**
 * Первая запись publish РЕАЛЬНОГО electron-builder.yml в виде объекта:
 * текстовый разбор значений (provider/channel — инварианты конфиг-теста 104,
 * url/publisherName — читаем из файла, не дублируем значения).
 */
function realFirstPublishEntry() {
  const config = readFileSync(join(APP_ROOT, 'electron-builder.yml'), 'utf-8');
  const start = config.search(/^publish:\r?\n/m) + 'publish:'.length;
  const block = config
    .slice(start)
    .split(/^[a-zA-Z][^\n]*:\r?\n/m)[0]
    .split(/^  - /m)[1];
  expect(block).toContain('provider: generic');
  expect(block).toContain('channel: stable');
  const url = block.match(/^    url: (.+)$/m)?.[1];
  const publisherName = block.match(/^      - (.+)$/m)?.[1];
  expect(url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download$/);
  expect(publisherName).toMatch(/^CN=/);
  return { provider: 'generic', url, channel: 'stable', publisherName: [publisherName] };
}

describe('buildAppUpdateYml — чистый генератор «конфиг → yaml» (TASK-120 AC1)', () => {
  it('из РЕАЛЬНОЙ первой записи publish electron-builder.yml даёт builder-формат (serializeToYaml)', () => {
    expect(buildAppUpdateYml(realFirstPublishEntry(), '@hldesktop-updater')).toBe(BUILDER_SAMPLE);
  });

  it('совпадает с ручным образцом аудита: provider generic, url latest/download, channel stable, publisherName', () => {
    const yml = buildAppUpdateYml(realFirstPublishEntry(), '@hldesktop-updater');

    // Поля publish-блока — точное совпадение построчно (AC1).
    expect(yml.split('\n').slice(0, AUDIT_MANUAL_SAMPLE.split('\n').length)).toEqual(
      AUDIT_MANUAL_SAMPLE.split('\n'),
    );
  });

  it('publisherName — только из ПЕРВОЙ (stable) записи; beta-канал в app-update.yml не попадает', () => {
    const yml = buildAppUpdateYml(realFirstPublishEntry(), '@hldesktop-updater');

    // §14 107: publisherName в файле один (NFR-11 не ослабляется); beta.yml —
    // артефакт канала, в ресурсах приложения ему не место (§5 107).
    expect(yml.match(/^publisherName:/gm)).toHaveLength(1);
    expect(yml).not.toContain('beta');
  });

  it('publisherName скаляром (не списком) сериализуется одной строкой', () => {
    expect(
      buildAppUpdateYml(
        {
          provider: 'generic',
          url: 'http://127.0.0.1:8123/',
          publisherName: 'CN=Test, O=Test, C=RU',
        },
        'test-updater',
      ),
    ).toBe(
      [
        'provider: generic',
        'url: http://127.0.0.1:8123/',
        'publisherName: CN=Test, O=Test, C=RU',
        'updaterCacheDirName: test-updater',
        '',
      ].join('\n'),
    );
  });

  it('канал не задан — строка channel отсутствует (зеркало builder: поле опционально)', () => {
    expect(
      buildAppUpdateYml({ provider: 'generic', url: 'http://127.0.0.1:8123/' }, 'test-updater'),
    ).toBe(
      [
        'provider: generic',
        'url: http://127.0.0.1:8123/',
        'updaterCacheDirName: test-updater',
        '',
      ].join('\n'),
    );
  });

  it('квотинг как у js-yaml: значение с YAML-индикатором (@…) — в одинарных кавычках', () => {
    // Имя пакета @hl/desktop → sanitizer убирает '/' → '@hldesktop-updater':
    // @ — зарезервированный индикатор YAML, js-yaml dump берёт значение в кавычки.
    // Кавычка ВНУТРИ plain-скаляра допустима — «it's» остаётся plain (сверено с
    // js-yaml@4 dump: serializeToYaml builder'а).
    expect(yamlScalar('@hldesktop-updater')).toBe("'@hldesktop-updater'");
    expect(yamlScalar('test-updater')).toBe('test-updater');
    expect(yamlScalar("it's")).toBe("it's");
    expect(yamlScalar('a: b')).toBe("'a: b'");
  });
});

describe('firstPublishEntry — asArray-семантика builder (publishConfigs[0])', () => {
  it('список записей → первая (stable с publisherName — контракт §5 104/107)', () => {
    const stable = realFirstPublishEntry();
    const beta = { provider: 'generic', url: stable.url, channel: 'beta' };

    expect(firstPublishEntry([stable, beta])).toBe(stable);
  });

  it('единственная запись (не список) → она же; publish нет → null', () => {
    const single = { provider: 'generic', url: 'http://127.0.0.1:8123/' };
    expect(firstPublishEntry(single)).toBe(single);
    expect(firstPublishEntry(undefined)).toBeNull();
    expect(firstPublishEntry(null)).toBeNull();
  });
});

describe('afterPack — догенерация отсутствующего файла (AC2, логика хука на fake-контексте)', () => {
  /** fake-контекст AfterPackContext (состав — configuration.d.ts PackContext):
   * appOutDir — каталог приложения, getResourcesDir добавляет к нему resources. */
  function fakeContext({ publish, appOutDir, existingYml }) {
    const resourcesDir = join(appOutDir, 'resources');
    if (existingYml !== undefined) {
      mkdirSync(resourcesDir, { recursive: true });
      writeFileSync(join(resourcesDir, 'app-update.yml'), existingYml, 'utf-8');
    }
    return {
      electronPlatformName: 'win32',
      appOutDir,
      packager: {
        config: { publish },
        appInfo: { updaterCacheDirName: '@hldesktop-updater' },
        getResourcesDir: (dir) => join(dir, 'resources'),
      },
    };
  }

  it('publish настроен, файла нет → resources/app-update.yml записан (контент генератора)', async () => {
    const appOutDir = join(makeTmp('hl-apu-write-'), 'win-unpacked');
    await afterPack(fakeContext({ publish: [realFirstPublishEntry()], appOutDir }));

    expect(readFileSync(join(appOutDir, 'resources', 'app-update.yml'), 'utf-8')).toBe(
      BUILDER_SAMPLE,
    );
  });

  it('файл уже есть (nsis-сборка, builder записал сам) → хук НЕ перезаписывает', async () => {
    const appOutDir = join(makeTmp('hl-apu-keep-'), 'win-unpacked');
    const existing = 'provider: generic\nurl: http://127.0.0.1:9/\n';
    await afterPack(
      fakeContext({ publish: [realFirstPublishEntry()], appOutDir, existingYml: existing }),
    );

    expect(readFileSync(join(appOutDir, 'resources', 'app-update.yml'), 'utf-8')).toBe(existing);
  });

  it('publish не настроен → хук молча ничего не пишет (файл не появляется)', async () => {
    const appOutDir = join(makeTmp('hl-apu-none-'), 'win-unpacked');
    await afterPack(fakeContext({ publish: undefined, appOutDir }));

    expect(existsSync(join(appOutDir, 'resources', 'app-update.yml'))).toBe(false);
  });

  it('publish — единственная запись (не список) → тоже работает (asArray-семантика builder)', async () => {
    const appOutDir = join(makeTmp('hl-apu-single-'), 'win-unpacked');
    await afterPack(fakeContext({ publish: realFirstPublishEntry(), appOutDir }));

    expect(readFileSync(join(appOutDir, 'resources', 'app-update.yml'), 'utf-8')).toBe(
      BUILDER_SAMPLE,
    );
  });
});
