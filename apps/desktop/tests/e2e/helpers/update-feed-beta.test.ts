/**
 * TASK-107 §19/§20: фид-механика beta-канала на локальном http-фиде (хелпер 104).
 *
 * МОДЕЛЬ ФИДА (§5 «один артефакт, разные фиды»): один каталог фида несёт ОБА
 * канальных файла — stable.yml (stable-версия) и beta.yml (пре-релиз) — как
 * активы одного релиза; клиент различается только именем канального файла:
 * GenericProvider запрашивает `<channel>.yml` (updater.channel || config.channel).
 *
 * Карта приёмки §20:
 *  AC1     — beta-клиент видит beta-версию (checkForUpdates → 0.9.1-beta.1);
 *  AC1     — изоляция: stable-клиент ТОТ ЖЕ фид → latest (0.9.1-beta.1 в stable.yml
 *            не попадает — запрошен только stable.yml);
 *  §19 spy — переключение канала меняет yml-запрос: stable.yml → beta.yml → stable.yml
 *            (боевой проводке соответствует setTestUpdaterChannel — зеркало
 *            wireElectronUpdater.setChannel);
 *  §13     — даунгрейд: клиент на beta-версии > stable-latest — updater НЕ
 *            даунгрейдит (стандартное поведение; предупреждение UI — golden в 097).
 *
 * Кроссплатформенно: app-update.yml БЕЗ publisherName — проверка подписи
 * пропускается (ветка «нет publisherName» electron-updater, §14 104), сетевой
 * драйвер — node:http (NodeHttpExecutor хелпера). Подпись каналов — §14 107
 * (один артефакт — одна подпись), здесь не участвует.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  buildAppUpdateYml,
  buildLatestYml,
  createTestUpdater,
  setTestUpdaterChannel,
  startLocalUpdateFeed,
  sha512Base64,
  type UpdateFeedHandle,
} from './update-feed.js';

/** Корень пакета @hl/desktop (tests/e2e/helpers/* → три уровня вверх). */
const APP_ROOT = join(fileURLToPath(new URL('../../..', import.meta.url)));

const UPDATER_CACHE_DIR_NAME = 'hl-updater-beta-test';
const STABLE_VERSION = '0.9.0';
const BETA_VERSION = '0.9.1-beta.1';

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

interface TwoChannelFeed {
  readonly feed: UpdateFeedHandle;
  readonly appUpdateYmlPath: string;
}

/**
 * Фид с двумя каналами в одном каталоге (модель релиза §5): stable.yml → 0.9.0,
 * beta.yml → 0.9.1-beta.1; установщики — фикстурные заглушки (проверка не
 * скачивает — достаточно канального файла; пути в yml резолвятся от baseUrl).
 */
async function makeTwoChannelFeed(): Promise<TwoChannelFeed> {
  const dir = tmpDir('hl-update-feed-beta-');
  const stableInstaller = join(dir, `health-log-setup-${STABLE_VERSION}.exe`);
  const betaInstaller = join(dir, `health-log-setup-${BETA_VERSION}.exe`);
  // Заглушка установщика: для проверки канального файла содержимое не важно,
  // но путь из yml обязан существовать (изоляция пути фида — хелпер 104).
  writeFileSync(stableInstaller, `fake-installer ${STABLE_VERSION}`, 'utf-8');
  writeFileSync(betaInstaller, `fake-installer ${BETA_VERSION}`, 'utf-8');
  const feed: UpdateFeedHandle = await startLocalUpdateFeed({ dir, installerSource: betaInstaller });
  writeFileSync(
    join(dir, 'stable.yml'),
    buildLatestYml({
      version: STABLE_VERSION,
      path: `health-log-setup-${STABLE_VERSION}.exe`,
      sha512: sha512Base64(stableInstaller),
      size: readSize(stableInstaller),
    }),
  );
  writeFileSync(
    join(dir, 'beta.yml'),
    buildLatestYml({
      version: BETA_VERSION,
      path: `health-log-setup-${BETA_VERSION}.exe`,
      sha512: sha512Base64(betaInstaller),
      size: readSize(betaInstaller),
    }),
  );
  // app-update.yml — как боевой (от publish[0], TASK-104): channel stable; БЕЗ
  // publisherName — updater пропускает проверку подписи (кроссплатформенность).
  writeFileSync(
    join(dir, 'app-update.yml'),
    buildAppUpdateYml({
      url: feed.baseUrl,
      channel: 'stable',
      updaterCacheDirName: UPDATER_CACHE_DIR_NAME,
    }),
  );
  return { feed, appUpdateYmlPath: join(dir, 'app-update.yml') };
}

/** Размер файла в байтах (поле size канального yml). */
const readSize = (file: string): number => readFileSync(file).length;

const makeClient = (
  feedInfo: TwoChannelFeed,
  installedVersion: string,
): ReturnType<typeof createTestUpdater> =>
  createTestUpdater({
    appUpdateYmlPath: feedInfo.appUpdateYmlPath,
    installedVersion,
    cacheDir: tmpDir('hl-update-feed-beta-cache-'),
    userDataDir: tmpDir('hl-update-feed-beta-udata-'),
  });

/** Канальные файлы из журнала запросов фида (spy §19). */
const channelFileRequests = (feed: UpdateFeedHandle): string[] =>
  feed.requests.filter((path) => path.endsWith('.yml') && path !== '/app-update.yml');

describe('update-feed beta — каналовая механика electron-updater (TASK-107 §19/§20)', () => {
  it('(AC1) beta-клиент видит beta-версию: setChannel(beta) → запрос beta.yml → available 0.9.1-beta.1', async () => {
    const feedInfo = await makeTwoChannelFeed();
    const updater = makeClient(feedInfo, STABLE_VERSION);
    setTestUpdaterChannel(updater, 'beta'); // §5: allowPrerelease = beta

    const check = await updater.checkForUpdates();

    expect(check?.isUpdateAvailable).toBe(true);
    expect(check?.updateInfo.version).toBe(BETA_VERSION);
    expect(channelFileRequests(feedInfo.feed)).toEqual(['/beta.yml']);
    await feedInfo.feed.close();
  });

  it('(AC1) изоляция: stable-клиент ТОТ ЖЕ фид → latest, beta.yml не запрашивается', async () => {
    const feedInfo = await makeTwoChannelFeed();
    const updater = makeClient(feedInfo, STABLE_VERSION); // канал из app-update.yml: stable

    const check = await updater.checkForUpdates();

    expect(check?.isUpdateAvailable).toBe(false); // 0.9.0 = установленной — latest
    expect(channelFileRequests(feedInfo.feed)).toEqual(['/stable.yml']); // beta не виден
    await feedInfo.feed.close();
  });

  it('(§19 spy) переключение канала меняет yml-запрос: stable.yml → beta.yml → stable.yml (next-check)', async () => {
    const feedInfo = await makeTwoChannelFeed();
    const updater = makeClient(feedInfo, STABLE_VERSION);

    await updater.checkForUpdates(); // дефолт — stable
    setTestUpdaterChannel(updater, 'beta');
    await updater.checkForUpdates(); // переключение применяет СЛЕДУЮЩАЯ проверка
    setTestUpdaterChannel(updater, 'stable');
    await updater.checkForUpdates(); // возврат — тоже next-check'ом

    expect(channelFileRequests(feedInfo.feed)).toEqual([
      '/stable.yml',
      '/beta.yml',
      '/stable.yml',
    ]);
    await feedInfo.feed.close();
  });

  it('(§13) даунгрейд: клиент на beta-версии > stable-latest — updater НЕ даунгрейдит (not available)', async () => {
    const feedInfo = await makeTwoChannelFeed();
    // Установлена 0.9.1-beta.1; пользователь переключился на stable (0.9.0 в фиде).
    const updater = makeClient(feedInfo, BETA_VERSION);
    setTestUpdaterChannel(updater, 'stable');

    const check = await updater.checkForUpdates();

    expect(check?.isUpdateAvailable).toBe(false); // откат невозможен — вернутся со следующим stable
    expect(channelFileRequests(feedInfo.feed)).toEqual(['/stable.yml']);
    await feedInfo.feed.close();
  });
});
