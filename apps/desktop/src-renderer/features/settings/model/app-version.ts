/**
 * TASK-097 §5: версия приложения для строки «Версия: …» секции «Обновления» —
 * упрощение «локально из процесса» (§5). РЕАЛЬНЫЙ layout UA Electron (ревью 097):
 * shell/common/application_info.cc строит '<name>/<version> Chrome/<x> Electron/<y>',
 * Chromium BuildUserAgentFromProduct дописывает Safari-токен последним — токен
 * приложения (health-log/<версия>; electron-builder.yml extraMetadata) стоит В
 * СЕРЕДИНЕ строки, перед ' Chrome/'. Привязка к концу строки ловила только
 * несуществующий layout (юнит-тесты зелёные — в проде «Версия: —» всегда).
 * Канал app/meta с полем appVersion — TASK-100 (todo), до него — разбор UA;
 * токена перед ' Chrome/' нет (не Electron, нестандартный агент) — undefined:
 * UI показывает «—» (строка не врёт).
 *
 * Имя в токене не анализируется (может содержать @ и / — dev-имя пакета,
 * @hl/desktop/0.0.0) — извлекается только версия: токен «что-то/x.y.z»,
 * непосредственно за которым следует ' Chrome/'. Сегменты Mozilla/5.0 (два
 * числа) и AppleWebKit/537.36 шаблон x.y.z не проходят; Chrome/126.0.0.0 сам за
 * собой ' Chrome/' не имеет — сам себя не матчит.
 */

/**
 * Версия из токена «Name/x.y.z», за которым следует ' Chrome/' (layout UA
 * Electron); нет такого токена — undefined.
 */
export function extractAppVersion(userAgent: string): string | undefined {
  const match = /([^\s/]+)\/(\d+\.\d+\.\d+[^\s/]*)(?= Chrome\/)/u.exec(userAgent);
  return match?.[2];
}

/** Версия текущего рантайма: userAgent окружения (вне окна — undefined). */
export function readAppVersion(userAgent?: string): string | undefined {
  const source = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return extractAppVersion(source);
}
