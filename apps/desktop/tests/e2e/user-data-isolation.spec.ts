/**
 * TASK-119 §3/§4 (находка F2 аудита 2026-Q1 §4): e2e smoke полной изоляции
 * Chromium-слой. Тест пишет в localStorage рендерера уникальный маркер → после
 * graceful-закрытия маркер есть в leveldb tmp-userData (Local Storage/) и его нет
 * в дефолтном профиле Chromium. Дефолтные профили (без app.setPath жил бы там):
 * dev-запуск — %APPDATA%/Electron (эмпирика mainProcessLogsDir, launch.ts),
 * packaged — %APPDATA%/health-log (AC §4: «в %APPDATA%\health-log/Local Storage
 * его нет»). До фикса (app.setPath в bootstrap, TASK-119) localStorage писался
 * именно в дефолтный профиль — RED-прогон этого спека и находки F2/F3 аудита.
 * Значение маркера уникально на прогон (randomUUID): старое загрязнение реального
 * профиля (hl.updates.lastCheckAt из F3) не даёт ложных срабатываний.
 *
 * Фикстуры — те же, что в critical-path.spec.ts (tmp-userData с очисткой,
 * tracked-запуск со страховкой закрытия). Никаких sleep: graceful quit → expect.poll
 * на сброс leveldb на диск (§13).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type ElectronApplication } from '@playwright/test';

import { collectDiagnostics } from './helpers/collect-diagnostics.js';
import { closeApp, launchApp, mainProcessLogsDir } from './helpers/launch.js';

/** Ключ-маркер изоляции: префикс hl. (семейство localStorage-ключей приложения). */
const MARKER_KEY = 'hl.e2e.userDataIsolation';

/**
 * Есть ли маркер в leveldb-каталоге «Local Storage» профиля. leveldb хранит строки
 * в utf8 или utf16le — ищем обе кодировки по всем файлам. Каталога нет (undefined)
 * = данных нет: для «реального профиля» это тоже отсутствие маркера.
 */
async function profileContainsMarker(
  profileDir: string,
  markerValue: string,
): Promise<boolean | undefined> {
  const localStorageDir = join(profileDir, 'Local Storage');
  if (!existsSync(localStorageDir)) {
    return undefined;
  }
  const needles = [Buffer.from(markerValue, 'utf8'), Buffer.from(markerValue, 'utf16le')];
  const entries = await readdir(localStorageDir, { recursive: true });
  for (const entry of entries) {
    const full = join(localStorageDir, entry);
    if (!(await stat(full)).isFile()) {
      continue;
    }
    const bytes = await readFile(full);
    if (needles.some((needle) => bytes.includes(needle))) {
      return true;
    }
  }
  return false;
}

/** Корень реальных профилей: %APPDATA% (эмпирика mainProcessLogsDir — там же). */
function realProfileRoot(): string {
  return process.env['APPDATA'] ?? '';
}

/**
 * Фикстуры (§5 «фикстура tmp-userData»): копия critical-path.spec.ts — tmpUserData
 * (mkdtemp, при падении — диагностика, затем rm) и tracked-launch со страховкой
 * закрытия (упавший тест не держит tmp на Windows; closeApp идемпотентен, §22).
 */
const test = base.extend<{
  tmpUserData: string;
  launch: (userData: string) => Promise<ElectronApplication>;
}>({
  tmpUserData: async ({}, use, testInfo) => {
    const dir = await mkdtemp(join(tmpdir(), 'hl-e2e-'));
    await use(dir);
    if (testInfo.status !== testInfo.expectedStatus) {
      await collectDiagnostics({
        userDataDir: dir,
        logsDir: mainProcessLogsDir(),
        destDir: testInfo.outputPath('failure-diagnostics'),
      });
    }
    await rm(dir, { recursive: true, force: true });
  },
  launch: async ({}, use) => {
    const apps: ElectronApplication[] = [];
    await use(async (userData: string) => {
      const app = await launchApp({ userData });
      apps.push(app);
      return app;
    });
    for (const app of apps) {
      await closeApp(app).catch(() => undefined);
    }
  },
});

test.describe('изоляция Chromium-слой (TASK-119)', () => {
  test('localStorage-маркер прогона — в tmp-userData, не в реальном профиле', async ({
    tmpUserData,
    launch,
  }) => {
    const markerValue = `e2e-userdata-${randomUUID()}`;

    const app = await launch(tmpUserData);
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Health Log');

    // Маркер пишется тем же механизмом, что hl.updates.lastCheckAt (TASK-097).
    await test.step('запись маркера в localStorage рендерера', async () => {
      await window.evaluate(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: MARKER_KEY, value: markerValue },
      );
      expect(await window.evaluate((key) => localStorage.getItem(key), MARKER_KEY)).toBe(
        markerValue,
      );
    });

    // Graceful quit: Chromium сбрасывает хранилище на диск (§22 TASK-035).
    await closeApp(app);

    // AC §4: в tmp-userData маркер ЕСТЬ (Local Storage — leveldb Chromium).
    await expect
      .poll(() => profileContainsMarker(tmpUserData, markerValue), {
        timeout: 10_000,
        message: 'маркер в tmp-userData/Local Storage',
      })
      .toBe(true);

    // AC §4: в реальном профиле маркера НЕТ — dev-профиль %APPDATA%/Electron;
    // packaged-профиль %APPDATA%/health-log проверяем, если существует.
    const devProfile = join(realProfileRoot(), 'Electron');
    expect(await profileContainsMarker(devProfile, markerValue)).not.toBe(true);
    const packagedProfile = join(realProfileRoot(), 'health-log');
    if (existsSync(packagedProfile)) {
      expect(await profileContainsMarker(packagedProfile, markerValue)).not.toBe(true);
    }
  });
});
