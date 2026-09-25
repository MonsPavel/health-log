/**
 * TASK-013 §5/§17: тест инициализации react-i18next — язык ru (источник истины),
 * fallback ru, ключи каталога: названия разделов, обучающий пустой текст common.wip,
 * ошибки errors.* согласованы с TASK-008/011 (errors.json существует с TASK-008).
 */
import { describe, expect, it } from 'vitest';

import i18n from './index';

describe('i18n — init (§5/§17)', () => {
  it('язык ru, fallback ru', () => {
    expect(i18n.language).toBe('ru');
    // i18next нормализует fallbackLng: 'ru' в массив ['ru'].
    expect(i18n.options.fallbackLng).toEqual(['ru']);
  });

  it('инициализирован синхронно (каталог inline — без бэкенда)', () => {
    expect(i18n.isInitialized).toBe(true);
  });

  it('common.wip — обучающий пустой текст «Экран появится после настройки»', () => {
    expect(i18n.t('common.wip')).toBe('Экран появится после настройки');
  });

  it('названия разделов — информационная архитектура §3', () => {
    expect(i18n.t('common.nav.dashboard')).toBe('Динамика');
    expect(i18n.t('common.nav.journal')).toBe('Журнал');
    expect(i18n.t('common.nav.ai')).toBe('ИИ');
    expect(i18n.t('common.nav.reports')).toBe('Отчёты');
    expect(i18n.t('common.nav.settings')).toBe('Настройки');
  });

  it('aria-label навигации — «Разделы» (§10)', () => {
    expect(i18n.t('common.sections')).toBe('Разделы');
  });

  it('errors.* согласованы с TASK-008/011 (тот же каталог)', () => {
    expect(i18n.t('errors.internal')).toBe('Что-то пошло не так. Попробуйте ещё раз.');
    expect(i18n.t('errors.validation')).toBe(
      'Проверьте правильность заполнения полей и попробуйте ещё раз.',
    );
    expect(i18n.t('errors.renderer')).toBe('Что-то сломалось. Перезагрузите приложение.');
  });
});
