/**
 * TASK-013 §5/§17: инициализация react-i18next. Каталог ru — источник истины
 * (второй каталог en — пост-MVP, TD-4); lng ru, fallback ru. Ресурсы inline —
 * инициализация синхронна, к первому рендеру тексты готовы (без вспышки ключей).
 *
 * Каталоги: ru/common.json (названия разделов, aria-label навигации, wip) и
 * ru/errors.json (internal/validation/renderer — согласованы с TASK-008/011: тот же
 * файл, что читает translateMessageKey). Один namespace 'translation' с группами
 * common./errors.: ключи в коде совпадают со строками messageKey контрактов
 * ('errors.renderer' — прецедент ErrorBoundary, TASK-011).
 *
 * escapeValue: false — экранирование делает React, ICU-подстановки включатся с
 * первого использования счётчиков (§17). Динамические ключи запрещены (§22):
 * только литералы в t() — иначе check:i18n не видит ключ.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import common from './ru/common.json';
import errors from './ru/errors.json';

const resources = {
  ru: { translation: { common, errors } },
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
