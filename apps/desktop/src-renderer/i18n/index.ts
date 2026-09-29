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
 * TASK-047 (features/settings/ru.json). Один namespace
 * 'translation' с группами common./data./errors./export./measurement./settings./critical./dashboard.: ключи в коде совпадают со
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
import measurement from '../features/measurement/ru.json';
import settings from '../features/settings/ru.json';
import critical from '../components/critical/ru.json';
import dashboard from '../features/dashboard/ru.json';

const resources = {
  ru: {
    translation: {
      common,
      data,
      errors,
      export: exportCatalog,
      report,
      measurement,
      settings,
      critical,
      dashboard,
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
