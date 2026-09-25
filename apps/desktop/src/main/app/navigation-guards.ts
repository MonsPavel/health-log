/**
 * Гварды навигации главного окна (TASK-007 §13; арх. 08 §1/§4): рендерер — недоверенная
 * зона, решения о навигации принимаются в main по строгому совпадению origin и белому
 * списку протоколов. Чистые функции без запуска Electron (§19).
 */

/**
 * Разрешена ли навигация окна на url: только на origin dev-сервера и только в dev.
 *
 * Сравнение origin (схема+хост+порт), а не строкового префикса: префикс
 * «http://127.0.0.1:5183» совпадает и с «http://127.0.0.1:5183.evil.test/», и с
 * «http://127.0.0.1:5183@evil.test/» (userinfo) — чужие origin. Невалидный URL
 * (в т.ч. невалидный devServerUrl) → запрет. В prod (devServerUrl undefined) — запрет.
 */
export function isNavigationAllowed(url: string, devServerUrl: string | undefined): boolean {
  if (devServerUrl === undefined) {
    return false;
  }
  try {
    return new URL(url).origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Является ли url внешней http/https-ссылкой, которую можно передать в
 * shell.openExternal (§13: «внешние ссылки — системный браузер»). Всё прочее
 * (file:, ms-msdt:, search-ms:, javascript:, кастомные протоколы ОС) из
 * недоверенного рендерера наружу не уходит (официальный security-чеклист Electron:
 * валидировать протокол перед openExternal).
 */
export function isExternalHttpUrl(url: string): boolean {
  return /^https?:/i.test(url);
}
