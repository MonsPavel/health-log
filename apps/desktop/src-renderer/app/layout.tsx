/**
 * TASK-013 §5/§10/§15/§16 + TASK-123 v3 (референс владельца): Sidebar-layout —
 * nav 240px (w-60, rem: масштабируется с FR-8.2) + контент. Сайдбар — по
 * референсу: ТЕМНЕЕ контента (bg-side), иконка + подпись, активный раздел —
 * приглушённая пилюля bg-nav-active (не яркий accent), внизу — переключатель
 * темы (луна + switch, как в референсе).
 *
 * Семантика a11y (§10/§16): nav aria-label="Разделы" (ключ common.sections),
 * список ul > li > a, aria-current="page" ставит NavLink; иконки aria-hidden;
 * видимый фокус — глобальный :focus-visible (theme.css).
 *
 * Layout рендерится ВНЕ Routes (children-паттерн, §15): при смене маршрута
 * перерисовывается только <Routes> — Sidebar не ре-рендерится.
 */
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { IoSwitch } from '../components/ios/kit.js';
import { usePreferences } from '../features/settings/model/use-preferences.js';

/** Раздел навигации: путь, ключ подписи (§17), контурная иконка (SF-дух). */
interface Section {
  readonly path: string;
  readonly labelKey: string;
  readonly icon: JSX.Element;
}

/** Контурные иконки 20px (stroke 1.8, скруглённые концы — SF Symbols дух). */
const ICONS = {
  dashboard: (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M3 11.5 10 4l7 7.5M5 10v6h4v-4h2v4h4v-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  journal: (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M6 3h8a2 2 0 0 1 2 2v12l-3-2-3 2-3-2-3 2V5a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  ai: (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M10 2.5 11.6 7 16 8.5 11.6 10 10 14.5 8.4 10 4 8.5 8.4 7 10 2.5ZM15.5 13.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  reports: (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M5.5 3h6L15 6.5V17H5.5V3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 9h4M8 12h4M8 15h2.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  settings: (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M10 2.8v2.4M10 14.8v2.4M2.8 10h2.4M14.8 10h2.4M4.9 4.9l1.7 1.7M13.4 13.4l1.7 1.7M15.1 4.9l-1.7 1.7M6.6 13.4l-1.7 1.7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  moon: (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" fill="none">
      <path
        d="M17 12.5A7.5 7.5 0 0 1 7.5 3 7 7 0 1 0 17 12.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
} as const;

/** Информационная архитектура §3: Динамика · Журнал · ИИ · Отчёты · Настройки. */
const SECTIONS: readonly Section[] = [
  { path: '/dashboard', labelKey: 'common.nav.dashboard', icon: ICONS.dashboard },
  { path: '/journal', labelKey: 'common.nav.journal', icon: ICONS.journal },
  { path: '/ai', labelKey: 'common.nav.ai', icon: ICONS.ai },
  { path: '/reports', labelKey: 'common.nav.reports', icon: ICONS.reports },
  { path: '/settings', labelKey: 'common.nav.settings', icon: ICONS.settings },
];

/**
 * Ссылка раздела (по референсу): активная — приглушённая пилюля bg-nav-active
 * (текст label-цвета — контраст ≥12:1 в обеих темах), неактивная — muted с
 * hover-подсветкой.
 */
const LINK_BASE_CLASS = 'flex items-center gap-2.5 rounded-lg px-3 py-2 text-base no-underline';

/** Переключатель темы внизу сайдбара (референс: «Тёмная тема» + switch). */
function ThemeSidebarToggle(): JSX.Element {
  const { t } = useTranslation();
  const { prefs, setPreferences } = usePreferences();
  const dark = prefs?.theme === 'dark';
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-base text-muted">
      {ICONS.moon}
      <span className="flex-1">
        {t(dark ? 'settings.theme.themeLight' : 'settings.theme.themeDark')}
      </span>
      <IoSwitch
        checked={dark}
        onChange={(next) => setPreferences.mutate({ theme: next ? 'dark' : 'light' })}
        labelText={t('common.theme.toggle')}
      />
    </div>
  );
}

/** Каркас экрана: skip-link + Sidebar + контент (children — subtree роутера, §15). */
export function AppLayout({ children }: { readonly children: ReactNode }): JSX.Element {
  const { t } = useTranslation();

  /**
   * TASK-108 §16: skip-link «Перейти к содержимому» — первый таб-стоп (до nav).
   * HashRouter: смена hash = смена МАРШРУТА, поэтому дефолт-переход отменяется —
   * фокус переносится в <main id="content"> программно (main с tabIndex=-1).
   */
  const skipToContent = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    document.getElementById('content')?.focus();
  };

  return (
    <div className="flex min-h-screen">
      <a
        href="#content"
        onClick={skipToContent}
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-3 focus:py-2 focus:text-base focus:font-semibold focus:text-text"
      >
        {t('common.skipToContent')}
      </a>
      <nav
        aria-label={t('common.sections')}
        className="flex w-60 shrink-0 flex-col border-r border-border bg-side p-3"
      >
        <ul className="flex flex-col gap-0.5">
          {SECTIONS.map((section) => (
            <li key={section.path}>
              <NavLink
                to={section.path}
                className={({ isActive }) =>
                  isActive
                    ? `${LINK_BASE_CLASS} bg-nav-active font-medium text-text`
                    : `${LINK_BASE_CLASS} text-muted hover:bg-fill hover:text-text`
                }
              >
                {section.icon}
                {t(section.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="mt-auto pt-3">
          <ThemeSidebarToggle />
        </div>
      </nav>
      <main id="content" tabIndex={-1} className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  );
}
