/**
 * TASK-013 §5/§10/§15/§16 + TASK-123 v2 (iPad-стиль): Sidebar-layout — nav 240px
 * (w-60, rem: масштабируется с FR-8.2) + контент. Сайдбар — как iPadOS:
 * иконка + подпись, активный раздел — filled-blue pill (как выделение в
 * iPadOS sidebar), группы разделены тонкой линией.
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
 * Ссылка раздела (iPadOS sidebar): иконка + подпись; активная — filled-blue
 * pill (bg-accent, белый текст — контрастная пара bg-on-accent гейта);
 * неактивная — label-цвет, hover — лёгкий fill.
 */
const LINK_BASE_CLASS =
  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-base font-medium no-underline';

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
      <nav aria-label={t('common.sections')} className="w-60 shrink-0 border-r border-border p-3">
        <ul className="flex flex-col gap-0.5">
          {SECTIONS.map((section) => (
            <li key={section.path}>
              <NavLink
                to={section.path}
                className={({ isActive }) =>
                  isActive
                    ? `${LINK_BASE_CLASS} bg-accent text-bg`
                    : `${LINK_BASE_CLASS} text-text hover:bg-fill`
                }
              >
                {section.icon}
                {t(section.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main id="content" tabIndex={-1} className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  );
}
