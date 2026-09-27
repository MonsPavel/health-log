/**
 * TASK-013 §5/§12/§13 + TASK-047 §5/§6/§10/§13: ThemeProvider — режимы
 * system|light|dark и rem-масштаб текста, data-theme/класс hl-text-* на <html>,
 * живое слежение за prefers-color-scheme в режиме system (без перезагрузки).
 *
 * ИСТОЧНИК (сменился в TASK-047 §6): настройки приходят из prefs (usePreferences →
 * каналы prefs/get|set, §10/§12) — применение мгновенное по подписке на prefs и
 * событию prefs:changed (§20 AC6), персистентность — в БД (AC2). localStorage
 * (hl.theme/hl.textScale) остаётся только fallback-ом ДО первой загрузки prefs:
 * applyPersistedAppearance применяет его до рендера (защита от FOUC, §13), а
 * readStoredMode/readStoredTextScale покрывают окно до ответа prefs/get. После
 * one-time миграции localStorage→БД (TASK-047 §12) ключи удалены — fallback
 * естественно вырождается в дефолты.
 *
 * Токены применяются CSS-переменными — дерево не ре-рендерится от смены темы
 * (арх. 06 §7). localStorage не хранит ничего чувствительного (§14).
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

import { usePreferences } from '../../features/settings/model/use-preferences';

/** Режим темы: system следит за ОС, light/dark — явный выбор (§5). */
export type ThemeMode = 'system' | 'light' | 'dark';

/** Разрешённая тема — значение атрибута data-theme на <html>. */
export type ResolvedTheme = 'light' | 'dark';

/** Ключ localStorage режима темы (TASK-013 §12; миграция в prefs — TASK-047). */
export const THEME_STORAGE_KEY = 'hl.theme';

/** Ключ localStorage масштаба текста: '100' | '112.5' | '125' (TASK-013 §12). */
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
  /** Смена режима — через prefs/set (TASK-047 §10; localStorage больше не пишется). */
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

/** Чтение режима из localStorage (fallback до prefs, см. шапку); мусор/нет → system. */
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

/** Безопасное чтение сырого ключа масштаба из localStorage (fallback до prefs); мусор → '100'. */
function readStoredTextScale(): string {
  try {
    const raw = localStorage.getItem(TEXT_SCALE_STORAGE_KEY);
    return raw !== null && TEXT_SCALE_CLASSES[raw] !== undefined ? raw : '100';
  } catch {
    return '100';
  }
}

/**
 * Применение сохранённых темы и масштаба до первого рендера (§13): вызывается из
 * main.tsx до createRoot.render. Читает ТОЛЬКО легаси-localStorage (после one-time
 * миграции TASK-047 ключей нет — безопасные дефолты). Повторный вызов безвреден.
 */
export function applyPersistedAppearance(): void {
  const html = document.documentElement;
  html.setAttribute('data-theme', resolveTheme(readStoredMode(), systemPrefersDark()));
  html.classList.remove(...Object.values(TEXT_SCALE_CLASSES));
  html.classList.add(TEXT_SCALE_CLASSES[readStoredTextScale()] ?? DEFAULT_TEXT_SCALE_CLASS);
}

/** Провайдер темы: data-theme + класс масштаба на <html>; источник — prefs (§6/§10). */
export function ThemeProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const { prefs, setPreferences } = usePreferences();

  // Fallback до первого prefs/get: легаси-localStorage (после миграции — дефолты).
  const [legacyMode] = useState<ThemeMode>(readStoredMode);
  const [legacyTextScale] = useState<string>(readStoredTextScale);

  const mode: ThemeMode = prefs?.theme ?? legacyMode;
  const textScaleKey: string = prefs?.textScale ?? legacyTextScale;
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

  // §13/AC6: применение к <html> немедленно — смена источника (TASK-047) механику
  // TASK-013 не меняет: атрибут/класс следят за значением prefs.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.remove(...Object.values(TEXT_SCALE_CLASSES));
    html.classList.add(TEXT_SCALE_CLASSES[textScaleKey] ?? DEFAULT_TEXT_SCALE_CLASS);
  }, [textScaleKey]);

  const setMode = useCallback(
    (next: ThemeMode): void => {
      // §10: мутация prefs/set (optimistic в usePreferences; персистентность — БД).
      setPreferences.mutate({ theme: next });
    },
    [setPreferences],
  );

  const api = useMemo<ThemeApi>(
    () => ({ mode, resolvedTheme, setMode }),
    [mode, resolvedTheme, setMode],
  );

  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}
