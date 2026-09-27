/**
 * TASK-035 §4/§6/§9: env-оверрайд userData для E2E. Playwright `_electron.launch`
 * стартует собранный main с переменной HL_TEST_USER_DATA=<tmp> (fixture mkdtemp);
 * bootstrap подставляет её значение вместо app.getPath('userData') — контейнер
 * (TASK-027) получает изолированный каталог: зашифрованная БД и vault.key живут
 * в tmp и очищаются после прогона, реальные данные пользователя не затронуты
 * (§20 п. 3). Чистая функция без импорта electron — юнит-тест рядом
 * (user-data-override.test.ts, прецедент single-instance.ts §19).
 *
 * БЕЗОПАСНОСТЬ (§9): переменная принимается только осознанно задающей её стороной
 * (тестовый раннер); защиты от «пользователь так запустил» нет — переменная безвредна:
 * меняет лишь каталог данных, не поведение. Пустая строка трактуется как «не задана»
 * (пустой путь сломал бы join(userDataPath, …)).
 */

/** Имя переменной окружения с путём tmp-userData для e2e (единственный источник). */
export const HL_TEST_USER_DATA_ENV = 'HL_TEST_USER_DATA';

/**
 * UserData контейнера: значение HL_TEST_USER_DATA, когда переменная задана непустым
 * значением; иначе — боевой путь (app.getPath('userData') от bootstrap).
 */
export function resolveUserDataPath(
  defaultPath: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env[HL_TEST_USER_DATA_ENV];
  return override !== undefined && override !== '' ? override : defaultPath;
}
