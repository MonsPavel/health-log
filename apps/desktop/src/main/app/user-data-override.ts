/**
 * TASK-035 §4/§6/§9: env-оверрайд userData для E2E. Playwright `_electron.launch`
 * стартует собранный main с переменной HL_TEST_USER_DATA=<tmp> (fixture mkdtemp);
 * bootstrap подставляет её значение вместо app.getPath('userData') — контейнер
 * (TASK-027) получает изолированный каталог: зашифрованная БД и vault.key живут
 * в tmp и очищаются после прогона, реальные данные пользователя не затронуты
 * (§20 п. 3). Чистая функция без импорта electron — юнит-тест рядом
 * (user-data-override.test.ts, прецедент single-instance.ts §19).
 *
 * TASK-119 §3/§4 (находка F2 аудита 2026-Q1 §4): изоляция расширена на Chromium-слой —
 * applyUserDataOverride зовёт app.setPath('userData', override) ДО whenReady,
 * single-instance и создания окна: localStorage (в т.ч. hl.updates.lastCheckAt),
 * disk/GPU-кэши и лок single-instance живут в tmp-userData, а не в реальном профиле.
 * Порядок в bootstrap: setPath → ready → buildContainer с тем же override
 * (resolveUserDataPath поверх уже переопределённого getPath('userData')).
 *
 * БЕЗОПАСНОСТЬ (§9): переменная принимается только осознанно задающей её стороной
 * (тестовый раннер); защиты от «пользователь так запустил» нет — переменная безвредна:
 * меняет лишь каталог данных, не поведение. Пустая строка трактуется как «не задана»
 * (пустой путь сломал бы join(userDataPath, …)).
 */

/** Имя переменной окружения с путём tmp-userData для e2e (единственный источник). */
export const HL_TEST_USER_DATA_ENV = 'HL_TEST_USER_DATA';

/**
 * Override, если переменная задана непустым значением; иначе undefined. Единственное
 * место трактовки «пустая строка = не задана» — общее для resolveUserDataPath и
 * applyUserDataOverride.
 */
function userDataOverride(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const override = env[HL_TEST_USER_DATA_ENV];
  return override !== undefined && override !== '' ? override : undefined;
}

/**
 * UserData контейнера: значение HL_TEST_USER_DATA, когда переменная задана непустым
 * значением; иначе — боевой путь (app.getPath('userData') от bootstrap).
 */
export function resolveUserDataPath(
  defaultPath: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return userDataOverride(env) ?? defaultPath;
}

/** Минимальная поверхность Electron app для применения оверрайда (мок в юнит-тесте). */
export interface UserDataPathApp {
  setPath(name: string, path: string): void;
}

/**
 * TASK-119 §4: применяет оверрайд к Chromium-слою — app.setPath('userData', override)
 * при заданной непустой переменной; без неё — no-op (боевой профиль не тронут).
 * Вызывается bootstrap-ом на импорте модуля, ДО whenReady — к моменту создания
 * окна/контейнера Chromium уже пишет localStorage/кэши в изолированный каталог.
 * Возвращает true, если оверрайд применён (наблюдаемость в вызывающем коде).
 */
export function applyUserDataOverride(
  app: UserDataPathApp,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const override = userDataOverride(env);
  if (override === undefined) {
    return false;
  }
  app.setPath('userData', override);
  return true;
}
