/**
 * TASK-013 §5/§12/§13: ThemeProvider — режимы system|light|dark, data-theme на
 * <html>, живое слежение за prefers-color-scheme в режиме system (§13, без
 * перезагрузки). Выбор сохраняется в localStorage `hl.theme` — ключи зарезервированы
 * для миграции в prefs (TASK-047); localStorage не хранит ничего чувствительного
 * (§14). Токены применяются CSS-переменными — дерево не ре-рендерится от смены
 * темы (арх. 06 §7).
 *
 * applyPersistedAppearance — вызывается в main.tsx ДО createRoot.render: тема и
 * rem-масштаб текста (классы hl-text-*, FR-8.2) применяются до первого рендера —
 * защита от FOUC (§13). Inline-скрипт в index.html невозможен: prod-CSP
 * script-src 'self' запрещает inline-код (TASK-008 §14) — тот же эффект даёт
 * отдельный модуль, исполняемый до рендера.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** Режим темы: system следит за ОС, light/dark — явный выбор (§5). */
export type ThemeMode = 'system' | 'light' | 'dark';

/** Разрешённая тема — значение атрибута data-theme на <html>. */
export type ResolvedTheme = 'light' | 'dark';

/** Ключ localStorage режима темы (§12; миграция в prefs — TASK-047). */
export const THEME_STORAGE_KEY = 'hl.theme';

/** Ключ localStorage масштаба текста: '100' | '112.5' | '125' (§12). */
export const TEXT_SCALE_STORAGE_KEY = 'hl.textScale';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** Класс масштаба на <html>; имена без точки — '112.5' → 'hl-text-112'. */
const TEXT_SCALE_CLASSES: Readonly<Record<string, string>> = {
  '100': 'hl-text-100',
  '112.5': 'hl-text-112',
  '125': 'hl-text-125',
};
const DEFAULT_TEXT_SCALE_CLASS = 'hl-text-100';

/** API темы для дерева (§12). */
export interface ThemeApi {
  /** Выбранный режим (system|light|dark). */
  readonly mode: ThemeMode;
  /** Фактическая тема после разрешения system (значение data-theme). */
  readonly resolvedTheme: ResolvedTheme;
  /** Смена режима с записью в localStorage (§12). */
  readonly setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeApi | null>(null);

/** Доступ к теме; вне провайдера — developer-ошибка (§12, прецедент useToast). */
export function useTheme(): ThemeApi {
  const api = useContext(ThemeContext);
  if (api === null) {
    throw new Error('useTheme вызван вне ThemeProvider — оберните дерево провайдером (§12)');
  }
  return api;
}

/** Чтение режима из localStorage; мусор/отсутствие → system. localStorage может
 *  быть недоступен (запрещён политикой) — §14: только тема/масштаб, сбой глушится. */
function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** systemDark: стабильно читаемый признак системной темы (§13). */
function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/** Разрешение режима в тему: system — по медиа-запросу, иначе как задано (§13). */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode !== 'system') {
    return mode;
  }
  return systemDark ? 'dark' : 'light';
}

/** Безопасное чтение класса масштаба из localStorage; мусор → обычный (FR-8.2). */
function readTextScaleClass(): string {
  try {
    const raw = localStorage.getItem(TEXT_SCALE_STORAGE_KEY);
    return (raw !== null && TEXT_SCALE_CLASSES[raw]) || DEFAULT_TEXT_SCALE_CLASS;
  } catch {
    return DEFAULT_TEXT_SCALE_CLASS;
  }
}

/**
 * Применение сохранённых темы и масштаба до первого рендера (§13): вызывается из
 * main.tsx до createRoot.render. Повторный вызов безвреден (идемпотентен).
 */
export function applyPersistedAppearance(): void {
  const html = document.documentElement;
  html.setAttribute('data-theme', resolveTheme(readStoredMode(), systemPrefersDark()));
  html.classList.remove(...Object.values(TEXT_SCALE_CLASSES));
  html.classList.add(readTextScaleClass());
}

/** Провайдер темы: data-theme на <html>, подписка prefers-color-scheme в system. */
export function ThemeProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // §13: живое переключение в режиме system; перечитываем медиа-запрос при возврате
  // в system (пока был явный выбор, ОС могла сменить тему).
  useEffect(() => {
    if (mode !== 'system' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    setSystemDark(media.matches);
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [mode]);

  const resolvedTheme = resolveTheme(mode, systemDark);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme]);

  const setMode = useCallback((next: ThemeMode): void => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // localStorage недоступен — тема проживёт до перезапуска в текущем значении
    }
    setModeState(next);
  }, []);

  const api = useMemo<ThemeApi>(() => ({ mode, resolvedTheme, setMode }), [mode, resolvedTheme, setMode]);

  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}
