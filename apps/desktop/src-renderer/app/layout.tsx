/**
 * TASK-013 §5/§10/§15/§16: Sidebar-layout — nav 240px (w-60, rem: масштабируется
 * с FR-8.2) + контент. Семантика a11y (§10/§16): nav aria-label="Разделы"
 * (ключ common.sections), список ul > li > a, aria-current="page" ставит NavLink
 * для активного раздела; видимый фокус — глобальный :focus-visible (theme.css).
 *
 * Layout рендерится ВНЕ Routes (children-паттерн, §15): при смене маршрута
 * перерисовывается только <Routes> — Sidebar не ре-рендерится.
 */
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';

/** Раздел навигации: путь маршрута + ключ подписи из каталога (§17). */
interface Section {
  readonly path: string;
  readonly labelKey: string;
}

/** Информационная архитектура §3: Динамика · Журнал · ИИ · Отчёты · Настройки. */
const SECTIONS: readonly Section[] = [
  { path: '/dashboard', labelKey: 'common.nav.dashboard' },
  { path: '/journal', labelKey: 'common.nav.journal' },
  { path: '/ai', labelKey: 'common.nav.ai' },
  { path: '/reports', labelKey: 'common.nav.reports' },
  { path: '/settings', labelKey: 'common.nav.settings' },
];

/** Базовые классы ссылки; активный раздел подсвечен акцентом (§20, п. 1). */
const LINK_BASE_CLASS = 'block rounded-md px-3 py-2 text-base no-underline hover:bg-accent/10';

/** Каркас экрана: Sidebar + контент (children — subtree роутера, §15). */
export function AppLayout({ children }: { readonly children: ReactNode }): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen">
      <nav aria-label={t('common.sections')} className="w-60 shrink-0 border-r border-border p-4">
        <ul className="flex flex-col gap-1">
          {SECTIONS.map((section) => (
            <li key={section.path}>
              <NavLink
                to={section.path}
                className={({ isActive }) =>
                  isActive
                    ? `${LINK_BASE_CLASS} bg-accent/10 font-semibold text-accent`
                    : `${LINK_BASE_CLASS} text-text`
                }
              >
                {t(section.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
