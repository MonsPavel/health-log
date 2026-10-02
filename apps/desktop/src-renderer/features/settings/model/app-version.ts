/**
 * TASK-097 §5: версия приложения для строки «Версия: …» секции «Обновления» —
 * упрощение «локально из процесса» (§5): Electron добавляет к navigator.userAgent
 * хвост «Name/version» (app.getName()/app.getVersion(); в упакованной сборке —
 * health-log/<версия>, в dev — имя пакета). Канал app/meta с полем appVersion —
 * TASK-100 (todo), до него источник версии — разбор UA; хвоста нет (не Electron,
 * нестандартный агент) — undefined: UI показывает «—» (строка не врёт).
 *
 * Имя в хвосте не анализируется (может содержать @ и /) — извлекается только
 * версия: последний токен «что-то/x.y.z» в самом конце строки. Токены вида
 * Chrome/126.0.0.0 в середине строки не принимаются — привязка к концу.
 */

/**
 * Версия из хвоста userAgent («Name/x.y.z» в конце строки) — x.y.z; нет хвоста —
 * undefined.
 */
export function extractAppVersion(userAgent: string): string | undefined {
  const tail = /([^\s/]+)\/(\d+\.\d+\.\d+[^\s/]*)$/u.exec(userAgent.trim());
  return tail?.[2];
}

/** Версия текущего рантайма: userAgent окружения (вне окна — undefined). */
export function readAppVersion(userAgent?: string): string | undefined {
  const source = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return extractAppVersion(source);
}
