/**
 * TASK-120: afterPack-хук electron-builder — догенерация resources/app-update.yml
 * для локальных (no-tag) сборок.
 *
 * Наблюдение F3 живого аудита TASK-106 (docs/architecture/audits/2026-Q1-mvp.md
 * §3): штатная запись app-update.yml живёт в PublishManager.onAfterPack, но там
 * генерация пропускается, когда ни одна цель сборки не является NSIS
 * (isSuitableWindowsTarget: nsis/appx) — локальные `--dir --publish never`
 * сборки (аудиты, CONTRIBUTING §11.2) файл не получают, updater в них падает
 * (updater-unavailable), S3-сценарий сетевого аудита невоспроизводим.
 *
 * Хук дополняет, а не заменяет штатный путь: если файл уже записан builder'ом
 * (nsis-сборки, CI-пайплайн на теге — PublishManager.onAfterPack регистрируется
 * раньше user-хуков) — ничего не делает. Содержимое — зеркало
 * PublishManager.getAppUpdatePublishConfiguration: ПЕРВАЯ запись publish
 * (publishConfigs[0] — stable с publisherName) + updaterCacheDirName из appInfo.
 * Сетевых/издательских действий хук не выполняет — только файл в resources
 * (§5: публикация и CI-pipeline вне задачи).
 *
 * Чистая часть (firstPublishEntry/buildAppUpdateYml) покрыта юнит-тестами
 * after-pack-app-update.test.mjs (§19); AC2 (файл появляется в `--dir --publish
 * never` сборке) проверяется приёмкой §24 — хук вызывает сам electron-builder.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Имя ресурса updater'а в resources упакованного приложения. */
export const APP_UPDATE_FILENAME = 'app-update.yml';

/**
 * Первая запись publish из конфига (asArray-семантика builder'а: publish —
 * запись ИЛИ список записей; app-update.yml строится из publishConfigs[0] —
 * stable, см. §5 104). Возвращает запись-объект или null, если publish нет.
 */
export function firstPublishEntry(publish) {
  if (publish == null) {
    return null;
  }
  const entries = Array.isArray(publish) ? publish : [publish];
  return entries.length > 0 ? (entries[0] ?? null) : null;
}

/**
 * YAML-скаляр в builder-стиле (serializeToYaml = js-yaml dump, lineWidth 8000):
 * plain, если значение не начинается с YAML-индикатора/пробела и не содержит
 * «: »/октоторп/перевод строки; иначе — одинарные кавычки ('' — экранирование
 * кавычки). Для значений этого конфига ('@hldesktop-updater', DN издателя,
 * https-URL) совпадает с выводом js-yaml байт-в-байт.
 */
export function yamlScalar(value) {
  const plain =
    value !== '' &&
    /^[!&*\]{}|>%@`"'\s]/.test(value) === false &&
    value.includes(': ') === false &&
    value.includes('#') === false &&
    value.includes('\n') === false &&
    value.trimEnd() === value;
  return plain ? value : `'${value.replaceAll("'", "''")}'`;
}

/**
 * app-update.yml из записи publish + updaterCacheDirName — ЗЕРКАЛО
 * PublishManager.getAppUpdatePublishConfiguration (publishConfigs[0] +
 * updaterCacheDirName = appInfo.updaterCacheDirName, затем serializeToYaml).
 * channel/publisherName — опциональные поля записи (отсутствуют — строки нет,
 * как у builder'а); publisherName — строка ИЛИ список строк (схема
 * app-builder-lib: массив, как в electron-builder.yml). Завершающий \n — файл
 * builder'а тоже. Чистая функция «конфиг → yaml» (§3/§19, AC1).
 */
export function buildAppUpdateYml(publishEntry, updaterCacheDirName) {
  const lines = [`provider: ${publishEntry.provider}`, `url: ${publishEntry.url}`];
  if (publishEntry.channel !== undefined) {
    lines.push(`channel: ${yamlScalar(String(publishEntry.channel))}`);
  }

  // §14 107: publisherName — из первой (stable) записи; один на файл — NFR-11
  // не ослабляется. Список сериализуется block-списком с отступом 2 (js-yaml).
  const publisherName = publishEntry.publisherName;
  if (Array.isArray(publisherName)) {
    lines.push('publisherName:');
    for (const item of publisherName) {
      lines.push(`  - ${yamlScalar(String(item))}`);
    }
  } else if (publisherName !== undefined) {
    lines.push(`publisherName: ${yamlScalar(String(publisherName))}`);
  }

  lines.push(`updaterCacheDirName: ${yamlScalar(String(updaterCacheDirName))}`, '');
  return lines.join('\n');
}

/**
 * afterPack (electron-builder.yml → afterPack: ./scripts/after-pack-app-update.mjs):
 * publish настроен, а resources/app-update.yml отсутствует → записать; иначе —
 * ничего (builder уже написал сам / publish нет — прежнее поведение).
 */
export async function afterPack(context) {
  const entry = firstPublishEntry(context.packager.config.publish);
  if (entry === null) {
    return;
  }
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const appUpdateYmlPath = join(resourcesDir, APP_UPDATE_FILENAME);
  if (existsSync(appUpdateYmlPath)) {
    return; // штатный путь builder'а (nsis/CI): файл уже есть — не перезаписываем
  }
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(
    appUpdateYmlPath,
    buildAppUpdateYml(entry, context.packager.appInfo.updaterCacheDirName),
    'utf-8',
  );
}
