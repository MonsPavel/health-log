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
 * Конфиг-источник — реальный apps/desktop/electron-builder.yml (извлечение
 * publish-блока — тот же приём, что в tests/e2e/helpers/update-feed.test.ts).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { afterPack, buildAppUpdateYml, firstPublishEntry } from './after-pack-app-update.mjs';

/** Корень пакета @hl/desktop (scripts/* → два уровня вверх). */
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
 * Builder-написанный образец (resources/app-update.yml полной nsis-сборки,
 *PublishManager.getAppUpdatePublishConfiguration → serializeToYaml):
 * те же четыре поля + updaterCacheDirName из appInfo (sanitizeFileName(name).
 * toLowerCase() + '-updater' — имя пакета @hl/desktop → @hldesktop).
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
 * Извлечение первой записи publish из текста electron-builder.yml — тот же
 * приём, что в конфиг-тесте update-feed.test.ts (publishEntries).
 */
function extractFirstPublishEntry(yamlText) {
  const start = yamlText.search(/^publish:\r?\n/m) + 'publish:'.length;
  const rest = yamlText.slice(start);
  const nextSection = rest.search(/^[a-zA-Z][^\n]*:\r?\n/m);
  const block = nextSection === -1 ? rest : rest.slice(0, nextSection);
  const entries = block.split(/^  - /m).slice(1);
  expect(entries.length).toBeGreaterThan(0);
  return entries[0];
}

describe('buildAppUpdateYml — чистый генератор «конфиг → yaml» (TASK-120 AC1)', () => {
  it('из РЕАЛЬНОЙ первой записи publish electron-builder.yml даёт builder-формат (serializeToYaml)', () => {
    const config = readFileSync(join(APP_ROOT, 'electron-builder.yml'), 'utf-8');
    const entry = firstPublishEntry(config);

    expect(buildAppUpdateYml(entry, '@hldesktop-updater')).toBe(BUILDER_SAMPLE);
  });

  it('совпадает с ручным образцом аудита: provider generic, url latest/download, channel stable, publisherName', () => {
    const config = readFileSync(join(APP_ROOT, 'electron-builder.yml'), 'utf-8');
    const yml = buildAppUpdateYml(firstPublishEntry(config), '@hldesktop-updater');

    // Поля publish-блока — точное совпадение построчно (AC1).
    expect(yml.split('\n').slice(0, AUDIT_MANUAL_SAMPLE.split('\n').length)).toEqual(
      AUDIT_MANUAL_SAMPLE.split('\n'),
    );
  });

  it('publisherName — только из ПЕРВОЙ (stable) записи; beta-канал в app-update.yml не попадает', () => {
    const config = readFileSync(join(APP_ROOT, 'electron-builder.yml'), 'utf-8');
    const yml = buildAppUpdateYml(firstPublishEntry(config), '@hldesktop-updater');

    // §14 107: publisherName в файле один (NFR-11 не ослабляется); beta.yml —
    // артефакт канала, в ресурсах приложения ему не место (§5 107).
    expect(yml.match(/^publisherName:/gm)).toHaveLength(1);
    expect(yml).not.toContain('channel: beta');
  });

  it('publisherName скаляром (не списком) сериализуется одной строкой', () => {
    const entry = [
      'provider: generic',
      'url: http://127.0.0.1:8123/',
      'publisherName: CN=Test, O=Test, C=RU',
    ].join('\n');

    expect(buildAppUpdateYml(entry, 'test-updater')).toBe(
      [
        'provider: generic',
        'url: http://127.0.0.1:8123/',
        'publisherName: CN=Test, O=Test, C=RU',
        "updaterCacheDirName: 'test-updater'",
        '',
      ].join('\n'),
    );
  });

  it('канал не задан — строка channel отсутствует (зеркало builder: поле опционально)', () => {
    const entry = ['provider: generic', 'url: http://127.0.0.1:8123/'].join('\n');

    expect(buildAppUpdateYml(entry, 'test-updater')).toBe(
      [
        'provider: generic',
        'url: http://127.0.0.1:8123/',
        "updaterCacheDirName: 'test-updater'",
        '',
      ].join('\n'),
    );
  });
});

describe('firstPublishEntry — извлечение записи publish из electron-builder.yml', () => {
  it('первая (stable) запись — с publisherName, вторая (beta) — без (контракт §5 104/107)', () => {
    const config = readFileSync(join(APP_ROOT, 'electron-builder.yml'), 'utf-8');

    // Ровно два элемента списка; stable — первым (app-update.yml строится из
    // publishConfigs[0] — PublishManager, проверено образцом dist-прогонов).
    expect(config).toMatch(/^publish:\r?\n/m);
    expect(config).toMatch(/^  - provider: generic\r?\n/m);
    expect(config).toMatch(/^    channel: stable\r?\n/m);
    expect(firstPublishEntry(config)).toContain('channel: stable');
    expect(firstPublishEntry(config)).toContain('CN=Health Log');
  });
});

describe('afterPack — догенерация отсутствующего файла (AC2, логика хука на fake-контексте)', () => {
  /** fake-контекст AfterPackContext (состав — configuration.d.ts PackContext). */
  function fakeContext({ publish, resourcesDir, existingYml }) {
    if (existingYml !== undefined) {
      writeFileSync(join(resourcesDir, 'app-update.yml'), existingYml, 'utf-8');
    }
    return {
      electronPlatformName: 'win32',
      appOutDir: resourcesDir,
      packager: {
        config: { publish },
        appInfo: { updaterCacheDirName: '@hldesktop-updater' },
        getResourcesDir: (appOutDir) => join(appOutDir, 'resources'),
      },
    };
  }

  const REAL_ENTRY = firstPublishEntry(
    readFileSync(join(APP_ROOT, 'electron-builder.yml'), 'utf-8'),
  );

  it('publish настроен, файла нет → resources/app-update.yml записан (контент генератора)', async () => {
    const dir = makeTmp('hl-apu-write-');
    const resourcesDir = join(dir, 'win-unpacked', 'resources');
    await afterPack(fakeContext({ publish: [REAL_ENTRY], resourcesDir }));

    expect(readFileSync(join(resourcesDir, 'app-update.yml'), 'utf-8')).toBe(BUILDER_SAMPLE);
  });

  it('файл уже есть (nsis-сборка, builder записал сам) → хук НЕ перезаписывает', async () => {
    const dir = makeTmp('hl-apu-keep-');
    const resourcesDir = join(dir, 'win-unpacked', 'resources');
    const existing = 'provider: generic\nurl: http://127.0.0.1:9/\n';
    await afterPack(
      fakeContext({ publish: [REAL_ENTRY], resourcesDir, existingYml: existing }),
    );

    expect(readFileSync(join(resourcesDir, 'app-update.yml'), 'utf-8')).toBe(existing);
  });

  it('publish не настроен → хук молча ничего не пишет (файл не появляется)', async () => {
    const dir = makeTmp('hl-apu-none-');
    const resourcesDir = join(dir, 'win-unpacked', 'resources');
    await afterPack(fakeContext({ publish: undefined, resourcesDir }));

    expect(existsSync(join(resourcesDir, 'app-update.yml'))).toBe(false);
  });

  it('publish — единственная запись (не список) → тоже работает (asArray-семантика builder)', async () => {
    const dir = makeTmp('hl-apu-single-');
    const resourcesDir = join(dir, 'win-unpacked', 'resources');
    await afterPack(fakeContext({ publish: REAL_ENTRY, resourcesDir }));

    expect(readFileSync(join(resourcesDir, 'app-update.yml'), 'utf-8')).toBe(BUILDER_SAMPLE);
  });
});
