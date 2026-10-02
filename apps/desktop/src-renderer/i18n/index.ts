/**
 * TASK-013 §5/§17: инициализация react-i18next. Каталог ru — источник истины
 * (второй каталог en — пост-MVP, TD-4); lng ru, fallback ru. Ресурсы inline —
 * инициализация синхронна, к первому рендеру тексты готовы (без вспышки ключей).
 *
 * Каталоги: ru/common.json (названия разделов, aria-label навигации, wip),
 * ru/errors.json (internal/validation/renderer — согласованы с TASK-008/011: тот же
 * файл, что читает translateMessageKey), ru/export.json (TASK-065 §17: ключи
 * export.* — тексты UI файлового экспорта), ru/data.json (TASK-073 §17: ключи
 * data.backup.* / data.restore.* / data.wipe.* — тексты экрана «Данные»),
 * feature-каталоги (features/⟨фича⟩/ru.json —
 * первый measurement, TASK-031: ключи с префиксом имени фичи) и каталог общих
 * компонентов components/critical/ru.json (TASK-041, группа critical); settings —
 * TASK-047 (features/settings/ru.json); ai — TASK-081 (features/ai/ru.json); lock —
 * TASK-095 (i18n/ru/lock.json — оверлей блокировки); security — TASK-095
 * (features/security/ru.json — секция «Защита паролем»); updates — TASK-097
 * (features/updates/ru.json — секция «Обновления»); privacy — TASK-099
 * (i18n/ru/privacy.json — секция «Приватность» настроек, ключи privacy.* по §17
 * задачи: descriptionKey операций генерирует main, 098); about — TASK-100
 * (i18n/ru/about.json — секция «О приложении», ключи about.*: версии — параметры).
 * Один namespace
 * 'translation' с группами common./data./errors./export./lock./measurement./settings./critical./dashboard./ai./security./updates./privacy./about.: ключи в коде совпадают со
 * строками messageKey контрактов ('errors.renderer' — прецедент ErrorBoundary, TASK-011).
 *
 * escapeValue: false — экранирование делает React, ICU-подстановки включатся с
 * первого использования счётчиков (§17). Динамические ключи запрещены (§22):
 * только литералы в t() — иначе check:i18n не видит ключ.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import common from './ru/common.json';
import data from './ru/data.json';
import errors from './ru/errors.json';
import exportCatalog from './ru/export.json';
import report from './ru/report.json';
// TASK-095 §17: ключи lock.* — экран блокировки (оверлей, эпик 6.1).
import lock from './ru/lock.json';
import measurement from '../features/measurement/ru.json';
import settings from '../features/settings/ru.json';
import critical from '../components/critical/ru.json';
import dashboard from '../features/dashboard/ru.json';
// TASK-081 §17: ключи ai.banner.* / ai.models.* — баннер «ИИ не настроен» и
// витрина моделей (карточки, состояния, согласие, предупреждения, «позже»).
import ai from '../features/ai/ru.json';
// TASK-095 §17: ключи security.passphrase.* / security.autolock.* — секция
// «Защита паролем» экрана настроек.
import security from '../features/security/ru.json';
// TASK-097 §17: ключи updates.* — секция «Обновления» экрана настроек.
import updates from '../features/updates/ru.json';
// TASK-099 §17: ключи privacy.* — секция «Приватность» (обещание, операции,
// лента, инструкция самопроверки; тексты описаний операций — по descriptionKey 098).
import privacy from './ru/privacy.json';
// TASK-100 §17: ключи about.* — секция «О приложении» (версии, статус сампроверки,
// полная проверка БД; версии — параметры подстановки).
import about from './ru/about.json';

const resources = {
  ru: {
    translation: {
      common,
      data,
      errors,
      export: exportCatalog,
      report,
      lock,
      measurement,
      settings,
      critical,
      dashboard,
      ai,
      security,
      updates,
      privacy,
      about,
    },
  },
} as const;

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources,
    lng: 'ru',
    fallbackLng: 'ru',
    interpolation: { escapeValue: false },
  });
}

/** Глобальный экземпляр с подключённым react-i18next (для тестов и вне React). */
export default i18next;
