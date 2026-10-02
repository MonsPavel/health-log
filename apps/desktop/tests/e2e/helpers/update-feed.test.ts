/**
 * TASK-104 §19/§20: тест-механики подписи Windows (test-cert) и update-фида.
 * Хелпер — ./update-feed.ts (локальный http-фид + test-cert + драйвер боевого
 * NsisUpdater из electron-updater, §19 «e2e-хелпер с локальным http-фидом»).
 *
 * Карта приёмки §20:
 *  AC1+AC3 — test-cert: подпись → Get-AuthenticodeSignature Valid; updater
 *            принимает подписанный фикстурный exe с локального фида и готов
 *            устанавливать (downloadUpdate → update-downloaded). Доверие корня —
 *            §5 «доверие в локальном хранилище»: Windows требует ОДНОГО
 *            интерактивного подтверждения при импорте тестового корня, поэтому
 *            без него тест ctx.skip с точной командой ручного прогона
 *            (docs/dev/certificates.md); лог проверки §20-1 — в PR-описании.
 *  AC4     — подмена байта после подписи → updater отвергает (sha512 latest.yml,
 *            ERR_CHECKSUM_MISMATCH — гейт DigestTransform загрузчика);
 *  §14     — updater не принимает неподписанные (publisherName в app-update.yml,
 *            дефолт verifyUpdateCodeSignature): ERR_UPDATER_INVALID_SIGNATURE;
 *  AC2     — timestamp-server присутствует в signtool-конфиге electron-builder.yml;
 *  §13     — поля latest-файла фида: version/path/sha512/files[{url,size,sha512}].
 *
 * Windows-описания гейтятся describe.skipIf: PR-CI — ubuntu (pr.yml), механики
 * §19 локальные. Драйверу updater'а электрон-бинарник не нужен (кастомный
 * node-executor), но подпись/Get-AuthenticodeSignature — Windows-only.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  buildAppUpdateYml,
  buildLatestYml,
  createTestCodeSigningCert,
  createTestUpdater,
  findUnsignedFixtureExe,
  getAuthenticodeStatus,
  importRootTrust,
  isRootTrusted,
  signInstaller,
  startLocalUpdateFeed,
  type UpdateFeedHandle,
} from './update-feed.js';

/** Корень пакета @hl/desktop (tests/e2e/helpers/* → три уровня вверх, §5 TASK-035). */
const APP_ROOT = join(fileURLToPath(new URL('../../..', import.meta.url)));

const INSTALLER_NAME = 'health-log-setup-1.0.1.exe';
const INSTALLED_VERSION = '1.0.0';
const UPDATE_VERSION = '1.0.1';
const UPDATER_CACHE_DIR_NAME = 'hl-updater-test';

const dirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** sha512 файла в base64 — кодировка latest-файла electron-builder (§13). */
const sha512Base64 = (file: string): string =>
  createHash('sha512').update(readFileSync(file)).digest('base64');

describe('update-feed — YAML-строители фида (TASK-104 §13)', () => {
  it('buildLatestYml: version/path/sha512 + files[{url,size,sha512}] — как у builder', () => {
    const sha512 = Buffer.from('a'.repeat(128), 'hex').toString('base64');
    const yml = buildLatestYml({
      version: UPDATE_VERSION,
      path: INSTALLER_NAME,
      sha512,
      size: 67_056,
    });

    expect(yml).toMatch(new RegExp(`^version: ${UPDATE_VERSION}$`, 'm'));
    expect(yml).toMatch(new RegExp(`^path: ${INSTALLER_NAME}$`, 'm'));
    expect(yml).toMatch(`sha512: ${sha512}`);
    // releaseDate — поле builder'а; без него серверное время не фиксируется в фикстуре.
    expect(yml).toMatch(/^releaseDate: .+$/m);
    // files: единственный файл-установщик с url=имени файла, size и sha512 (§13).
    expect(yml).toMatch(new RegExp(`^  - url: ${INSTALLER_NAME}$`, 'm'));
    expect(yml).toMatch(/^    size: 67056$/m);
    expect(yml).toMatch(`    sha512: ${sha512}`);
  });

  it("buildAppUpdateYml: provider/url/channel/publisherName/updaterCacheDirName — зеркало builder'а", () => {
    const yml = buildAppUpdateYml({
      url: 'http://127.0.0.1:8123/',
      channel: 'stable',
      publisherName: 'CN=Health Log Test, O=Health Log, C=RU',
      updaterCacheDirName: UPDATER_CACHE_DIR_NAME,
    });

    expect(yml).toMatch(/^provider: generic$/m);
    expect(yml).toMatch(/^url: http:\/\/127\.0\.0\.1:8123\/$/m);
    expect(yml).toMatch(/^channel: stable$/m);
    expect(yml).toMatch(/^publisherName: CN=Health Log Test, O=Health Log, C=RU$/m);
    expect(yml).toMatch(new RegExp(`^updaterCacheDirName: ${UPDATER_CACHE_DIR_NAME}$`, 'm'));
  });

  it('buildAppUpdateYml без publisherName — поле отсутствует (updater пропустит проверку подписи)', () => {
    const yml = buildAppUpdateYml({
      url: 'http://127.0.0.1:8123/',
      updaterCacheDirName: UPDATER_CACHE_DIR_NAME,
    });

    expect(yml).not.toContain('publisherName');
  });
});

describe('update-feed — контракт подписи electron-builder.yml (TASK-104 §20-2, §5, §14)', () => {
  const config = readFileSync(join(APP_ROOT, 'electron-builder.yml'), 'utf-8');

  it('(AC2) RFC3161 timestamp-server присутствует в signtoolOptions (подпись переживает истечение сертификата)', () => {
    expect(config).toMatch(/^  signtoolOptions:$/m);
    expect(config).toMatch(/^    rfc3161TimeStampServer: https?:\/\/\S+$/m);
  });

  it('хеш подписи — sha256 (§5: signtoolOptions sha256)', () => {
    expect(config).toMatch(/^    signingHashAlgorithms:$/m);
    expect(config).toMatch(/^      - sha256$/m);
  });

  it("publisherName задан и совпадает в win.signtoolOptions и publish (требование updater'а §5)", () => {
    // Схема app-builder-lib: в publish publisherName — только массив (список YAML),
    // в win.signtoolOptions — скаляр; значения обязаны совпадать. [ \t]* — чтобы
    // не пересечь перевод строки (ключ publish без значения на той же строке).
    const scalars = [...config.matchAll(/^[ \t]*publisherName:[ \t]+(\S.*?)[ \t]*$/gm)].map(
      (match) => match[1]?.trim(),
    );
    const listItems = [...config.matchAll(/^[ \t]*-[ \t]+(CN=\S.*?)[ \t]*$/gm)].map((match) =>
      match[1]?.trim(),
    );
    const values = [...scalars, ...listItems];
    expect(values.length).toBe(2);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toMatch(/^CN=/);
  });

  it('publish: generic-провайдер на GitHub Releases latest, канал stable (§5)', () => {
    expect(config).toMatch(/^publish:$/m);
    expect(config).toMatch(/^  provider: generic$/m);
    expect(config).toMatch(
      /^  url: https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/latest\/download$/m,
    );
    expect(config).toMatch(/^  channel: stable$/m);
  });

  it('(§14) updater-проверка подписи не отключена (verifyUpdateCodeSignature — дефолт)', () => {
    expect(config).not.toMatch(/^.*verifyUpdateCodeSignature:\s*false.*$/m);
  });

  it('(§14) секреты подписи не в конфиге: certificateFile/certificatePassword — только env (CI/локальный env-файл вне git)', () => {
    expect(config).not.toMatch(/^.*certificate(File|Password):.*$/m);
  });
});

describe.skipIf(process.platform !== 'win32')(
  'update-feed — подпись test-cert и боевой updater (TASK-104 §19/§20, Windows)',
  () => {
    /** Уникальный CN тестового сертификата прогона (клин — в finally каждого теста). */
    const CERT_CN = `Health Log Test Signing ${process.pid}`;

    /**
     * Подготовка фикстуры установщика: catalog-free PE (без каталожной подписи
     * Windows — иначе Get-AuthenticodeSignature отвечает по каталогу, минуя нашу
     * подпись) копируется и подписывается test-cert (§5: New-SelfSignedCertificate
     * → signtool → подпись).
     */
    const makeInstallerFixture = (dir: string): string => {
      const installerSource = join(dir, INSTALLER_NAME);
      copyFileSync(findUnsignedFixtureExe(), installerSource);
      return installerSource;
    };

    it('(AC1+AC3) test-cert: подпись Valid; updater принимает подписанный exe с локального фида и готов устанавливать', async (ctx) => {
      const dir = tmpDir('hl-update-feed-pos-');
      const installerSource = makeInstallerFixture(dir);
      const cert = createTestCodeSigningCert(dir, CERT_CN);
      try {
        // §5 «доверие в локальном хранилище»: Windows показывает диалог
        // подтверждения на импорт корня — без HL_TEST_CERT_TRUST_ROOT=1
        // (и присутствия человека) тест честно пропускается.
        const trusted =
          isRootTrusted(cert.thumbprint) ||
          (process.env['HL_TEST_CERT_TRUST_ROOT'] === '1' &&
            importRootTrust(cert.cerPath) === 'trusted');
        if (!trusted) {
          ctx.skip(
            'Root-импорт test-cert требует интерактивного подтверждения Windows. ' +
              'Однократно: HL_TEST_CERT_TRUST_ROOT=1 pnpm exec vitest run ' +
              'apps/desktop/tests/e2e/helpers/update-feed.test.ts (docs/dev/certificates.md §4)',
          );
        }

        signInstaller(installerSource, cert);
        const feed: UpdateFeedHandle = await startLocalUpdateFeed({ dir, installerSource });
        writeFileSync(
          join(dir, 'stable.yml'),
          buildLatestYml({
            version: UPDATE_VERSION,
            path: INSTALLER_NAME,
            sha512: sha512Base64(installerSource),
            size: readFileSync(installerSource).length,
          }),
        );
        writeFileSync(
          join(dir, 'app-update.yml'),
          buildAppUpdateYml({
            url: feed.baseUrl,
            channel: 'stable',
            publisherName: cert.subjectDn,
            updaterCacheDirName: UPDATER_CACHE_DIR_NAME,
          }),
        );
        const updater = createTestUpdater({
          appUpdateYmlPath: join(dir, 'app-update.yml'),
          installedVersion: INSTALLED_VERSION,
          cacheDir: tmpDir('hl-update-feed-cache-'),
          userDataDir: tmpDir('hl-update-feed-udata-'),
        });
        const events: string[] = [];
        updater.on('update-available', () => events.push('update-available'));
        updater.on('update-downloaded', () => events.push('update-downloaded'));

        const check = await updater.checkForUpdates();
        expect(check?.isUpdateAvailable).toBe(true);
        expect(check?.updateInfo.version).toBe(UPDATE_VERSION);

        const downloaded = await updater.downloadUpdate();
        // «Готов устанавливать» (§20-3): событие update-downloaded + путь из кэша updater'а.
        expect(events).toContain('update-downloaded');
        expect(downloaded.length).toBeGreaterThan(0);
        expect(readFileSync(downloaded[0] as string).equals(readFileSync(installerSource))).toBe(
          true,
        );
        // §20-1: подпись скачанного установщика — Valid, наш издатель (лог — в PR-описании).
        const status = getAuthenticodeStatus(downloaded[0] as string);
        expect(status.status).toBe(0);
        expect(status.signerSubject).toBe(cert.subjectDn);
      } finally {
        cert.remove();
      }
    }, 180_000);

    it('(AC3) локальный фид: updater скачивает подписанный exe и готов устанавливать (downloadUpdate → update-downloaded)', async () => {
      // Автоматизируемая часть §20-3: полный позитивный конвейер фида
      // (latest-файл → загрузка → sha512 → готовность) на ПОДПИСАННОЙ фикстуре.
      // app-update.yml без publisherName — updater пропускает проверку подписи
      // (ветка «нет publisherName» electron-updater), поэтому доверие корня
      // (интерактивный шаг Windows) не требуется; подпись фикстуры подтверждается
      // напрямую (signerSubject) и в AC1-тесте выше — вместе с принятием подписи.
      const dir = tmpDir('hl-update-feed-ready-');
      const installerSource = makeInstallerFixture(dir);
      const cert = createTestCodeSigningCert(dir, CERT_CN);
      try {
        signInstaller(installerSource, cert);
        const feed: UpdateFeedHandle = await startLocalUpdateFeed({ dir, installerSource });
        writeFileSync(
          join(dir, 'stable.yml'),
          buildLatestYml({
            version: UPDATE_VERSION,
            path: INSTALLER_NAME,
            sha512: sha512Base64(installerSource),
            size: readFileSync(installerSource).length,
          }),
        );
        writeFileSync(
          join(dir, 'app-update.yml'),
          buildAppUpdateYml({
            url: feed.baseUrl,
            channel: 'stable',
            updaterCacheDirName: UPDATER_CACHE_DIR_NAME,
          }),
        );
        const updater = createTestUpdater({
          appUpdateYmlPath: join(dir, 'app-update.yml'),
          installedVersion: INSTALLED_VERSION,
          cacheDir: tmpDir('hl-update-feed-cache-'),
          userDataDir: tmpDir('hl-update-feed-udata-'),
        });
        const events: string[] = [];
        updater.on('update-downloaded', () => events.push('update-downloaded'));

        expect((await updater.checkForUpdates())?.isUpdateAvailable).toBe(true);
        const downloaded = await updater.downloadUpdate();

        expect(events).toContain('update-downloaded');
        expect(downloaded.length).toBeGreaterThan(0);
        expect(readFileSync(downloaded[0] as string).equals(readFileSync(installerSource))).toBe(
          true,
        );
        // Подписанная фикстура доехала до кэша updater'а байт-в-байт: наш издатель.
        const status = getAuthenticodeStatus(downloaded[0] as string);
        expect(status.signerSubject).toBe(cert.subjectDn);
      } finally {
        cert.remove();
      }
    }, 90_000);

    it('(AC4) подмена байта после подписи → updater отвергает: sha512 latest.yml (ERR_CHECKSUM_MISMATCH)', async () => {
      const dir = tmpDir('hl-update-feed-tamper-');
      const installerSource = makeInstallerFixture(dir);
      const cert = createTestCodeSigningCert(dir, CERT_CN);
      try {
        signInstaller(installerSource, cert); // доверие не нужно: хеш-гейт раньше подписи
        const feed: UpdateFeedHandle = await startLocalUpdateFeed({ dir, installerSource });
        writeFileSync(
          join(dir, 'stable.yml'),
          buildLatestYml({
            version: UPDATE_VERSION,
            path: INSTALLER_NAME,
            sha512: sha512Base64(installerSource), // хеш ПОДЛИННИКА — сервер отдаёт подмену
            size: readFileSync(installerSource).length,
          }),
        );
        writeFileSync(
          join(dir, 'app-update.yml'),
          buildAppUpdateYml({
            url: feed.baseUrl,
            channel: 'stable',
            publisherName: cert.subjectDn,
            updaterCacheDirName: UPDATER_CACHE_DIR_NAME,
          }),
        );
        // Подмена отдаваемых байтов: инвертируем байт рядом с концом подписанного PE.
        feed.tamperInstaller((bytes) => {
          const tampered = Buffer.from(bytes);
          const position = tampered.length - 3;
          tampered[position] = (tampered[position] ?? 0) ^ 0xff;
          return tampered;
        });
        const updater = createTestUpdater({
          appUpdateYmlPath: join(dir, 'app-update.yml'),
          installedVersion: INSTALLED_VERSION,
          cacheDir: tmpDir('hl-update-feed-cache-'),
          userDataDir: tmpDir('hl-update-feed-udata-'),
        });
        const events: string[] = [];
        updater.on('update-downloaded', () => events.push('update-downloaded'));

        expect((await updater.checkForUpdates())?.isUpdateAvailable).toBe(true);
        await expect(updater.downloadUpdate()).rejects.toMatchObject({
          code: 'ERR_CHECKSUM_MISMATCH',
        });
        expect(events).not.toContain('update-downloaded');
      } finally {
        cert.remove();
      }
    }, 90_000);

    it('(§14) неподписанный exe при publisherName в app-update.yml → updater отвергает (ERR_UPDATER_INVALID_SIGNATURE)', async () => {
      const dir = tmpDir('hl-update-feed-unsigned-');
      const installerSource = makeInstallerFixture(dir); // НЕ подписываем
      const feed: UpdateFeedHandle = await startLocalUpdateFeed({ dir, installerSource });
      writeFileSync(
        join(dir, 'stable.yml'),
        buildLatestYml({
          version: UPDATE_VERSION,
          path: INSTALLER_NAME,
          sha512: sha512Base64(installerSource), // хеш сходится — отклонит именно подпись
          size: readFileSync(installerSource).length,
        }),
      );
      writeFileSync(
        join(dir, 'app-update.yml'),
        buildAppUpdateYml({
          url: feed.baseUrl,
          channel: 'stable',
          publisherName: 'CN=Health Log, O=Health Log, C=RU',
          updaterCacheDirName: UPDATER_CACHE_DIR_NAME,
        }),
      );
      const updater = createTestUpdater({
        appUpdateYmlPath: join(dir, 'app-update.yml'),
        installedVersion: INSTALLED_VERSION,
        cacheDir: tmpDir('hl-update-feed-cache-'),
        userDataDir: tmpDir('hl-update-feed-udata-'),
      });
      const events: string[] = [];
      updater.on('update-downloaded', () => events.push('update-downloaded'));

      expect((await updater.checkForUpdates())?.isUpdateAvailable).toBe(true);
      await expect(updater.downloadUpdate()).rejects.toMatchObject({
        code: 'ERR_UPDATER_INVALID_SIGNATURE',
      });
      expect(events).not.toContain('update-downloaded');
    }, 60_000);
  },
);
